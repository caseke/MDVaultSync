// Whether a trigger runs a sync (R-TRIG-1…3): unattended triggers never nag a signed-out user.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Trigger } from "../src/core/ports.ts";
import { triggerDecision } from "../src/ui/triggers.ts";

const ALL: Trigger[] = ["startup", "interval", "command", "ribbon", "preview", "rerun"];

test("signed in: every trigger runs", () => {
	for (const t of ALL) assert.deepEqual(triggerDecision(t, "signed-in", true), { action: "run" }, t);
});

test("not signed in: startup and interval skip silently; user actions explain why", () => {
	for (const status of ["signed-out", "sign-in-required"] as const) {
		for (const t of ["startup", "interval", "rerun"] as Trigger[]) assert.deepEqual(triggerDecision(t, status, true), { action: "skip" }, `${status} ${t}`);
		for (const t of ["command", "ribbon", "preview"] as Trigger[]) {
			const d = triggerDecision(t, status, true);
			assert.equal(d.action, "notice", `${status} ${t}`);
		}
	}
	const noId = triggerDecision("command", "signed-out", false);
	assert.ok(noId.action === "notice" && /client\) ID/.test(noId.text));
	const expired = triggerDecision("ribbon", "sign-in-required", true);
	assert.ok(expired.action === "notice" && /expired|revoked/.test(expired.text));
});
