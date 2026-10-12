// Status bar and ribbon tooltip text (R-UI-2, design §5.6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSyncTime, statusText } from "../src/ui/status.ts";

const NOW = new Date(2026, 9, 12, 15, 30).getTime();
const T1402 = new Date(2026, 9, 12, 14, 2).getTime();
const YESTERDAY = new Date(2026, 9, 11, 9, 5).getTime();

test("times: today as HH:MM, older as YYYY-MM-DD HH:MM", () => {
	assert.equal(formatSyncTime(T1402, NOW), "14:02");
	assert.equal(formatSyncTime(YESTERDAY, NOW), "2026-10-11 09:05");
});

test("every engine status has text", () => {
	const ctx = { now: NOW, lastSyncAt: null, signedIn: true };
	assert.equal(statusText({ state: "idle", lastSyncAt: T1402 }, ctx), "Synced 14:02");
	assert.equal(statusText({ state: "idle", lastSyncAt: null }, ctx), "Not synced yet");
	assert.equal(statusText({ state: "idle", lastSyncAt: null }, { ...ctx, lastSyncAt: YESTERDAY }), "Synced 2026-10-11 09:05");
	assert.equal(statusText({ state: "syncing", phase: "pull" }, ctx), "Syncing…");
	assert.equal(statusText({ state: "waiting-for-user" }, ctx), "Waiting for you: open MDVaultSync to review");
	assert.equal(statusText({ state: "error", code: "network" }, ctx), "Sync error (network)");
	assert.equal(statusText({ state: "sign-in-required" }, ctx), "Sign-in required");
});

test("every state also shows the last successful sync time when there is one (R-UI-2, M7 review)", () => {
	const ctx = { now: NOW, lastSyncAt: T1402, signedIn: true };
	assert.equal(statusText({ state: "syncing", phase: "pull" }, ctx), "Syncing… (last synced 14:02)");
	assert.equal(statusText({ state: "waiting-for-user" }, ctx), "Waiting for you: open MDVaultSync to review (last synced 14:02)");
	assert.equal(statusText({ state: "error", code: "network" }, ctx), "Sync error (network) (last synced 14:02)");
	assert.equal(statusText({ state: "sign-in-required" }, ctx), "Sign-in required (last synced 14:02)");
});

test("an idle engine while signed out says so", () => {
	assert.equal(statusText({ state: "idle", lastSyncAt: null }, { now: NOW, lastSyncAt: T1402, signedIn: false }), "Signed out");
	assert.equal(statusText({ state: "sign-in-required" }, { now: NOW, lastSyncAt: null, signedIn: false }), "Sign-in required");
});

test("an error code that isn't a plain identifier is shown as 'other'", () => {
	assert.equal(statusText({ state: "error", code: "a b/c" }, { now: NOW, lastSyncAt: null, signedIn: true }), "Sync error (other)");
});
