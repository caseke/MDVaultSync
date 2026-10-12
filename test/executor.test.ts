// Executor (design §5.5, plan M6): every op end to end against FakeVault + FakeRemote, the pre-write checks,
// 412/409 handling, eTag chaining, containment, hash mismatches and batched state saves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { executePlan, type ExecContext } from "../src/core/executor.ts";
import { plan } from "../src/core/planner.ts";
import { TransformedRemoteContent } from "../src/core/remote-content.ts";
import { Saver } from "../src/core/saver.ts";
import { IdentityTransform } from "../src/core/transform.ts";
import { quickXorHash } from "../src/core/quickxor.ts";
import type { Plan, PlanOp, RemotePort, VaultPath, VaultPort } from "../src/core/ports.ts";
import { classifyError } from "../src/remote/classify.ts";
import { GraphError } from "../src/remote/errors.ts";
import { CFG, SETTINGS, STAMP, hashOf, vp, world, type World } from "./fakes/plan-fixtures.ts";
import { ManualClock, MemoryStateStore, enc, withOverrides } from "./fakes/sync-fakes.ts";

const UNIT = 327_680;

interface Run {
	plan: Plan;
	ctx: ExecContext;
	store: MemoryStateStore;
	clock: ManualClock;
}

async function planOf(w: World): Promise<Plan> {
	w.state.remoteIndex = w.remote.index(); // what the pull leaves behind
	return plan(w.state, await w.vault.scan(), w.state.remoteIndex, SETTINGS);
}

async function prepare(w: World, opts: { vault?: VaultPort; remote?: RemotePort; ops?: PlanOp[]; between?: () => void; putHonorsIfMatch?: boolean } = {}): Promise<Run> {
	const p = await planOf(w);
	if (opts.ops) p.ops = opts.ops;
	const scan = await w.vault.scan();
	opts.between?.();
	const store = new MemoryStateStore(CFG);
	const clock = new ManualClock();
	const remote = opts.remote ?? w.remote;
	const ctx: ExecContext = {
		state: w.state,
		plan: p,
		scan,
		vault: opts.vault ?? w.vault,
		remote,
		content: new TransformedRemoteContent(remote, new IdentityTransform(), {
			putHonorsIfMatch: opts.putHonorsIfMatch ?? true,
			classify: classifyError,
			simpleMax: UNIT,
			fragmentSize: UNIT,
		}),
		classify: classifyError,
		settings: { configDir: CFG, pathPrefixLen: SETTINGS.pathPrefixLen, maxFileSize: SETTINGS.maxFileSize, deviceName: "iPad", now: SETTINGS.now, transformId: "identity" },
		saver: new Saver({ store, clock, state: () => w.state }),
		expectedWrites: new Map(),
	};
	return { plan: p, ctx, store, clock };
}

async function sync(w: World, opts: Parameters<typeof prepare>[1] = {}) {
	const r = await prepare(w, opts);
	const out = await executePlan(r.ctx);
	return { ...r, out, codes: out.results.filter((x) => !x.ok).map((x) => (x.ok ? "" : x.code)), kinds: out.results.filter((x) => x.ok).map((x) => x.op.kind) };
}

/** After a run, the next plan on the same device has nothing left to do. */
async function settled(w: World): Promise<void> {
	const p = await planOf(w);
	assert.deepEqual(
		p.ops.filter((o) => o.kind !== "skip"),
		[],
		"nothing left to do",
	);
}

function bytesOf(n: number, seed = 3): Uint8Array {
	const b = new Uint8Array(n);
	// An LCG, not a short periodic pattern: QuickXorHash can collide on periodic data that differs by a constant.
	let x = seed * 2654435761;
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		b[i] = x >>> 24;
	}
	return b;
}

// ---------- every op ----------

test("upload-new: a new local file in a new folder creates the folder, uploads, and records both", async () => {
	const w = world({ "a.md": "a" });
	w.vault.write("dir/sub/new.md", "fresh");
	const { kinds, codes } = await sync(w);
	assert.deepEqual(codes, []);
	assert.ok(kinds.includes("upload-new"));
	assert.equal(w.remote.contentAt("dir/sub/new.md"), "fresh");
	assert.equal(w.state.files[vp("dir/sub/new.md")]?.remoteId, w.remote.itemAt("dir/sub/new.md")?.id);
	assert.equal(w.state.folders[vp("dir/sub")], w.remote.itemAt("dir/sub")?.id);
	await settled(w);
});

test("upload-replace: a local edit is uploaded with If-Match and the record takes the new eTag", async () => {
	const w = world({ "a.md": "v1" });
	w.vault.write("a.md", "v2");
	const { kinds } = await sync(w);
	assert.deepEqual(kinds, ["upload-replace"]);
	assert.equal(w.remote.contentAt("a.md"), "v2");
	assert.equal(w.state.files[vp("a.md")]?.eTag, w.remote.itemAt("a.md")?.eTag);
	await settled(w);
});

test("download: a new remote file in a new folder is written atomically and recorded", async () => {
	const w = world({ "a.md": "a" });
	w.remote.putFile("x/y/new.md", "remote");
	const { codes, ctx } = await sync(w);
	assert.deepEqual(codes, []);
	assert.equal(w.vault.contentAt("x/y/new.md"), "remote");
	assert.equal(w.state.files[vp("x/y/new.md")]?.localHash, hashOf("remote"));
	assert.equal(ctx.expectedWrites?.get(vp("x/y/new.md")), hashOf("remote"), "expected write registered for the echo filter");
	await settled(w);
});

test("download: a remote edit overwrites the unchanged local file", async () => {
	const w = world({ "a.md": "v1" });
	w.remote.putFile("a.md", "v2");
	const { kinds } = await sync(w);
	assert.deepEqual(kinds, ["download"]);
	assert.equal(w.vault.contentAt("a.md"), "v2");
	await settled(w);
});

test("remote-move: a local rename moves the item by id (R-MOVE-1)", async () => {
	const w = world({ "a.md": "a" });
	const id = w.remote.itemAt("a.md")?.id;
	w.vault.rename("a.md", "deep/b.md");
	const { kinds } = await sync(w);
	// The move creates "deep" on demand; the planned folder op then adopts it.
	assert.deepEqual(kinds, ["remote-move", "upload-new"]);
	assert.equal(w.remote.itemAt("deep/b.md")?.id, id);
	assert.equal(w.state.files[vp("deep/b.md")]?.remoteId, id);
	assert.equal(w.state.files[vp("a.md")], undefined);
	await settled(w);
});

test("eTag chaining: rename plus edit uses the eTag the move returned (no false conflict)", async () => {
	const w = world({ "a.md": "v1", "other.md": "o" });
	w.vault.rename("a.md", "b.md");
	w.vault.write("b.md", "v2");
	w.state.pendingLocal.push({ kind: "renamed", from: vp("a.md"), to: vp("b.md") });
	const { kinds, codes } = await sync(w);
	assert.deepEqual(codes, []);
	assert.deepEqual(kinds, ["remote-move", "upload-replace"]);
	assert.equal(w.remote.contentAt("b.md"), "v2");
	assert.equal(w.remote.itemAt("a.md"), null);
});

test("local-move: a remote rename moves the local file with Vault.rename and keeps the record", async () => {
	const w = world({ "a.md": "a" });
	const id = w.remote.itemAt("a.md")?.id;
	w.remote.rename("a.md", "n/b.md");
	const { kinds } = await sync(w);
	assert.deepEqual(kinds, ["local-move", "download"], "the move, then the planned folder op for n");
	assert.equal(w.vault.contentAt("n/b.md"), "a");
	assert.equal(w.vault.contentAt("a.md"), null);
	assert.equal(w.state.files[vp("n/b.md")]?.remoteId, id);
	assert.equal(w.state.files[vp("n/b.md")]?.eTag, w.remote.itemAt("n/b.md")?.eTag, "record follows the rename's eTag");
	await settled(w);
});

test("folder moves: a remote folder rename re-paths every record under it", async () => {
	const w = world({ "f/a.md": "a", "f/s/b.md": "b" });
	w.remote.rename("f", "g");
	const { kinds } = await sync(w);
	assert.deepEqual(kinds, ["local-move"]);
	assert.equal(w.vault.contentAt("g/s/b.md"), "b");
	assert.deepEqual(Object.keys(w.state.files).sort(), ["g/a.md", "g/s/b.md"]);
	assert.ok(w.state.folders[vp("g")]);
	assert.equal(w.state.folders[vp("f")], undefined);
	await settled(w);
});

test("folder moves: a local folder rename is one remote-move and re-paths the records", async () => {
	const w = world({ "f/a.md": "a", "f/b.md": "b" });
	const id = w.remote.itemAt("f")?.id;
	w.vault.rename("f", "g");
	w.state.pendingLocal.push({ kind: "renamed", from: vp("f"), to: vp("g") });
	const { kinds } = await sync(w);
	assert.deepEqual(kinds, ["remote-move"]);
	assert.equal(w.remote.itemAt("g")?.id, id);
	assert.deepEqual(Object.keys(w.state.files).sort(), ["g/a.md", "g/b.md"]);
	await settled(w);
});

test("remote-delete and local-trash propagate deletes both ways (R-DEL-1)", async () => {
	const w = world({ "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d", "e.md": "e" });
	w.vault.remove("a.md");
	w.remote.remove("b.md");
	const { kinds } = await sync(w);
	assert.deepEqual(kinds.sort(), ["local-trash", "remote-delete"]);
	assert.equal(w.remote.itemAt("a.md"), null);
	assert.ok(w.remote.recycleBin.some((i) => i.name === "a.md"), "remote delete goes to the recycle bin");
	assert.deepEqual(w.vault.trashed, ["b.md"]);
	assert.equal(w.state.files[vp("a.md")], undefined);
	assert.equal(w.state.files[vp("b.md")], undefined);
	await settled(w);
});

test("folders: an emptied remote folder is removed locally; an empty local-deleted folder is deleted remotely", async () => {
	const w = world({ "keep.md": "k", "x.md": "x" }, ["gone-remote", "gone-local"]);
	w.remote.remove("gone-remote");
	w.vault.remove("gone-local");
	const { codes } = await sync(w);
	assert.deepEqual(codes, []);
	assert.ok(!w.vault.folders.has("gone-remote"));
	assert.equal(w.remote.itemAt("gone-local"), null);
	assert.equal(w.state.folders[vp("gone-remote")], undefined);
	assert.equal(w.state.folders[vp("gone-local")], undefined);
	await settled(w);
});

test("conflict: the local version becomes the copy, the remote keeps the name, and the copy is uploaded (R-CONF-1)", async () => {
	const w = world({ "n.md": "base" });
	w.vault.write("n.md", "mine");
	w.remote.putFile("n.md", "theirs");
	const { out, kinds } = await sync(w);
	const copy = `n (conflict iPad ${STAMP}).md`;
	assert.deepEqual(out.conflicts, [{ path: vp("n.md"), copyPath: vp(copy) }]);
	assert.ok(kinds.includes("conflict"));
	assert.equal(w.vault.contentAt("n.md"), "theirs");
	assert.equal(w.vault.contentAt(copy), "mine");
	assert.equal(w.remote.contentAt(copy), "mine");
	assert.deepEqual(w.state.pendingConflicts, {});
	await settled(w);
});

test("adopt and forget only change records", async () => {
	const w = world({ "a.md": "a", "gone.md": "g" });
	w.vault.write("same.md", "same");
	w.remote.putFile("same.md", "same");
	w.vault.remove("gone.md");
	w.remote.remove("gone.md");
	const { kinds } = await sync(w);
	assert.deepEqual(kinds.sort(), ["adopt", "forget"]);
	assert.equal(w.state.files[vp("same.md")]?.remoteId, w.remote.itemAt("same.md")?.id);
	assert.equal(w.state.files[vp("gone.md")], undefined);
	await settled(w);
});

// ---------- 412 and 409 ----------

test("412 with only a metadata change retries once with the fresh eTag (R-CC-2)", async () => {
	const w = world({ "a.md": "v1" });
	w.vault.write("a.md", "v2");
	const { kinds, codes } = await sync(w, { between: () => w.remote.touchMetadata("a.md") });
	assert.deepEqual(codes, []);
	assert.deepEqual(kinds, ["upload-replace"]);
	assert.equal(w.remote.contentAt("a.md"), "v2");
});

test("412 with a content change runs the conflict procedure (no overwrite)", async () => {
	const w = world({ "a.md": "v1" });
	w.vault.write("a.md", "mine");
	const { kinds, out } = await sync(w, { between: () => w.remote.putFile("a.md", "theirs") });
	assert.deepEqual(kinds, ["conflict", "upload-new"], "the conflict, then the copy's upload");
	assert.equal(out.conflicts.length, 1);
	assert.equal(w.vault.contentAt("a.md"), "theirs");
	assert.equal(w.remote.contentAt(`a (conflict iPad ${STAMP}).md`), "mine");
});

test("412 on a replace whose item was deleted meanwhile uploads it new (edits win)", async () => {
	const w = world({ "a.md": "v1" });
	w.vault.write("a.md", "v2");
	const { codes } = await sync(w, { between: () => w.remote.remove("a.md") });
	assert.deepEqual(codes, []);
	assert.equal(w.remote.contentAt("a.md"), "v2");
});

test("409 on upload-new: same bytes adopt, different bytes become a conflict", async () => {
	const w = world({ "a.md": "a" });
	w.vault.write("same.md", "s");
	w.vault.write("diff.md", "mine");
	const { kinds } = await sync(w, {
		between: () => {
			w.remote.putFile("same.md", "s");
			w.remote.putFile("diff.md", "theirs");
		},
	});
	assert.deepEqual(kinds.sort(), ["adopt", "conflict", "upload-new"]);
	assert.equal(w.vault.contentAt("diff.md"), "theirs");
	assert.equal(w.remote.contentAt(`diff (conflict iPad ${STAMP}).md`), "mine");
});

test("remote-delete: 404 is already gone (forget); 412 downloads the remote edit back (R-DEL-2)", async () => {
	const w = world({ "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d", "e.md": "e", "f.md": "f", "g.md": "g", "h.md": "h" });
	w.vault.remove("a.md");
	w.vault.remove("b.md");
	const { kinds } = await sync(w, {
		between: () => {
			w.remote.remove("a.md");
			w.remote.putFile("b.md", "edited there");
		},
	});
	assert.deepEqual(kinds.sort(), ["download", "forget"]);
	assert.equal(w.vault.contentAt("b.md"), "edited there");
	assert.equal(w.state.files[vp("a.md")], undefined);
});

// ---------- edits during the sync (R-CONF-4) ----------

test("edit during sync: a download onto a file edited since the scan becomes a conflict", async () => {
	const w = world({ "a.md": "v1" });
	w.remote.putFile("a.md", "remote v2");
	const { kinds } = await sync(w, { between: () => w.vault.write("a.md", "typed during sync") });
	assert.deepEqual(kinds, ["conflict", "upload-new"]);
	assert.equal(w.vault.contentAt("a.md"), "remote v2");
	assert.equal(w.vault.contentAt(`a (conflict iPad ${STAMP}).md`), "typed during sync");
	await settled(w);
});

test("edit during sync: a trash of a file edited since the scan is deferred, and the next run uploads it", async () => {
	const w = world({ "a.md": "v1", "b.md": "b", "c.md": "c", "d.md": "d", "e.md": "e" });
	w.remote.remove("a.md");
	const { codes } = await sync(w, { between: () => w.vault.write("a.md", "typed during sync") });
	assert.deepEqual(codes, ["changed-during-sync"]);
	assert.equal(w.vault.contentAt("a.md"), "typed during sync");
	assert.deepEqual(w.vault.trashed, []);
	const next = await sync(w);
	assert.deepEqual(next.kinds, ["upload-new"]);
	assert.equal(w.remote.contentAt("a.md"), "typed during sync");
});

test("edit during sync: a local-move of a file edited since the scan is deferred", async () => {
	const w = world({ "a.md": "v1" });
	w.remote.rename("a.md", "b.md");
	const { codes } = await sync(w, { between: () => w.vault.write("a.md", "typed") });
	assert.deepEqual(codes, ["changed-during-sync"]);
	assert.equal(w.vault.contentAt("a.md"), "typed");
});

test("upload-session race: the item changes mid-upload → session cancelled before the final fragment, conflict run", async () => {
	const w = world({});
	w.vault.write("big.bin", bytesOf(3 * UNIT));
	w.remote.putFile("big.bin", bytesOf(3 * UNIT));
	const { baseline } = await import("./fakes/plan-fixtures.ts");
	baseline(w);
	w.vault.write("big.bin", bytesOf(3 * UNIT, 9));
	let fragments = 0;
	const perSession = new Map<string, number>();
	const racing: RemotePort = withOverrides(w.remote, {
		putFragment: (u: string, s: number, t: number, b: ArrayBuffer) => {
			fragments++;
			perSession.set(u, (perSession.get(u) ?? 0) + 1);
			if (fragments === 1) w.remote.putFile("big.bin", "other device");
			return w.remote.putFragment(u, s, t, b);
		},
	});
	const { kinds } = await sync(w, { remote: racing, putHonorsIfMatch: false });
	assert.equal([...perSession.values()][0], 2, "the replace session's final fragment was never sent");
	assert.deepEqual(kinds, ["conflict", "upload-new"]);
	assert.equal(w.vault.contentAt("big.bin"), "other device");
	assert.equal(w.remote.itemAt(`big (conflict iPad ${STAMP}).bin`)?.quickXorHash, quickXorHash(bytesOf(3 * UNIT, 9)));
	assert.deepEqual(w.state.uploadSessions, {});
});

// ---------- safety checks ----------

test("containment: an op that would write into configDir, a hidden folder or outside the vault writes nothing (T-T1)", async () => {
	const w = world({ "a.md": "a" });
	const it = w.remote.putFile("evil.js", "alert(1)");
	const ops: PlanOp[] = [
		{ kind: "download", id: it.id, path: vp(`${CFG}/plugins/x/main.js`), reason: "new" },
		{ kind: "download", id: it.id, path: vp(".hidden/x.js"), reason: "new" },
		{ kind: "download", id: it.id, path: vp("../x.js"), reason: "new" },
		{ kind: "download", id: it.id, path: vp("a b.md"), reason: "new" },
	];
	const { codes } = await sync(w, { ops });
	assert.deepEqual(codes, ["unsafe-path", "unsafe-path", "unsafe-path", "unsafe-path"]);
	assert.deepEqual([...w.vault.files.keys()], ["a.md"]);
});

test("hash mismatch: corrupted download bytes are discarded and reported (R-IO-2)", async () => {
	const w = world({ "a.md": "v1" });
	w.remote.putFile("a.md", "v2");
	const corrupt: RemotePort = withOverrides(w.remote, {
		download: () => Promise.resolve(enc("XX")),
	});
	const { codes } = await sync(w, { remote: corrupt });
	assert.deepEqual(codes, ["hash-mismatch"]);
	assert.equal(w.vault.contentAt("a.md"), "v1");
});

test("size cap before download: an item that grew past the cap since the pull is not downloaded (T-D6)", async () => {
	const w = world({ "a.md": "a" });
	w.remote.putFile("big.md", "small");
	let downloads = 0;
	const counting: RemotePort = withOverrides(w.remote, {
		download: (id: string) => {
			downloads++;
			return w.remote.download(id);
		},
	});
	const r = await prepare(w, { remote: counting, between: () => w.remote.putFile("big.md", "x".repeat(64)) });
	r.ctx.settings = { ...r.ctx.settings, maxFileSize: 10 };
	const out = await executePlan(r.ctx);
	assert.deepEqual(
		out.results.map((x) => (x.ok ? "ok" : x.code)),
		["too-large"],
	);
	assert.equal(downloads, 0);
});

test("order: pull side before push side, moves first (R-ORDER)", async () => {
	const w = world({ "a.md": "a", "r.md": "r", "keep.md": "k" });
	w.vault.write("up.md", "up");
	w.remote.putFile("down.md", "down");
	w.remote.rename("r.md", "r2.md");
	const seq: string[] = [];
	const vault: VaultPort = withOverrides(w.vault, {
		move: (f: VaultPath, t: VaultPath) => (seq.push("local-move"), w.vault.move(f, t)),
		writeAtomic: (p: VaultPath, d: ArrayBuffer) => (seq.push("local-write"), w.vault.writeAtomic(p, d)),
	});
	const remote: RemotePort = withOverrides(w.remote, {
		uploadNew: (p: string, n: string, d: ArrayBuffer) => (seq.push("remote-write"), w.remote.uploadNew(p, n, d)),
	});
	await sync(w, { vault, remote });
	assert.deepEqual(seq, ["local-move", "local-write", "remote-write"]);
});

test("state saves: at most one second after an op, and immediately before a destructive op (R-RES-3)", async () => {
	const w = world({ "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d", "e.md": "e" });
	w.remote.putFile("new.md", "n");
	w.remote.remove("a.md");
	let savesAtTrash = -1;
	const r = await prepare(w, {});
	r.ctx.vault = withOverrides(w.vault, {
		trash: (p: VaultPath) => {
			savesAtTrash = r.store.saves;
			assert.ok(r.store.state?.files["a.md" as VaultPath], "the saved state still holds the record being trashed");
			return w.vault.trash(p);
		},
	});
	const done = executePlan(r.ctx);
	const out = await done;
	assert.equal(out.results.filter((x) => !x.ok).length, 0);
	assert.ok(savesAtTrash >= 1, "flushed before the trash");
	const before = r.store.saves;
	r.ctx.saver.dirty();
	assert.equal(r.store.saves, before, "not saved synchronously");
	await r.clock.advance(1000);
	await r.ctx.saver.flush();
	assert.ok(r.store.saves > before, "saved within a second");
	assert.equal(r.store.state?.files["a.md" as VaultPath], undefined);
});

test("state maps: a note named __proto__ stays data and round-trips through the saved state (M5 carry-in)", async () => {
	const w = world({ "a.md": "a" });
	w.vault.write("__proto__", "p");
	w.vault.write("constructor", "c");
	const r = await prepare(w);
	await executePlan(r.ctx);
	await r.ctx.saver.flush();
	assert.ok(Object.prototype.hasOwnProperty.call(w.state.files, "__proto__"));
	const loaded = await r.store.load();
	assert.equal(loaded?.files[vp("__proto__")]?.localHash, quickXorHash(enc("p")));
	assert.equal(loaded?.files[vp("constructor")]?.localHash, quickXorHash(enc("c")));
	assert.equal(Object.getPrototypeOf(loaded?.files), Object.prototype);
});

// ---------- security-review regressions ----------

test("a local folder where the remote has a file fails once as type-clash (no download/conflict loop)", async () => {
	const w = world({ "a.md": "a" });
	w.vault.write("Ideas/x.md", "x");
	const it = w.remote.putFile("Ideas", "a remote file with no extension");
	let reads = 0;
	const counting: RemotePort = withOverrides(w.remote, {
		getItem: (id: string) => {
			reads++;
			return w.remote.getItem(id);
		},
	});
	const r = await prepare(w, { remote: counting, ops: [{ kind: "download", id: it.id, path: vp("Ideas"), reason: "new" }] });
	const out = await executePlan(r.ctx);
	assert.deepEqual(
		out.results.map((x) => (x.ok ? x.op.kind : x.code)),
		["type-clash"],
	);
	assert.ok(reads <= 2, `bounded reads (${reads})`);
	assert.equal(w.vault.contentAt("Ideas/x.md"), "x");
});

test("two conflicts in one run whose copy names shorten to the same name get different copies (no lost edit)", async () => {
	const stem = "n".repeat(240);
	const p1 = `${stem}-one.md`;
	const p2 = `${stem}-two.md`;
	const w = world({ [p1]: "base1", [p2]: "base2" });
	w.remote.putFile(p1, "theirs1");
	w.remote.putFile(p2, "theirs2");
	// Edited after the scan, so both conflicts are discovered at runtime and run concurrently.
	const { out } = await sync(w, {
		between: () => {
			w.vault.write(p1, "mine1");
			w.vault.write(p2, "mine2");
		},
	});
	assert.equal(out.conflicts.length, 2);
	const copies = out.conflicts.map((c) => c.copyPath);
	assert.notEqual(copies[0], copies[1]);
	const kept = new Set(copies.map((c) => w.vault.contentAt(c)));
	assert.deepEqual([...kept].sort(), ["mine1", "mine2"]);
	assert.equal(w.vault.contentAt(p1), "theirs1");
	assert.equal(w.vault.contentAt(p2), "theirs2");
});

test("a 404 on a replace whose item still exists (an expired session) is not treated as a remote delete", async () => {
	const w = world({ "a.md": "v1" });
	w.vault.write("a.md", "v2");
	let failed = false;
	const flaky: RemotePort = withOverrides(w.remote, {
		uploadReplace: (id: string, ifMatch: string, d: ArrayBuffer) => {
			if (!failed) {
				failed = true;
				return Promise.reject(new GraphError(404, "itemNotFound"));
			}
			return w.remote.uploadReplace(id, ifMatch, d);
		},
	});
	const { kinds, out } = await sync(w, { remote: flaky });
	assert.deepEqual(kinds, ["upload-replace"]);
	assert.deepEqual(out.conflicts, []);
	assert.equal(w.remote.contentAt("a.md"), "v2");
});

test("a folder remote-move that hits 412 because the folder moved elsewhere doesn't override that move", async () => {
	const w = world({ "f/a.md": "a", "f/b.md": "b" });
	w.vault.rename("f", "g");
	w.state.pendingLocal.push({ kind: "renamed", from: vp("f"), to: vp("g") });
	const { codes } = await sync(w, { between: () => w.remote.rename("f", "elsewhere") });
	assert.deepEqual(codes, ["precondition"]);
	assert.ok(w.remote.itemAt("elsewhere"), "the other device's rename stands");
});

test("after sign-out (live() false) no further op starts", async () => {
	const w = world({ "a.md": "a" });
	for (let i = 0; i < 10; i++) w.remote.putFile(`n${i}.md`, `${i}`);
	const r = await prepare(w);
	let alive = true;
	r.ctx.live = () => alive;
	r.ctx.concurrency = 1;
	r.ctx.vault = withOverrides(w.vault, {
		writeAtomic: (p: VaultPath, d: ArrayBuffer) => {
			alive = false;
			return w.vault.writeAtomic(p, d);
		},
	});
	const out = await executePlan(r.ctx);
	assert.equal(out.results.length, 1);
});
