import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAGMENT, FRAGMENT_UNIT, fragmentRanges } from "../src/remote/upload-session.ts";
import { GraphError, UntrustedUrl } from "../src/remote/errors.ts";
import { InvalidResponse } from "../src/remote/validate.ts";
import { URL_SECRET, UPLOAD_HOST } from "./fakes/fake-graph.ts";
import { FakeHttp, jsonResponse } from "./fakes/fake-http.ts";
import { graphOver, last, pattern, setupGraph } from "./graph-setup.ts";

const MiB = 1024 * 1024;

test("fragment size is 10 MiB, a multiple of 320 KiB [G-UP-6]", () => {
	assert.equal(FRAGMENT, 10 * MiB);
	assert.equal(FRAGMENT_UNIT, 327_680);
	assert.equal(FRAGMENT % FRAGMENT_UNIT, 0);
});

test("fragmentRanges: 12 MiB is 10 + 2; exact multiples; small and empty totals", () => {
	assert.deepEqual(fragmentRanges(12 * MiB), [
		{ start: 0, end: 10 * MiB },
		{ start: 10 * MiB, end: 12 * MiB },
	]);
	assert.deepEqual(fragmentRanges(20 * MiB).length, 2);
	assert.deepEqual(fragmentRanges(5), [{ start: 0, end: 5 }]);
	assert.deepEqual(fragmentRanges(0), []);
	assert.throws(() => fragmentRanges(-1), RangeError);
	assert.throws(() => fragmentRanges(1.5), RangeError);
});

test("new-file session: conflictBehavior=fail in the body (no fileSize), 10 + 2 MiB fragments, no auth to the upload host", async () => {
	const { g, fake } = setupGraph();
	const data = pattern(12 * MiB);
	const s = await g.createUploadSession({ kind: "new", parentId: "APPROOT", name: "big.bin" }, null, data.byteLength);
	assert.ok(s.uploadUrl.startsWith(`${UPLOAD_HOST}/up/`));
	const createReq = last(fake.requests);
	assert.equal(createReq?.method, "POST");
	assert.ok(createReq?.url.endsWith("/me/drive/items/APPROOT:/big.bin:/createUploadSession"));
	assert.deepEqual(JSON.parse(createReq?.body as string), { item: { "@microsoft.graph.conflictBehavior": "fail" } });
	const ranges = fragmentRanges(data.byteLength);
	const first = await g.putFragment(s.uploadUrl, 0, data.byteLength, data.slice(0, ranges[0]?.end));
	assert.equal(first, null);
	assert.equal(last(fake.requests)?.headers?.["Content-Range"], `bytes 0-${10 * MiB - 1}/${12 * MiB}`);
	const status = await g.getUploadStatus(s.uploadUrl);
	assert.equal(status.nextExpectedStart, 10 * MiB);
	const item = await g.putFragment(s.uploadUrl, 10 * MiB, data.byteLength, data.slice(10 * MiB));
	assert.equal(item?.name, "big.bin");
	assert.equal(item?.size, 12 * MiB);
	assert.deepEqual(fake.authLeaks, []);
	const uploads = fake.requests.filter((r) => r.url.startsWith(UPLOAD_HOST));
	assert.equal(uploads.length, 3);
	for (const r of uploads) assert.ok(!Object.keys(r.headers ?? {}).some((k) => k.toLowerCase() === "authorization"));
});

test("replace session sends If-Match verbatim; a stale one is 412; replace needs an If-Match", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.md", new Uint8Array([1]));
	const etag = fake.eTag(n);
	await g.createUploadSession({ kind: "replace", id: n.id }, etag, 5);
	const req = last(fake.requests);
	assert.equal(req?.headers?.["If-Match"], etag);
	assert.ok(req?.url.endsWith(`/me/drive/items/${encodeURIComponent(n.id)}/createUploadSession`));
	assert.deepEqual(JSON.parse(req?.body as string), { item: { "@microsoft.graph.conflictBehavior": "replace" } });
	await assert.rejects(g.createUploadSession({ kind: "replace", id: n.id }, '"stale"', 5), (e: unknown) => e instanceof GraphError && e.status === 412);
	const before = fake.requests.length;
	await assert.rejects(g.createUploadSession({ kind: "replace", id: n.id }, null, 5), RangeError);
	assert.equal(fake.requests.length, before);
});

test("replace session completes and returns the updated item", async () => {
	const { g, fake } = setupGraph();
	const n = fake.addFile("APPROOT", "a.md", new Uint8Array([1]));
	const s = await g.createUploadSession({ kind: "replace", id: n.id }, fake.eTag(n), 3);
	const item = await g.putFragment(s.uploadUrl, 0, 3, new Uint8Array([7, 8, 9]).buffer);
	assert.equal(item?.size, 3);
});

test("a non-final fragment that isn't a multiple of 320 KiB, or out of range, is refused before sending", async () => {
	const { g, fake } = setupGraph();
	const s = await g.createUploadSession({ kind: "new", parentId: "APPROOT", name: "x.bin" }, null, 2 * FRAGMENT_UNIT);
	const before = fake.requests.length;
	await assert.rejects(g.putFragment(s.uploadUrl, 0, 2 * FRAGMENT_UNIT, new ArrayBuffer(1000)), RangeError);
	await assert.rejects(g.putFragment(s.uploadUrl, 0, 10, new ArrayBuffer(11)), RangeError);
	await assert.rejects(g.putFragment(s.uploadUrl, 0, 10, new ArrayBuffer(0)), RangeError);
	await assert.rejects(g.putFragment(s.uploadUrl, -1, 10, new ArrayBuffer(1)), RangeError);
	await assert.rejects(g.putFragment(s.uploadUrl, 0, FRAGMENT * 3, new ArrayBuffer(FRAGMENT + FRAGMENT_UNIT)), RangeError);
	assert.equal(fake.requests.length, before);
});

test("416 on an overlapping fragment surfaces as GraphError 416", async () => {
	const { g } = setupGraph();
	const s = await g.createUploadSession({ kind: "new", parentId: "APPROOT", name: "x.bin" }, null, 2 * FRAGMENT_UNIT);
	await g.putFragment(s.uploadUrl, 0, 2 * FRAGMENT_UNIT, new ArrayBuffer(FRAGMENT_UNIT));
	await assert.rejects(
		g.putFragment(s.uploadUrl, 0, 2 * FRAGMENT_UNIT, new ArrayBuffer(FRAGMENT_UNIT)),
		(e: unknown) => e instanceof GraphError && e.status === 416 && e.innerCodes.includes("fragmentOverlap"),
	);
});

test("cancel, then status is gone (404 → nextExpectedStart null); cancel of a gone session is fine", async () => {
	const { g } = setupGraph();
	const s = await g.createUploadSession({ kind: "new", parentId: "APPROOT", name: "x.bin" }, null, 10);
	await g.cancelUpload(s.uploadUrl);
	assert.deepEqual(await g.getUploadStatus(s.uploadUrl), { nextExpectedStart: null, expiresAt: "" });
	await g.cancelUpload(s.uploadUrl);
});

test("status and cancel errors other than 404 throw", async () => {
	const http = new FakeHttp();
	const { g } = graphOver(http);
	http.enqueueJson(400, { error: { code: "invalidRequest" } });
	await assert.rejects(g.getUploadStatus("https://api.onedrive.com/up/1"), GraphError);
	http.enqueueJson(400, { error: { code: "invalidRequest" } });
	await assert.rejects(g.cancelUpload("https://api.onedrive.com/up/1"), GraphError);
	http.enqueueJson(400, { error: { code: "invalidRequest" } });
	await assert.rejects(g.putFragment("https://api.onedrive.com/up/1", 0, 1, new ArrayBuffer(1)), GraphError);
	http.enqueueJson(500, {});
	http.enqueueJson(200, { uploadUrl: "https://evil.example/up", expirationDateTime: "e" });
	await assert.rejects(g.createUploadSession({ kind: "new", parentId: "P", name: "n" }, null, 1), UntrustedUrl);
	http.enqueueJson(200, { id: "x" });
	await assert.rejects(g.putFragment("https://api.onedrive.com/up/1", 0, 1, new ArrayBuffer(1)), InvalidResponse);
});

test("an untrusted uploadUrl is refused before any request, and the error carries no URL", async () => {
	const { g, fake } = setupGraph();
	const evil = `https://evil.example/up?tempauth=${URL_SECRET}`;
	const before = fake.requests.length;
	for (const p of [g.putFragment(evil, 0, 1, new ArrayBuffer(1)), g.getUploadStatus(evil), g.cancelUpload(evil)]) {
		const e = await p.catch((x: unknown) => x);
		assert.ok(e instanceof UntrustedUrl);
		assert.ok(!`${e.message}${e.stack ?? ""}`.includes(URL_SECRET));
	}
	assert.equal(fake.requests.length, before);
});

test("202 means more fragments are expected; 201 returns the item", async () => {
	const http = new FakeHttp();
	const { g } = graphOver(http);
	http.enqueue(() => jsonResponse(202, { nextExpectedRanges: [`${FRAGMENT_UNIT}-`], expirationDateTime: "e" }));
	assert.equal(await g.putFragment("https://api.onedrive.com/up/1", 0, 2 * FRAGMENT_UNIT, new ArrayBuffer(FRAGMENT_UNIT)), null);
	http.enqueue(() => jsonResponse(201, { id: "N1", name: "n", eTag: "e", size: 1, file: {} }));
	assert.equal((await g.putFragment("https://api.onedrive.com/up/1", 0, 1, new ArrayBuffer(1)))?.id, "N1");
});
