// OneDrive storage in settings (T-D7, design §10) [G-QT-1]: the text and the cache behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUOTA_TTL_MS, QuotaCache, formatBytes, quotaText, type Quota } from "../src/ui/quota.ts";
import { deferred } from "./fakes/fake-http.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

test("formatBytes: binary units, as OneDrive shows them", () => {
	assert.equal(formatBytes(0), "0 bytes");
	assert.equal(formatBytes(1), "1 byte");
	assert.equal(formatBytes(1023), "1023 bytes");
	assert.equal(formatBytes(1024), "1 KB");
	assert.equal(formatBytes(1536), "1.5 KB");
	assert.equal(formatBytes(350 * MiB), "350 MB");
	assert.equal(formatBytes(5 * GiB), "5 GB");
	assert.equal(formatBytes(4.25 * GiB), "4.3 GB");
	assert.equal(formatBytes(1024 * GiB), "1 TB");
	assert.equal(formatBytes(-3), "0 bytes");
	assert.equal(formatBytes(Number.NaN), "0 bytes");
});

test("quotaText: used, total and free; a warning at 10 % free or less, and when full", () => {
	assert.deepEqual(quotaText({ total: 5 * GiB, used: 1 * GiB, remaining: 4 * GiB }), {
		text: "1 GB used of 5 GB (4 GB free). The recycle bin counts toward this.",
		warn: false,
	});
	const low = quotaText({ total: 5 * GiB, used: 4.5 * GiB, remaining: 0.5 * GiB });
	assert.equal(low.warn, true);
	assert.match(low.text, /^4\.5 GB used of 5 GB \(512 MB free\)\. OneDrive is almost full/);
	const full = quotaText({ total: 5 * GiB, used: 5 * GiB, remaining: 0 });
	assert.equal(full.warn, true);
	assert.match(full.text, /OneDrive is full\. Sync stops uploading until you free up space, including the recycle bin\./);
	assert.equal(quotaText({ total: 100, used: 89, remaining: 11 }).warn, false);
	assert.equal(quotaText({ total: 100, used: 90, remaining: 10 }).warn, true);
	assert.equal(quotaText({ total: 0, used: 0, remaining: 0 }).warn, true, "a zero-size drive is full");
});

test("quotaText: null means the sign-in can't read it", () => {
	assert.deepEqual(quotaText(null), { text: "Not available for this sign-in.", warn: false });
});

function cache(fetchImpl: () => Promise<Quota | null>, now: { t: number }) {
	let calls = 0;
	const c = new QuotaCache(() => {
		calls++;
		return fetchImpl();
	}, () => now.t);
	return { c, calls: () => calls };
}

const Q: Quota = { total: 10, used: 4, remaining: 6 };

test("QuotaCache: one request per 5 minutes; callers during a request share it", async () => {
	const now = { t: 1_000 };
	const d = deferred<Quota | null>();
	const { c, calls } = cache(() => d.promise, now);
	const a = c.get();
	const b = c.get();
	assert.equal(calls(), 1, "concurrent renders share one request");
	d.resolve(Q);
	assert.equal(await a, Q);
	assert.equal(await b, Q);
	now.t += QUOTA_TTL_MS - 1;
	assert.equal(await c.get(), Q);
	assert.equal(calls(), 1, "cached inside the TTL");
	now.t += 1;
	await c.get();
	assert.equal(calls(), 2, "fetched again after the TTL");
});

test("QuotaCache: a failure isn't cached; invalidate() forces a fresh read", async () => {
	const now = { t: 0 };
	let fail = true;
	const { c, calls } = cache(() => (fail ? Promise.reject(new Error("x")) : Promise.resolve(Q)), now);
	await assert.rejects(c.get());
	fail = false;
	assert.equal(await c.get(), Q);
	assert.equal(calls(), 2);
	c.invalidate();
	await c.get();
	assert.equal(calls(), 3);
});

test("QuotaCache: a request that started before invalidate() doesn't refill the cache", async () => {
	const now = { t: 0 };
	const d = deferred<Quota | null>();
	let first = true;
	const { c, calls } = cache(() => {
		if (first) {
			first = false;
			return d.promise;
		}
		return Promise.resolve(null);
	}, now);
	const old = c.get();
	c.invalidate(); // e.g. sign-out, or a sync that hit a full drive
	d.resolve(Q);
	assert.equal(await old, Q, "the caller still gets its answer");
	assert.equal(await c.get(), null, "but the next read asks again");
	assert.equal(calls(), 2);
});
