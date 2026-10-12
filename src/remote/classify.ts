// Maps remote and auth errors to the core failure kinds (src/core/failure.ts). Codes are the error's fixed
// identifiers only, never a message, URL or name (T-I3).
import { coreFailure, type RemoteFailure } from "../core/failure.ts";
import { AuthError } from "./auth.ts";
import { GraphError, NetworkError, ResyncRequired, RetryBudgetExceeded, UntrustedUrl } from "./errors.ts";
import { InvalidResponse } from "./validate.ts";

const AUTH_NETWORK = new Set(["network", "token-request-failed"]);

export function classifyError(e: unknown): RemoteFailure {
	const core = coreFailure(e);
	if (core) return core;
	if (e instanceof ResyncRequired) return { kind: "resync", code: "resync" };
	if (e instanceof GraphError) {
		const codes = [e.code, ...e.innerCodes];
		if (e.status === 507 || codes.includes("quotaLimitReached")) return { kind: "quota", code: "quota" };
		if (e.status === 412) return { kind: "precondition", code: "precondition" };
		if (e.status === 409 && codes.includes("nameAlreadyExists")) return { kind: "name-exists", code: "name-exists" };
		if (e.status === 404) return { kind: "not-found", code: "not-found" };
		if (e.status === 416) return { kind: "range", code: "range" };
		if (e.status === 401) return { kind: "auth", code: "unauthorized" };
		if (e.status === 403) return { kind: "forbidden", code: "forbidden" };
		return { kind: "other", code: `graph-${e.status}` };
	}
	if (e instanceof NetworkError) return { kind: "network", code: "network" };
	if (e instanceof RetryBudgetExceeded) return { kind: "budget", code: "retry-budget-exceeded" };
	if (e instanceof AuthError) return AUTH_NETWORK.has(e.code) ? { kind: "network", code: e.code } : { kind: "auth", code: e.code };
	if (e instanceof UntrustedUrl) return { kind: "other", code: "untrusted-url" };
	if (e instanceof InvalidResponse) {
		// The bytes or the item's size don't match what was checked (T-T4, T-D6).
		if (e.reason === "download-length-mismatch") return { kind: "hash-mismatch", code: "hash-mismatch" };
		return { kind: "other", code: "invalid-response" };
	}
	if (e instanceof RangeError) return { kind: "other", code: "range-error" };
	return { kind: "other", code: "other" };
}
