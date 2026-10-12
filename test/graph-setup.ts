// Shared wiring for Graph tests: FakeGraph behind the real AuthorizingTransport and RetryPolicy.
import { AuthorizingTransport } from "../src/remote/http.ts";
import { RetryPolicy } from "../src/remote/retry.ts";
import { GraphClient, type GraphClientOptions } from "../src/remote/graph.ts";
import { RingLogger } from "../src/core/logger.ts";
import type { DeltaForm } from "../src/remote/capabilities.ts";
import type { HttpTransport } from "../src/core/ports.ts";
import { FakeGraph, type FakeGraphOptions } from "./fakes/fake-graph.ts";
import { FakeClock } from "./fakes/fake-http.ts";

export const TOKEN = "AT-SENTINEL";

export function graphOver(transport: HttpTransport, extra: Partial<GraphClientOptions> = {}) {
	const clock = new FakeClock();
	const log = new RingLogger({ now: () => clock.now() });
	const retry = new RetryPolicy({ clock, random: () => 0.5, logger: log });
	const g = new GraphClient({ transport, retry, clock, logger: log, ...extra });
	return { g, clock, log, retry };
}

export function setupGraph(opts: FakeGraphOptions = {}, deltaForm?: DeltaForm, extra: Partial<GraphClientOptions> = {}) {
	const fake = new FakeGraph(opts);
	const tokens = { getAccessToken: () => Promise.resolve(TOKEN), invalidateAccessToken: () => {} };
	const transport = new AuthorizingTransport(fake, tokens);
	return { fake, transport, ...graphOver(transport, { ...(deltaForm ? { deltaForm } : {}), ...extra }) };
}

export function pattern(n: number, seed = 1): ArrayBuffer {
	const u8 = new Uint8Array(n);
	for (let i = 0; i < n; i++) u8[i] = (i * 31 + seed) & 0xff;
	return u8.buffer;
}

export const enc = (s: string) => new TextEncoder().encode(s);

export function last<T>(a: readonly T[]): T | undefined {
	return a[a.length - 1];
}

/** Origin of a URL, for "which server did this go to" assertions. Compare origins, never string prefixes. */
export function originOf(url: string): string {
	return new URL(url).origin;
}
