// RemoteContent (design §2, §6.3, plan M6): the only path content takes between the executor and RemotePort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAGMENT as CORE_FRAGMENT, TransformedRemoteContent } from "../src/core/remote-content.ts";
import { HashMismatch, ReplaceRaced } from "../src/core/failure.ts";
import { IdentityTransform } from "../src/core/transform.ts";
import { quickXorHash } from "../src/core/quickxor.ts";
import type { RemoteItem, RemotePort, UploadSessionRecord, VaultPath } from "../src/core/ports.ts";
import { classifyError } from "../src/remote/classify.ts";
import { FRAGMENT as REMOTE_FRAGMENT } from "../src/remote/upload-session.ts";
import { GraphError } from "../src/remote/errors.ts";
import { APPROOT_ID, FakeRemote } from "./fakes/fake-remote.ts";
import { XorTransform, dec, enc, withOverrides, xor } from "./fakes/sync-fakes.ts";

const P = "note.md" as VaultPath;
const UNIT = 327_680;

/** Wraps a FakeRemote and counts calls per method. */
function spy(remote: FakeRemote, hooks: Partial<Record<keyof RemotePort, (...a: unknown[]) => void>> = {}) {
	const calls: string[] = [];
	const proxy = new Proxy(remote, {
		get(target, prop, recv) {
			const v = Reflect.get(target, prop, recv) as unknown;
			if (typeof v !== "function") return v;
			return (...args: unknown[]) => {
				calls.push(String(prop));
				hooks[prop as keyof RemotePort]?.(...args);
				return (v as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
	return { remote: proxy as RemotePort, calls };
}

function bytesOf(n: number, seed = 7): ArrayBuffer {
	const b = new Uint8Array(n);
	let x = seed * 2654435761;
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		b[i] = x >>> 24;
	}
	return b.buffer;
}

const opts = (extra: Partial<ConstructorParameters<typeof TransformedRemoteContent>[2]> = {}) => ({
	putHonorsIfMatch: true,
	classify: classifyError,
	fragmentSize: UNIT,
	simpleMax: UNIT,
	...extra,
});

test("FRAGMENT in core equals the remote client's 10 MiB fragment (R-RES-2)", () => {
	assert.equal(CORE_FRAGMENT, REMOTE_FRAGMENT);
	assert.equal(CORE_FRAGMENT % UNIT, 0);
});

test("a fragment size that isn't a multiple of 320 KiB is refused", () => {
	assert.throws(() => new TransformedRemoteContent(new FakeRemote(), new IdentityTransform(), opts({ fragmentSize: 1000 })), RangeError);
});

test("fetch: downloads, checks the stored-bytes hash, then decodes (T-T4, R-ENG-4)", async () => {
	const remote = new FakeRemote();
	const item = remote.putFile("note.md", new Uint8Array(xor(enc("hello"))));
	const rc = new TransformedRemoteContent(remote, new XorTransform(), opts());
	const { plain, remoteHash } = await rc.fetch(item, P);
	assert.equal(dec(plain), "hello");
	assert.equal(remoteHash, item.quickXorHash);
});

test("fetch: bytes that don't match the item's hash are discarded with HashMismatch", async () => {
	const remote = new FakeRemote();
	const item = remote.putFile("note.md", "hello");
	const rc = new TransformedRemoteContent(remote, new IdentityTransform(), opts());
	await assert.rejects(rc.fetch({ ...item, quickXorHash: quickXorHash(enc("other")) }, P), HashMismatch);
	await assert.rejects(rc.fetch({ ...item, size: 4 }, P), HashMismatch);
});

test("fetch: a null remote hash checks the size and records the computed hash (§5.4)", async () => {
	const remote = new FakeRemote();
	const item = remote.putFile("empty.md", "");
	assert.equal(item.quickXorHash, null);
	const rc = new TransformedRemoteContent(remote, new IdentityTransform(), opts());
	const { plain, remoteHash } = await rc.fetch(item, P);
	assert.equal(plain.byteLength, 0);
	assert.equal(remoteHash, quickXorHash(new Uint8Array()));
});

test("store new: small files use one PUT with conflictBehavior=fail and store transformed bytes", async () => {
	const fake = new FakeRemote();
	const { remote, calls } = spy(fake);
	const rc = new TransformedRemoteContent(remote, new XorTransform(), opts());
	const { item, remoteHash } = await rc.store({ kind: "new", parentId: APPROOT_ID, name: "note.md" }, null, enc("hi"), P);
	assert.deepEqual(calls, ["uploadNew"]);
	assert.equal(fake.contentAt("note.md"), dec(xor(enc("hi"))));
	assert.equal(remoteHash, item.quickXorHash);
	assert.equal(remoteHash, await rc.storedHashOf(enc("hi"), P));
});

test("store new: a name clash surfaces as 409 (never an overwrite)", async () => {
	const remote = new FakeRemote();
	remote.putFile("Note.md", "theirs");
	const rc = new TransformedRemoteContent(remote, new IdentityTransform(), opts());
	await assert.rejects(rc.store({ kind: "new", parentId: APPROOT_ID, name: "note.md" }, null, enc("mine"), P), (e) => classifyError(e).kind === "name-exists");
	assert.equal(remote.contentAt("Note.md"), "theirs");
});

test("store new: files over the simple-upload size use a session; onSession runs before the first fragment", async () => {
	const fake = new FakeRemote();
	const { remote, calls } = spy(fake);
	const rc = new TransformedRemoteContent(remote, new IdentityTransform(), opts());
	const data = bytesOf(2 * UNIT + 5);
	let seen = -1;
	const { item } = await rc.store({ kind: "new", parentId: APPROOT_ID, name: "big.bin" }, null, data, P, (s) => {
		seen = calls.filter((c) => c === "putFragment").length;
		assert.match(s.uploadUrl, /^https:/);
		return Promise.resolve();
	});
	assert.equal(seen, 0);
	assert.deepEqual(calls.filter((c) => c === "putFragment").length, 3);
	assert.equal(item.size, data.byteLength);
	assert.equal(item.quickXorHash, quickXorHash(data));
});

test("store replace: PUT with If-Match when the probe confirmed it (D-11); a stale eTag is still 412", async () => {
	const fake = new FakeRemote();
	const it = fake.putFile("note.md", "v1");
	const { remote, calls } = spy(fake);
	const rc = new TransformedRemoteContent(remote, new IdentityTransform(), opts());
	const { item } = await rc.store({ kind: "replace", id: it.id }, it.eTag, enc("v2"), P);
	assert.deepEqual(calls, ["uploadReplace"]);
	assert.equal(fake.contentAt("note.md"), "v2");
	await assert.rejects(rc.store({ kind: "replace", id: it.id }, it.eTag, enc("v3"), P), (e) => classifyError(e).kind === "precondition");
	assert.notEqual(item.eTag, it.eTag);
	assert.equal(fake.contentAt("note.md"), "v2");
});

test("store replace: without PUT If-Match support it uses a session created with If-Match; stale is 412", async () => {
	const fake = new FakeRemote();
	const it = fake.putFile("note.md", "v1");
	const { remote, calls } = spy(fake);
	const rc = new TransformedRemoteContent(remote, new IdentityTransform(), opts({ putHonorsIfMatch: false }));
	await rc.store({ kind: "replace", id: it.id }, it.eTag, enc("v2"), P);
	assert.ok(calls.includes("createUploadSession"));
	assert.ok(!calls.includes("uploadReplace"));
	await assert.rejects(rc.store({ kind: "replace", id: it.id }, it.eTag, enc("v3"), P), (e) => classifyError(e).kind === "precondition");
	assert.equal(fake.contentAt("note.md"), "v2");
});

test("store replace: a replace without If-Match is refused (R-CC-1)", async () => {
	const fake = new FakeRemote();
	const it = fake.putFile("note.md", "v1");
	const rc = new TransformedRemoteContent(fake, new IdentityTransform(), opts());
	await assert.rejects(rc.store({ kind: "replace", id: it.id }, null, enc("v2"), P), RangeError);
});

test("replace session race: the item changes mid-upload → cancelled before the final fragment (§6.3)", async () => {
	const fake = new FakeRemote();
	const it = fake.putFile("big.bin", new Uint8Array(bytesOf(3 * UNIT)));
	let fragments = 0;
	let url = "";
	const { remote } = spy(fake, {
		putFragment: (u) => {
			url = u as string;
			fragments++;
			if (fragments === 1) fake.putFile("big.bin", "another device committed");
		},
	});
	const rc = new TransformedRemoteContent(remote, new IdentityTransform(), opts());
	await assert.rejects(rc.store({ kind: "replace", id: it.id }, it.eTag, bytesOf(3 * UNIT, 9), P), ReplaceRaced);
	assert.equal(fragments, 2, "the final fragment was never sent");
	assert.equal((await fake.getUploadStatus(url)).nextExpectedStart, null, "session cancelled");
	assert.equal(fake.contentAt("big.bin"), "another device committed");
});

test("store: a returned hash that differs from the stored bytes is HashMismatch", async () => {
	const fake = new FakeRemote();
	const wrong: RemotePort = withOverrides(fake, {
		uploadNew: async (p: string, n: string, d: ArrayBuffer): Promise<RemoteItem> => ({ ...(await fake.uploadNew(p, n, d)), quickXorHash: quickXorHash(enc("x")) }),
	});
	const rc = new TransformedRemoteContent(wrong, new IdentityTransform(), opts());
	await assert.rejects(rc.store({ kind: "new", parentId: APPROOT_ID, name: "a.md" }, null, enc("a"), P), HashMismatch);
});

test("store: zero-byte files use PUT (a session can't send an empty fragment)", async () => {
	const fake = new FakeRemote();
	const { remote, calls } = spy(fake);
	const rc = new TransformedRemoteContent(remote, new IdentityTransform(), opts({ simpleMax: 0 }));
	await rc.store({ kind: "new", parentId: APPROOT_ID, name: "e.md" }, null, new ArrayBuffer(0), P);
	assert.deepEqual(calls, ["uploadNew"]);
});

function sessionRecord(url: string, target: UploadSessionRecord["target"], data: ArrayBuffer, ifMatch: string | null): UploadSessionRecord {
	return { path: P, uploadUrl: url, expiresAt: "2099-01-01T00:00:00Z", totalSize: data.byteLength, localHash: quickXorHash(data), ifMatch, target };
}

test("resume: continues from nextExpectedRanges after an interruption mid-upload (R-RES-2)", async () => {
	const fake = new FakeRemote();
	const data = bytesOf(3 * UNIT + 11);
	const target = { kind: "new" as const, parentId: APPROOT_ID, name: "big.bin" };
	const info = await fake.createUploadSession(target, null, data.byteLength);
	await fake.putFragment(info.uploadUrl, 0, data.byteLength, data.slice(0, UNIT));
	const { remote, calls } = spy(fake);
	const rc = new TransformedRemoteContent(remote, new IdentityTransform(), opts());
	const res = await rc.resume(sessionRecord(info.uploadUrl, target, data, null), data);
	assert.ok(res);
	assert.equal(calls.filter((c) => c === "putFragment").length, 3);
	assert.equal(res.item.quickXorHash, quickXorHash(data));
});

test("resume: a session that is gone (404) returns null so the upload starts over [G-UP-9]", async () => {
	const fake = new FakeRemote();
	const data = bytesOf(2 * UNIT);
	const target = { kind: "new" as const, parentId: APPROOT_ID, name: "big.bin" };
	const info = await fake.createUploadSession(target, null, data.byteLength);
	await fake.cancelUpload(info.uploadUrl);
	const rc = new TransformedRemoteContent(fake, new IdentityTransform(), opts());
	assert.equal(await rc.resume(sessionRecord(info.uploadUrl, target, data, null), data), null);
});

test("resume of a replace session re-checks the eTag before the final fragment", async () => {
	const fake = new FakeRemote();
	const it = fake.putFile("big.bin", "old");
	const data = bytesOf(2 * UNIT);
	const info = await fake.createUploadSession({ kind: "replace", id: it.id }, it.eTag, data.byteLength);
	await fake.putFragment(info.uploadUrl, 0, data.byteLength, data.slice(0, UNIT));
	fake.touchMetadata("big.bin");
	const rc = new TransformedRemoteContent(fake, new IdentityTransform(), opts());
	await assert.rejects(rc.resume(sessionRecord(info.uploadUrl, { kind: "replace", id: it.id }, data, it.eTag), data), ReplaceRaced);
	assert.equal(fake.contentAt("big.bin"), "old");
});

test("a 416 on a fragment reads the status and continues from the server's next byte", async () => {
	const fake = new FakeRemote();
	const data = bytesOf(3 * UNIT);
	let thrown = false;
	const flaky: RemotePort = withOverrides(fake, {
		putFragment: async (u: string, start: number, total: number, b: ArrayBuffer) => {
			if (start === UNIT && !thrown) {
				// The server already took this fragment, but the answer was lost.
				thrown = true;
				await fake.putFragment(u, start, total, b);
				throw new GraphError(416, "invalidRange");
			}
			return fake.putFragment(u, start, total, b);
		},
	});
	const rc = new TransformedRemoteContent(flaky, new IdentityTransform(), opts());
	const { item } = await rc.store({ kind: "new", parentId: APPROOT_ID, name: "big.bin" }, null, data, P);
	assert.ok(thrown);
	assert.equal(item.quickXorHash, quickXorHash(data));
});
