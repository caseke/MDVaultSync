// Request timeouts (design §6.1, M7 carry-in "Long requests"). requestUrl takes no timeout [O-API-1], and one
// iPad request hung for about 24 minutes while its run held the single-flight lock (M7 owner check 8). Every
// request races a timer here. A timeout is not a NetworkError, so RetryPolicy doesn't retry it: the run ends
// `partial` and the next run continues. A response that arrives after its timeout is dropped. requestUrl can't be
// aborted, so a timed-out write may still land, even during or after the next run. Every write that has a
// server-side precondition is safe when it lands late: replace, move and delete send If-Match (412), new files
// conflictBehavior=fail (409). The one write without one is an upload session's final fragment, which commits
// the file with no If-Match [G-UP-5]: a late commit could overwrite a newer upload. So it gets NO_TIMEOUT and
// keeps holding the run's single-flight lock, as before M8 (M8 security review, design §6.1).
import type { HttpRequest, HttpResponse, HttpTransport } from "../core/ports.ts";

/** Timeout for a request with no body to speak of: every Graph API call and the token endpoint. */
export const API_TIMEOUT_MS = 120_000;
/** `HttpRequest.timeoutMs` for a request that must never be abandoned: no timer at all. */
export const NO_TIMEOUT = Number.POSITIVE_INFINITY;
/** Extra time per 64 KiB of transfer (64 KiB/s, a slow mobile link): 10 MiB → +160 s, 100 MiB → +1,600 s. */
const MS_PER_CHUNK = 1_000;
const CHUNK = 64 * 1024;

/** Starts a timer; returns a function that cancels it. main.ts passes window.setTimeout / clearTimeout. */
export type SetTimer = (ms: number, fn: () => void) => () => void;

/** The request didn't answer in time. Carries no URL: transfer URLs are bearer credentials (T-I3). */
export class RequestTimeout extends Error {
	constructor() {
		super("timeout");
		this.name = "RequestTimeout";
	}
}

/** API_TIMEOUT_MS plus MS_PER_CHUNK for every started 64 KiB of `bytes`. */
export function timeoutFor(bytes: number): number {
	const n = Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes / CHUNK) : 0;
	return API_TIMEOUT_MS + n * MS_PER_CHUNK;
}

function bodyBytes(body: HttpRequest["body"]): number {
	if (body === undefined) return 0;
	if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
	return body.byteLength;
}

/** null: no timer (NO_TIMEOUT). */
function deadline(req: HttpRequest): number | null {
	const t = req.timeoutMs;
	if (t === NO_TIMEOUT) return null;
	if (typeof t === "number" && Number.isFinite(t) && t > 0) return t;
	return timeoutFor(bodyBytes(req.body));
}

export class TimeoutTransport implements HttpTransport {
	private readonly inner: HttpTransport;
	private readonly setTimer: SetTimer;
	private stuckCount = 0;

	constructor(inner: HttpTransport, setTimer: SetTimer) {
		this.inner = inner;
		this.setTimer = setTimer;
	}

	/**
	 * Requests that timed out and haven't answered since. Each one still holds its body (up to a 10 MiB fragment)
	 * and a connection, so main.ts pauses unattended runs while there are STUCK_LIMIT of them (ui/triggers.ts).
	 */
	get stuck(): number {
		return this.stuckCount;
	}

	send(req: HttpRequest): Promise<HttpResponse> {
		const ms = deadline(req);
		if (ms === null) return this.inner.send(req);
		return new Promise<HttpResponse>((resolve, reject) => {
			let settled = false;
			let timedOut = false;
			const cancel = this.setTimer(ms, () => {
				if (settled) return;
				settled = true;
				timedOut = true;
				this.stuckCount++;
				reject(new RequestTimeout());
			});
			const done = (): boolean => {
				if (timedOut) {
					// The late answer or failure is dropped: the run has already moved on.
					timedOut = false;
					this.stuckCount--;
					return false;
				}
				if (settled) return false;
				settled = true;
				cancel();
				return true;
			};
			this.inner.send(req).then(
				(res) => {
					if (done()) resolve(res);
				},
				(e: unknown) => {
					if (done()) reject(e instanceof Error ? e : new Error("transport"));
				},
			);
		});
	}
}
