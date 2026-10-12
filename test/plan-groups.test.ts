// What the preview modal and the report view list (R-FIRST-2, R-CONF-3, T-R1).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Plan, PlanOp, SyncReport, VaultPath } from "../src/core/ports.ts";
import { previewGroups, reportSummary } from "../src/ui/plan-groups.ts";

const vp = (p: string) => p as VaultPath;

function plan(ops: PlanOp[], over: Partial<Plan> = {}): Plan {
	return { ops, deleteCount: 0, trackedCount: 0, unionMode: false, differsNoHistory: 0, ...over };
}

test("preview groups ops by what happens, with counts; adopt and forget are hidden", () => {
	const g = previewGroups(
		plan([
			{ kind: "download", id: "1", path: vp("d.md"), reason: "new" },
			{ kind: "upload-new", path: vp("u1.md") },
			{ kind: "upload-replace", path: vp("u2.md"), id: "2", ifMatch: "e" },
			{ kind: "local-move", from: vp("a.md"), to: vp("b.md") },
			{ kind: "remote-move", id: "3", ifMatch: "e", from: vp("c.md"), to: vp("e.md") },
			{ kind: "local-trash", path: vp("t.md") },
			{ kind: "remote-delete", id: "4", ifMatch: "e", path: vp("r.md") },
			{ kind: "conflict", path: vp("k.md"), id: "5", copyPath: vp("k (conflict).md") },
			{ kind: "conflict", path: vp("n.md"), id: "6", copyPath: vp("n (conflict).md"), noHistory: true },
			{ kind: "adopt", path: vp("same.md"), id: "7" },
			{ kind: "forget", path: vp("gone.md") },
			{ kind: "skip", path: vp("big.bin"), reason: "too-large" },
		]),
	);
	assert.deepEqual(
		g.map((x) => [x.id, x.count]),
		[
			["download", 1],
			["upload", 2],
			["move", 2],
			["delete", 2],
			["conflict", 1],
			["no-history", 1],
			["skip", 1],
		],
	);
	const by = (id: string) => g.find((x) => x.id === id)?.lines ?? [];
	assert.deepEqual(by("move"), ["a.md → b.md (on this device)", "c.md → e.md (in OneDrive)"]);
	assert.deepEqual(by("delete"), ["t.md (to this device's trash)", "r.md (to the OneDrive recycle bin)"]);
	assert.deepEqual(by("conflict"), ["k.md (this device's version kept as k (conflict).md)"]);
	assert.deepEqual(by("skip"), ["big.bin (larger than the size limit)"]);
	assert.equal(g.find((x) => x.id === "no-history")?.label, "Differs on both sides, no sync history");
});

test("empty groups are left out; an empty plan has none", () => {
	assert.deepEqual(previewGroups(plan([{ kind: "adopt", path: vp("a.md"), id: "1" }])), []);
	assert.deepEqual(previewGroups(plan([])), []);
});

test("names in groups are display-escaped", () => {
	const g = previewGroups(plan([{ kind: "upload-new", path: vp("x\u202Ey.md") }]));
	assert.deepEqual(g[0]?.lines, ["x\\u{202E}y.md"]);
});

test("every skip reason has text", () => {
	const reasons = ["too-large", "invalid-name", "path-too-long", "case-collision", "reserved-name", "outside-vault", "hidden", "excluded", "unicode-collision"] as const;
	const g = previewGroups(plan(reasons.map((reason, i) => ({ kind: "skip", path: vp(`f${i}`), reason }))));
	for (const line of g[0]?.lines ?? []) assert.doesNotMatch(line, /\(\w+-\w+\)$/, "a readable reason, not the code");
	assert.equal(g[0]?.count, reasons.length);
});

test("the report summary lists result, counts, changes, conflicts, skips and errors (T-R1)", () => {
	const r: SyncReport = {
		trigger: "command",
		startedAt: 1,
		finishedAt: new Date(2026, 9, 12, 14, 2).getTime(),
		result: "partial",
		counts: { download: 2, "upload-new": 1, "upload-replace": 0, "remote-move": 0, "local-move": 1, "remote-delete": 0, "local-trash": 0, conflict: 1, adopt: 0, forget: 0, skip: 1 },
		touched: [
			{ kind: "download", path: vp("d.md") },
			{ kind: "local-move", path: vp("a.md"), to: vp("b.md") },
		],
		conflicts: [{ path: vp("k.md"), copyPath: vp("k (conflict).md") }],
		skipped: [{ path: vp("big.bin"), reason: "too-large" }],
		errors: [
			{ path: vp("x.md"), code: "hash-mismatch" },
			{ path: null, code: "network" },
		],
	};
	const s = reportSummary(r, new Date(2026, 9, 12, 15, 0).getTime());
	assert.equal(s.heading, "14:02: some files didn't sync");
	assert.deepEqual(s.counts, ["2 downloaded", "1 uploaded", "1 moved or renamed", "1 conflict", "1 skipped"]);
	const by = (id: string) => s.groups.find((x) => x.id === id)?.lines ?? [];
	assert.deepEqual(by("changed"), ["d.md (downloaded)", "a.md → b.md (moved on this device)"]);
	assert.deepEqual(by("conflict"), ["k.md (this device's version kept as k (conflict).md)"]);
	assert.deepEqual(by("skip"), ["big.bin (larger than the size limit)"]);
	assert.equal(by("error").length, 2);
	assert.match(by("error")[1] ?? "", /^Whole sync: /);
});

test("report headings for each result", () => {
	const base: SyncReport = {
		trigger: "interval", startedAt: 0, finishedAt: new Date(2026, 9, 12, 14, 2).getTime(), result: "ok",
		counts: { download: 0, "upload-new": 0, "upload-replace": 0, "remote-move": 0, "local-move": 0, "remote-delete": 0, "local-trash": 0, conflict: 0, adopt: 0, forget: 0, skip: 0 },
		touched: [], conflicts: [], skipped: [], errors: [],
	};
	const now = new Date(2026, 9, 12, 15, 0).getTime();
	assert.equal(reportSummary(base, now).heading, "14:02: synced");
	assert.deepEqual(reportSummary(base, now).counts, ["Nothing changed"]);
	assert.equal(reportSummary({ ...base, result: "failed" }, now).heading, "14:02: sync failed");
	assert.equal(reportSummary({ ...base, result: "cancelled" }, now).heading, "14:02: cancelled");
});
