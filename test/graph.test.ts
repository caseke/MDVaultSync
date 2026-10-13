import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILDREN_WALK_LINK, GRAPH_BASE, SIMPLE_UPLOAD_MAX, encodeSegment } from "../src/remote/graph.ts";
import { GraphError, ResyncRequired, UntrustedUrl } from "../src/remote/errors.ts";
import { InvalidResponse } from "../src/remote/validate.ts";
import { DOWNLOAD_HOST, GRAPH, UPLOAD_HOST, URL_SECRET } from "./fakes/fake-graph.ts";
import { classifyError } from "../src/remote/classify.ts";
import { timeoutFor } from "../src/remote/timeout.ts";
import { FakeHttp, bytes, jsonResponse } from "./fakes/fake-http.ts";
import type { HttpTransport } from "../src/core/ports.ts";
import { enc, graphOver, last, pattern, setupGraph, originOf } from "./graph-setup.ts";

const isGraphError = (status: number, code?: string) => (e: unknown) =>
	e instanceof GraphError && e.status === status && (code === undefined || e.code === code);

test("GRAPH_BASE is Graph v1.0", () => {
	assert.equal(GRAPH_BASE, "https://graph.microsoft.com/v1.0");
});

test("getAppRoot: item and decoded pathPrefix [G-AF-1]", async () => {
	const { g, fake } = setupGraph();
	const root = await g.getAppRoot();
	assert.equal(root.item.id, "APPROOT");
	assert.equal(root.pathPrefix, "/Apps/MDVaultSync");
	assert.equal(fake.requests[0]?.url, `${GRAPH}/me/drive/special/approot`);
	assert.equal(fake.requests[0]?.headers?.["Authorization"], "Bearer AT-SENTINEL");
});

test("getAppRoot: percent-encoded parent path is decoded; bad paths are rejected", async () => {
	const http = new FakeHttp();
	const { g } = graphOver(http);
	const item = (path: unknown) => ({ id: "R", name: "My App", eTag: "e", size: 0, folder: {}, parentReference: { id: "P", path } });
	http.enqueueJson(200, item("/drive/root:/My%20Apps"));
	assert.equal((await g.getAppRoot()).pathPrefix, "/My Apps/My App");
	http.enqueueJson(200, item("/drive/root:"));
	assert.equal((await g.getAppRoot()).pathPrefix, "/My App");
	for (const bad of [
		"/drives/x/root:/Apps",
		"/drive/root:/%E0%A4%A",
		"/drive/root:/a/../b",
		"/drive/root:/a%00b",
		"/drive/root:/a%0Ab",
		"/drive/root:/a%5Cb",
		`/drive/root:/${"a/".repeat(200)}`,
		undefined,
	]) {
		http.enqueueJson(200, item(bad));
		await assert.rejects(g.getAppRoot(), InvalidResponse, String(bad));
	}
	http.enqueueJson(200, { ...item("/drive/root:/Apps"), folder: undefined, file: {} });
	await assert.rejects(g.getAppRoot(), InvalidResponse);
	http.enqueueJson(404, { error: { code: "itemNotFound" } });
	await assert.rejects(g.getAppRoot(), isGraphError(404, "itemNotFound"));
});

test("delta(null), approot-colon form: first page URL and paging to deltaLink [G-DL-1], [G-DL-2]", async () => {
	const { g, fake } = setupGraph({ pageSize: 2 }, "approot-colon");
	fake.addFile("APPROOT", "a.md", enc("a"));
	const sub = fake.addFolder("APPROOT", "sub");
	fake.addFile(sub.id, "b.md", enc("bb"));
	const first = await g.delta(null);
	assert.equal(fake.requests[0]?.url, `${GRAPH}/me/drive/special/approot:/:/delta`);
	assert.equal(first.items.length, 2);
	assert.ok(first.nextLink);
	const all = await g.deltaAll(null);
	assert.equal(all.items.length, 4);
	assert.equal(all.pages, 2);
	assert.equal(all.deltaLink, `${GRAPH}/me/drive/special/approot:/:/delta?token=T1`);
	const again = await g.delta(all.deltaLink);
	assert.ok(again.deltaLink || again.nextLink);
	assert.deepEqual(fake.authLeaks, []);
});

test("delta(null), items-id form uses the approot id", async () => {
	const { g, fake } = setupGraph({}, "items-id");
	const page = await g.delta(null);
	assert.ok(page.items.some((i) => i.id === "APPROOT"));
	assert.deepEqual(
		fake.requests.map((r) => r.url),
		[`${GRAPH}/me/drive/special/approot`, `${GRAPH}/me/drive/items/APPROOT/delta`],
	);
	await g.delta(null);
	assert.equal(fake.requests.length, 3, "the approot id is cached");
});

test("children-walk form: BFS over children with a sentinel deltaLink (design §5.2)", async () => {
	const { g, fake } = setupGraph({ pageSize: 2 }, "children-walk");
	fake.addFile("APPROOT", "a.md", enc("a"));
	const sub = fake.addFolder("APPROOT", "sub");
	const deeper = fake.addFolder(sub.id, "deeper");
	fake.addFile(deeper.id, "c.md", enc("c"));
	fake.addFile("APPROOT", "d.md", enc("d"));
	const page = await g.delta(null);
	assert.equal(page.deltaLink, CHILDREN_WALK_LINK);
	assert.equal(page.nextLink, undefined);
	assert.deepEqual(page.items.map((i) => i.name).sort(), ["MDVaultSync", "a.md", "c.md", "d.md", "deeper", "sub"]);
	const again = await g.deltaAll(CHILDREN_WALK_LINK);
	assert.equal(again.items.length, 6);
	assert.equal(again.deltaLink, CHILDREN_WALK_LINK);
});

test("a persisted link that isn't a Graph v1.0 URL is refused before any request", async () => {
	const { g, fake } = setupGraph();
	for (const link of ["https://evil.example/v1.0/delta", "http://graph.microsoft.com/v1.0/x", "garbage"]) {
		await assert.rejects(g.delta(link), UntrustedUrl);
	}
	assert.equal(fake.requests.length, 0);
});

test("410 and resync* codes on delta raise ResyncRequired [G-DL-4]", async () => {
	const http = new FakeHttp();
	const { g } = graphOver(http);
	http.enqueue(() => ({ status: 410, headers: { location: `${GRAPH}/fresh` }, body: new ArrayBuffer(0) }));
	await assert.rejects(g.delta(`${GRAPH}/me/drive/items/X/delta?token=old`), ResyncRequired);
	http.enqueueJson(400, { error: { code: "resyncChangesApplyDifferences" } });
	await assert.rejects(g.delta(`${GRAPH}/me/drive/items/X/delta?token=old`), ResyncRequired);
});

test("deltaAll stops at the page cap", async () => {
	const http = new FakeHttp();
	const { g } = graphOver(http, { maxPages: 3 });
	for (let i = 0; i < 3; i++) http.enqueueJson(200, { value: [], "@odata.nextLink": `${GRAPH}/d?page=${i + 1}` });
	await assert.rejects(g.deltaAll(`${GRAPH}/d`), InvalidResponse);
});

test("delta keeps duplicate ids in order for the engine to resolve [G-DL-6]", async () => {
	const http = new FakeHttp();
	const { g } = graphOver(http);
	const it = (eTag: string) => ({ id: "A", name: "a.md", eTag, size: 1, file: {} });
	http.enqueueJson(200, { value: [it("e1")], "@odata.nextLink": `${GRAPH}/d?p=2` });
	http.enqueueJson(200, { value: [it("e2")], "@odata.deltaLink": `${GRAPH}/d?token=1` });
	const r = await g.deltaAll(`${GRAPH}/d`);
	assert.deepEqual(r.items.map((i) => i.eTag), ["e1", "e2"]);
});

test("listChildren follows nextLink", async () => {
	const { g, fake } = setupGraph({ pageSize: 2 });
	for (const n of ["a", "b", "c", "d", "e"]) fake.addFile("APPROOT", `${n}.md`, enc(n));
	const items = await g.listChildren("APPROOT");
	assert.equal(items.length, 5);
	assert.ok(fake.requests[0]?.url.startsWith(`${GRAPH}/me/drive/items/APPROOT/children`));
});

test("getItem: item, null on 404, GraphError otherwise; hostile ids refused locally", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.md", enc("abc"));
	const it = await g.getItem(n.id);
	assert.equal(it?.size, 3);
	assert.ok(last(fake.requests)?.url.includes("$select="));
	assert.ok(!last(fake.requests)?.url.includes("downloadUrl"), "personal OneDrive drops downloadUrl under $select [G-DLD-1]");
	assert.equal(await g.getItem("NOPE"), null);
	const before = fake.requests.length;
	for (const id of ["../x", "a/b", ""]) await assert.rejects(g.getItem(id), RangeError);
	assert.equal(fake.requests.length, before);
	fake.intercept = () => jsonResponse(403, { error: { code: "accessDenied" } });
	await assert.rejects(g.getItem(n.id), isGraphError(403, "accessDenied"));
});

const encodingCases: [string, string][] = [
	["a#b.md", "a%23b.md"],
	["100%.md", "100%25.md"],
	["q?.md", "q%3F.md"],
	["sp ace.md", "sp%20ace.md"],
	["📝.md", "%F0%9F%93%9D.md"],
	["café.md", "caf%C3%A9.md"],
	["it's (1).md", "it's%20(1).md"],
];
for (const [name, expected] of encodingCases) {
	test(`per-segment encoding of ${JSON.stringify(name)} [G-ADR-1]`, async () => {
		assert.equal(encodeSegment(name), expected);
		const { g, fake } = setupGraph();
		const created = await g.uploadNew("APPROOT", name, bytes("x"));
		assert.equal(created.name, name.normalize("NFC"));
		assert.ok(last(fake.requests)?.url.endsWith(`/me/drive/items/APPROOT:/${expected}:/content?@microsoft.graph.conflictBehavior=fail`));
		const found = await g.getChildByName("APPROOT", name);
		assert.equal(found?.id, created.id);
		assert.ok(last(fake.requests)?.url.includes(`/me/drive/items/APPROOT:/${expected}?`));
	});
}

test("getChildByName is case-insensitive at the server and returns null on 404", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "Note.md", enc("x"));
	assert.equal((await g.getChildByName("APPROOT", "note.md"))?.id, n.id);
	assert.equal(await g.getChildByName("APPROOT", "missing.md"), null);
	await assert.rejects(g.getChildByName("APPROOT", "a/b"), RangeError);
});

test("uploadNew: conflictBehavior=fail in the query, 409 on a case-insensitive clash [G-UP-2], [G-NM-5]", async () => {
	const { g, fake } = setupGraph();
	const item = await g.uploadNew("APPROOT", "probe.md", bytes("one"));
	const req = last(fake.requests);
	assert.equal(req?.method, "PUT");
	assert.equal(new URL(req?.url ?? "").searchParams.get("@microsoft.graph.conflictBehavior"), "fail");
	assert.equal(req?.headers?.["Content-Type"], "application/octet-stream");
	assert.equal(item.quickXorHash?.length, 28);
	await assert.rejects(g.uploadNew("APPROOT", "PROBE.md", bytes("two")), isGraphError(409, "nameAlreadyExists"));
});

test("uploadNew refuses more than 10 MiB and invalid names without a request", async () => {
	const { g, fake } = setupGraph();
	assert.equal(SIMPLE_UPLOAD_MAX, 10 * 1024 * 1024);
	await assert.rejects(g.uploadNew("APPROOT", "big.bin", new ArrayBuffer(SIMPLE_UPLOAD_MAX + 1)), RangeError);
	await assert.rejects(g.uploadReplace("X", '"e"', new ArrayBuffer(SIMPLE_UPLOAD_MAX + 1)), RangeError);
	for (const name of ["..", "a/b", "a\\b", "", "x".repeat(256)]) await assert.rejects(g.uploadNew("APPROOT", name, bytes("x")), RangeError);
	assert.equal(fake.requests.length, 0);
	assert.equal((await g.uploadNew("APPROOT", "max.bin", new ArrayBuffer(SIMPLE_UPLOAD_MAX))).size, SIMPLE_UPLOAD_MAX);
});

test("uploadReplace sends If-Match verbatim; stale → 412 [G-UP-3], [G-TAG-2]", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.md", enc("1"));
	const etag = fake.eTag(n);
	const updated = await g.uploadReplace(n.id, etag, bytes("22"));
	assert.equal(last(fake.requests)?.headers?.["If-Match"], etag);
	assert.ok(last(fake.requests)?.url.endsWith(`/me/drive/items/${encodeURIComponent(n.id)}/content`));
	assert.equal(updated.size, 2);
	await assert.rejects(g.uploadReplace(n.id, etag, bytes("333")), isGraphError(412, "resourceModified"));
});

test("If-Match values with CR, LF or empty are refused locally", async () => {
	const { g, fake } = setupGraph();
	for (const bad of ["", "\"e\"\r\nX-Evil: 1", "a\nb", "a\u0000b", "a\tb", "é", "e".repeat(513)]) {
		await assert.rejects(g.uploadReplace("X", bad, bytes("1")), RangeError);
		await assert.rejects(g.move("X", bad, "P", "n.md"), RangeError);
		await assert.rejects(g.delete("X", bad), RangeError);
	}
	assert.equal(fake.requests.length, 0);
});

test("move: PATCH with parentReference.id, NFC name and If-Match; stale → 412 with inner codes [G-MV-1]", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.md", enc("1"));
	const sub = fake.addFolder("APPROOT", "sub");
	const etag = fake.eTag(n);
	const moved = await g.move(n.id, etag, sub.id, "café.md");
	const req = last(fake.requests);
	assert.equal(req?.method, "PATCH");
	assert.equal(req?.headers?.["If-Match"], etag);
	assert.deepEqual(JSON.parse(req?.body as string), { parentReference: { id: sub.id }, name: "café.md" });
	assert.equal(moved.parentId, sub.id);
	await assert.rejects(
		g.move(n.id, etag, "APPROOT", "b.md"),
		(e: unknown) => isGraphError(412)(e) && (e as GraphError).innerCodes.includes("entityTagDoesNotMatch"),
	);
	await assert.rejects(g.move(n.id, fake.eTag(n), "APPROOT", "x/y"), RangeError);
});

test("delete: If-Match, 204; stale → 412; missing → 404 (never permanentDelete) [G-DEL-1]", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.md", enc("1"));
	await assert.rejects(g.delete(n.id, '"stale"'), isGraphError(412));
	await g.delete(n.id, fake.eTag(n));
	const req = last(fake.requests);
	assert.equal(req?.method, "DELETE");
	assert.ok(!req?.url.includes("permanentDelete"));
	await assert.rejects(g.delete(n.id, '"e"'), isGraphError(404, "itemNotFound"));
});

test("createFolder: conflictBehavior=fail in the body; 409 on clash", async () => {
	const { g, fake } = setupGraph();
	const f = await g.createFolder("APPROOT", "Notes");
	assert.equal(f.isFolder, true);
	assert.deepEqual(JSON.parse(last(fake.requests)?.body as string), { name: "Notes", folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
	assert.equal(last(fake.requests)?.headers?.["Content-Type"], "application/json");
	await assert.rejects(g.createFolder("APPROOT", "notes"), isGraphError(409, "nameAlreadyExists"));
});

test("download: fresh downloadUrl, no Authorization to the download host, exact bytes [G-DLD-1]", async () => {
	const { g, fake } = setupGraph();
	const content = new Uint8Array(pattern(5000));
	const n = fake.addFile("APPROOT", "a.bin", content);
	const got = await g.download(n.id);
	assert.deepEqual(new Uint8Array(got), content);
	const dl = last(fake.requests);
	assert.ok(dl);
	assert.equal(originOf(dl.url), DOWNLOAD_HOST);
	assert.equal(dl?.method, "GET");
	assert.deepEqual(fake.authLeaks, []);
	assert.ok(!fake.requests.some((r) => r.url.includes("/content") && r.method === "GET"), "never GET Graph /content (302 with auth)");
});

test("download rejects a length that differs from the item size", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.bin", enc("12345"));
	fake.intercept = (req) => (originOf(req.url) === DOWNLOAD_HOST ? { status: 200, headers: {}, body: bytes("1234") } : null);
	await assert.rejects(g.download(n.id), InvalidResponse);
});

test("download with an expected size refuses an item whose size changed, before any transfer (T-D6)", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.bin", enc("12345"));
	await assert.rejects(g.download(n.id, 3), InvalidResponse);
	assert.ok(!fake.requests.some((r) => originOf(r.url) === DOWNLOAD_HOST), "the download host was never contacted");
	assert.equal(new Uint8Array(await g.download(n.id, 5)).length, 5);
});

test("download refuses an untrusted download host without contacting it", async () => {
	const { g, fake } = setupGraph({ downloadHost: "https://cdn.evil.example" });
	const n = fake.addFile("APPROOT", "a.bin", enc("x"));
	await assert.rejects(g.download(n.id), UntrustedUrl);
	assert.ok(!fake.requests.some((r) => originOf(r.url) === "https://cdn.evil.example"));
});

test("download: missing item → 404, folder or no URL → InvalidResponse, transfer error → GraphError", async () => {
	const { g, fake } = setupGraph();
	await assert.rejects(g.download("NOPE"), isGraphError(404, "itemNotFound"));
	const f = fake.addFolder("APPROOT", "dir");
	await assert.rejects(g.download(f.id), InvalidResponse);
	const n = fake.addFile("APPROOT", "a.bin", enc("x"));
	fake.intercept = (req) => (originOf(req.url) === DOWNLOAD_HOST ? jsonResponse(403, { error: { code: "accessDenied" } }) : null);
	await assert.rejects(g.download(n.id), isGraphError(403));
	const http = new FakeHttp();
	const o = graphOver(http);
	http.enqueueJson(200, { id: "A", name: "a", eTag: "e", size: 1, file: {} });
	await assert.rejects(o.g.download("A"), InvalidResponse);
});

test("quota: null when the scope forbids it, numbers when readable [G-QT-1]", async () => {
	assert.equal(await setupGraph({ quotaReadable: false }).g.quota(), null);
	assert.deepEqual(await setupGraph({ quotaReadable: true }).g.quota(), { total: 5000, used: 1000, remaining: 4000 });
	const http = new FakeHttp();
	const { g } = graphOver(http);
	http.enqueueJson(400, { error: { code: "invalidRequest" } });
	await assert.rejects(g.quota(), GraphError);
});

test("quota: 507 and quotaLimitReached from any write classify as quota and are not retried (T-D7) [G-ERR-1]", async () => {
	const cases: [number, Record<string, unknown>][] = [
		[507, { error: { code: "insufficientStorage" } }],
		[507, {}],
		[403, { error: { code: "quotaLimitReached" } }],
		[400, { error: { code: "invalidRequest", innerError: { code: "quotaLimitReached" } } }],
	];
	for (const [status, body] of cases) {
		const { g, fake } = setupGraph();
		const existing = fake.addFile("APPROOT", "e.md", enc("e"));
		let hits = 0;
		fake.intercept = (req) => {
			if (req.method === "GET") return null;
			hits++;
			return jsonResponse(status, body);
		};
		const etag = fake.eTag(existing);
		const calls: (() => Promise<unknown>)[] = [
			() => g.uploadNew("APPROOT", "n.md", enc("n").buffer),
			() => g.uploadReplace(existing.id, etag, enc("r").buffer),
			() => g.createFolder("APPROOT", "dir"),
			() => g.createUploadSession({ kind: "new", parentId: "APPROOT", name: "big.bin" }, null, 4),
		];
		for (const call of calls) {
			const before = hits;
			const e = await call().then(
				() => assert.fail("expected a quota error"),
				(x: unknown) => x,
			);
			assert.deepEqual(classifyError(e), { kind: "quota", code: "quota" }, `${status} ${JSON.stringify(body)}`);
			assert.equal(hits - before, 1, "a full drive isn't retried");
		}
	}
});

test("quota: a 507 on an upload fragment classifies as quota", async () => {
	const { g, fake } = setupGraph();
	const s = await g.createUploadSession({ kind: "new", parentId: "APPROOT", name: "big.bin" }, null, 4);
	fake.intercept = (req) => (originOf(req.url) === UPLOAD_HOST && req.method === "PUT" ? jsonResponse(507, { error: { code: "quotaLimitReached" } }) : null);
	const e = await g.putFragment(s.uploadUrl, 0, 4, enc("abcd").buffer).then(
		() => assert.fail("expected a quota error"),
		(x: unknown) => x,
	);
	assert.deepEqual(classifyError(e), { kind: "quota", code: "quota" });
});

test("download: the transfer GET carries a size-scaled timeout; API calls carry none (design §6.1)", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.bin", new Uint8Array(pattern(200_000)));
	await g.download(n.id, 200_000);
	const get = fake.requests.find((r) => originOf(r.url) === DOWNLOAD_HOST);
	assert.equal(get?.timeoutMs, timeoutFor(200_000));
	assert.ok(fake.requests.filter((r) => originOf(r.url) !== DOWNLOAD_HOST).every((r) => r.timeoutMs === undefined));
});

test("throttling: 503 with Retry-After is retried transparently and logged without URLs or names", async () => {
	const { g, fake, log } = setupGraph();
	fake.addFile("APPROOT", "Secret Diary.md", enc("x"));
	let throttled = false;
	fake.intercept = () => {
		if (throttled) return null;
		throttled = true;
		return { status: 503, headers: { "retry-after": "2" }, body: new ArrayBuffer(0) };
	};
	const page = await g.deltaAll(null);
	assert.ok(page.items.length > 0);
	const s = log.serialize();
	assert.ok(s.includes('"retry.backoff"') && s.includes('"graph.request"'));
	for (const bad of ["Secret", "Diary", URL_SECRET, "graph.microsoft.com", "AT-SENTINEL", "APPROOT"]) assert.ok(!s.includes(bad), bad);
});

test("a network failure is logged by error name only and rethrown", async () => {
	const http = new FakeHttp();
	const { g, log } = graphOver(http);
	for (let i = 0; i < 6; i++) http.enqueueNetworkError();
	await assert.rejects(g.getAppRoot(), /network/);
	assert.equal(last(log.entries().filter((e) => e.op === "graph.request"))?.code, "NetworkError");
});

test("invalid JSON from Graph surfaces as InvalidResponse", async () => {
	const http = new FakeHttp();
	const { g } = graphOver(http);
	http.enqueue(() => ({ status: 200, headers: {}, body: bytes("<html>") }));
	await assert.rejects(g.getItem("A"), InvalidResponse);
});

test("sendRaw goes through retry and logging, and only to Graph", async () => {
	const { g } = setupGraph();
	const res = await g.sendRaw({ url: `${GRAPH}/me/drive/special/approot`, method: "GET" });
	assert.equal(res.status, 200);
	await assert.rejects(g.sendRaw({ url: "https://evil.example/x", method: "GET" }), UntrustedUrl);
});

test("transfers use the transfer transport, Graph calls the authorizing one (T-I4)", async () => {
	const { fake, transport } = setupGraph();
	const graphSide: string[] = [];
	const transferSide: string[] = [];
	const spy = (inner: HttpTransport, log: string[]): HttpTransport => ({
		send: (req) => {
			log.push(new URL(req.url).hostname);
			return inner.send(req);
		},
	});
	const { g } = graphOver(spy(transport, graphSide), { transferTransport: spy(fake, transferSide) });
	const n = fake.addFile("APPROOT", "a.bin", enc("abc"));
	await g.download(n.id);
	const s = await g.createUploadSession({ kind: "new", parentId: "APPROOT", name: "b.bin" }, null, 3);
	await g.getUploadStatus(s.uploadUrl);
	await g.putFragment(s.uploadUrl, 0, 3, bytes("xyz"));
	assert.deepEqual([...new Set(graphSide)], ["graph.microsoft.com"]);
	assert.deepEqual([...new Set(transferSide)].sort(), ["api.onedrive.com", "public.dm.files.1drv.com"]);
	assert.deepEqual(fake.authLeaks, []);
});

test("dot-only ids never reach a URL", async () => {
	const { g, fake } = setupGraph();
	for (const id of [".", ".."]) {
		await assert.rejects(g.getItem(id), RangeError);
		await assert.rejects(g.delete(id, '"e"'), RangeError);
	}
	assert.equal(fake.requests.length, 0);
});

test("a delta page holding a name longer than 255 characters still parses (0.3.0 Ubuntu probe regression)", async () => {
	const { g, fake } = setupGraph({}, "approot-colon");
	fake.addFile("APPROOT", `${"L".repeat(296)}.txt`, enc("long"));
	const all = await g.deltaAll(null);
	assert.ok(all.items.some((i) => i.name.length === 300));
});

test("getItem works when the download host is unlisted; only download() refuses it", async () => {
	const { g, fake } = setupGraph({ downloadHost: "https://cdn.unlisted.example" });
	const n = fake.addFile("APPROOT", "a.bin", enc("abc"));
	assert.equal((await g.getItem(n.id))?.size, 3);
	assert.equal((await g.getChildByName("APPROOT", "a.bin"))?.id, n.id);
	await assert.rejects(g.download(n.id), UntrustedUrl);
	assert.ok(!fake.requests.some((r) => originOf(r.url) === "https://cdn.unlisted.example"));
});

test("download() failures carry a reason code, never data", async () => {
	const reasonOf = async (p: Promise<unknown>) => {
		const e = await p.catch((x: unknown) => x);
		assert.ok(e instanceof InvalidResponse);
		return e.reason;
	};
	const a = setupGraph({ omitDownloadUrl: true });
	const n = a.fake.addFile("APPROOT", "a.bin", enc("abc"));
	assert.equal(await reasonOf(a.g.download(n.id)), "download-url-missing");
	const b = setupGraph();
	const dir = b.fake.addFolder("APPROOT", "dir");
	assert.equal(await reasonOf(b.g.download(dir.id)), "not-a-file");
	const m = b.fake.addFile("APPROOT", "m.bin", enc("12345"));
	b.fake.intercept = (req) => (originOf(req.url) === DOWNLOAD_HOST ? { status: 200, headers: {}, body: bytes("1234") } : null);
	assert.equal(await reasonOf(b.g.download(m.id)), "download-length-mismatch");
	const http = new FakeHttp();
	const o = graphOver(http);
	for (const bad of ["", 5]) {
		http.enqueueJson(200, { id: "A", name: "a", eTag: "e", size: 1, file: {}, "@microsoft.graph.downloadUrl": bad });
		assert.equal(await reasonOf(o.g.download("A")), "download-url-invalid");
	}
	const c = setupGraph({ downloadUrlPad: 9000 });
	const l = c.fake.addFile("APPROOT", "l.bin", enc("x"));
	assert.equal(await reasonOf(c.g.download(l.id)), "download-url-too-long");
});

test("getItem and getChildByName survive an overlong download URL; only download() refuses it", async () => {
	const { g, fake } = setupGraph({ downloadUrlPad: 9000 });
	const n = fake.addFile("APPROOT", "a.bin", enc("abc"));
	assert.equal((await g.getItem(n.id))?.size, 3);
	assert.equal((await g.getChildByName("APPROOT", "a.bin"))?.id, n.id);
	await assert.rejects(g.download(n.id), (e: unknown) => e instanceof InvalidResponse && e.reason === "download-url-too-long");
});

test("download reads the item without $select, because OneDrive personal drops downloadUrl under $select (0.3.4 probe)", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.bin", enc("hello"));
	assert.deepEqual(new Uint8Array(await g.download(n.id)), enc("hello"));
	const meta = fake.requests.filter((r) => r.url.startsWith(`${GRAPH}/me/drive/items/`));
	assert.equal(last(meta)?.url, `${GRAPH}/me/drive/items/${encodeURIComponent(n.id)}`);
	const dl = last(fake.requests);
	assert.ok(dl);
	assert.equal(originOf(dl.url), DOWNLOAD_HOST);
	assert.ok(!Object.keys(dl?.headers ?? {}).some((k) => k.toLowerCase() === "authorization"));
	assert.deepEqual(fake.authLeaks, []);
});
