// Calls per second for the settings refresh breadcrumb (M8 matrix row 10): a refresh storm shows as a rising count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RecentCounter } from "../src/ui/recent-counter.ts";

test("RecentCounter counts hits inside the window and forgets older ones", () => {
	const c = new RecentCounter(1_000);
	assert.equal(c.hit(0), 1);
	assert.equal(c.hit(500), 2);
	assert.equal(c.hit(999), 3);
	assert.equal(c.hit(1_000), 3, "the hit at 0 left the window");
	assert.equal(c.hit(5_000), 1);
});

test("RecentCounter keeps a bounded history under a storm", () => {
	const c = new RecentCounter(1_000, 50);
	let n = 0;
	for (let i = 0; i < 10_000; i++) n = c.hit(0);
	assert.equal(n, 50, "capped: a storm reads as at least the cap");
});
