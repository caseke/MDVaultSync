import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES_PROBED, DELTA_FORM, NAME_MAX, PUT_HONORS_IF_MATCH } from "../src/remote/capabilities.ts";

// Pins the values applied from the M3 probe (docs/plan.md M3, research.md). Change them only with new probe evidence.
test("capabilities applied from the Ubuntu probe runs (v1 and v2, 2026-10-12)", () => {
	assert.equal(PUT_HONORS_IF_MATCH, true, "stale If-Match on PUT returned 412 [G-UP-3]");
	assert.equal(DELTA_FORM, "items-id", "items-id delta worked, approot-colon did not [G-DL-1]");
	assert.equal(NAME_MAX, 255, "256 accepted, 300 rejected: send at most 255 [G-NM-6]");
});

test("CAPABILITIES_PROBED is true: every probe question passed on Ubuntu and the iPad (0.3.5, 2026-10-12)", () => {
	assert.equal(CAPABILITIES_PROBED, true);
});
