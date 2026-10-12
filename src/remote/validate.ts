// Type guards for untrusted remote JSON (design §8, T-T2). M2 added the token endpoint; M3 adds Graph items.
import type { DeltaPage, RemoteItem, UploadSessionInfo, UploadStatus } from "../core/ports.ts";
import { NAME_MAX } from "./capabilities.ts";
import { UntrustedUrl } from "./errors.ts";

/** Token responses are small; anything bigger is not a token response. */
export const MAX_TOKEN_BODY = 64 * 1024;

export interface TokenResponse {
	accessToken: string;
	refreshToken: string | null;
	expiresInSec: number;
}

/** Fixed identifiers only, so a reason can never carry a name, URL or token (T-I3). */
export type InvalidReason =
	| ""
	| "not-a-file"
	| "download-url-missing"
	| "download-url-invalid"
	| "download-url-too-long"
	| "download-length-mismatch";

export class InvalidResponse extends Error {
	/** What failed, as a fixed identifier; never data from the response. */
	readonly reason: InvalidReason;

	constructor(reason: InvalidReason = "") {
		super("invalid-response");
		this.name = "InvalidResponse";
		this.reason = reason;
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

// ---------- Graph (M3, design §8, T-T2, T-T5) ----------

/** Caps memory for a delta page; checked before parsing. */
export const MAX_JSON_BODY = 32 * 1024 * 1024;
/**
 * Hosts that upload and download URLs may use (design §8, T-T5), narrowed at M3 close (2026-10-12):
 * - `.microsoftpersonalcontent.com`: the only host observed, for uploads and downloads on the owner's Ubuntu and iPad
 *   (M3 probe). Microsoft-registered (WHOIS) [G-UP-11].
 * - `.1drv.com`, `.onedrive.com`, `.livefilestore.com`: OneDrive personal content endpoints in Microsoft's required-URL
 *   list (*.files.1drv.com, *.onedrive.com, *.livefilestore.com), kept so a server-side host change fails over
 *   rather than stopping transfers.
 * Dropped: `.sharepoint.com` (any company can own a tenant subdomain, so a tampered URL could exfiltrate to it),
 * `.microsoft.com` and `.live.com` (very large zones with no observed transfer use).
 */
export const TRANSFER_HOST_SUFFIXES: readonly string[] = [".microsoftpersonalcontent.com", ".1drv.com", ".onedrive.com", ".livefilestore.com"];
/** Longest name we send: capabilities.ts NAME_MAX, one source so they can't drift [G-NM-6]. */
export const NAME_LIMIT = NAME_MAX;
/**
 * Longest name we accept from Graph: the 400-character full-path limit [G-NM-4]. OneDrive accepts names over 255
 * (0.3.0 probe, Ubuntu), so a longer remote name is a real state; the planner skips it as invalid-name (M4)
 * rather than letting one item fail every delta page.
 */
export const MAX_REMOTE_NAME = 400;
// Dot-only ids are refused: "..", unencoded in a URL path, would climb out of /items/ (M3 review).
const ID_RE = /^(?!\.+$)[A-Za-z0-9!._-]{1,256}$/;
const QXH_RE = /^[A-Za-z0-9+/]{27}=$/;
const MAX_TAG = 512;
const MAX_TIMESTAMP = 64;
const MAX_PARENT_PATH = 2048;
const MAX_TRANSFER_URL = 8192;
const MAX_RANGE_START = Number.MAX_SAFE_INTEGER;

function obj(v: unknown): Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new InvalidResponse();
	return v as Record<string, unknown>;
}
function optObj(v: unknown): Record<string, unknown> | null {
	return v === undefined ? null : obj(v);
}
function boundedString(v: unknown, max: number, allowEmpty = false): string {
	if (typeof v !== "string" || v.length > max || (!allowEmpty && v.length === 0)) throw new InvalidResponse();
	return v;
}
/** eTag and cTag go back out as If-Match headers, so they must be printable ASCII (M3 review). */
function tag(v: unknown): string {
	const s = boundedString(v, MAX_TAG);
	if (!/^[\x20-\x7e]+$/.test(s)) throw new InvalidResponse();
	return s;
}
function safeSize(v: unknown): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new InvalidResponse();
	return v;
}

export function isValidId(v: unknown): v is string {
	// ID_RE: 1–256 of [A-Za-z0-9!._-], not only dots (design §8).
	return typeof v === "string" && ID_RE.test(v);
}

/** Name rules shared by names we receive and names we send: 1–max chars, no `/`, `\` or NUL, not `.` or `..`. */
function nameOk(v: unknown, max: number): v is string {
	return (
		typeof v === "string" &&
		v.length >= 1 &&
		v.length <= max &&
		!v.includes("/") &&
		!v.includes("\\") &&
		!v.includes("\0") &&
		v !== "." &&
		v !== ".."
	);
}

/** True for a name we would send (design §8, at most NAME_LIMIT). */
export function isValidName(v: unknown): v is string {
	return nameOk(v, NAME_LIMIT);
}

/** Throws RangeError for a name we must not send. `max` is raised only by the probe's name-length test. */
export function checkName(name: string, max = NAME_LIMIT): string {
	if (!nameOk(name, max)) throw new RangeError("invalid-name");
	return name;
}

/** Validates a driveItem into a RemoteItem. Unknown fields are ignored; bad required fields throw. */
export function parseDriveItem(raw: unknown): RemoteItem {
	const o = obj(raw);
	if (!isValidId(o["id"])) throw new InvalidResponse();
	const deleted = optObj(o["deleted"]) !== null;
	const parent = optObj(o["parentReference"]);
	let parentId: string | null = null;
	if (parent && parent["id"] !== undefined) {
		if (!isValidId(parent["id"])) throw new InvalidResponse();
		parentId = parent["id"];
	}
	// Deleted items on consumer OneDrive omit cTag and size, and may omit name and eTag [G-DL-5].
	let name = "";
	if (!deleted || o["name"] !== undefined) {
		if (!nameOk(o["name"], MAX_REMOTE_NAME)) throw new InvalidResponse();
		name = o["name"];
	}
	const eTag = deleted && o["eTag"] === undefined ? "" : tag(o["eTag"]);
	const cTag = o["cTag"] === undefined ? null : tag(o["cTag"]);
	const size = deleted && o["size"] === undefined ? 0 : safeSize(o["size"]);
	const lastModified = o["lastModifiedDateTime"] === undefined ? "" : boundedString(o["lastModifiedDateTime"], MAX_TIMESTAMP, true);
	let quickXorHash: string | null = null;
	const fileFacet = optObj(o["file"]);
	const hashes = fileFacet ? optObj(fileFacet["hashes"]) : null;
	if (hashes && hashes["quickXorHash"] !== undefined) {
		const h = hashes["quickXorHash"];
		if (typeof h !== "string" || !QXH_RE.test(h)) throw new InvalidResponse();
		quickXorHash = h;
	}
	return {
		id: o["id"],
		parentId,
		name,
		isFolder: optObj(o["folder"]) !== null,
		eTag,
		cTag,
		size,
		quickXorHash,
		lastModified,
		deleted,
	};
}

/**
 * Fields outside RemoteItem that some calls need: the raw download URL and the parent's drive path. The download
 * URL is NOT host-checked here, so an unlisted CDN host can't break every item read; download() runs
 * checkTransferUrl before any request (design §8, T-T5).
 */
export function parseItemExtras(raw: unknown): { downloadUrl: string | null; parentPath: string | null } {
	const o = obj(raw);
	const dl = o["@microsoft.graph.downloadUrl"];
	const parent = optObj(o["parentReference"]);
	const path = parent ? parent["path"] : undefined;
	return {
		downloadUrl: dl === undefined ? null : downloadUrlField(dl),
		parentPath: path === undefined ? null : boundedString(path, MAX_PARENT_PATH),
	};
}

function downloadUrlField(v: unknown): string {
	if (typeof v !== "string" || v.length === 0) throw new InvalidResponse("download-url-invalid");
	if (v.length > MAX_TRANSFER_URL) throw new InvalidResponse("download-url-too-long");
	return v;
}

/**
 * Upload and download URLs: https, no userinfo or port, host under an allowlisted suffix (design §8, T-T5).
 * Stops a tampered response from sending our bytes elsewhere. Throws UntrustedUrl, which carries no URL.
 */
export function checkTransferUrl(v: unknown): string {
	if (typeof v !== "string") throw new UntrustedUrl();
	let u: URL;
	try {
		u = new URL(v);
	} catch {
		throw new UntrustedUrl();
	}
	const host = u.hostname.toLowerCase();
	const ok =
		u.protocol === "https:" &&
		u.username === "" &&
		u.password === "" &&
		u.port === "" &&
		// Graph itself is never a transfer host: a Graph URL here would be an authorized, unconditional request
		// (T-I4, M3 review). Transfers also use a transport with no auth decorator.
		host !== "graph.microsoft.com" &&
		TRANSFER_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
	if (!ok) throw new UntrustedUrl();
	return v;
}

/** Paging and delta links carry our Authorization, so they must be Graph v1.0 URLs. */
export function isGraphApiUrl(v: unknown): v is string {
	if (typeof v !== "string") return false;
	try {
		const u = new URL(v);
		return u.origin === "https://graph.microsoft.com" && u.username === "" && u.password === "" && u.pathname.startsWith("/v1.0/");
	} catch {
		return false;
	}
}

function graphLink(v: unknown): string {
	if (!isGraphApiUrl(v)) throw new UntrustedUrl();
	return v;
}

function items(o: Record<string, unknown>): RemoteItem[] {
	const value = o["value"];
	if (!Array.isArray(value)) throw new InvalidResponse();
	return value.map(parseDriveItem);
}

/** A delta page: items plus exactly one of nextLink or deltaLink [G-DL-2]. */
export function parseDeltaPage(body: ArrayBuffer): DeltaPage {
	const o = parseJsonObject(body, MAX_JSON_BODY);
	const list = items(o);
	const next = o["@odata.nextLink"];
	const delta = o["@odata.deltaLink"];
	if ((next === undefined) === (delta === undefined)) throw new InvalidResponse();
	return next !== undefined ? { items: list, nextLink: graphLink(next) } : { items: list, deltaLink: graphLink(delta) };
}

export function parseChildrenPage(body: ArrayBuffer): { items: RemoteItem[]; nextLink?: string } {
	const o = parseJsonObject(body, MAX_JSON_BODY);
	const list = items(o);
	const next = o["@odata.nextLink"];
	return next === undefined ? { items: list } : { items: list, nextLink: graphLink(next) };
}

export function parseUploadSession(body: ArrayBuffer): UploadSessionInfo {
	const o = parseJsonObject(body, MAX_JSON_BODY);
	return { uploadUrl: checkTransferUrl(o["uploadUrl"]), expiresAt: boundedString(o["expirationDateTime"], MAX_TIMESTAMP) };
}

/** `nextExpectedRanges` like ["12345-"] or ["0-99","200-"] → the first missing byte [G-UP-9]. */
export function parseUploadStatus(body: ArrayBuffer): UploadStatus {
	const o = parseJsonObject(body, MAX_JSON_BODY);
	const expiresAt = o["expirationDateTime"] === undefined ? "" : boundedString(o["expirationDateTime"], MAX_TIMESTAMP);
	const ranges = o["nextExpectedRanges"];
	if (ranges === undefined) return { nextExpectedStart: null, expiresAt };
	if (!Array.isArray(ranges)) throw new InvalidResponse();
	if (ranges.length === 0) return { nextExpectedStart: null, expiresAt };
	const m = typeof ranges[0] === "string" ? /^(\d{1,16})-(\d{0,16})$/.exec(ranges[0]) : null;
	const start = m ? Number(m[1]) : NaN;
	if (!Number.isSafeInteger(start) || start > MAX_RANGE_START) throw new InvalidResponse();
	return { nextExpectedStart: start, expiresAt };
}

/** `GET /me/drive` quota, or null when the response has none [G-QT-1]. */
export function parseQuota(body: ArrayBuffer): { total: number; used: number; remaining: number } | null {
	const o = parseJsonObject(body, MAX_JSON_BODY);
	if (o["quota"] === undefined) return null;
	const q = obj(o["quota"]);
	return { total: safeSize(q["total"]), used: safeSize(q["used"]), remaining: safeSize(q["remaining"]) };
}
