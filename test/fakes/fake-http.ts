import type { Clock, HttpRequest, HttpResponse, HttpTransport } from "../../src/core/ports.ts";

export type Responder = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/** Scripted HttpTransport: records every request and answers from a queue of responders. */
export class FakeHttp implements HttpTransport {
	readonly requests: HttpRequest[] = [];
	private readonly queue: Responder[] = [];

	/** Queue a responder for the next request. */
	enqueue(responder: Responder): this {
		this.queue.push(responder);
		return this;
	}

	enqueueJson(status: number, body: unknown): this {
		return this.enqueue(() => jsonResponse(status, body));
	}

	/** Queue a network failure (the transport contract: throw, never a status). */
	enqueueNetworkError(): this {
		return this.enqueue(() => {
			throw new Error("network");
		});
	}

	async send(req: HttpRequest): Promise<HttpResponse> {
		this.requests.push(req);
		const next = this.queue.shift();
		if (!next) throw new Error("FakeHttp: no response queued");
		return next(req);
	}
}

export function jsonResponse(status: number, body: unknown): HttpResponse {
	return { status, headers: { "content-type": "application/json" }, body: bytes(JSON.stringify(body)) };
}

export function bytes(s: string): ArrayBuffer {
	const u8 = new TextEncoder().encode(s);
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** Form body of a request as a URLSearchParams. */
export function formOf(req: HttpRequest): URLSearchParams {
	if (typeof req.body !== "string") throw new Error("expected a string body");
	return new URLSearchParams(req.body);
}

/** Manually advanced clock. `sleep` resolves immediately and advances time. */
export class FakeClock implements Clock {
	t: number;
	constructor(t = 1_700_000_000_000) {
		this.t = t;
	}
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
	sleep(ms: number): Promise<void> {
		this.t += ms;
		return Promise.resolve();
	}
}

/** A deferred promise, for holding a response open while other calls run. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
