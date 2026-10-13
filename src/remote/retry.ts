// Retry policy for Graph and transfer requests (design §6.1, R-RES-1, T-D5).
// 429/503 honor Retry-After with a pause shared by every request [G-THR-1], [G-THR-2]; other 5xx and network
// errors back off exponentially with full jitter; total backoff per run is capped.
import type { Clock, HttpResponse } from "../core/ports.ts";
import { NULL_LOGGER, type Logger } from "../core/logger.ts";
import { NetworkError, RetryBudgetExceeded } from "./errors.ts";

export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 300_000;

export interface RetryOptions {
	clock: Clock;
	/** Uniform in [0, 1); injected for tests. */
	random?: () => number;
	logger?: Logger;
	maxAttempts?: number;
	baseMs?: number;
	capMs?: number;
	/** Total backoff allowed per sync run before it ends `partial`. */
	budgetMs?: number;
	/**
	 * Send once and hand back whatever comes, even a 429 with Retry-After: no wait, no global pause, no budget.
	 * For reads a settings render makes (quota), which must never stall or throttle a sync (M8 review).
	 */
	singleAttempt?: boolean;
}

/** Retry-After as delta-seconds or an HTTP date, in ms clamped to 1–300 s; null if absent or unparseable. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
	if (value === undefined) return null;
	const v = value.trim();
	let ms: number;
	if (/^\d+$/.test(v)) ms = Number(v) * 1000;
	else if (/[a-z]/i.test(v)) {
		const at = Date.parse(v);
		if (Number.isNaN(at)) return null;
		ms = at - now;
	} else return null;
	return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}

/** 429 and 5xx are retried, except 507 (insufficient storage), which retrying can't fix. */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599 && status !== 507);
}

function header(res: HttpResponse, name: string): string | undefined {
	for (const [k, v] of Object.entries(res.headers)) if (k.toLowerCase() === name) return v;
	return undefined;
}

export class RetryPolicy {
	private readonly clock: Clock;
	private readonly random: () => number;
	private readonly logger: Logger;
	private readonly maxAttempts: number;
	private readonly baseMs: number;
	private readonly capMs: number;
	private readonly budgetMs: number;
	private readonly singleAttempt: boolean;
	private spent = 0;
	private pauseUntil = 0;

	constructor(opts: RetryOptions) {
		this.clock = opts.clock;
		this.random = opts.random ?? Math.random;
		this.logger = opts.logger ?? NULL_LOGGER;
		this.maxAttempts = opts.maxAttempts ?? 6;
		this.baseMs = opts.baseMs ?? 1_000;
		this.capMs = opts.capMs ?? 60_000;
		this.budgetMs = opts.budgetMs ?? 600_000;
		this.singleAttempt = opts.singleAttempt ?? false;
	}

	/** Backoff spent in this run, in ms. */
	get spentMs(): number {
		return this.spent;
	}

	/** End of the current global pause (epoch ms); 0 if never throttled. */
	get pausedUntil(): number {
		return this.pauseUntil;
	}

	/** Starts a new run's budget (the engine calls this once per sync run). */
	resetBudget(): void {
		this.spent = 0;
	}

	/**
	 * Sends until a non-retryable status, or attempts or budget run out. Returns the last response; rethrows the
	 * last NetworkError, and any other error at once. Throws RetryBudgetExceeded when the next wait would pass the run budget.
	 */
	async execute(send: () => Promise<HttpResponse>): Promise<HttpResponse> {
		if (this.singleAttempt) return send();
		for (let attempt = 1; ; attempt++) {
			await this.waitForPause();
			let res: HttpResponse | null = null;
			let failure: unknown = null;
			try {
				res = await send();
			} catch (e) {
				// Only transport failures are retried. Anything else (an auth error from the token refresh, a bad
				// URL) can't be fixed by waiting, so it goes straight back to the caller (design §6.1).
				if (!(e instanceof NetworkError)) throw e;
				failure = e;
			}
			if (res && !isRetryableStatus(res.status)) return res;
			const throttled = res !== null && (res.status === 429 || res.status === 503);
			const retryAfter = throttled && res ? parseRetryAfter(header(res, "retry-after"), this.clock.now()) : null;
			let delay: number;
			if (retryAfter !== null) {
				// Bounded by the run budget rather than the attempt cap: the server told us when to come back.
				delay = retryAfter;
			} else {
				if (attempt >= this.maxAttempts) {
					if (res) return res;
					throw failure;
				}
				const window = Math.min(this.capMs, this.baseMs * 2 ** (attempt - 1));
				delay = Math.floor(this.random() * window);
			}
			if (this.spent + delay > this.budgetMs) throw new RetryBudgetExceeded();
			this.spent += delay;
			this.logger.event("retry.backoff", res ? { attempt, status: res.status, durationMs: delay } : { attempt, code: "network", durationMs: delay });
			if (retryAfter !== null) {
				// A global pause: every request waits it out, not only this one [G-THR-2].
				this.pauseUntil = Math.max(this.pauseUntil, this.clock.now() + delay);
			} else {
				await this.clock.sleep(delay);
			}
		}
	}

	private async waitForPause(): Promise<void> {
		for (let now = this.clock.now(); this.pauseUntil > now; now = this.clock.now()) {
			await this.clock.sleep(this.pauseUntil - now);
		}
	}
}
