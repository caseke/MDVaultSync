// Which notices a finished sync raises (R-UI-3, R-CONF-2, design §5.6): errors and conflicts only.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SyncReport, Trigger, VaultPath } from "../src/core/ports.ts";
import { ERROR_TEXT, errorText, noticesFor } from "../src/ui/notices.ts";

const vp = (p: string) => p as VaultPath;

function report(over: Partial<SyncReport> = {}): SyncReport {
	return {
		trigger: "interval",
		startedAt: 0,
		finishedAt: 1,
		result: "ok",
		counts: { download: 0, "upload-new": 0, "upload-replace": 0, "remote-move": 0, "local-move": 0, "remote-delete": 0, "local-trash": 0, conflict: 0, adopt: 0, forget: 0, skip: 0 },
		touched: [],
		conflicts: [],
		skipped: [],
		errors: [],
		...over,
	};
}

test("a successful sync with no conflicts raises no notice (R-UI-3)", () => {
	assert.deepEqual(noticesFor(report({ skipped: [{ path: vp("big.bin"), reason: "too-large" }] }), null), []);
});

test("a cancelled preview raises no notice", () => {
	assert.deepEqual(noticesFor(report({ result: "cancelled", errors: [] }), null), []);
});

test("conflicts raise one persistent notice listing every copy (R-CONF-2)", () => {
	const r = report({
		conflicts: [
			{ path: vp("a.md"), copyPath: vp("a (conflict iPad 2026-10-12 140200).md") },
			{ path: vp("b\u202E.md"), copyPath: vp("b\u202E (conflict iPad 2026-10-12 140200).md") },
		],
	});
	const n = noticesFor(r, null);
	assert.equal(n.length, 1);
	assert.equal(n[0]?.persistent, true);
	assert.deepEqual(n[0]?.lines, ["a (conflict iPad 2026-10-12 140200).md", "b\\u{202E} (conflict iPad 2026-10-12 140200).md"]);
	assert.match(n[0]?.message ?? "", /2 conflict/);
});

test("errors raise a notice with readable text; conflicts and errors together raise both", () => {
	const r = report({
		result: "partial",
		conflicts: [{ path: vp("a.md"), copyPath: vp("a (conflict).md") }],
		errors: [
			{ path: vp("x.md"), code: "hash-mismatch" },
			{ path: null, code: "network" },
		],
	});
	const n = noticesFor(r, null);
	assert.equal(n.length, 2);
	const err = n[1];
	assert.ok(err);
	assert.equal(err.persistent, false);
	assert.ok(err.message.startsWith(ERROR_TEXT["hash-mismatch"] ?? "missing"));
	assert.match(err.message, /1 more/);
	assert.deepEqual(err.lines, [`x.md: ${errorText("hash-mismatch")}`]);
});

test("every M6 carry-in code and run-level failure has its own text", () => {
	for (const code of ["type-clash", "changed-during-sync", "hash-mismatch", "too-large", "conflict-name", "path-too-long", "network", "retry-budget-exceeded", "quota", "forbidden", "unsafe-path", "replace-raced", "untrusted-url", "invalid-response"]) {
		assert.ok(ERROR_TEXT[code], code);
		assert.equal(errorText(code), ERROR_TEXT[code]);
	}
	assert.equal(errorText("graph-500"), "Sync error (graph-500).");
	assert.equal(errorText("<script>"), "Sync error (other).");
	assert.equal(errorText("__proto__"), "Sync error (__proto__).");
});

test("an auth failure is silent on unattended triggers (the sign-in notice already showed) and explained on 'Sync now'", () => {
	for (const t of ["startup", "interval", "rerun"] as Trigger[]) {
		assert.deepEqual(noticesFor(report({ trigger: t, result: "failed", errors: [{ path: null, code: "sign-in-required" }] }), null), [], t);
	}
	for (const t of ["command", "ribbon", "preview"] as Trigger[]) {
		const n = noticesFor(report({ trigger: t, result: "failed", errors: [{ path: null, code: "unauthorized" }] }), null);
		assert.equal(n.length, 1, t);
		assert.match(n[0]?.message ?? "", /[Ss]ign in/);
	}
});

test("an unattended run repeating the previous run's error doesn't notice again; 'Sync now' always does", () => {
	const prev = report({ result: "partial", errors: [{ path: null, code: "network" }] });
	assert.deepEqual(noticesFor(report({ result: "partial", errors: [{ path: null, code: "network" }] }), prev), []);
	assert.equal(noticesFor(report({ result: "partial", errors: [{ path: null, code: "quota" }] }), prev).length, 1, "a new error notices");
	assert.equal(noticesFor(report({ trigger: "command", result: "partial", errors: [{ path: null, code: "network" }] }), prev).length, 1);
	assert.equal(noticesFor(report({ result: "partial", errors: [{ path: null, code: "network" }] }), report()).length, 1, "after an ok run it notices");
});

test("at most 10 error lines are listed", () => {
	const errors = Array.from({ length: 15 }, (_, i) => ({ path: vp(`f${i}.md`), code: "type-clash" }));
	const n = noticesFor(report({ trigger: "command", result: "partial", errors }), null);
	assert.equal(n[0]?.lines.length, 10);
});
