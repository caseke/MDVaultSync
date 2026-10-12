// HttpTransport decorator that attaches the access token for Microsoft Graph only (design §8, T-I4).
import type { AccessTokenProvider, HttpRequest, HttpResponse, HttpTransport } from "../core/ports.ts";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";

/** An AccessTokenProvider that can also drop a token Graph rejected with 401 (AuthClient). */
export interface InvalidatingTokenProvider extends AccessTokenProvider {
	invalidateAccessToken?(token: string): void;
}

/** Thrown for an unparseable URL. Carries no URL: transfer URLs are bearer credentials (T-I3). */
export class InvalidUrl extends Error {
	constructor() {
		super("invalid-url");
		this.name = "InvalidUrl";
	}
}

/** True only for https://graph.microsoft.com URLs (default port, no userinfo). Throws InvalidUrl if unparseable. */
export function isGraphUrl(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new InvalidUrl();
	}
	return u.protocol === "https:" && u.origin === GRAPH_ORIGIN && u.username === "" && u.password === "";
}

export class AuthorizingTransport implements HttpTransport {
	private readonly inner: HttpTransport;
	private readonly tokens: InvalidatingTokenProvider;

	constructor(inner: HttpTransport, tokens: InvalidatingTokenProvider) {
		this.inner = inner;
		this.tokens = tokens;
	}

	async send(req: HttpRequest): Promise<HttpResponse> {
		const graph = isGraphUrl(req.url);
		// Drop any caller-supplied Authorization, so upload and download URLs never carry one [G-UP-7], [G-DLD-1].
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers ?? {})) {
			if (k.toLowerCase() !== "authorization") headers[k] = v;
		}
		if (!graph) return this.inner.send({ ...req, headers });
		const token = await this.tokens.getAccessToken();
		const res = await this.inner.send({ ...req, headers: { ...headers, Authorization: `Bearer ${token}` } });
		// Design §6.1: on 401, refresh the token once and retry once. A second 401 goes back to the caller.
		if (res.status !== 401 || !this.tokens.invalidateAccessToken) return res;
		this.tokens.invalidateAccessToken(token);
		const fresh = await this.tokens.getAccessToken();
		return this.inner.send({ ...req, headers: { ...headers, Authorization: `Bearer ${fresh}` } });
	}
}
