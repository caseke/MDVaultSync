// Property test for the planner (plan M5, T-D2): 5,000 random three-way states from a seeded PRNG (written here,
// no dependency). Each state picks, per path, a base, a local file and a remote file independently, with
// contents from a small pool so equal and different content both happen often. Then:
//  (a) bytes that only one side has are never deleted or overwritten;
//  (b) union mode never deletes;
//  (c) a conflict happens only when both sides changed (or there is no base) and the contents differ;
//  (d) nothing at a skipped path is transferred or deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, type ScannedEntry } from "../src/core/planner.ts";
import { emptyState } from "../src/core/state.ts";
import { caseKey } from "../src/core/paths.ts";
import type { FileRecord, Plan, PlanOp, RemoteItem, VaultPath } from "../src/core/ports.ts";
import { CFG, SETTINGS, hashOf, line } from "./fakes/plan-fixtures.ts";

/** mulberry32: small, fast, good enough to spread test cases. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PATHS = ["a.md", "A.md", "b.md", "d/e.md", "d/f.md", "x y.md", `${CFG}/p.js`];
const CONTENTS = ["x", "y", "z", "", "0123456789-long"];
const ROOT = "approot";
const FOLDER_ID = "folder-d";

interface Case {
	base: Map<string, string>; // path → content at last sync
	local: Map<string, string>;
	remote: Map<string, { content: string; id: string; sameItem: boolean }>;
	union: boolean;
	cap: number;
	patterns: string[];
}

function idFor(path: string): string {
	return "id-" + [...path].map((c) => c.charCodeAt(0).toString(16)).join("");
}

function genCase(rnd: () => number): Case {
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
	const c: Case = { base: new Map(), local: new Map(), remote: new Map(), union: rnd() < 0.3, cap: rnd() < 0.2 ? 5 : 1000, patterns: rnd() < 0.1 ? ["b.md"] : [] };
	for (const p of PATHS) {
		if (rnd() < 0.15) continue; // path unused
		const hasBase = rnd() < 0.6;
		const b = pick(CONTENTS);
		if (hasBase) c.base.set(p, b);
		if (rnd() < 0.75) c.local.set(p, hasBase && rnd() < 0.5 ? b : pick(CONTENTS));
		if (rnd() < 0.75) {
			const content = hasBase && rnd() < 0.5 ? b : pick(CONTENTS);
			const sameItem = hasBase && rnd() < 0.9;
			c.remote.set(p, { content, id: sameItem ? idFor(p) : idFor(p) + "-new", sameItem });
		}
	}
	return c;
}

const remoteHash = (content: string) => (content === "" ? null : hashOf(content));
const cTagOf = (content: string, n: number) => `"c:${n}:${hashOf(content)}"`;

function build(c: Case): { p: Plan; c: Case } {
	const state = emptyState("dev");
	state.appRootId = ROOT;
	state.unionPending = c.union;
	state.firstSyncCompleted = true;
	for (const [p, content] of c.base) {
		const rec: FileRecord = {
			path: p as VaultPath,
			remoteId: idFor(p),
			eTag: `"e:${idFor(p)}:1"`,
			cTag: cTagOf(content, 1),
			size: content.length,
			mtime: 1,
			localHash: hashOf(content),
			remoteHash: hashOf(content),
			transformId: "identity",
		};
		state.files[p as VaultPath] = rec;
	}
	if ([...c.base.keys()].some((p) => p.startsWith("d/"))) state.folders["d" as VaultPath] = FOLDER_ID;

	const local: ScannedEntry[] = [];
	for (const [p, content] of c.local) local.push({ path: p, isFolder: false, size: content.length, mtime: 2, localHash: hashOf(content), storedHash: hashOf(content) });
	if ([...c.local.keys()].some((p) => p.startsWith("d/"))) local.push({ path: "d", isFolder: true, size: 0, mtime: 0, localHash: null, storedHash: null });

	const index: Record<string, RemoteItem> = {
		[ROOT]: { id: ROOT, parentId: null, name: "MDVaultSync", isFolder: true, eTag: '"root"', cTag: null, size: 0, quickXorHash: null, lastModified: "", deleted: false },
	};
	if ([...c.remote.keys()].some((p) => p.startsWith("d/"))) {
		index[FOLDER_ID] = { id: FOLDER_ID, parentId: ROOT, name: "d", isFolder: true, eTag: '"fd"', cTag: null, size: 0, quickXorHash: null, lastModified: "", deleted: false };
	}
	for (const [p, r] of c.remote) {
		const segs = p.split("/");
		const base = c.base.get(p);
		const unchanged = r.sameItem && base === r.content;
		index[r.id] = {
			id: r.id,
			parentId: segs.length > 1 ? FOLDER_ID : ROOT,
			name: segs[segs.length - 1] as string,
			isFolder: false,
			eTag: unchanged ? `"e:${r.id}:1"` : `"e:${r.id}:2"`,
			cTag: unchanged ? cTagOf(r.content, 1) : cTagOf(r.content, 2),
			size: r.content.length,
			quickXorHash: remoteHash(r.content),
			lastModified: "",
			deleted: false,
		};
	}
	const p = plan(state, local, index, { ...SETTINGS, maxFileSize: c.cap, excludePatterns: c.patterns });
	return { p, c };
}

function targets(op: PlanOp): string[] {
	if (op.kind === "remote-move" || op.kind === "local-move") return [op.from, op.to];
	return [op.path];
}

function check(p: Plan, c: Case, label: string): void {
	const show = () => `${label}\n${JSON.stringify({ base: [...c.base], local: [...c.local], remote: [...c.remote], union: c.union, cap: c.cap, patterns: c.patterns })}\n${p.ops.map(line).join("\n")}`;
	const isDelete = (op: PlanOp) => op.kind === "remote-delete" || op.kind === "local-trash";

	// (b) union mode never deletes.
	if (c.union) assert.ok(!p.ops.some(isDelete), `union delete\n${show()}`);

	// Exact paths: a case-collision loser shares its caseKey with the tracked keeper, which keeps syncing.
	const skipped = new Set(p.ops.filter((o) => o.kind === "skip").map((o) => o.path.normalize("NFC")));
	for (const op of p.ops) {
		if (op.kind === "skip") continue;
		// (d) nothing at a skipped path is touched.
		for (const t of targets(op)) assert.ok(!skipped.has(t), `op on a skipped path\n${show()}`);
	}

	// Local: the exact spelling, else a case variant that isn't a skipped collision loser. Remote and base: by key
	// (remote names are case-insensitive; two that fold together are both skipped and never reach here).
	const sameKey = <T>(m: Map<string, T>, path: string) => [...m].filter(([p]) => caseKey(p) === caseKey(path));
	const localAt = (path: string) => c.local.get(path) ?? sameKey(c.local, path).find(([p]) => !skipped.has(p))?.[1];
	const oneAt = <T>(m: Map<string, T>, path: string) => m.get(path) ?? sameKey(m, path)[0]?.[1];
	for (const op of p.ops) {
		if (op.kind === "skip" || op.kind === "remote-move" || op.kind === "local-move") continue;
		const b = oneAt(c.base, op.path);
		const l = localAt(op.path);
		const r = oneAt(c.remote, op.path);
		const localUnique = l !== undefined && l !== r?.content && l !== b;
		const remoteUnique = r !== undefined && r.content !== l && (!r.sameItem || r.content !== b);
		// (a) unique local bytes: never trashed, never overwritten by a download.
		if (localUnique) assert.ok(op.kind !== "local-trash" && op.kind !== "download", `lost local bytes\n${show()}`);
		// (a) unique remote bytes: never deleted, never overwritten by an upload.
		if (remoteUnique) assert.ok(op.kind !== "remote-delete" && op.kind !== "upload-replace", `lost remote bytes\n${show()}`);
		// (c) conflicts only when both sides changed (or no base) with different contents.
		if (op.kind === "conflict") {
			assert.ok(l !== undefined && r !== undefined && l !== r.content, `conflict on equal content\n${show()}`);
			if (b !== undefined && r.sameItem) assert.ok(l !== b && r.content !== b, `conflict without two changes\n${show()}`);
		}
	}
}

test("5,000 random three-way states keep every invariant", () => {
	const rnd = prng(0x5eed_2026);
	let conflicts = 0;
	let deletes = 0;
	for (let i = 0; i < 5000; i++) {
		const { p, c } = build(genCase(rnd));
		check(p, c, `case ${i}`);
		conflicts += p.ops.filter((o) => o.kind === "conflict").length;
		deletes += p.deleteCount;
	}
	// The generator must actually reach the interesting rows.
	assert.ok(conflicts > 100, `only ${conflicts} conflicts generated`);
	assert.ok(deletes > 100, `only ${deletes} deletes generated`);
});

test("the planner is deterministic", () => {
	const a = prng(7);
	const b = prng(7);
	for (let i = 0; i < 200; i++) assert.deepEqual(build(genCase(a)).p, build(genCase(b)).p);
});
