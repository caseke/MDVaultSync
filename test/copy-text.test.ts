// Copy log (M9 owner note: on Ubuntu the button did nothing, no notice either way). copyText must always settle,
// whatever the clipboard API does, so the log modal can fall back to selecting the text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY_TIMEOUT_MS, copyText, type ClipboardLike, type SetTimer } from "../src/ui/copy-text.ts";

/** A timer the test fires by hand; records the delay asked for. */
function manualTimer() {
	let fire: (() => void) | null = null;
	let delay = -1;
	let cancelled = false;
	const timer: SetTimer = (ms, fn) => {
		delay = ms;
		fire = fn;
		return () => {
			cancelled = true;
		};
	};
	return { timer, fire: () => fire?.(), delay: () => delay, cancelled: () => cancelled };
}

test("a write that succeeds reports copied and cancels the timer", async () => {
	let got = "";
	const clip: ClipboardLike = {
		writeText: (t) => {
			got = t;
			return Promise.resolve();
		},
	};
	const t = manualTimer();
	assert.equal(await copyText("LOG", clip, t.timer), "copied");
	assert.equal(got, "LOG");
	assert.equal(t.delay(), COPY_TIMEOUT_MS);
	assert.ok(t.cancelled());
});

test("a rejected write falls back to manual copy", async () => {
	const clip: ClipboardLike = { writeText: () => Promise.reject(new Error("NotAllowedError")) };
	assert.equal(await copyText("LOG", clip, manualTimer().timer), "manual");
});

test("a write that throws synchronously falls back to manual copy", async () => {
	const clip: ClipboardLike = {
		writeText: () => {
			throw new TypeError("not a function");
		},
	};
	assert.equal(await copyText("LOG", clip, manualTimer().timer), "manual");
});

test("a write that never settles falls back after the timeout", async () => {
	const clip: ClipboardLike = { writeText: () => new Promise<void>(() => undefined) };
	const t = manualTimer();
	const out = copyText("LOG", clip, t.timer);
	t.fire();
	assert.equal(await out, "manual");
});

test("no clipboard API at all falls back to manual copy", async () => {
	assert.equal(await copyText("LOG", undefined, manualTimer().timer), "manual");
	assert.equal(await copyText("LOG", {} as ClipboardLike, manualTimer().timer), "manual");
});

test("a late success after the timeout doesn't change the answer", async () => {
	let resolve: () => void = () => undefined;
	const clip: ClipboardLike = { writeText: () => new Promise<void>((r) => (resolve = r)) };
	const t = manualTimer();
	const out = copyText("LOG", clip, t.timer);
	t.fire();
	resolve();
	assert.equal(await out, "manual");
});
