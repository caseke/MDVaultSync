// ObsidianVault (plan M6): VaultPort over Obsidian's Vault, adapter and FileManager, through structural types so
// it runs without Obsidian. Atomic writes (R-IO-1), the containment re-check (T-T1), trash (R-DEL-1, O-API-7),
// Vault.rename (O-API-8) and the rename-overwrite fallback (O-API-10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ObsidianVault } from "../src/platform/obsidian-vault.ts";
import { replaceInto, TargetRemoved } from "../src/platform/atomic.ts";
import { UnsafePath } from "../src/core/failure.ts";
import type { VaultPath } from "../src/core/ports.ts";
import { FakeObsidian, normalizePath } from "./fakes/fake-obsidian.ts";

const vp = (s: string) => s as VaultPath;
const enc = (s: string) => new TextEncoder().encode(s).buffer;

function setup(patterns: string[] = []) {
	const o = new FakeObsidian();
	let n = 0;
	const v = new ObsidianVault({
		vault: o.vault,
		fileManager: o.fileManager,
		normalizePath,
		excludePatterns: () => patterns,
		pathPrefixLen: () => 16,
		randomHex: () => `r${n++}`,
	});
	return { o, v };
}

test("list: files and folders the Vault API sees, minus configDir, hidden paths and exclude patterns (R-SCOPE-2)", async () => {
	const { o, v } = setup(["private/"]);
	o.put("a.md", new Uint8Array([1]));
	o.put("dir/b.md", new Uint8Array([1, 2]));
	o.put("obs-config/plugins/x/data.json", new Uint8Array());
	o.put(".trash/old.md", new Uint8Array());
	o.put("private/s.md", new Uint8Array());
	const list = await v.list();
	assert.deepEqual(
		list.map((e) => `${e.isFolder ? "d" : "f"} ${e.path} ${e.size}`).sort(),
		["d dir 0", "f a.md 1", "f dir/b.md 2"],
	);
});

test("writeAtomic: writes a hidden temp sibling, then renames it into place (R-IO-1)", async () => {
	const { o, v } = setup();
	await v.writeAtomic(vp("dir/new.md"), enc("hello"));
	assert.equal(o.text("dir/new.md"), "hello");
	assert.deepEqual(
		o.calls.filter((c) => !c.startsWith("createFolder")),
		["writeBinary dir/.mdvaultsync-tmp-r0", "rename dir/.mdvaultsync-tmp-r0 -> dir/new.md"],
	);
	assert.ok(![...o.entries.keys()].some((p) => p.includes("mdvaultsync-tmp")));
});

test("writeAtomic over an existing file: rename replaces it where the platform allows", async () => {
	const { o, v } = setup();
	o.put("a.md", new Uint8Array([1]));
	await v.writeAtomic(vp("a.md"), enc("new"));
	assert.equal(o.text("a.md"), "new");
	assert.ok(!o.calls.includes("remove a.md"));
});

test("writeAtomic over an existing file: if rename refuses, remove then rename (O-API-10 fallback)", async () => {
	for (const mode of [false, "keep"] as const) {
		const { o, v } = setup();
		o.renameOverwrites = mode;
		o.put("a.md", new Uint8Array([1]));
		await v.writeAtomic(vp("a.md"), enc("new"));
		assert.equal(o.text("a.md"), "new", String(mode));
		assert.ok(![...o.entries.keys()].some((p) => p.includes("mdvaultsync-tmp")), `temp cleaned (${String(mode)})`);
	}
});

test("writeAtomic: the temp file is removed when the rename fails", async () => {
	const { o, v } = setup();
	o.adapter.rename = () => Promise.reject(new Error("EIO"));
	await assert.rejects(v.writeAtomic(vp("a.md"), enc("x")));
	assert.equal([...o.entries.keys()].filter((p) => p.includes("mdvaultsync-tmp")).length, 0);
	assert.equal(o.text("a.md"), null);
});

test("writeAtomic re-checks containment and names right before the write (T-T1)", async () => {
	const { o, v } = setup();
	for (const p of ["obs-config/plugins/x/main.js", "Obs-Config/x.js", ".hidden/a.md", "../a.md", "/abs.md", "a/../b.md", "con.md", "a b.md", "OBSIDIAN/../x"]) {
		await assert.rejects(v.writeAtomic(vp(p), enc("x")), UnsafePath, p);
	}
	assert.equal(o.entries.size, 0);
});

test("move uses Vault.rename and creates the parent; trash uses FileManager.trashFile (O-API-7, O-API-8)", async () => {
	const { o, v } = setup();
	o.put("a.md", new Uint8Array([1]));
	await v.move(vp("a.md"), vp("new/dir/b.md"));
	assert.ok(o.calls.includes("vault.rename a.md -> new/dir/b.md"));
	assert.equal(o.text("new/dir/b.md"), "\u0001");
	await v.trash(vp("new/dir/b.md"));
	assert.deepEqual(o.trashed, ["new/dir/b.md"]);
	await assert.rejects(v.move(vp("missing.md"), vp("x.md")));
	o.put("x.md", new Uint8Array([2]));
	await assert.rejects(v.move(vp("x.md"), vp("obs-config/x.md")), UnsafePath);
	assert.equal(o.text("x.md"), "\u0002");
});

test("removeEmptyFolder trashes only an empty folder", async () => {
	const { o, v } = setup();
	o.put("full/a.md", new Uint8Array());
	o.folderSet.add("empty");
	assert.equal(await v.removeEmptyFolder(vp("full")), false);
	assert.equal(await v.removeEmptyFolder(vp("empty")), true);
	assert.deepEqual(o.trashed, ["empty"]);
});

test("stat and read resolve a name stored in another Unicode form (NFD on ext4) by its NFC path", async () => {
	const { o, v } = setup();
	const nfd = "café.md";
	o.put(nfd, new Uint8Array([7]));
	const nfcPath = vp(nfd.normalize("NFC"));
	assert.deepEqual(await v.stat(nfcPath), { path: nfcPath, size: 1, mtime: o.entries.get(nfd)?.mtime, isFolder: false });
	assert.deepEqual([...new Uint8Array(await v.read(nfcPath))], [7]);
	await v.writeAtomic(nfcPath, enc("z"));
	assert.equal(o.text(nfd), "z", "the existing file is replaced, not duplicated");
	assert.equal(await v.stat(vp("nope.md")), null);
});

test("replaceInto: never leaves the temp file when the fallback runs", async () => {
	const o = new FakeObsidian();
	o.renameOverwrites = false;
	o.put("t", new Uint8Array([1]));
	o.put("x", new Uint8Array([2]));
	await replaceInto(o.adapter, "t", "x");
	assert.equal(o.text("x"), "\u0001");
	assert.equal(o.text("t"), null);
});

test("fallback: if the retried rename fails after the target was removed, the temp file is kept (it holds the only copy)", async () => {
	const { o, v } = setup();
	o.renameOverwrites = false;
	o.put("a.md", new Uint8Array([1]));
	let renames = 0;
	const rename = o.adapter.rename;
	o.adapter.rename = (a: string, b: string) => (++renames === 2 ? Promise.reject(new Error("EIO")) : rename(a, b));
	await assert.rejects(v.writeAtomic(vp("a.md"), enc("new")), TargetRemoved);
	const temps = [...o.entries.keys()].filter((p) => p.includes("mdvaultsync-tmp"));
	assert.equal(temps.length, 1);
	assert.equal(o.text(temps[0] ?? ""), "new");
});

test("replaceInto: a rename failure with no existing target is not a refusal: nothing is removed", async () => {
	const o = new FakeObsidian();
	o.put("t", new Uint8Array([1]));
	o.adapter.rename = () => Promise.reject(new Error("EIO"));
	await assert.rejects(replaceInto(o.adapter, "t", "x"), /EIO/);
	assert.ok(!o.calls.some((c) => c.startsWith("remove")));
	assert.equal(o.text("t"), "\u0001");
});

test("trash and removeEmptyFolder re-check containment too (T-T1)", async () => {
	const { o, v } = setup();
	o.put("obs-config/x.md", new Uint8Array());
	await assert.rejects(v.trash(vp("obs-config/x.md")), UnsafePath);
	await assert.rejects(v.removeEmptyFolder(vp("obs-config")), UnsafePath);
	assert.deepEqual(o.trashed, []);
});
