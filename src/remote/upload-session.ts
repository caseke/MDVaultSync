// Upload-session primitives [G-UP-5]…[G-UP-9] (design §6.3). Resume orchestration is M6's (upload-resume.ts).
// Every call checks the upload URL against the host allowlist, and none adds Authorization [G-UP-7]; the
// AuthorizingTransport also strips it for any non-Graph host (T-I4, T-T5).
import type { HttpRequest, HttpResponse, RemoteItem, UploadSessionInfo, UploadStatus } from "../core/ports.ts";
import { toGraphError } from "./errors.ts";
import { NO_TIMEOUT } from "./timeout.ts";
import { checkTransferUrl, parseDriveItem, parseJsonObject, parseUploadSession, parseUploadStatus, MAX_JSON_BODY } from "./validate.ts";

/** Fragments must be multiples of 320 KiB [G-UP-6]. */
export const FRAGMENT_UNIT = 327_680;
/** 10 MiB = 32 × 320 KiB (R-RES-2). */
export const FRAGMENT = 10 * 1024 * 1024;
if (FRAGMENT % FRAGMENT_UNIT !== 0) throw new Error("FRAGMENT must be a multiple of 320 KiB");

/** Sends one request through retry and logging (GraphClient.sendRaw's implementation). */
export type Call = (req: HttpRequest) => Promise<HttpResponse>;

/** Half-open byte ranges [start, end) of FRAGMENT size; the last one is the remainder. */
export function fragmentRanges(total: number): { start: number; end: number }[] {
	if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("invalid-size");
	const out: { start: number; end: number }[] = [];
	for (let start = 0; start < total; start += FRAGMENT) out.push({ start, end: Math.min(total, start + FRAGMENT) });
	return out;
}

/** POSTs a createUploadSession body to a Graph URL. `ifMatch` is checked by Graph at creation only [G-UP-5]. */
export async function createSession(call: Call, url: string, ifMatch: string | null, body: unknown): Promise<UploadSessionInfo> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (ifMatch !== null) headers["If-Match"] = ifMatch;
	const res = await call({ url, method: "POST", headers, body: JSON.stringify(body) });
	if (res.status !== 200 && res.status !== 201) throw toGraphError(res);
	return parseUploadSession(res.body);
}

/**
 * PUTs bytes [start, start + length) of a `total`-byte upload. Returns null while more fragments are expected
 * (202), or the driveItem after the final fragment (200/201) [G-UP-8]. A 416 surfaces as GraphError.
 */
export async function putFragment(call: Call, uploadUrl: string, start: number, total: number, bytes: ArrayBuffer): Promise<RemoteItem | null> {
	checkTransferUrl(uploadUrl);
	const len = bytes.byteLength;
	if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(start) || start < 0) throw new RangeError("invalid-range");
	if (len === 0 || len > FRAGMENT || start + len > total) throw new RangeError("invalid-range");
	if (start + len < total && len % FRAGMENT_UNIT !== 0) throw new RangeError("fragment-not-aligned");
	const res = await call({
		url: uploadUrl,
		method: "PUT",
		headers: { "Content-Range": `bytes ${start}-${start + len - 1}/${total}` },
		body: bytes,
		// The final fragment commits the file without If-Match [G-UP-5]: it is never abandoned, so a late commit
		// can't overwrite a newer upload from the next run (src/remote/timeout.ts).
		...(start + len === total ? { timeoutMs: NO_TIMEOUT } : {}),
	});
	if (res.status === 202) return null;
	if (res.status === 200 || res.status === 201) return parseDriveItem(parseJsonObject(res.body, MAX_JSON_BODY));
	throw toGraphError(res);
}

/** `GET uploadUrl` → first missing byte; a 404 means the session is gone and the upload restarts [G-UP-9]. */
export async function getUploadStatus(call: Call, uploadUrl: string): Promise<UploadStatus> {
	checkTransferUrl(uploadUrl);
	const res = await call({ url: uploadUrl, method: "GET" });
	if (res.status === 404) return { nextExpectedStart: null, expiresAt: "" };
	if (res.status !== 200) throw toGraphError(res);
	return parseUploadStatus(res.body);
}

/** `DELETE uploadUrl`. An already-gone session counts as cancelled. */
export async function cancelUpload(call: Call, uploadUrl: string): Promise<void> {
	checkTransferUrl(uploadUrl);
	const res = await call({ url: uploadUrl, method: "DELETE" });
	if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw toGraphError(res);
}
