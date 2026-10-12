// HttpTransport decorator that attaches the access token for Microsoft Graph only (design §8, T-I4).
import type { AccessTokenProvider, HttpRequest, HttpResponse, HttpTransport } from "../core/ports.ts";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";

/** True only for https://graph.microsoft.com URLs (default port, no userinfo). Throws on an unparseable URL. */
export function isGraphUrl(url: string): boolean {
	const u = new URL(url);
	return u.protocol === "https:" && u.origin === GRAPH_ORIGIN && u.username === "" && u.password === "";
}

export class AuthorizingTransport implements HttpTransport {
	private readonly inner: HttpTransport;
	private readonly tokens: AccessTokenProvider;

	constructor(inner: HttpTransport, tokens: AccessTokenProvider) {
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
		if (graph) headers["Authorization"] = `Bearer ${await this.tokens.getAccessToken()}`;
		return this.inner.send({ ...req, headers });
	}
}
