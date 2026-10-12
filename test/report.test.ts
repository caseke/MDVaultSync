// SyncReport building (design §5.6, T-R1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, opPath } from "../src/core/report.ts";
import type { Plan, PlanOp } from "../src/core/ports.ts";
import { vp } from "./fakes/plan-fixtures.ts";

const ops: PlanOp[] = [
	{ kind: "skip", path: vp("big.bin"), reason: "too-large" },
	{ kind: "download", id: "i1", path: vp("a.md"), reason: "new" },
	{ kind: "local-move", from: vp("b.md"), to: vp("c.md") },
	{ kind: "conflict", path: vp("d.md"), id: "i2", copyPath: vp("d (conflict iPad 2026-01-05 070809).md") },
	{ kind: "adopt", path: vp("e.md"), id: "i3" },
	{ kind: "forget", path: vp("f.md") },
	{ kind: "remote-delete", id: "i4", ifMatch: '"x"', path: vp("g.md") },
];
const plan: Plan = { ops, deleteCount: 1, trackedCount: 5, unionMode: false, differsNoHistory: 0 };

test("counts completed ops, lists touched paths, conflicts and skips", () => {
	const r = buildReport({ trigger: "command", startedAt: 10, finishedAt: 20, plan, results: ops.filter((o) => o.kind !== "skip").map((op) => ({ op, ok: true as const })) });
	assert.equal(r.result, "ok");
	assert.equal(r.trigger, "command");
	assert.equal(r.startedAt, 10);
	assert.equal(r.finishedAt, 20);
	assert.deepEqual(r.counts, { download: 1, "upload-new": 0, "upload-replace": 0, "remote-move": 0, "local-move": 1, "remote-delete": 1, "local-trash": 0, conflict: 1, adopt: 1, forget: 1, skip: 1 });
	assert.deepEqual(r.touched, [
		{ kind: "download", path: "a.md" },
		{ kind: "local-move", path: "b.md", to: "c.md" },
		{ kind: "conflict", path: "d.md" },
		{ kind: "remote-delete", path: "g.md" },
	]);
	assert.deepEqual(r.conflicts, [{ path: "d.md", copyPath: "d (conflict iPad 2026-01-05 070809).md" }]);
	assert.deepEqual(r.skipped, [{ path: "big.bin", reason: "too-large" }]);
	assert.deepEqual(r.errors, []);
});

test("a failed op makes the run partial; error codes are filtered to identifiers", () => {
	const r = buildReport({
		trigger: "interval",
		startedAt: 0,
		finishedAt: 1,
		plan,
		results: [
			{ op: ops[1] as PlanOp, ok: false, code: "hash-mismatch" },
			{ op: ops[2] as PlanOp, ok: false, code: "token=eyJ secret path/a.md" },
			{ op: ops[0] as PlanOp, ok: true },
		],
	});
	assert.equal(r.result, "partial");
	assert.deepEqual(r.errors, [
		{ path: "a.md", code: "hash-mismatch" },
		{ path: "b.md", code: "other" },
	]);
	assert.deepEqual(r.touched, []);
	assert.equal(r.counts.skip, 1, "skips come from the plan, not from results");
});

test("an early end is failed or cancelled, and run-level errors are kept", () => {
	const failed = buildReport({ trigger: "startup", startedAt: 0, finishedAt: 1, plan, results: [], outcome: "failed", runErrors: [{ path: null, code: "network" }, { path: null, code: "a b" }] });
	assert.equal(failed.result, "failed");
	assert.deepEqual(failed.errors, [
		{ path: null, code: "network" },
		{ path: null, code: "other" },
	]);
	assert.equal(buildReport({ trigger: "preview", startedAt: 0, finishedAt: 1, plan, results: [], outcome: "cancelled" }).result, "cancelled");
});

test("opPath is the source of a move", () => {
	assert.equal(opPath({ kind: "remote-move", id: "i", ifMatch: '"e"', from: vp("x"), to: vp("y") }), "x");
	assert.equal(opPath({ kind: "upload-new", path: vp("z") }), "z");
});
