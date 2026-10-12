// Planner (design §5.4, plan M5). One named test per row of the three-way table, then renames, folders, union
// mode, the delete guard, null hashes, every skip reason and the M3/M4 carry-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exceedsDeleteGuard, plan } from "../src/core/planner.ts";
import { applyAppRoot, emptyState } from "../src/core/state.ts";
import type { FileRecord, PlanOp, RemoteItem, SyncState } from "../src/core/ports.ts";
import { APPROOT_ID, FakeRemote } from "./fakes/fake-remote.ts";
import { CFG, SETTINGS, STAMP, baseline, hashOf, lines, run, vp, world } from "./fakes/plan-fixtures.ts";

const NFC_E = "é";
const NFD_E = "é";

function opOf<K extends PlanOp["kind"]>(ops: PlanOp[], kind: K): Extract<PlanOp, { kind: K }> {
	const op = ops.find((o) => o.kind === kind);
	assert.ok(op, `no ${kind} op`);
	return op as Extract<PlanOp, { kind: K }>;
}

function noDeletes(ops: PlanOp[]): void {
	assert.deepEqual(
		ops.filter((o) => o.kind === "remote-delete" || o.kind === "local-trash"),
		[],
	);
}

function item(id: string, parentId: string, name: string, extra: Partial<RemoteItem> = {}): RemoteItem {
	const hash = extra.quickXorHash === undefined ? hashOf(id) : extra.quickXorHash;
	return {
		id,
		parentId,
		name,
		isFolder: false,
		eTag: `"${id},1"`,
		cTag: `"c:${id},1"`,
		size: 5,
		quickXorHash: hash,
		lastModified: "",
		deleted: false,
		...extra,
	};
}

function rootIndex(...items: RemoteItem[]): Record<string, RemoteItem> {
	const out: Record<string, RemoteItem> = { [APPROOT_ID]: item(APPROOT_ID, "", "MDVaultSync", { parentId: null, isFolder: true, cTag: null, quickXorHash: null }) };
	for (const it of items) out[it.id] = it;
	return out;
}

function syncedState(): SyncState {
	const s = emptyState("device-1");
	s.appRootId = APPROOT_ID;
	s.unionPending = false;
	s.firstSyncCompleted = true;
	return s;
}

// ---------- design §5.4 table, one test per row ----------
test("row – ✓ –: a new local file is uploaded", async () => {
	const w = world();
	w.vault.write("n.md", "x");
	assert.deepEqual(lines(await run(w)), ["upload-new n.md"]);
});

test("row – – ✓: a new remote file is downloaded", async () => {
	const w = world();
	w.remote.putFile("n.md", "x");
	assert.deepEqual(lines(await run(w)), ["download n.md"]);
});

test("row – ✓ ✓, same content: adopt, no copy (R-CONF-3)", async () => {
	const w = world();
	w.vault.write("n.md", "x");
	w.remote.putFile("n.md", "x");
	const p = await run(w);
	assert.deepEqual(lines(p), ["adopt n.md"]);
	assert.equal(p.differsNoHistory, 0);
});

test("row – ✓ ✓, different content: conflict, remote keeps the name (D-9)", async () => {
	const w = world();
	w.vault.write("n.md", "x");
	w.remote.putFile("n.md", "y");
	const p = await run(w);
	assert.deepEqual(lines(p), [`conflict n.md => n (conflict iPad ${STAMP}).md`]);
	assert.equal(opOf(p.ops, "conflict").id, w.remote.itemAt("n.md")?.id);
	assert.equal(p.differsNoHistory, 1);
});

test("row ✓ same same: nothing to do", async () => {
	const p = await run(world({ "a.md": "A" }));
	assert.deepEqual(lines(p), []);
	assert.equal(p.trackedCount, 1);
	assert.equal(p.unionMode, false);
});

test("row ✓ changed same: upload-replace with If-Match on the base eTag", async () => {
	const w = world({ "a.md": "A" });
	w.vault.write("a.md", "A2");
	const p = await run(w);
	assert.deepEqual(lines(p), ["upload-replace a.md"]);
	const op = opOf(p.ops, "upload-replace");
	assert.equal(op.id, w.state.files[vp("a.md")]?.remoteId);
	assert.equal(op.ifMatch, w.state.files[vp("a.md")]?.eTag);
});

test("row ✓ same changed: download", async () => {
	const w = world({ "a.md": "A" });
	w.remote.putFile("a.md", "A2");
	assert.deepEqual(lines(await run(w)), ["download a.md"]);
});

test("row ✓ changed changed, same content: adopt", async () => {
	const w = world({ "a.md": "A" });
	w.vault.write("a.md", "A2");
	w.remote.putFile("a.md", "A2");
	assert.deepEqual(lines(await run(w)), ["adopt a.md"]);
});

test("row ✓ changed changed, different content: conflict (not counted as no-history)", async () => {
	const w = world({ "a.md": "A" });
	w.vault.write("a.md", "local");
	w.remote.putFile("a.md", "remote");
	const p = await run(w);
	assert.deepEqual(lines(p), [`conflict a.md => a (conflict iPad ${STAMP}).md`]);
	assert.equal(p.differsNoHistory, 0);
});

test("row ✓ deleted same: remote-delete with If-Match; union mode restores instead", async () => {
	const w = world({ "a.md": "A" });
	w.vault.remove("a.md");
	const p = await run(w);
	assert.deepEqual(lines(p), ["remote-delete a.md"]);
	const op = opOf(p.ops, "remote-delete");
	assert.equal(op.ifMatch, w.state.files[vp("a.md")]?.eTag);
	assert.equal(p.deleteCount, 1);
	w.state.unionPending = true;
	const u = await run(w);
	assert.deepEqual(lines(u), ["download a.md"]);
	assert.equal(u.deleteCount, 0);
});

test("row ✓ deleted changed: download (remote edit beats local delete, R-DEL-2)", async () => {
	const w = world({ "a.md": "A" });
	w.vault.remove("a.md");
	w.remote.putFile("a.md", "A2");
	assert.deepEqual(lines(await run(w)), ["download a.md"]);
});

test("row ✓ same deleted: local-trash; union mode restores instead", async () => {
	const w = world({ "a.md": "A" });
	w.remote.remove("a.md");
	const p = await run(w);
	assert.deepEqual(lines(p), ["local-trash a.md"]);
	assert.equal(p.deleteCount, 1);
	w.state.unionPending = true;
	assert.deepEqual(lines(await run(w)), ["upload-new a.md"]);
});

test("row ✓ changed deleted: upload-new (local edit beats remote delete, R-DEL-2)", async () => {
	const w = world({ "a.md": "A" });
	w.remote.remove("a.md");
	w.vault.write("a.md", "A2");
	assert.deepEqual(lines(await run(w)), ["upload-new a.md"]);
});

test("row ✓ deleted deleted: forget", async () => {
	const w = world({ "a.md": "A" });
	w.remote.remove("a.md");
	w.vault.remove("a.md");
	const p = await run(w);
	assert.deepEqual(lines(p), ["forget a.md"]);
	assert.equal(p.deleteCount, 0);
});

test("a different item at the base's path counts as a remote change: same bytes adopt, a local delete restores", async () => {
	const w = world({ "a.md": "A" });
	w.remote.remove("a.md");
	w.remote.putFile("a.md", "A"); // new id, same bytes
	assert.deepEqual(lines(await run(w)), ["adopt a.md"]);
	w.vault.remove("a.md");
	assert.deepEqual(lines(await run(w)), ["download a.md"]);
	w.vault.write("a.md", "A2");
	assert.match(lines(await run(w))[0] ?? "", /^conflict a\.md/);
});

// ---------- renames and moves (design §5.4) ----------
test("remote rename: local-move, no transfer (R-MOVE-1)", async () => {
	const w = world({ "a.md": "A" });
	w.remote.rename("a.md", "b.md");
	assert.deepEqual(lines(await run(w)), ["local-move a.md -> b.md"]);
});

test("remote rename plus remote edit: local-move, then download at the new path", async () => {
	const w = world({ "a.md": "A" });
	w.remote.rename("a.md", "b.md");
	w.remote.putFile("b.md", "B");
	assert.deepEqual(lines(await run(w)), ["local-move a.md -> b.md", "download b.md"]);
});

test("remote rename plus local edit: local-move, then upload-replace at the new path", async () => {
	const w = world({ "a.md": "A" });
	w.remote.rename("a.md", "b.md");
	w.vault.write("a.md", "A2");
	assert.deepEqual(lines(await run(w)), ["local-move a.md -> b.md", "upload-replace b.md"]);
});

test("remote rename onto a path taken by a new local file: no move, both files kept", async () => {
	const w = world({ "a.md": "A" });
	w.remote.rename("a.md", "b.md");
	w.vault.write("b.md", "other");
	const ops = lines(await run(w));
	assert.ok(!ops.some((l) => l.startsWith("local-move")), ops.join("\n"));
	assert.ok(ops.includes(`conflict b.md => b (conflict iPad ${STAMP}).md`), ops.join("\n"));
});

test("remote rename of a file deleted locally restores it at the new path", async () => {
	const w = world({ "a.md": "A" });
	w.remote.rename("a.md", "b.md");
	w.vault.remove("a.md");
	assert.deepEqual(lines(await run(w)), ["download b.md"]);
});

test("local rename from a vault event: remote-move by id with If-Match (R-MOVE-1)", async () => {
	const w = world({ "a.md": "A" });
	w.vault.rename("a.md", "b.md");
	w.state.pendingLocal = [{ kind: "renamed", from: vp("a.md"), to: vp("b.md") }];
	const p = await run(w);
	assert.deepEqual(lines(p), ["remote-move a.md -> b.md"]);
	const op = opOf(p.ops, "remote-move");
	assert.equal(op.id, w.state.files[vp("a.md")]?.remoteId);
	assert.equal(op.ifMatch, w.state.files[vp("a.md")]?.eTag);
	assert.equal(p.deleteCount, 0);
});

test("local rename found by a unique hash and size match (startup, no event)", async () => {
	const w = world({ "a.md": "A" });
	w.vault.rename("a.md", "dir/b.md");
	// Moves come first; M6 creates the missing parent folder on demand (and the folder op then adopts it).
	assert.deepEqual(lines(await run(w)), ["remote-move a.md -> dir/b.md", "upload-new dir"]);
});

test("ambiguous hash matches are not treated as renames", async () => {
	const w = world({ "a.md": "same", "c.md": "same" });
	w.vault.rename("a.md", "b.md");
	w.vault.rename("c.md", "d.md");
	assert.deepEqual(lines(await run(w)), ["remote-delete a.md", "upload-new b.md", "remote-delete c.md", "upload-new d.md"]);
});

test("chained rename events collapse to one move", async () => {
	const w = world({ "a.md": "A" });
	w.vault.rename("a.md", "c.md");
	w.state.pendingLocal = [
		{ kind: "renamed", from: vp("a.md"), to: vp("b.md") },
		{ kind: "dirty", path: vp("b.md") },
		{ kind: "renamed", from: vp("b.md"), to: vp("c.md") },
		{ kind: "renamed", from: vp("nope.md"), to: vp("zz.md") },
	];
	assert.deepEqual(lines(await run(w)), ["remote-move a.md -> c.md"]);
});

test("local rename plus local edit: remote-move, then upload-replace", async () => {
	const w = world({ "a.md": "A" });
	w.vault.rename("a.md", "b.md");
	w.vault.write("b.md", "B");
	w.state.pendingLocal = [{ kind: "renamed", from: vp("a.md"), to: vp("b.md") }];
	assert.deepEqual(lines(await run(w)), ["remote-move a.md -> b.md", "upload-replace b.md"]);
});

test("local rename while the remote content changed: move back to the remote path, then the content rules", async () => {
	const w = world({ "a.md": "A" });
	w.vault.rename("a.md", "b.md");
	w.remote.putFile("a.md", "A2");
	w.state.pendingLocal = [{ kind: "renamed", from: vp("a.md"), to: vp("b.md") }];
	assert.deepEqual(lines(await run(w)), ["local-move b.md -> a.md", "download a.md"]);
});

test("local rename of a file deleted remotely uploads it at the new path", async () => {
	const w = world({ "a.md": "A" });
	w.vault.rename("a.md", "b.md");
	w.remote.remove("a.md");
	w.state.pendingLocal = [{ kind: "renamed", from: vp("a.md"), to: vp("b.md") }];
	assert.deepEqual(lines(await run(w)), ["forget a.md", "upload-new b.md"]);
});

test("both sides renamed to different targets: the remote path wins", async () => {
	const w = world({ "a.md": "A" });
	w.vault.rename("a.md", "b.md");
	w.remote.rename("a.md", "c.md");
	w.state.pendingLocal = [{ kind: "renamed", from: vp("a.md"), to: vp("b.md") }];
	assert.deepEqual(lines(await run(w)), ["local-move b.md -> c.md"]);
});

test("both sides renamed to the same target: record update only (adopt), no transfer", async () => {
	const w = world({ "a.md": "A" });
	w.vault.rename("a.md", "b.md");
	w.remote.rename("a.md", "b.md");
	assert.deepEqual(lines(await run(w)), ["adopt b.md"]);
});

test("case-only local rename travels as remote-move, and a second run is quiet", async () => {
	const w = world({ "Note.md": "N" });
	w.vault.rename("Note.md", "note.md");
	w.state.pendingLocal = [{ kind: "renamed", from: vp("Note.md"), to: vp("note.md") }];
	assert.deepEqual(lines(await run(w)), ["remote-move Note.md -> note.md"]);
	// Apply it the way the executor will, then plan again.
	w.remote.rename("Note.md", "note.md");
	w.state.pendingLocal = [];
	baseline(w);
	assert.deepEqual(lines(await run(w)), []);
});

test("case-only remote rename emits no local-move and stays quiet run after run (no loop)", async () => {
	const w = world({ "Note.md": "N" });
	w.remote.rename("Note.md", "NOTE.md");
	assert.deepEqual(lines(await run(w)), []);
	assert.deepEqual(lines(await run(w)), []);
	// A content change still syncs, at the local spelling.
	w.remote.putFile("NOTE.md", "N2");
	assert.deepEqual(lines(await run(w)), ["download Note.md"]);
});

test("local folder rename collapses into one remote-move of the folder", async () => {
	const w = world({ "D/a.md": "A", "D/sub/b.md": "B" });
	w.vault.rename("D", "E");
	w.state.pendingLocal = [
		{ kind: "renamed", from: vp("D"), to: vp("E") },
		{ kind: "renamed", from: vp("D/a.md"), to: vp("E/a.md") },
		{ kind: "renamed", from: vp("D/sub/b.md"), to: vp("E/sub/b.md") },
	];
	const p = await run(w);
	assert.deepEqual(lines(p), ["remote-move D -> E"]);
	assert.equal(opOf(p.ops, "remote-move").id, w.remote.itemAt("D")?.id);
});

test("local folder rename collapse keeps child edits as uploads at the new paths", async () => {
	const w = world({ "D/a.md": "A", "D/b.md": "B" });
	w.vault.rename("D", "E");
	w.vault.write("E/b.md", "B2");
	w.vault.write("E/new.md", "N");
	w.state.pendingLocal = [{ kind: "renamed", from: vp("D"), to: vp("E") }];
	assert.deepEqual(lines(await run(w)), ["remote-move D -> E", "upload-replace E/b.md", "upload-new E/new.md"]);
});

test("remote folder rename collapses into one local-move of the folder", async () => {
	const w = world({ "D/a.md": "A", "D/b.md": "B" });
	w.remote.rename("D", "E");
	w.remote.putFile("E/b.md", "B2");
	assert.deepEqual(lines(await run(w)), ["local-move D -> E", "download E/b.md"]);
});

test("a new remote item at a path vacated by a remote rename waits for the move (review: no overwrite of a local edit)", async () => {
	const w = world({ "daily.md": "D" });
	w.remote.rename("daily.md", "daily-old.md");
	w.remote.putFile("daily.md", "new day");
	w.vault.write("daily.md", "unsynced edit");
	const p = lines(await run(w));
	assert.deepEqual(p, ["local-move daily.md -> daily-old.md", "upload-replace daily-old.md", "download daily.md"]);
});

test("every move precedes every other op on its source or destination", async () => {
	const w = world({ "D/a.md": "A", "x.md": "X" });
	w.remote.rename("D", "E");
	w.remote.putFile("D/new.md", "N");
	w.remote.rename("x.md", "y.md");
	w.remote.putFile("x.md", "X2");
	const ops = (await run(w)).ops;
	const firstOther = ops.findIndex((o) => o.kind !== "skip" && o.kind !== "local-move" && o.kind !== "remote-move");
	const lastMove = ops.map((o) => o.kind === "local-move" || o.kind === "remote-move").lastIndexOf(true);
	assert.ok(lastMove >= 0 && lastMove < firstOther, lines(await run(w)).join("\n"));
});

test("a tracked file whose remote item can't be placed (missing parent) is not trashed (review)", () => {
	const s = syncedState();
	const it = item("f1", "missing-parent", "a.md");
	s.files[vp("a.md")] = { path: vp("a.md"), remoteId: "f1", eTag: it.eTag, cTag: it.cTag, size: 5, mtime: 1, localHash: hashOf("f1"), remoteHash: hashOf("f1"), transformId: "identity" };
	const local = [{ path: "a.md", isFolder: false, size: 5, mtime: 1, localHash: hashOf("f1"), storedHash: hashOf("f1") }];
	const p = plan(s, local, rootIndex(it), SETTINGS);
	noDeletes(p.ops);
	assert.deepEqual(lines(p), ["skip a.md (outside-vault)"]);
	// A real remote delete (the item is gone from the index) still trashes.
	assert.deepEqual(lines(plan(s, local, rootIndex(), SETTINGS)), ["local-trash a.md"]);
});

test("a state with records but no approot id plans a union merge, never deletes (review, T-T6)", async () => {
	const w = world({ "a.md": "A" });
	w.state.appRootId = null;
	const p = await run(w);
	assert.equal(p.unionMode, true);
	noDeletes(p.ops);
	assert.equal(applyAppRoot(w.state, APPROOT_ID).unionPending, true);
});

// ---------- folders ----------
test("empty folders are created on the other side and adopted when both have them", async () => {
	const w = world();
	w.vault.folders.add("L");
	w.remote.mkdir("R");
	w.vault.folders.add("B");
	w.remote.mkdir("B");
	assert.deepEqual(lines(await run(w)), ["adopt B", "upload-new L", "download R"]);
});

test("folder records: kept, trashed when deleted remotely and empty, restored in union, forgotten when gone", async () => {
	const w = world({}, ["E"]);
	assert.deepEqual(lines(await run(w)), []);
	w.remote.remove("E");
	assert.deepEqual(lines(await run(w)), ["local-trash E"]);
	w.state.unionPending = true;
	assert.deepEqual(lines(await run(w)), ["upload-new E"]);
	w.state.unionPending = false;
	w.vault.remove("E");
	assert.deepEqual(lines(await run(w)), ["forget E"]);
});

test("a remote folder is deleted only when the index shows no children (R-DEL-3)", async () => {
	const w = world({ "D/a.md": "A" });
	w.vault.remove("D/a.md");
	const first = await run(w);
	assert.deepEqual(lines(first), ["remote-delete D/a.md"]);
	assert.equal(first.deleteCount, 1, "folder deletes don't count toward the guard");
	w.remote.remove("D/a.md");
	w.state.remoteIndex = w.remote.index();
	const second = await run(w);
	assert.deepEqual(lines(second), ["remote-delete D", "forget D/a.md"]);
	assert.equal(opOf(second.ops, "remote-delete").ifMatch, w.remote.itemAt("D")?.eTag);
	w.state.unionPending = true;
	assert.deepEqual(lines(await run(w)), ["download D", "forget D/a.md"]);
});

test("a remote folder delete is blocked by a skipped (too-large) child (R-DEL-3, carry-in)", async () => {
	const w = world({ "D/a.md": "A" });
	w.remote.putFile("D/big.bin", "x".repeat(20));
	w.vault.remove("D/a.md");
	w.remote.remove("D/a.md");
	const p = await run(w, { maxFileSize: 10 });
	assert.deepEqual(lines(p), ["skip D/big.bin (too-large)", "forget D/a.md"]);
});

test("a local folder deleted remotely is kept while local entries remain under it", async () => {
	const w = world({ "D/a.md": "A" });
	w.remote.remove("D");
	w.vault.write("D/a.md", "A2");
	assert.deepEqual(lines(await run(w)), ["upload-new D/a.md"]);
});

// ---------- union mode ----------
test("union mode with bases (resync): one-sided changes sync normally, no conflicts, no deletes", async () => {
	const w = world({ "a.md": "A", "b.md": "B", "c.md": "C", "d.md": "D" });
	w.state.unionPending = true;
	w.vault.write("a.md", "A2");
	w.remote.putFile("b.md", "B2");
	w.vault.remove("c.md");
	w.remote.remove("d.md");
	const p = await run(w);
	assert.deepEqual(lines(p), ["upload-replace a.md", "download b.md", "download c.md", "upload-new d.md"]);
	assert.equal(p.unionMode, true);
	assert.equal(p.deleteCount, 0);
	assert.equal(p.differsNoHistory, 0);
});

test("union mode without bases (stale device rejoins): differing pairs become conflicts in differsNoHistory", async () => {
	const w = world();
	w.state = emptyState("device-1");
	w.state.appRootId = APPROOT_ID;
	w.vault.write("x.md", "1");
	w.vault.write("y.md", "same");
	w.vault.write("w.md", "local only");
	w.remote.putFile("x.md", "2");
	w.remote.putFile("y.md", "same");
	w.remote.putFile("z.md", "remote only");
	const p = await run(w);
	assert.deepEqual(lines(p), ["upload-new w.md", `conflict x.md => x (conflict iPad ${STAMP}).md`, "adopt y.md", "download z.md"]);
	assert.equal(p.unionMode, true);
	assert.equal(p.differsNoHistory, 1);
	noDeletes(p.ops);
});

test("an approot ID change resets remote state and plans a union merge with no deletes (D-18)", async () => {
	const w = world({ "a.md": "A", "b.md": "B" });
	w.state.appRootId = "old-root";
	w.remote = new FakeRemote(); // the App Folder was deleted and recreated empty
	const s = applyAppRoot(w.state, APPROOT_ID);
	assert.equal(s.unionPending, true);
	assert.deepEqual(s.files, {});
	assert.equal(s.deltaLink, null);
	w.state = s;
	const p = await run(w);
	assert.deepEqual(lines(p), ["upload-new a.md", "upload-new b.md"]);
	noDeletes(p.ops);
});

// ---------- mass-delete guard (R-GUARD-1) ----------
test("guard threshold boundary: deletes > max(1, ceil(tracked × pct))", async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 8; i++) files[`f${i}.md`] = `content ${i}`;
	const w = world(files);
	w.vault.remove("f0.md");
	w.vault.remove("f1.md");
	const two = await run(w);
	assert.equal(two.deleteCount, 2);
	assert.equal(two.trackedCount, 8);
	assert.equal(exceedsDeleteGuard(two, 25), false);
	w.remote.remove("f2.md");
	const three = await run(w);
	assert.equal(three.deleteCount, 3);
	assert.equal(exceedsDeleteGuard(three, 25), true);

	const one = world({ "a.md": "A" });
	one.vault.remove("a.md");
	assert.equal(exceedsDeleteGuard(await run(one), 25), false, "the floor is one delete");
	assert.equal(exceedsDeleteGuard(await run(one), 1), false);
});

test("declined deletes are not re-proposed until either side changes, unless re-offered", async () => {
	const w = world({ "a.md": "A", "b.md": "B" });
	w.vault.remove("a.md");
	w.remote.remove("b.md");
	w.state.declinedDeletes = {
		[vp("a.md")]: { localHash: null, eTag: w.state.files[vp("a.md")]?.eTag ?? null },
		[vp("b.md")]: { localHash: hashOf("B"), eTag: null },
	};
	const p = await run(w);
	assert.deepEqual(lines(p), []);
	assert.equal(p.deleteCount, 0);
	assert.deepEqual(lines(await run(w, { reofferDeclined: true })), ["remote-delete a.md", "local-trash b.md"]);
	w.remote.touchMetadata("a.md");
	assert.deepEqual(lines(await run(w)), ["remote-delete a.md"]);
});

// ---------- null remote hash [G-DL-8] ----------
test("null remote hash: zero-byte files adopt; cTag decides changes; size and eTag are the last fallback", () => {
	const s = syncedState();
	const zero = [{ path: "e.md", isFolder: false, size: 0, mtime: 1, localHash: hashOf(""), storedHash: hashOf("") }];
	const empty = item("e1", APPROOT_ID, "e.md", { quickXorHash: null, size: 0 });
	assert.deepEqual(lines(plan(s, zero, rootIndex(empty), SETTINGS)), ["adopt e.md"]);

	// A non-empty item whose hash is missing from delta: only tags and size can tell.
	const local = [{ path: "n.md", isFolder: false, size: 5, mtime: 1, localHash: hashOf("abcde"), storedHash: hashOf("abcde") }];
	const it = item("n1", APPROOT_ID, "n.md", { quickXorHash: null, size: 5 });
	const rec: FileRecord = { path: vp("n.md"), remoteId: "n1", eTag: it.eTag, cTag: it.cTag, size: 5, mtime: 1, localHash: hashOf("abcde"), remoteHash: hashOf("abcde"), transformId: "identity" };
	s.files[vp("n.md")] = rec;
	assert.deepEqual(lines(plan(s, local, rootIndex(it), SETTINGS)), []);
	assert.deepEqual(lines(plan(s, local, rootIndex({ ...it, eTag: `"n1,2"` }), SETTINGS)), [], "an eTag-only change is metadata");
	assert.deepEqual(lines(plan(s, local, rootIndex({ ...it, cTag: `"c:n1,2"` }), SETTINGS)), ["download n.md"]);

	s.files[vp("n.md")] = { ...rec, cTag: null };
	const noTags = { ...it, cTag: null };
	assert.deepEqual(lines(plan(s, local, rootIndex(noTags), SETTINGS)), []);
	assert.deepEqual(lines(plan(s, local, rootIndex({ ...noTags, eTag: `"n1,9"` }), SETTINGS)), ["download n.md"]);
	assert.deepEqual(lines(plan(s, local, rootIndex({ ...noTags, size: 3 }), SETTINGS)), ["download n.md"]);
});

test("null remote hash on a non-empty no-base pair is a conflict, never a silent overwrite", () => {
	const s = syncedState();
	const local = [{ path: "n.md", isFolder: false, size: 5, mtime: 1, localHash: hashOf("abcde"), storedHash: hashOf("abcde") }];
	const p = plan(s, local, rootIndex(item("n1", APPROOT_ID, "n.md", { quickXorHash: null })), SETTINGS);
	assert.deepEqual(lines(p), [`conflict n.md => n (conflict iPad ${STAMP}).md`]);
});

// ---------- conflicts ----------
test("conflict copy names avoid existing paths and reuse a pending conflict's copy", async () => {
	const w = world({ "a.md": "A" });
	w.vault.write("a.md", "local");
	w.remote.putFile("a.md", "remote");
	w.remote.putFile(`a (conflict iPad ${STAMP}).md`, "older copy");
	const p = await run(w);
	assert.ok(lines(p).includes(`conflict a.md => a (conflict iPad ${STAMP}) 2.md`), lines(p).join("\n"));

	// A crash mid-procedure: the same pair reuses its copy path, even with the copy already written.
	const remoteId = w.remote.itemAt("a.md")?.id ?? "";
	const pending = vp("a (conflict iPad 2025-12-31 235959).md");
	w.state.pendingConflicts = { [vp("a.md")]: { path: vp("a.md"), copyPath: pending, localHash: hashOf("local"), remoteId } };
	assert.equal(opOf((await run(w)).ops, "conflict").copyPath, pending);
	w.vault.write(pending, "local");
	assert.equal(opOf((await run(w)).ops, "conflict").copyPath, pending);
});

test("a stale or forged pending conflict never points the copy at another file (review, T-T6)", async () => {
	const w = world({ "a.md": "A", "b.md": "B" });
	w.vault.write("a.md", "local");
	w.remote.putFile("a.md", "remote");
	const remoteId = w.remote.itemAt("a.md")?.id ?? "";
	const fresh = `a (conflict iPad ${STAMP}).md`;
	const cases: [string, Partial<{ copyPath: string; localHash: string; remoteId: string }>][] = [
		["another tracked note", { copyPath: "b.md" }],
		["the original itself, other case", { copyPath: "A.md" }],
		["a remote file", { copyPath: "r.md" }],
		["an excluded path", { copyPath: "tmp/x.md" }],
		["a local file with other bytes", { copyPath: "l.md" }],
		["a different local version", { localHash: hashOf("older") }],
		["a different remote item", { remoteId: "other" }],
	];
	w.remote.putFile("r.md", "R");
	w.vault.write("l.md", "L");
	for (const [name, over] of cases) {
		w.state.pendingConflicts = {
			[vp("a.md")]: { path: vp("a.md"), copyPath: vp(over.copyPath ?? "a (conflict iPad 2025-12-31 235959).md"), localHash: over.localHash ?? hashOf("local"), remoteId: over.remoteId ?? remoteId },
		};
		assert.equal(opOf((await run(w, { excludePatterns: ["tmp/"] })).ops, "conflict").copyPath, fresh, name);
	}
});

test("a conflict whose copy name can't fit is skipped, leaving both sides untouched", async () => {
	const dir = Array.from({ length: 4 }, (_, i) => `${i}`.repeat(90)).join("/");
	const w = world({ [`${dir}/a.md`]: "A" });
	w.vault.write(`${dir}/a.md`, "local");
	w.remote.putFile(`${dir}/a.md`, "remote");
	assert.deepEqual(lines(await run(w)), [`skip ${dir}/a.md (path-too-long)`]);
});

// ---------- skips (every SkipReason) ----------
test("skip too-large, local and remote; a skip never transfers or deletes", async () => {
	const w = world({ "a.md": "A", "b.md": "B" });
	w.vault.write("big.bin", "x".repeat(20));
	w.remote.putFile("rbig.bin", "y".repeat(20));
	w.vault.write("a.md", "x".repeat(20)); // tracked file grew past the cap
	w.remote.putFile("b.md", "y".repeat(20));
	const p = await run(w, { maxFileSize: 10 });
	assert.deepEqual(lines(p), ["skip a.md (too-large)", "skip b.md (too-large)", "skip big.bin (too-large)", "skip rbig.bin (too-large)"]);
});

test("skip invalid-name, reserved-name and path-too-long local names (R-PATH-3)", async () => {
	const w = world();
	w.vault.write("a?b.md", "x");
	w.vault.write("CON.md", "x");
	w.vault.write("nb\u00a0sp.md", "x");
	const deep = `${"d".repeat(130)}/${"n".repeat(250)}.md`; // 384 > 400 - 16 - 1
	w.vault.write(deep, "x");
	const p = await run(w);
	assert.deepEqual(lines(p), ["skip a?b.md (invalid-name)", "skip CON.md (reserved-name)", `skip ${deep} (path-too-long)`, "skip nb\u00a0sp.md (invalid-name)", `upload-new ${"d".repeat(130)}`]);
});

test("skip case-collision and unicode-collision local paths (R-PATH-1, R-PATH-2)", async () => {
	const w = world({ "Note.md": "N" });
	w.vault.write("note.md", "n");
	w.vault.write("Q.md", "q");
	w.vault.write("q.md", "q2");
	w.vault.write(`caf${NFC_E}.md`, "1");
	w.vault.write(`caf${NFD_E}.md`, "2");
	const p = await run(w);
	// Both Unicode forms are skipped and shown as they are on disk; the tracked "Note.md" keeps syncing.
	assert.deepEqual(lines(p), [
		`skip caf${NFD_E}.md (unicode-collision)`,
		`skip caf${NFC_E}.md (unicode-collision)`,
		"skip note.md (case-collision)",
		"skip Q.md (case-collision)",
		"skip q.md (case-collision)",
	]);
});

test("skip remote case-collision and unicode-collision siblings (M4 carry-in)", () => {
	const s = syncedState();
	const index = rootIndex(
		item("u1", APPROOT_ID, "X.md"),
		item("u2", APPROOT_ID, "x.md"),
		item("u3", APPROOT_ID, `caf${NFC_E}.md`),
		item("u4", APPROOT_ID, `caf${NFD_E}.md`),
	);
	const p = plan(s, [], index, SETTINGS);
	assert.deepEqual(lines(p), [`skip caf${NFD_E}.md (unicode-collision)`, `skip caf${NFC_E}.md (unicode-collision)`, "skip X.md (case-collision)", "skip x.md (case-collision)"]);
});

test("skip remote outside-vault, hidden, configDir, invalid and excluded paths (R-SCOPE-4, R-PATH-4)", () => {
	const s = syncedState();
	const index = rootIndex(
		item("p1", APPROOT_ID, ".."),
		item("p2", APPROOT_ID, ".hidden", { isFolder: true, quickXorHash: null, cTag: null }),
		item("p3", "p2", "x.md"),
		item("p4", APPROOT_ID, CFG.toUpperCase(), { isFolder: true, quickXorHash: null, cTag: null }),
		item("p5", "p4", "main.js"),
		item("p6", APPROOT_ID, "n".repeat(256)),
		item("p7", APPROOT_ID, "private", { isFolder: true, quickXorHash: null, cTag: null }),
		item("p8", "p7", "x.md"),
		item("p9", "nowhere", "orphan.md"),
	);
	const p = plan(s, [], index, { ...SETTINGS, excludePatterns: ["private/"] });
	assert.deepEqual(lines(p), [
		"skip .. (outside-vault)",
		"skip .hidden (hidden)",
		"skip .hidden/x.md (hidden)",
		`skip ${"n".repeat(256)} (invalid-name)`,
		`skip ${CFG.toUpperCase()} (hidden)`,
		`skip ${CFG.toUpperCase()}/main.js (hidden)`,
		"skip private (excluded)",
		"skip private/x.md (excluded)",
	]);
});

test("skip local outside-vault, hidden and excluded entries even if the vault port lets them through", () => {
	const s = syncedState();
	const f = (path: string) => ({ path, isFolder: false, size: 1, mtime: 1, localHash: hashOf(path), storedHash: hashOf(path) });
	const p = plan(s, [f("a/../b.md"), f(".git/x"), f(`${CFG}/plugins/x/main.js`), f("tmp/x.md")], rootIndex(), { ...SETTINGS, excludePatterns: ["tmp/"] });
	assert.deepEqual(lines(p), ["skip .git/x (hidden)", "skip a/../b.md (outside-vault)", `skip ${CFG}/plugins/x/main.js (hidden)`, "skip tmp/x.md (excluded)"]);
});

// ---------- carry-ins: skips never delete (T-D1) ----------
test("a tracked file whose remote item is now skipped is never trashed (M3 carry-in)", async () => {
	const w = world({ "a.md": "A" });
	const long = "x".repeat(256) + ".md";
	w.remote.rename("a.md", long);
	const p = await run(w);
	noDeletes(p.ops);
	assert.deepEqual(lines(p), ["skip a.md (invalid-name)", `skip ${long} (invalid-name)`]);
});

test("a tracked path that becomes excluded is never deleted on either side", async () => {
	const w = world({ "p/a.md": "A", "q.md": "Q" });
	w.remote.remove("q.md");
	const p = await run(w, { excludePatterns: ["p/", "q.md"] });
	noDeletes(p.ops);
	assert.deepEqual(lines(p), ["skip p (excluded)", "skip p/a.md (excluded)", "skip q.md (excluded)"]);
});

test("a tracked file renamed to a skipped name blocks its record instead of deleting the remote copy", async () => {
	const w = world({ "a b.md": "A", "c.md": "C" });
	w.vault.rename("a b.md", "a\u00a0b.md"); // matched by hash and size
	w.vault.rename("c.md", "c?d.md"); // matched by the vault event
	w.state.pendingLocal = [{ kind: "renamed", from: vp("c.md"), to: vp("c?d.md") }];
	const p = await run(w);
	noDeletes(p.ops);
	assert.deepEqual(lines(p), ["skip a b.md (invalid-name)", "skip a\u00a0b.md (invalid-name)", "skip c.md (invalid-name)", "skip c?d.md (invalid-name)"]);
});

test("a skipped local collision loser never deletes the tracked file's remote copy", async () => {
	const w = world({ "Note.md": "N" });
	w.vault.write("note.md", "other");
	w.vault.remove("Note.md");
	w.vault.write("Note.md", "N");
	const p = await run(w);
	assert.deepEqual(lines(p), ["skip note.md (case-collision)"]);
});

test("when a tracked collision keeper moves away, nothing is written over the skipped loser (property-test find)", async () => {
	const w = world({ "Note.md": "N" });
	w.vault.write("note.md", "loser bytes");
	w.remote.rename("Note.md", "moved.md");
	w.remote.putFile("note.md", "new remote file");
	const p = await run(w);
	assert.deepEqual(lines(p), ["skip note.md (case-collision)", "local-move Note.md -> moved.md"]);
});

test("rejects a scanned file without hashes", () => {
	assert.throws(() => plan(syncedState(), [{ path: "a.md", isFolder: false, size: 1, mtime: 1, localHash: null, storedHash: null }], rootIndex(), SETTINGS), /scan-incomplete/);
});
