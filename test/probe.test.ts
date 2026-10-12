import { test } from "node:test";
import assert from "node:assert/strict";
import { LARGE_SIZE, PROBE_DIR, probeBytes, runProbe, type ProbeDeps } from "../src/remote/probe.ts";
import type { DeltaForm } from "../src/remote/capabilities.ts";
import { FakeGraph, URL_SECRET, UPLOAD_HOST, type FakeGraphOptions, sha1Base64 } from "./fakes/fake-graph.ts";
import { jsonResponse } from "./fakes/fake-http.ts";
import { TOKEN, enc, graphOver } from "./graph-setup.ts";
import { AuthorizingTransport } from "../src/remote/http.ts";

function setup(opts: FakeGraphOptions = {}) {
	const fake = new FakeGraph(opts);
	const transport = new AuthorizingTransport(fake, { getAccessToken: () => Promise.resolve(TOKEN) });
	const base = graphOver(transport);
	const deps: ProbeDeps = {
		graph: base.g,
		graphFor: (form: DeltaForm) => graphOver(transport, { deltaForm: form }).g,
		clock: base.clock,
		platform: "test",
		pluginVersion: "0.0.0",
	};
	return { fake, deps, log: base.log };
}

test("probeBytes is deterministic and seed-dependent", () => {
	const a = new Uint8Array(probeBytes(1000, 1));
	assert.deepEqual(a, new Uint8Array(probeBytes(1000, 1)));
	assert.notDeepEqual(a, new Uint8Array(probeBytes(1000, 2)));
	assert.equal(LARGE_SIZE, 12 * 1024 * 1024);
});

test("full probe against an OneDrive-like fake records every result and cleans up", async () => {
	const { fake, deps } = setup({ quotaReadable: false });
	fake.addFile("APPROOT", "Secret Diary.md", enc("private words"));
	const r = await runProbe(deps);
	assert.equal(r.probeVersion, 1);
	assert.equal(r.platform, "test");
	assert.deepEqual(r.approot, { ok: true, parentPath: "/drive/root:/Apps", name: "MDVaultSync", pathPrefixLength: 16 });
	for (const form of ["approot-colon", "items-id"] as const) {
		const d = r.delta[form];
		assert.equal(d.ok, true, form);
		assert.equal(d.approotListed, true);
		assert.ok((d.filesWithHash ?? 0) > 0);
		assert.equal(d.filesWithoutHash, 0);
		assert.ok((d.pages ?? 0) >= 1);
	}
	assert.equal(r.putIfMatch.honored, true);
	assert.equal(r.putIfMatch.staleStatus, 412);
	assert.equal(r.caseInsensitive.confirmed, true);
	assert.equal(r.caseInsensitive.status, 409);
	assert.equal(r.nameLength.len255.status, 201);
	assert.equal(r.nameLength.len256.status, 400);
	assert.equal(r.nameLength.nameMax, 255);
	assert.deepEqual(r.patchIfMatch, { currentStatus: 200, staleStatus: 412 });
	assert.deepEqual(r.deleteIfMatch, { staleStatus: 412, currentStatus: 204 });
	assert.deepEqual(r.quota, { readable: false });
	assert.equal(r.largeFile.ok, true);
	assert.equal(r.largeFile.size, LARGE_SIZE);
	assert.equal(r.largeFile.fragments, 2);
	assert.equal(r.largeFile.bytesMatch, true);
	assert.equal(r.largeFile.uploadHost, "api.onedrive.com");
	assert.equal(r.largeFile.downloadHost, "public.dm.files.1drv.com");
	assert.equal(typeof r.largeFile.uploadMs, "number");
	assert.equal(typeof r.largeFile.downloadMs, "number");
	// QuickXorHash vectors for M4: the fake uses sha1 in place of QuickXorHash, so compare against that.
	const large = r.hashVectors.find((h) => h.file === "large.bin");
	assert.equal(large?.quickXorHash, sha1Base64(new Uint8Array(probeBytes(LARGE_SIZE, large?.seed ?? -1))));
	assert.ok(r.hashVectors.some((h) => h.file === "empty.bin" && h.size === 0));
	assert.ok(r.hashVectors.every((h) => typeof h.generator === "string"));
	assert.deepEqual(r.cleanup, { ok: true });
	assert.equal(r.errors, 0);
	assert.deepEqual(fake.authLeaks, []);
	// Only the user's file and the fixed folders remain.
	assert.deepEqual([...fake.nodes.values()].map((n) => n.name).sort(), ["Apps", "MDVaultSync", "Secret Diary.md", "root"]);
});

test("the result JSON holds no vault names, URLs, tokens or URL credentials", async () => {
	const { fake, deps, log } = setup();
	fake.addFile("APPROOT", "Secret Diary.md", enc("private words"));
	const s = JSON.stringify(await runProbe(deps)) + log.serialize();
	for (const bad of ["Secret", "Diary", "private", URL_SECRET, TOKEN, "https://", "tempauth", "/up/", "/dl/"]) {
		assert.ok(!s.includes(bad), bad);
	}
});

test("PUT that ignores If-Match, case-sensitive names, longer names and readable quota are reported", async () => {
	const { deps } = setup({ putHonorsIfMatch: false, nameMax: 400, quotaReadable: true });
	const r = await runProbe(deps);
	assert.equal(r.putIfMatch.honored, false);
	assert.equal(r.putIfMatch.staleStatus, 200);
	assert.equal(r.nameLength.nameMax, null);
	assert.equal(r.nameLength.len256.status, 201);
	assert.deepEqual(r.quota, { readable: true });
	assert.deepEqual(r.cleanup, { ok: true });
});

test("an unsupported delta form is recorded with its status and code", async () => {
	const { deps } = setup({ deltaForms: ["items-id"] });
	const r = await runProbe(deps);
	assert.deepEqual(r.delta["approot-colon"], { ok: false, status: 400, code: "invalidRequest" });
	assert.equal(r.delta["items-id"].ok, true);
});

test("a leftover probe folder from an earlier run is removed first", async () => {
	const { fake, deps } = setup();
	const old = fake.addFolder("APPROOT", PROBE_DIR);
	fake.addFile(old.id, "probe.md", enc("old"));
	const r = await runProbe(deps);
	assert.equal(r.leftoverRemoved, true);
	assert.equal(r.caseInsensitive.confirmed, true);
	assert.ok(![...fake.nodes.values()].some((n) => n.name === PROBE_DIR));
});

test("a failing step is recorded and cleanup still runs", async () => {
	const { fake, deps } = setup();
	fake.intercept = (req) =>
		req.url.startsWith(UPLOAD_HOST) && req.method === "PUT" ? jsonResponse(507, { error: { code: "quotaLimitReached" } }) : null;
	const r = await runProbe(deps);
	assert.deepEqual(
		{ ok: r.largeFile.ok, status: r.largeFile.status, code: r.largeFile.code },
		{ ok: false, status: 507, code: "quotaLimitReached" },
	);
	assert.ok(r.errors >= 1);
	assert.deepEqual(r.cleanup, { ok: true });
	assert.ok(![...fake.nodes.values()].some((n) => n.name === PROBE_DIR));
});

test("if the approot can't be read, nothing else runs", async () => {
	const { fake, deps } = setup();
	fake.intercept = () => jsonResponse(403, { error: { code: "accessDenied" } });
	const r = await runProbe(deps);
	assert.deepEqual(r.approot, { ok: false, status: 403, code: "accessDenied" });
	assert.equal(r.cleanup.ok, true);
	assert.equal(fake.requests.length, 1);
});

test("a cleanup failure is reported", async () => {
	const { fake, deps } = setup();
	fake.intercept = (req) => {
		if (req.method !== "DELETE") return null;
		const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
		return fake.nodes.get(id)?.name === PROBE_DIR ? jsonResponse(403, { error: { code: "accessDenied" } }) : null;
	};
	const r = await runProbe(deps);
	assert.deepEqual(r.cleanup, { ok: false, status: 403, code: "accessDenied" });
});
