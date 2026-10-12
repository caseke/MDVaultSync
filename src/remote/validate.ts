// Type guards for untrusted remote JSON (design §8, T-T2). M2 added the token endpoint; M3 adds Graph items.
import type { DeltaPage, RemoteItem, UploadSessionInfo, UploadStatus } from "../core/ports.ts";
import { UntrustedUrl } from "./errors.ts";

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

// ---------- Graph (M3, design §8, T-T2, T-T5) ----------

/** Caps memory for a delta page; checked before parsing. */
export const MAX_JSON_BODY = 32 * 1024 * 1024;
/** Hosts that upload and download URLs may use (design §8). M3's probe records observed hosts to refine this. */
export const TRANSFER_HOST_SUFFIXES: readonly string[] = [
	".microsoft.com",
	".live.com",
	".sharepoint.com",
	".1drv.com",
	".onedrive.com",
	".livefilestore.com",
];
export const NAME_LIMIT = 255;
const ID_RE = /^[A-Za-z0-9!._-]{1,256}$/;
const QXH_RE = /^[A-Za-z0-9+/]{27}=$/;
const MAX_TAG = 512;
const MAX_TIMESTAMP = 64;
const MAX_PARENT_PATH = 2048;
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
function safeSize(v: unknown): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new InvalidResponse();
	return v;
}

export function isValidId(v: unknown): v is string {
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
		if (!nameOk(o["name"], NAME_LIMIT)) throw new InvalidResponse();
		name = o["name"];
	}
	const eTag = deleted && o["eTag"] === undefined ? "" : boundedString(o["eTag"], MAX_TAG);
	const cTag = o["cTag"] === undefined ? null : boundedString(o["cTag"], MAX_TAG);
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

/** Fields outside RemoteItem that some calls need: a checked download URL, and the parent's drive path. */
export function parseItemExtras(raw: unknown): { downloadUrl: string | null; parentPath: string | null } {
	const o = obj(raw);
	const dl = o["@microsoft.graph.downloadUrl"];
	const parent = optObj(o["parentReference"]);
	const path = parent ? parent["path"] : undefined;
	return {
		downloadUrl: dl === undefined ? null : checkTransferUrl(dl),
		parentPath: path === undefined ? null : boundedString(path, MAX_PARENT_PATH),
	};
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
