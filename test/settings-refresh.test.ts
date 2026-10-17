// When the fallback settings renderer (Obsidian before 1.13) may redraw: only while the tab is on screen, since
// drawing prepares a sign-in (R-SEC-1). On 1.13+ the tab always calls update() (M8 matrix row 10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshAction } from "../src/ui/settings-refresh.ts";

test("closed tab: no re-render, even when the container is still attached", () => {
	assert.equal(refreshAction({ onScreen: false, connected: true }), "skip");
});

test("open tab: re-render", () => {
	assert.equal(refreshAction({ onScreen: true, connected: true }), "render");
});

test("a detached container never re-renders", () => {
	assert.equal(refreshAction({ onScreen: true, connected: false }), "skip");
	assert.equal(refreshAction({ onScreen: false, connected: false }), "skip");
});
