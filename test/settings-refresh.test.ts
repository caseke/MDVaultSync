// When the settings tab may re-render (M8 matrix row 10): only while it is on screen. A status change while the
// tab is closed (a revoked grant seen by a background sync) must not call update() on a closed tab.
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
