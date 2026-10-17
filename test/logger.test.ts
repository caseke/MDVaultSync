import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { LOG_CAPACITY, RingLogger, NULL_LOGGER } from "../src/core/logger.ts";

function setup(debug = false) {
	let t = 1000;
	const log = new RingLogger({ now: () => t++, debug: () => debug });
	return log;
}

test("records op and numeric fields with a timestamp", () => {
	const log = setup();
	log.event("graph.request", { status: 200, durationMs: 12 });
	assert.deepEqual(log.entries(), [{ t: 1000, op: "graph.request", status: 200, durationMs: 12 }]);
});

test("keeps only the newest LOG_CAPACITY entries", () => {
	const log = setup();
	for (let i = 0; i < LOG_CAPACITY + 7; i++) log.event("graph.request", { count: i });
	const e = log.entries();
	assert.equal(LOG_CAPACITY, 500);
	assert.equal(e.length, LOG_CAPACITY);
	assert.equal(e[0]?.count, 7);
	assert.equal(e[e.length - 1]?.count, LOG_CAPACITY + 6);
});

test("codes that aren't short identifiers become 'other'", () => {
	const log = setup();
	const bad = ["notes/Secret Plan.md", "Bearer eyJhbGciOi", "", "a".repeat(65), "x y", "é"];
	for (const code of bad) log.event("graph.request", { code });
	log.event("graph.request", { code: "nameAlreadyExists" });
	log.event("graph.request", { code: "retry.budget-exceeded_1" });
	assert.deepEqual(
		log.entries().map((e) => e.code),
		[...bad.map(() => "other"), "nameAlreadyExists", "retry.budget-exceeded_1"],
	);
});

test("non-finite or non-number numeric fields are dropped", () => {
	const log = setup();
	log.event("graph.request", { status: Number.NaN, durationMs: Infinity, count: "12" as unknown as number, attempt: 2 });
	assert.deepEqual(log.entries(), [{ t: 1000, op: "graph.request", attempt: 2 }]);
});

test("unknown keys passed at runtime are ignored", () => {
	const log = setup();
	const fields = { status: 404, path: "Private/Diary.md", token: "RT-SENTINEL" } as unknown as { status: number };
	log.event("graph.request", fields);
	const s = log.serialize();
	assert.ok(!s.includes("Diary") && !s.includes("RT-SENTINEL"));
	assert.deepEqual(log.entries(), [{ t: 1000, op: "graph.request", status: 404 }]);
});

test("an op outside the OpKind shape is dropped", () => {
	const log = setup();
	log.event("notes/Diary.md" as unknown as "graph.request", {});
	assert.equal(log.entries().length, 0);
});

test("serialize is JSON lines of the entries; clear empties the buffer", () => {
	const log = setup();
	log.event("retry.backoff", { attempt: 1 });
	log.event("op.upload-new", { count: 2 });
	assert.deepEqual(log.serialize().split("\n").map((l) => JSON.parse(l) as unknown), log.entries());
	log.clear();
	assert.equal(log.serialize(), "");
});

test("mirrors to console.debug only when verbose logging is on, never console.log", () => {
	const dbg = mock.method(console, "debug", () => {});
	const lg = mock.method(console, "log", () => {});
	try {
		setup(false).event("graph.request", { status: 200 });
		assert.equal(dbg.mock.callCount(), 0);
		setup(true).event("graph.request", { status: 200 });
		assert.equal(dbg.mock.callCount(), 1);
		assert.equal(lg.mock.callCount(), 0);
	} finally {
		dbg.mock.restore();
		lg.mock.restore();
	}
});

test("entries() returns copies", () => {
	const log = setup();
	log.event("graph.request", { status: 1 });
	const e = log.entries();
	(e[0] as { status?: number }).status = 99;
	assert.equal(log.entries()[0]?.status, 1);
});

test("NULL_LOGGER accepts events", () => {
	NULL_LOGGER.event("graph.request", { status: 200 });
});

test("ui.settings breadcrumbs are kept, with a fixed code and a count (M8 matrix row 10)", () => {
	const log = new RingLogger({ now: () => 0 });
	log.event("ui.settings", { code: "account-2-done" });
	log.event("ui.settings", { code: "refresh", count: 3 });
	assert.deepEqual(log.entries(), [
		{ t: 0, op: "ui.settings", code: "account-2-done" },
		{ t: 0, op: "ui.settings", code: "refresh", count: 3 },
	]);
});
