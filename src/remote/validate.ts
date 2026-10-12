// Type guards for untrusted remote JSON (design §8, T-T2). M2 adds the token endpoint; M3 adds Graph items.

/** Token responses are small; anything bigger is not a token response. */
export const MAX_TOKEN_BODY = 64 * 1024;

export interface TokenResponse {
	accessToken: string;
	refreshToken: string | null;
	expiresInSec: number;
}

export class InvalidResponse extends Error {
	constructor() {
		super("invalid-response");
		this.name = "InvalidResponse";
	}
}

/** Parses a JSON body of at most `maxBytes`. Throws InvalidResponse on anything else. */
export function parseJsonObject(body: ArrayBuffer, maxBytes: number): Record<string, unknown> {
	if (body.byteLength > maxBytes) throw new InvalidResponse();
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		throw new InvalidResponse();
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidResponse();
	return value as Record<string, unknown>;
}

/**
 * Validates a successful token endpoint response (design §4 step 5).
 * `requireRefreshToken` is true for code redemption; a refresh may omit it, and the old one is kept then.
 */
export function parseTokenResponse(body: ArrayBuffer, requireRefreshToken: boolean): TokenResponse {
	const o = parseJsonObject(body, MAX_TOKEN_BODY);
	const { access_token: at, refresh_token: rt, expires_in: exp, token_type: type } = o;
	if (typeof at !== "string" || at.length === 0 || at.length > 16_384) throw new InvalidResponse();
	if (typeof type !== "string" || type.toLowerCase() !== "bearer") throw new InvalidResponse();
	if (typeof exp !== "number" || !Number.isFinite(exp) || exp < 60 || exp > 86_400) throw new InvalidResponse();
	let refreshToken: string | null = null;
	if (rt !== undefined) {
		if (typeof rt !== "string" || rt.length === 0 || rt.length > 16_384) throw new InvalidResponse();
		refreshToken = rt;
	} else if (requireRefreshToken) {
		throw new InvalidResponse();
	}
	return { accessToken: at, refreshToken, expiresInSec: exp };
}

const CODE_RE = /^[a-z0-9_]{1,64}$/;

/** Reduces an OAuth error code to a safe token. `error_description` is never read [design §8]. */
export function sanitizeErrorCode(value: unknown): string {
	return typeof value === "string" && CODE_RE.test(value) ? value : "other";
}

/** The `error` code of a token endpoint error body, or "other". */
export function parseTokenError(body: ArrayBuffer): string {
	try {
		return sanitizeErrorCode(parseJsonObject(body, MAX_TOKEN_BODY)["error"]);
	} catch {
		return "other";
	}
}
