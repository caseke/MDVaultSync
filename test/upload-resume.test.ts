// Upload-session resume (design §6.3, R-RES-2, R-RES-3) [G-UP-9]: a persisted session continues from
// nextExpectedRanges after an interruption; a lost session restarts; a changed file or a raced replace cancels.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RemotePort, VaultPath } from "../src/core/ports.ts";
import { NetworkError } from "../src/remote/errors.ts";
import { quickXorHash } from "../src/core/quickxor.ts";
import { FakeRemote } from "./fakes/fake-remote.ts";
import { Device, UNIT, remoteFiles, vaultFiles } from "./fakes/device.ts";
import { STAMP } from "./fakes/plan-fixtures.ts";
import { withOverrides } from "./fakes/sync-fakes.ts";
import { resumeUploads } from "../src/core/upload-resume.ts";
import { classifyError } from "../src/remote/classify.ts";

function lcg(n: number, seed: number): Uint8Array {
	const b = new Uint8Array(n);
	let x = seed * 2654435761;
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		b[i] = x >>> 24;
	}
	return b;
}

const BIG = 3 * UNIT + 17;

/** A remote whose `failAt`-th fragment PUT (1-based) fails like a dropped network. Counts every fragment. */
function flaky(failAt: number) {
	const stats = { fragments: 0, starts: [] as number[] };
	const wrap = (r: RemotePort) =>
		withOverrides(r, {
			putFragment: (u: string, s: number, t: number, b: ArrayBuffer) => {
				stats.fragments++;
				stats.starts.push(s);
				if (stats.fragments === failAt) return Promise.reject(new NetworkError());
				return r.putFragment(u, s, t, b);
			},
		});
	return { stats, wrap };
}

async function synced(remote: FakeRemote, files: Record<string, string | Uint8Array>, wrap?: (r: RemotePort) => RemotePort) {
	const dev = new Device(remote, wrap ? { remote: wrap } : {});
	for (const [p, c] of Object.entries(files)) dev.vault.write(p, c);
	await dev.sync("startup");
	return dev;
}

test("an upload interrupted mid-fragment resumes from nextExpectedRanges after a restart", async () => {
	const remote = new FakeRemote();
	const f = flaky(2);
	const dev = await synced(remote, { "a.md": "a" }, f.wrap);
	dev.vault.write("big.bin", lcg(BIG, 1));
	const r1 = await dev.sync("interval");
	assert.equal(r1.result, "partial", "a dead network ends the run partial and keeps progress");
	const rec = dev.store.state?.uploadSessions["big.bin" as VaultPath];
	assert.ok(rec, "the session was persisted");
	assert.equal(rec.localHash, quickXorHash(lcg(BIG, 1)));
	assert.equal((await remote.getUploadStatus(rec.uploadUrl)).nextExpectedStart, UNIT);

	f.stats.starts.length = 0;
	dev.restart();
	const r2 = await dev.sync("interval");
	assert.equal(r2.result, "ok");
	assert.deepEqual(f.stats.starts, [UNIT, 2 * UNIT, 3 * UNIT], "only the missing fragments were sent");
	assert.equal(remote.itemAt("big.bin")?.quickXorHash, quickXorHash(lcg(BIG, 1)));
	assert.deepEqual(dev.store.state?.uploadSessions, {});
	assert.ok(dev.store.state?.files["big.bin" as VaultPath]);
	const r3 = await dev.sync("interval");
	assert.equal(r3.counts["upload-new"] + r3.counts.adopt, 0, "nothing uploaded twice");
});

test("a session that is gone (404) restarts the upload from the beginning", async () => {
	const remote = new FakeRemote();
	const f = flaky(2);
	const dev = await synced(remote, { "a.md": "a" }, f.wrap);
	dev.vault.write("big.bin", lcg(BIG, 2));
	await dev.sync("interval");
	const rec = dev.store.state?.uploadSessions["big.bin" as VaultPath];
	assert.ok(rec);
	await remote.cancelUpload(rec.uploadUrl); // expired or dropped by the server
	f.stats.starts.length = 0;
	dev.restart();
	await dev.sync("interval");
	assert.equal(f.stats.starts[0], 0, "started over");
	assert.equal(remote.itemAt("big.bin")?.quickXorHash, quickXorHash(lcg(BIG, 2)));
	assert.deepEqual(dev.store.state?.uploadSessions, {});
});

test("a file edited after the interruption cancels the old session and uploads the new bytes", async () => {
	const remote = new FakeRemote();
	const f = flaky(2);
	const dev = await synced(remote, { "a.md": "a" }, f.wrap);
	dev.vault.write("big.bin", lcg(BIG, 3));
	await dev.sync("interval");
	const old = dev.store.state?.uploadSessions["big.bin" as VaultPath];
	assert.ok(old);
	dev.vault.write("big.bin", lcg(BIG, 4));
	dev.restart();
	await dev.sync("interval");
	assert.equal((await remote.getUploadStatus(old.uploadUrl)).nextExpectedStart, null, "old session cancelled");
	assert.equal(remote.itemAt("big.bin")?.quickXorHash, quickXorHash(lcg(BIG, 4)));
});

test("a replace interrupted mid-upload whose item then changed remotely is cancelled and becomes a conflict", async () => {
	const remote = new FakeRemote();
	const f = flaky(0);
	const dev = await synced(remote, { "big.bin": lcg(BIG, 5) }, f.wrap);
	dev.vault.write("big.bin", lcg(BIG, 6));
	const fail = flaky(2);
	dev.restart({ remote: fail.wrap, putHonorsIfMatch: false });
	await dev.sync("interval");
	const rec = dev.store.state?.uploadSessions["big.bin" as VaultPath];
	assert.ok(rec);
	assert.equal(rec.target.kind, "replace");
	remote.putFile("big.bin", "another device committed");
	dev.restart({ remote: (r) => r });
	await dev.sync("interval");
	assert.equal((await remote.getUploadStatus(rec.uploadUrl)).nextExpectedStart, null, "session cancelled, never committed");
	const copy = `big (conflict iPad ${STAMP}).bin`;
	assert.equal(dev.vault.contentAt("big.bin"), "another device committed");
	assert.equal(remote.itemAt(copy)?.quickXorHash, quickXorHash(lcg(BIG, 6)));
	assert.deepEqual(Object.keys(vaultFiles(dev.vault)).sort(), Object.keys(remoteFiles(remote)).sort());
});

test("after a reset (sign-out, unload) resume touches nothing: no status check, no fragment, record kept (M7 review)", async () => {
	const remote = new FakeRemote();
	const f = flaky(2);
	const dev = await synced(remote, { "a.md": "a" }, f.wrap);
	dev.vault.write("big.bin", lcg(BIG, 1));
	await dev.sync("interval");
	const state = dev.store.state;
	assert.ok(state?.uploadSessions["big.bin" as VaultPath]);
	const sent = f.stats.fragments;
	let calls = 0;
	const watched = withOverrides(remote as RemotePort, {
		getUploadStatus: (u: string) => {
			calls++;
			return remote.getUploadStatus(u);
		},
	});
	await resumeUploads({
		state,
		vault: dev.vault,
		remote: watched,
		content: {} as never, // never reached
		classify: classifyError,
		saver: {} as never,
		transformId: "identity",
		live: () => false,
	});
	assert.equal(calls, 0);
	assert.equal(f.stats.fragments, sent);
	assert.ok(state.uploadSessions["big.bin" as VaultPath], "kept for the next live run");
});
