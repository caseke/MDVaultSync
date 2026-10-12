// Remote path rebuild from parentId chains (design §5.2) [G-DL-6], [G-DL-7], and remote-side skips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRemoteTree } from "../src/core/remote-tree.ts";
import type { RemoteItem } from "../src/core/ports.ts";
import { CFG } from "./fakes/plan-fixtures.ts";

const ROOT = "root";
const PREFIX = 16;

function it(id: string, parentId: string | null, name: string, isFolder = false, extra: Partial<RemoteItem> = {}): RemoteItem {
	return { id, parentId, name, isFolder, eTag: `"${id}"`, cTag: null, size: 1, quickXorHash: null, lastModified: "", deleted: false, ...extra };
}

function index(...items: RemoteItem[]): Record<string, RemoteItem> {
	return Object.fromEntries([it(ROOT, null, "MDVaultSync", true), ...items].map((i) => [i.id, i]));
}

function paths(t: ReturnType<typeof buildRemoteTree>): Record<string, string> {
	return Object.fromEntries([...t.byId].map(([id, e]) => [id, e.path]));
}

test("rebuilds nested paths and leaves the approot out", () => {
	const t = buildRemoteTree(index(it("d", ROOT, "Notes", true), it("s", "d", "Sub", true), it("f", "s", "a.md"), it("g", ROOT, "b.md")), ROOT, CFG, PREFIX);
	assert.deepEqual(paths(t), { d: "Notes", s: "Notes/Sub", f: "Notes/Sub/a.md", g: "b.md" });
	assert.deepEqual(t.skipped, []);
	assert.equal(t.childCount.get(ROOT), 2);
	assert.equal(t.childCount.get("s"), 1);
});

test("drops deleted items, orphans and cycles", () => {
	const t = buildRemoteTree(
		index(it("x", ROOT, "gone.md", false, { deleted: true }), it("o", "missing", "orphan.md"), it("c1", "c2", "a", true), it("c2", "c1", "b", true), it("k", "c1", "in-cycle.md")),
		ROOT,
		CFG,
		PREFIX,
	);
	assert.deepEqual(paths(t), {});
	assert.deepEqual(t.skipped, []);
	assert.deepEqual([...t.unresolvedIds].sort(), ["c1", "c2", "k", "o"], "live but unplaceable items are not deletes");
});

test("no approot id means no tree, and every live item is unresolved", () => {
	const t = buildRemoteTree(index(it("f", ROOT, "a.md")), null, CFG, PREFIX);
	assert.equal(t.byId.size, 0);
	assert.ok(t.unresolvedIds.has("f"));
	assert.equal(t.childCount.get(ROOT), 1);
});

test("hostile names are skipped, and a skipped folder takes its descendants with it (T-T1, T-E1)", () => {
	const t = buildRemoteTree(
		index(
			it("up", ROOT, ".."),
			it("dot", ROOT, ".", true),
			it("dotkid", "dot", "x.md"),
			it("cfg", ROOT, CFG, true),
			it("plug", "cfg", "plugins", true),
			it("main", "plug", "main.js"),
			it("hid", ROOT, ".git", true),
			it("bs", ROOT, "a\\b.md"),
			it("ctl", ROOT, "a\u0001b.md"),
			it("long", ROOT, "n".repeat(256)),
			it("dir", ROOT, "trailing.", true),
			it("dirkid", "dir", "x.md"),
		),
		ROOT,
		CFG,
		PREFIX,
	);
	assert.deepEqual(paths(t), {});
	const reasons = Object.fromEntries(t.skipped.map((s) => [s.id, `${s.displayPath} (${s.reason})`]));
	assert.deepEqual(reasons, {
		up: ".. (outside-vault)",
		dot: ". (outside-vault)",
		dotkid: "./x.md (outside-vault)",
		cfg: `${CFG} (hidden)`,
		plug: `${CFG}/plugins (hidden)`,
		main: `${CFG}/plugins/main.js (hidden)`,
		hid: ".git (hidden)",
		bs: "a\\b.md (outside-vault)",
		ctl: "a\u0001b.md (outside-vault)",
		long: `${"n".repeat(256)} (invalid-name)`,
		dir: "trailing. (invalid-name)",
		dirkid: "trailing./x.md (invalid-name)",
	});
	assert.equal(t.skippedIds.get("main"), "hidden");
	assert.equal(t.childCount.get(ROOT), 8, "skipped children still count (R-DEL-3)");
});

test("siblings that collide by Unicode form or case are all skipped, with their descendants (M4 carry-in)", () => {
	const t = buildRemoteTree(
		index(
			it("a", ROOT, "Notes", true),
			it("b", ROOT, "notes", true),
			it("ak", "a", "x.md"),
			it("n1", ROOT, "café.md"),
			it("n2", ROOT, "café.md"),
			it("n3", ROOT, "CAFÉ.md"),
			it("ok", ROOT, "fine.md"),
		),
		ROOT,
		CFG,
		PREFIX,
	);
	assert.deepEqual(paths(t), { ok: "fine.md" });
	const reasons = Object.fromEntries(t.skipped.map((s) => [s.id, s.reason]));
	assert.deepEqual(reasons, { a: "case-collision", b: "case-collision", ak: "case-collision", n1: "unicode-collision", n2: "unicode-collision", n3: "case-collision" });
	assert.equal(t.skipped.find((s) => s.id === "n2")?.mapped, "café.md");
	assert.equal(t.skipped.find((s) => s.id === "ak")?.mapped, null);
});

test("the full-path limit counts the App Folder prefix [G-NM-4]", () => {
	const dir = "d".repeat(200);
	const ok = "f".repeat(400 - PREFIX - 1 - dir.length - 1);
	const t = buildRemoteTree(index(it("d", ROOT, dir, true), it("ok", "d", ok), it("bad", "d", ok + "x")), ROOT, CFG, PREFIX);
	assert.deepEqual(Object.keys(paths(t)).sort(), ["d", "ok"]);
	assert.equal(t.skippedIds.get("bad"), "path-too-long");
});
