// Typed errors for Graph responses (design §6.1) [G-ERR-1]. Messages carry status and code only, never a URL,
// a name or the server's `message` text (T-I3).
import type { HttpResponse } from "../core/ports.ts";
import { parseJsonObject } from "./validate.ts";

/** Error bodies are small; anything bigger is not parsed. */
export const MAX_ERROR_BODY = 64 * 1024;
const MAX_INNER_DEPTH = 8;
const GRAPH_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export class GraphError extends Error {
	readonly status: number;
	readonly code: string;
	readonly innerCodes: readonly string[];

	constructor(status: number, code: string, innerCodes: readonly string[] = []) {
		super(`graph-${status}-${code}`);
		this.name = "GraphError";
		this.status = status;
		this.code = code;
		this.innerCodes = innerCodes;
	}
}

/** Any 410, or a code starting with `resync`: the delta token is dead; re-enumerate in union mode [G-DL-4]. */
export class ResyncRequired extends GraphError {
	constructor(status: number, code: string, innerCodes: readonly string[] = []) {
		super(status, code, innerCodes);
		this.name = "ResyncRequired";
	}
}

/** A transfer or paging URL outside the allowlist (design §8, T-T5). Carries no URL: they are bearer credentials. */
export class UntrustedUrl extends Error {
	constructor() {
		super("untrusted-url");
		this.name = "UntrustedUrl";
	}
}

/** Total backoff in this run passed the budget (design §6.1); the run ends `partial`. */
export class RetryBudgetExceeded extends Error {
	constructor() {
		super("retry-budget-exceeded");
		this.name = "RetryBudgetExceeded";
	}
}

export function sanitizeGraphCode(v: unknown): string {
	return typeof v === "string" && GRAPH_CODE_RE.test(v) ? v : "other";
}

export function isResyncCode(code: string): boolean {
	return code.startsWith("resync");
}

function asObject(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Maps a non-2xx response to GraphError (or ResyncRequired). Reads `error.code` and the innerError chain only. */
export function toGraphError(res: HttpResponse): GraphError {
	let code = "other";
	const inner: string[] = [];
	try {
		const err = asObject(parseJsonObject(res.body, MAX_ERROR_BODY)["error"]);
		if (err) {
			code = sanitizeGraphCode(err["code"]);
			let cur = asObject(err["innerError"] ?? err["innererror"]);
			while (cur && inner.length < MAX_INNER_DEPTH) {
				if (cur["code"] !== undefined) inner.push(sanitizeGraphCode(cur["code"]));
				cur = asObject(cur["innerError"] ?? cur["innererror"]);
			}
		}
	} catch {
		// Not a Graph error body: keep "other".
	}
	if (res.status === 410 || isResyncCode(code) || inner.some(isResyncCode)) return new ResyncRequired(res.status, code, inner);
	return new GraphError(res.status, code, inner);
}
