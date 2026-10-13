// Request timeouts (M7 carry-in "Long requests", design §6.1): requestUrl has no timeout of its own, so every
// request races a timer. A timeout is not retried; the run ends partial and the next run continues.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/core/ports.ts";
import { classifyError } from "../src/remote/classify.ts";
import { NetworkError } from "../src/remote/errors.ts";
import { RetryPolicy } from "../src/remote/retry.ts";
import { API_TIMEOUT_MS, RequestTimeout, TimeoutTransport, timeoutFor, type SetTimer } from "../src/remote/timeout.ts";
import { runOutcome } from "../src/core/failure.ts";
import { FakeClock, deferred } from "./fakes/fake-http.ts";

/** Timers that fire only when the test says so. */
class FakeTimers {
	readonly timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
	readonly set: SetTimer = (ms, fn) => {
		const t = { ms, fn, cancelled: false };
		this.timers.push(t);
		return () => {
			t.cancelled = true;
		};
	};
	fireAll(): void {
		for (const t of this.timers) if (!t.cancelled) t.fn();
	}
	get live(): number {
		return this.timers.filter((t) => !t.cancelled).length;
	}
}

const ok: HttpResponse = { status: 200, headers: {}, body: new ArrayBuffer(0) };
const tick = () => new Promise<void>((r) => setImmediate(r));

function hanging(): { transport: HttpTransport; answer: (r: HttpResponse) => void; fail: (e: unknown) => void; seen: HttpRequest[] } {
	const seen: HttpRequest[] = [];
	let answer!: (r: HttpResponse) => void;
	let fail!: (e: unknown) => void;
	return {
		transport: {
			send: (req) => {
				seen.push(req);
				return new Promise<HttpResponse>((res, rej) => {
					answer = res;
					fail = rej;
				});
			},
		},
		answer: (r) => answer(r),
		fail: (e) => fail(e),
		seen,
	};
}

test("timeoutFor: 2 minutes, plus 1 s per 64 KiB of body", () => {
	assert.equal(API_TIMEOUT_MS, 120_000);
	assert.equal(timeoutFor(0), 120_000);
	assert.equal(timeoutFor(1), 121_000);
	assert.equal(timeoutFor(65_536), 121_000);
	assert.equal(timeoutFor(10 * 1024 * 1024), 120_000 + 160_000, "a 10 MiB fragment gets 280 s");
	assert.equal(timeoutFor(100 * 1024 * 1024), 120_000 + 1_600_000, "the 100 MiB cap gets about 29 minutes");
	assert.equal(timeoutFor(-5), 120_000);
	assert.equal(timeoutFor(Number.NaN), 120_000);
});

test("a request that never answers rejects RequestTimeout when its timer fires; the late answer is dropped", async () => {
	const h = hanging();
	const timers = new FakeTimers();
	const t = new TimeoutTransport(h.transport, timers.set);
	const p = t.send({ url: "https://graph.microsoft.com/v1.0/me/drive", method: "GET" });
	await tick();
	assert.equal(timers.timers[0]?.ms, API_TIMEOUT_MS);
	timers.fireAll();
	await assert.rejects(p, RequestTimeout);
	h.answer(ok); // arrives after the run gave up: nothing happens
	await tick();
});

test("a late failure after the timeout is swallowed (no unhandled rejection)", async () => {
	const h = hanging();
	const timers = new FakeTimers();
	const p = new TimeoutTransport(h.transport, timers.set).send({ url: "https://x.example/", method: "GET" });
	await tick();
	timers.fireAll();
	await assert.rejects(p, RequestTimeout);
	h.fail(new NetworkError());
	await tick();
});

test("an answer before the deadline passes through and cancels the timer", async () => {
	const h = hanging();
	const timers = new FakeTimers();
	const p = new TimeoutTransport(h.transport, timers.set).send({ url: "https://x.example/", method: "GET" });
	await tick();
	h.answer(ok);
	assert.equal(await p, ok);
	assert.equal(timers.live, 0, "the timer is cleared");
	timers.fireAll(); // a stale timer callback changes nothing
});

test("a failure before the deadline passes through unchanged", async () => {
	const h = hanging();
	const timers = new FakeTimers();
	const p = new TimeoutTransport(h.transport, timers.set).send({ url: "https://x.example/", method: "GET" });
	await tick();
	h.fail(new NetworkError());
	await assert.rejects(p, NetworkError);
	assert.equal(timers.live, 0);
});

test("the deadline scales with the body, and an explicit timeoutMs wins", async () => {
	const h = hanging();
	const timers = new FakeTimers();
	const t = new TimeoutTransport(h.transport, timers.set);
	void t.send({ url: "https://x.example/", method: "PUT", body: new ArrayBuffer(10 * 1024 * 1024) }).catch(() => {});
	void t.send({ url: "https://x.example/", method: "POST", body: "a=b" }).catch(() => {});
	void t.send({ url: "https://x.example/", method: "GET", timeoutMs: 999_000 }).catch(() => {});
	void t.send({ url: "https://x.example/", method: "GET", timeoutMs: -1 }).catch(() => {});
	await tick();
	assert.deepEqual(
		timers.timers.map((x) => x.ms),
		[280_000, 121_000, 999_000, 120_000],
		"string bodies count their UTF-8 bytes; a nonsense timeoutMs falls back to the default",
	);
	assert.equal(h.seen[2]?.timeoutMs, 999_000, "the request reaches the inner transport unchanged");
	timers.fireAll();
});

test("RetryPolicy does not retry a timeout; the classifier makes it a partial-run network failure", async () => {
	let calls = 0;
	const retry = new RetryPolicy({ clock: new FakeClock(), random: () => 0 });
	await assert.rejects(
		retry.execute(() => {
			calls++;
			return Promise.reject(new RequestTimeout());
		}),
		RequestTimeout,
	);
	assert.equal(calls, 1);
	const f = classifyError(new RequestTimeout());
	assert.deepEqual(f, { kind: "network", code: "timeout" });
	assert.equal(runOutcome(f.kind), "partial");
});

test("RequestTimeout carries no URL", async () => {
	const d = deferred<HttpResponse>();
	const timers = new FakeTimers();
	const p = new TimeoutTransport({ send: () => d.promise }, timers.set).send({ url: "https://x.example/up/S1?tempauth=SECRET", method: "GET" });
	await tick();
	timers.fireAll();
	const e = await p.then(
		() => assert.fail("expected a timeout"),
		(x: unknown) => x,
	);
	assert.ok(e instanceof RequestTimeout);
	assert.equal(e.message, "timeout");
	assert.ok(!JSON.stringify({ m: e.message, n: e.name, s: e.stack ?? "" }).includes("SECRET"));
});
