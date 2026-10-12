// The fakes must behave like OneDrive and the vault, or tests built on them prove nothing (plan M5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROOT_ID, FakeRemote, PATH_PREFIX } from "./fakes/fake-remote.ts";
import { FakeVault } from "./fakes/fake-vault.ts";
import { GraphError } from "../src/remote/errors.ts";
import { quickXorHash } from "../src/core/quickxor.ts";
import type { RemoteItem, VaultPath } from "../src/core/ports.ts";
import { CFG } from "./fakes/plan-fixtures.ts";

const enc = (s: string) => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);
const vp = (s: string) => s as VaultPath;

async function rejectsWith(p: Promise<unknown>, status: number, code?: string): Promise<void> {
	await assert.rejects(p, (e: unknown) => e instanceof GraphError && e.status === status && (code === undefined || e.code === code));
}

test("approot and path prefix", async () => {
	const r = new FakeRemote();
	const root = await r.getAppRoot();
	assert.equal(root.item.id, APPROOT_ID);
	assert.equal(root.pathPrefix, PATH_PREFIX);
});

test("names are unique per folder, compared case-insensitively: 409 nameAlreadyExists", async () => {
	const r = new FakeRemote();
	await r.uploadNew(APPROOT_ID, "Note.md", enc("a"));
	await rejectsWith(r.uploadNew(APPROOT_ID, "note.md", enc("b")), 409, "nameAlreadyExists");
	await rejectsWith(r.createFolder(APPROOT_ID, "NOTE.md"), 409, "nameAlreadyExists");
	const other = await r.uploadNew(APPROOT_ID, "other.md", enc("c"));
	await rejectsWith(r.move(other.id, other.eTag, APPROOT_ID, "NOTE.MD"), 409, "nameAlreadyExists");
	assert.equal((await r.getChildByName(APPROOT_ID, "NOTE.MD"))?.name, "Note.md");
	assert.equal(await r.getChildByName(APPROOT_ID, "missing"), null);
});

test("eTag changes on every change; cTag only on content changes", async () => {
	const r = new FakeRemote();
	const a = await r.uploadNew(APPROOT_ID, "a.md", enc("1"));
	const moved = await r.move(a.id, a.eTag, APPROOT_ID, "b.md");
	assert.notEqual(moved.eTag, a.eTag);
	assert.equal(moved.cTag, a.cTag);
	assert.equal(moved.quickXorHash, a.quickXorHash);
	const edited = await r.uploadReplace(a.id, moved.eTag, enc("2"));
	assert.notEqual(edited.eTag, moved.eTag);
	assert.notEqual(edited.cTag, moved.cTag);
	assert.equal(edited.quickXorHash, quickXorHash(enc("2")));
	const meta = r.touchMetadata("b.md");
	assert.notEqual(meta.eTag, edited.eTag);
	assert.equal(meta.cTag, edited.cTag);
});

test("a stale If-Match is 412 on replace, move, delete and replace sessions", async () => {
	const r = new FakeRemote();
	const a = await r.uploadNew(APPROOT_ID, "a.md", enc("1"));
	await r.uploadReplace(a.id, a.eTag, enc("2"));
	await rejectsWith(r.uploadReplace(a.id, a.eTag, enc("3")), 412);
	await rejectsWith(r.move(a.id, a.eTag, APPROOT_ID, "x.md"), 412);
	await rejectsWith(r.delete(a.id, a.eTag), 412);
	await rejectsWith(r.createUploadSession({ kind: "replace", id: a.id }, a.eTag, 1), 412);
	await rejectsWith(r.createUploadSession({ kind: "replace", id: a.id }, null, 1), 400);
	await rejectsWith(r.getItem("nope").then((x) => r.download(x?.id ?? "nope")), 404);
});

test("delete moves the item, recursively for folders, to the recycle bin; delta reports it deleted", async () => {
	const r = new FakeRemote();
	r.putFile("D/a.md", "A");
	r.putFile("D/sub/b.md", "B");
	const start = await r.delta(null);
	const link = start.deltaLink ?? "";
	const d = r.itemAt("D") as RemoteItem;
	await r.delete(d.id, d.eTag);
	assert.equal(r.itemAt("D/a.md"), null);
	assert.deepEqual(r.recycleBin.map((i) => i.name).sort(), ["D", "a.md", "b.md", "sub"]);
	const page = await r.delta(link);
	assert.equal(page.items.length, 4);
	assert.ok(page.items.every((i) => i.deleted && i.name === "" && i.cTag === null));
	await rejectsWith(r.delete(APPROOT_ID, (await r.getAppRoot()).item.eTag), 403);
});

test("delta pages to a deltaLink, then returns only changes, with an item changed twice appearing twice", async () => {
	const r = new FakeRemote({ pageSize: 2 });
	r.putFile("a.md", "1");
	r.putFile("b.md", "1");
	r.putFile("c.md", "1");
	const pages: RemoteItem[][] = [];
	let link: string | null = null;
	for (;;) {
		const p = await r.delta(link);
		pages.push(p.items);
		if (p.deltaLink) {
			link = p.deltaLink;
			break;
		}
		link = p.nextLink ?? null;
	}
	assert.deepEqual(pages.map((p) => p.length), [2, 2]);
	assert.deepEqual(pages.flat().map((i) => i.name), ["MDVaultSync", "a.md", "b.md", "c.md"]);
	r.putFile("a.md", "2");
	r.putFile("a.md", "3");
	const next = await r.delta(link);
	assert.deepEqual(next.items.map((i) => i.name), ["a.md", "a.md"]);
	assert.equal(next.items[1]?.quickXorHash, quickXorHash(enc("3")));
	await rejectsWith(r.delta("https://evil.example/"), 400);
});

test("zero-byte files report no hash [G-DL-8], unless configured otherwise", () => {
	assert.equal(new FakeRemote().putFile("e.md", "").quickXorHash, null);
	assert.equal(new FakeRemote({ nullHashForEmpty: false }).putFile("e.md", "").quickXorHash, quickXorHash(new ArrayBuffer(0)));
});

test("listing, items, download and quota", async () => {
	const r = new FakeRemote();
	const f = r.putFile("D/a.md", "hello", "fixed-id");
	assert.equal(f.id, "fixed-id");
	const d = r.mkdir("D");
	assert.deepEqual((await r.listChildren(d.id)).map((i) => i.name), ["a.md"]);
	assert.equal(dec(await r.download(f.id)), "hello");
	assert.equal(r.contentAt("D/a.md"), "hello");
	assert.equal(r.contentAt("D"), null);
	await rejectsWith(r.download(d.id), 400);
	assert.equal((await r.getItem(f.id))?.parentId, d.id);
	assert.ok((await r.quota())?.total);
	assert.equal(Object.keys(r.index()).length, 3);
	r.rename("D/a.md", "E/b.md");
	assert.equal(r.contentAt("E/b.md"), "hello");
	r.remove("E");
	assert.equal(r.itemAt("E"), null);
	await rejectsWith(r.uploadNew(f.id, "x", enc("x")), 404);
});

test("upload sessions: fragments in order, 416 on a wrong offset, status, cancel, commit", async () => {
	const r = new FakeRemote();
	const s = await r.createUploadSession({ kind: "new", parentId: APPROOT_ID, name: "big.bin" }, null, 4);
	await rejectsWith(r.putFragment(s.uploadUrl, 2, 4, enc("cd")), 416);
	assert.equal(await r.putFragment(s.uploadUrl, 0, 4, enc("ab")), null);
	assert.equal((await r.getUploadStatus(s.uploadUrl)).nextExpectedStart, 2);
	const item = await r.putFragment(s.uploadUrl, 2, 4, enc("cd"));
	assert.equal(item?.name, "big.bin");
	assert.equal(r.contentAt("big.bin"), "abcd");
	assert.equal((await r.getUploadStatus(s.uploadUrl)).nextExpectedStart, null);
	await rejectsWith(r.putFragment(s.uploadUrl, 0, 4, enc("ab")), 404);

	const big = r.itemAt("big.bin") as RemoteItem;
	const rep = await r.createUploadSession({ kind: "replace", id: big.id }, big.eTag, 2);
	// Graph checks If-Match only at creation [G-UP-5]: a change in between doesn't stop the commit.
	r.touchMetadata("big.bin");
	assert.equal((await r.putFragment(rep.uploadUrl, 0, 2, enc("zz")))?.id, big.id);
	assert.equal(r.contentAt("big.bin"), "zz");

	await rejectsWith(r.createUploadSession({ kind: "new", parentId: APPROOT_ID, name: "BIG.bin" }, null, 1), 409);
	const late = await r.createUploadSession({ kind: "new", parentId: APPROOT_ID, name: "late.bin" }, null, 1);
	r.putFile("LATE.bin", "x");
	await rejectsWith(r.putFragment(late.uploadUrl, 0, 1, enc("y")), 409);
	const c = await r.createUploadSession({ kind: "new", parentId: APPROOT_ID, name: "c.bin" }, null, 1);
	await r.cancelUpload(c.uploadUrl);
	assert.equal((await r.getUploadStatus(c.uploadUrl)).nextExpectedStart, null);
});

test("FakeVault: list hides configDir, hidden and excluded paths; folders are implied", async () => {
	const v = new FakeVault({ configDir: CFG, patterns: ["tmp/"] });
	v.write("a/b.md", "x");
	v.write(`${CFG}/plugins/p/main.js`, "x");
	v.write(".git/HEAD", "x");
	v.write("tmp/t.md", "x");
	v.folders.add("empty");
	assert.deepEqual((await v.list()).map((e) => `${e.path}${e.isFolder ? "/" : ""}`), ["a/", "a/b.md", "empty/"]);
	const scan = await v.scan();
	assert.equal(scan.find((e) => e.path === "a/b.md")?.localHash, quickXorHash(enc("x")));
	assert.equal(scan.find((e) => e.path === "a")?.localHash, null);
});

test("FakeVault: VaultPort operations", async () => {
	const v = new FakeVault({ configDir: CFG });
	await v.writeAtomic(vp("d/a.md"), enc("1"));
	assert.equal((await v.stat(vp("d/a.md")))?.size, 1);
	assert.equal((await v.stat(vp("d")))?.isFolder, true);
	assert.equal(await v.stat(vp("none")), null);
	assert.equal(dec(await v.read(vp("d/a.md"))), "1");
	await assert.rejects(v.read(vp("none")));
	await v.move(vp("d"), vp("e"));
	assert.equal(v.contentAt("e/a.md"), "1");
	assert.equal(await v.removeEmptyFolder(vp("e")), false);
	await v.trash(vp("e/a.md"));
	assert.deepEqual(v.trashed, ["e/a.md"]);
	await assert.rejects(v.trash(vp("e/a.md")));
	await v.mkdirp(vp("e"));
	assert.equal(await v.removeEmptyFolder(vp("e")), true);
	v.write("x.md", "x");
	v.remove("x.md");
	assert.equal(v.contentAt("x.md"), null);
});
