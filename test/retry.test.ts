import { test } from "node:test";
import assert from "node:assert/strict";
import { RetryPolicy, parseRetryAfter, isRetryableStatus } from "../src/remote/retry.ts";
import { NetworkError, RetryBudgetExceeded } from "../src/remote/errors.ts";
import { RingLogger } from "../src/core/logger.ts";
import { FakeClock } from "./fakes/fake-http.ts";
import type { HttpResponse } from "../src/core/ports.ts";

const res = (status: number, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: new ArrayBuffer(0) });

function setup(random = () => 0.5, extra: { budgetMs?: number } = {}) {
	const clock = new FakeClock();
	const log = new RingLogger({ now: () => clock.now() });
	const sleeps: number[] = [];
	const sleep = clock.sleep.bind(clock);
	clock.sleep = (ms: number) => {
		sleeps.push(ms);
		return sleep(ms);
	};
	const policy = new RetryPolicy({ clock, random, logger: log, ...extra });
	return { clock, log, sleeps, policy };
}

/** A send that returns the scripted responses in order (an Error entry is thrown). */
function script(items: (HttpResponse | Error)[], clock?: FakeClock) {
	const times: number[] = [];
	let i = 0;
	const send = () => {
		if (clock) times.push(clock.now());
		const next = items[i++];
		if (!next) throw new Error("script exhausted");
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	};
	return { send, times, calls: () => i };
}

test("parseRetryAfter: seconds, HTTP date, clamping, junk", () => {
	const now = Date.parse("2026-10-12T00:00:00Z");
	assert.equal(parseRetryAfter("5", now), 5_000);
	assert.equal(parseRetryAfter(" 7 ", now), 7_000);
	assert.equal(parseRetryAfter("0", now), 1_000);
	assert.equal(parseRetryAfter("100000", now), 300_000);
	assert.equal(parseRetryAfter("Mon, 12 Oct 2026 00:00:30 GMT", now), 30_000);
	assert.equal(parseRetryAfter("Mon, 11 Oct 2026 00:00:00 GMT", now), 1_000);
	assert.equal(parseRetryAfter("Tue, 13 Oct 2026 00:00:00 GMT", now), 300_000);
	assert.equal(parseRetryAfter(undefined, now), null);
	assert.equal(parseRetryAfter("soon", now), null);
	assert.equal(parseRetryAfter("-3", now), null);
	assert.equal(parseRetryAfter("1.5", now), null);
});

test("isRetryableStatus", () => {
	for (const s of [429, 500, 502, 503, 504, 509]) assert.equal(isRetryableStatus(s), true, String(s));
	for (const s of [200, 201, 202, 204, 400, 401, 403, 404, 409, 410, 412, 413, 416, 507]) assert.equal(isRetryableStatus(s), false, String(s));
});

test("returns a success at once", async () => {
	const { policy, sleeps } = setup();
	const s = script([res(200)]);
	assert.equal((await policy.execute(s.send)).status, 200);
	assert.equal(s.calls(), 1);
	assert.deepEqual(sleeps, []);
});

for (const status of [400, 401, 403, 404, 409, 410, 412, 413, 416, 507]) {
	test(`does not retry ${status}`, async () => {
		const { policy } = setup();
		const s = script([res(status)]);
		assert.equal((await policy.execute(s.send)).status, status);
		assert.equal(s.calls(), 1);
	});
}

test("429 with Retry-After (seconds) waits that long, then retries", async () => {
	const { policy, clock, log } = setup();
	const s = script([res(429, { "retry-after": "12" }), res(200)], clock);
	assert.equal((await policy.execute(s.send)).status, 200);
	assert.equal((s.times[1] ?? 0) - (s.times[0] ?? 0), 12_000);
	assert.deepEqual(
		log.entries().map((e) => [e.op, e.status, e.durationMs, e.attempt]),
		[["retry.backoff", 429, 12_000, 1]],
	);
});

test("503 with Retry-After as an HTTP date is honored; header name case doesn't matter", async () => {
	const { policy, clock } = setup();
	const at = new Date(clock.now() + 20_000).toUTCString();
	const s = script([res(503, { "Retry-After": at }), res(204)], clock);
	assert.equal((await policy.execute(s.send)).status, 204);
	const waited = (s.times[1] ?? 0) - (s.times[0] ?? 0);
	assert.ok(waited >= 19_000 && waited <= 20_000, String(waited));
});

/** A clock whose sleeps resolve only when the test advances time. */
class ManualClock {
	t = 1_700_000_000_000;
	private sleepers: { until: number; resolve: () => void }[] = [];
	now(): number {
		return this.t;
	}
	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => this.sleepers.push({ until: this.t + ms, resolve }));
	}
	advance(ms: number): void {
		this.t += ms;
		const due = this.sleepers.filter((s) => s.until <= this.t);
		this.sleepers = this.sleepers.filter((s) => s.until > this.t);
		for (const s of due) s.resolve();
	}
}
const flush = () => new Promise<void>((r) => setImmediate(r));

test("Retry-After sets a global pause that holds every other request", async () => {
	const clock = new ManualClock();
	const policy = new RetryPolicy({ clock, random: () => 0.5 });
	const a = script([res(429, { "retry-after": "30" }), res(200)]);
	const first = policy.execute(a.send);
	await flush();
	assert.equal(a.calls(), 1);
	assert.equal(policy.pausedUntil, clock.now() + 30_000);
	const b = script([res(200)]);
	const second = policy.execute(b.send);
	await flush();
	assert.equal(b.calls(), 0, "a request started during the pause must wait");
	clock.advance(29_999);
	await flush();
	assert.equal(b.calls(), 0);
	clock.advance(1);
	await flush();
	await Promise.all([first, second]);
	assert.equal(a.calls(), 2);
	assert.equal(b.calls(), 1);
});

test("429 without Retry-After uses backoff", async () => {
	const { policy, sleeps } = setup(() => 0.5);
	const s = script([res(429), res(200)]);
	await policy.execute(s.send);
	assert.deepEqual(sleeps, [500]);
});

test("5xx: full-jitter exponential backoff, capped at 60 s, 6 attempts, last response returned", async () => {
	const { policy, sleeps, log } = setup(() => 0.999999);
	const s = script([res(500), res(502), res(504), res(500), res(500), res(503)]);
	const r = await policy.execute(s.send);
	assert.equal(r.status, 503);
	assert.equal(s.calls(), 6);
	assert.deepEqual(sleeps, [999, 1999, 3999, 7999, 15999]);
	assert.equal(log.entries().length, 5);
});

test("backoff is capped at 60 s", async () => {
	const clock = new FakeClock();
	const sleeps: number[] = [];
	clock.sleep = (ms: number) => {
		sleeps.push(ms);
		clock.advance(ms);
		return Promise.resolve();
	};
	const policy = new RetryPolicy({ clock, random: () => 0.999999, maxAttempts: 10 });
	const s = script(Array.from({ length: 10 }, () => res(500)));
	await policy.execute(s.send);
	assert.equal(Math.max(...sleeps), 59_999);
});

test("jitter is a fraction of the exponential window", async () => {
	const { policy, sleeps } = setup(() => 0);
	await policy.execute(script([res(500), res(500), res(200)]).send);
	assert.deepEqual(sleeps, [0, 0]);
});

test("network errors are retried, then rethrown after the last attempt", async () => {
	const { policy, log } = setup();
	const boom = new NetworkError();
	const s = script([boom, res(200)]);
	assert.equal((await policy.execute(s.send)).status, 200);
	assert.equal(log.entries()[0]?.code, "network");
	const s2 = script(Array.from({ length: 6 }, () => new NetworkError()));
	await assert.rejects(policy.execute(s2.send), /network/);
	assert.equal(s2.calls(), 6);
});

test("total backoff over the run budget throws RetryBudgetExceeded", async () => {
	const { policy } = setup(() => 0.5, { budgetMs: 20_000 });
	const s = script([res(429, { "retry-after": "15" }), res(429, { "retry-after": "15" }), res(200)]);
	await assert.rejects(policy.execute(s.send), RetryBudgetExceeded);
	assert.equal(policy.spentMs, 15_000);
});

test("the default budget is 10 minutes, spent across requests, and resetBudget starts over", async () => {
	const { policy } = setup();
	for (let i = 0; i < 2; i++) await policy.execute(script([res(429, { "retry-after": "300" }), res(200)]).send);
	assert.equal(policy.spentMs, 600_000);
	await assert.rejects(policy.execute(script([res(429, { "retry-after": "1" })]).send), RetryBudgetExceeded);
	policy.resetBudget();
	assert.equal(policy.spentMs, 0);
	assert.equal((await policy.execute(script([res(429, { "retry-after": "1" }), res(200)]).send)).status, 200);
});

test("Retry-After retries are bounded by the budget, not the attempt cap", async () => {
	const { policy } = setup();
	const items = [...Array.from({ length: 8 }, () => res(429, { "retry-after": "1" })), res(200)];
	const s = script(items);
	assert.equal((await policy.execute(s.send)).status, 200);
	assert.equal(s.calls(), 9);
});

test("errors other than NetworkError are rethrown at once, without backoff", async () => {
	const { policy, sleeps, log } = setup();
	class AuthLike extends Error {}
	const s = script([new AuthLike("sign-in-required"), res(200)]);
	await assert.rejects(policy.execute(s.send), AuthLike);
	assert.equal(s.calls(), 1);
	assert.deepEqual(sleeps, []);
	assert.equal(log.entries().length, 0);
});
