// HttpTransport over Obsidian's requestUrl, the only network path (R-NET-1) [O-API-1].
// main.ts passes the real requestUrl in, so this module has no runtime obsidian import and runs under node --test.
import type { HttpRequest, HttpResponse, HttpTransport } from "../core/ports.ts";
import { NetworkError } from "../remote/errors.ts";

/** The subset of Obsidian's RequestUrlParam this transport uses. */
export interface RequestUrlParamLike {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}
export interface RequestUrlResponseLike {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
}
export type RequestUrlFn = (p: RequestUrlParamLike) => Promise<RequestUrlResponseLike>;

// NetworkError lives in remote/errors.ts so the retry policy can recognize it; re-exported for existing callers.
export { NetworkError };

export function createRequestUrlTransport(requestUrlFn: RequestUrlFn): HttpTransport {
	return {
		async send(req: HttpRequest): Promise<HttpResponse> {
			const param: RequestUrlParamLike = { url: req.url, method: req.method, throw: false };
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers ?? {})) {
				if (k.toLowerCase() === "content-type") param.contentType = v;
				else headers[k] = v;
			}
			param.headers = headers;
			if (req.body !== undefined) param.body = req.body;
			let res: RequestUrlResponseLike;
			try {
				res = await requestUrlFn(param);
			} catch {
				throw new NetworkError();
			}
			const outHeaders: Record<string, string> = {};
			for (const [k, v] of Object.entries(res.headers)) outHeaders[k.toLowerCase()] = v;
			return { status: res.status, headers: outHeaders, body: res.arrayBuffer };
		},
	};
}
