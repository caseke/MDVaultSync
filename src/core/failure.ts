// How a failed call is classified for the executor and engine (design §5.5, §6.1). Core can't import src/remote
// (design §7), so the Graph error classes are mapped to these kinds by an injected classifier
// (src/remote/classify.ts). Codes are short identifiers, never messages, URLs or names (T-I3).

export type FailureKind =
	| "precondition" // 412: If-Match failed [G-TAG-2]
	| "name-exists" // 409 nameAlreadyExists
	| "not-found" // 404
	| "range" // 416 on an upload fragment
	| "resync" // 410 / resync* on delta [G-DL-4]
	| "auth" // no token, refresh refused, or 401 after a refresh
	| "forbidden" // 403
	| "quota" // 507 / quotaLimitReached
	| "budget" // the run's backoff budget is spent (design §6.1)
	| "network" // the request failed below HTTP, after retries
	| "hash-mismatch" // transferred bytes don't match the hash (T-T4)
	| "raced" // a replace session's item changed before the commit (design §6.3)
	| "other";

export interface RemoteFailure {
	kind: FailureKind;
	code: string;
}

export type ErrorClassifier = (e: unknown) => RemoteFailure;

/** Downloaded or uploaded bytes don't match their QuickXorHash or declared size (T-T4). Carries no data. */
export class HashMismatch extends Error {
	constructor() {
		super("hash-mismatch");
		this.name = "HashMismatch";
	}
}

/** The item changed while a replace session was open; the session was cancelled before the commit (§6.3). */
export class ReplaceRaced extends Error {
	constructor() {
		super("replace-raced");
		this.name = "ReplaceRaced";
	}
}

/** A path failed the containment or naming re-check right before a local write (T-T1). Carries no path. */
export class UnsafePath extends Error {
	constructor() {
		super("unsafe-path");
		this.name = "UnsafePath";
	}
}

/** Failures raised by core itself; the remote classifier checks these first. */
export function coreFailure(e: unknown): RemoteFailure | null {
	if (e instanceof HashMismatch) return { kind: "hash-mismatch", code: "hash-mismatch" };
	if (e instanceof ReplaceRaced) return { kind: "raced", code: "replace-raced" };
	if (e instanceof UnsafePath) return { kind: "other", code: "unsafe-path" };
	return null;
}

/**
 * How a failure ends the run, or null if it fails only its own op. Auth, 403 and quota stop everything (design
 * §5 "Failed"); a spent budget or a dead network keeps progress and ends `partial` (design §6.1).
 */
export function runOutcome(kind: FailureKind): "failed" | "partial" | null {
	if (kind === "auth" || kind === "forbidden" || kind === "quota") return "failed";
	if (kind === "budget" || kind === "network") return "partial";
	return null;
}
