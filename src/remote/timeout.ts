// Request timeouts (design §6.1, M7 carry-in "Long requests"). requestUrl takes no timeout [O-API-1], and one
// iPad request hung for about 24 minutes while its run held the single-flight lock (M7 owner check 8). Every
// request races a timer here. A timeout is not a NetworkError, so RetryPolicy doesn't retry it: the run ends
// `partial` and the next run continues. A response that arrives after its timeout is dropped. If that request
// was a write that OneDrive applied anyway, the next run sees it like a crash after the call (M6): If-Match and
// conflictBehavior=fail keep it safe (design §5.5).
import type { HttpRequest, HttpResponse, HttpTransport } from "../core/ports.ts";

/** Timeout for a request with no body to speak of: every Graph API call and the token endpoint. */
export const API_TIMEOUT_MS = 120_000;
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

function deadline(req: HttpRequest): number {
	const t = req.timeoutMs;
	if (typeof t === "number" && Number.isFinite(t) && t > 0) return t;
	return timeoutFor(bodyBytes(req.body));
}

export class TimeoutTransport implements HttpTransport {
	private readonly inner: HttpTransport;
	private readonly setTimer: SetTimer;

	constructor(inner: HttpTransport, setTimer: SetTimer) {
		this.inner = inner;
		this.setTimer = setTimer;
	}

	send(req: HttpRequest): Promise<HttpResponse> {
		return new Promise<HttpResponse>((resolve, reject) => {
			let settled = false;
			const cancel = this.setTimer(deadline(req), () => {
				if (settled) return;
				settled = true;
				reject(new RequestTimeout());
			});
			this.inner.send(req).then(
				(res) => {
					// After a timeout the response is dropped: the run has already moved on.
					if (settled) return;
					settled = true;
					cancel();
					resolve(res);
				},
				(e: unknown) => {
					if (settled) return;
					settled = true;
					cancel();
					reject(e instanceof Error ? e : new Error("transport"));
				},
			);
		});
	}
}
