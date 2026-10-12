// Persisted sync state (design §2 `SyncState`, §6.2). The state file is untrusted: another plugin can edit it
// (T-T6). Every field is checked here, and a malformed file is treated as "no state", which forces a union
// merge that deletes nothing (R-FIRST-1, T-D1). Pure: no Obsidian import.
import { containmentProblem, toVaultPath } from "./paths.ts";
import type {
	FileRecord,
	PendingConflict,
	PendingLocalOp,
	PlanOp,
	RemoteItem,
	SkipReason,
	SyncReport,
	SyncState,
	Trigger,
	UploadSessionRecord,
	UploadTarget,
	UploadTargetReplace,
	VaultPath,
} from "./ports.ts";

// Same rules as src/remote/validate.ts (core can't import remote; test/state.test.ts checks they agree).
/** 1–256 of [A-Za-z0-9!._-], not only dots (design §8). */
export const ID_RE = /^(?!\.+$)[A-Za-z0-9!._-]{1,256}$/;
/** QuickXorHash, base64 of 20 bytes. */
export const QXH_RE = /^[A-Za-z0-9+/]{27}=$/;
/** eTag/cTag: printable ASCII, at most 512, because they go back out as If-Match. */
const TAG_RE = /^[\x20-\x7e]{1,512}$/;
const MAX_REMOTE_NAME = 400;
const MAX_STRING = 8192;
const MAX_PENDING_LOCAL = 100_000;
const MAX_REPORT_ROWS = 100_000;

const TRIGGERS: readonly Trigger[] = ["startup", "interval", "command", "ribbon", "preview", "rerun"];
const RESULTS: readonly SyncReport["result"][] = ["ok", "partial", "failed", "cancelled"];
const OP_KINDS: readonly PlanOp["kind"][] = [
	"download",
	"upload-new",
	"upload-replace",
	"remote-move",
	"local-move",
	"remote-delete",
	"local-trash",
	"conflict",
	"adopt",
	"forget",
	"skip",
];
const SKIP_REASONS: readonly SkipReason[] = [
	"too-large",
	"invalid-name",
	"path-too-long",
	"case-collision",
	"reserved-name",
	"outside-vault",
	"hidden",
	"excluded",
	"unicode-collision",
];

/** Thrown inside the parser; `parseSyncState` turns it into null. Carries no data (T-I3). */
class Malformed extends Error {
	constructor() {
		super("malformed-state");
	}
}

function fail(): never {
	throw new Malformed();
}

function obj(v: unknown): Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) fail();
	return v as Record<string, unknown>;
}

function arr(v: unknown, max: number): unknown[] {
	if (!Array.isArray(v) || v.length > max) fail();
	return v;
}

function str(v: unknown, max = MAX_STRING, allowEmpty = false): string {
	if (typeof v !== "string" || v.length > max || (!allowEmpty && v.length === 0)) fail();
	return v;
}

function bool(v: unknown): boolean {
	if (typeof v !== "boolean") fail();
	return v;
}

function count(v: unknown): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail();
	return v;
}

function time(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail();
	return v;
}

function id(v: unknown): string {
	if (typeof v !== "string" || !ID_RE.test(v)) fail();
	return v;
}

function tag(v: unknown): string {
	if (typeof v !== "string" || !TAG_RE.test(v)) fail();
	return v;
}

function optTag(v: unknown): string | null {
	return v === null ? null : tag(v);
}

function hash(v: unknown): string {
	if (typeof v !== "string" || !QXH_RE.test(v)) fail();
	return v;
}

function optHash(v: unknown): string | null {
	return v === null ? null : hash(v);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
	if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) fail();
	return v as T;
}

/** A path that may be written to: a normalized VaultPath outside configDir and hidden folders (T-T1). */
function path(v: unknown, configDir: string): VaultPath {
	if (typeof v !== "string") fail();
	const p = toVaultPath(v);
	if (p === null || p !== v || containmentProblem(p, configDir) !== null) fail();
	return p;
}

/** Map keyed by vault path. `Object.fromEntries` defines own properties, so a key like "__proto__" stays data. */
function pathMap<T>(v: unknown, configDir: string, parse: (value: unknown, key: VaultPath) => T): Record<VaultPath, T> {
	return Object.fromEntries(
		Object.entries(obj(v)).map(([k, value]) => {
			const key = path(k, configDir);
			return [key, parse(value, key)];
		}),
	);
}

function remoteItem(v: unknown): RemoteItem {
	const o = obj(v);
	const deleted = bool(o["deleted"]);
	const name = str(o["name"], MAX_REMOTE_NAME, deleted);
	if (name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") fail();
	return {
		id: id(o["id"]),
		parentId: o["parentId"] === null ? null : id(o["parentId"]),
		name,
		isFolder: bool(o["isFolder"]),
		eTag: deleted && o["eTag"] === "" ? "" : tag(o["eTag"]),
		cTag: optTag(o["cTag"]),
		size: count(o["size"]),
		quickXorHash: optHash(o["quickXorHash"]),
		lastModified: str(o["lastModified"], 64, true),
		deleted,
	};
}

function fileRecord(v: unknown, key: VaultPath, configDir: string): FileRecord {
	const o = obj(v);
	if (path(o["path"], configDir) !== key) fail();
	return {
		path: key,
		remoteId: id(o["remoteId"]),
		eTag: tag(o["eTag"]),
		cTag: optTag(o["cTag"]),
		size: count(o["size"]),
		mtime: time(o["mtime"]),
		localHash: hash(o["localHash"]),
		remoteHash: hash(o["remoteHash"]),
		transformId: str(o["transformId"], 64),
	};
}

function uploadTarget(v: unknown): UploadTarget | UploadTargetReplace {
	const o = obj(v);
	if (o["kind"] === "replace") return { kind: "replace", id: id(o["id"]) };
	if (o["kind"] !== "new") fail();
	const name = str(o["name"], MAX_REMOTE_NAME);
	if (name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") fail();
	return { kind: "new", parentId: id(o["parentId"]), name };
}

function uploadSession(v: unknown, key: VaultPath, configDir: string): UploadSessionRecord {
	const o = obj(v);
	if (path(o["path"], configDir) !== key) fail();
	const target = uploadTarget(o["target"]);
	const ifMatch = optTag(o["ifMatch"]);
	// A replace session without If-Match must never be resumed (R-CC-1).
	if (target.kind === "replace" && ifMatch === null) fail();
	return {
		path: key,
		// The URL is a bearer credential; it is checked against the host allowlist at every use (design §8).
		uploadUrl: str(o["uploadUrl"]),
		expiresAt: str(o["expiresAt"], 64),
		totalSize: count(o["totalSize"]),
		localHash: hash(o["localHash"]),
		ifMatch,
		target,
	};
}

function pendingConflict(v: unknown, key: VaultPath, configDir: string): PendingConflict {
	const o = obj(v);
	if (path(o["path"], configDir) !== key) fail();
	return { path: key, copyPath: path(o["copyPath"], configDir), localHash: hash(o["localHash"]), remoteId: id(o["remoteId"]) };
}

function pendingLocal(v: unknown, configDir: string): PendingLocalOp {
	const o = obj(v);
	if (o["kind"] === "renamed") return { kind: "renamed", from: path(o["from"], configDir), to: path(o["to"], configDir) };
	if (o["kind"] === "dirty" || o["kind"] === "deleted") return { kind: o["kind"], path: path(o["path"], configDir) };
	fail();
}

/** Report paths are display-only (never written), so they need only be strings; kinds and reasons are closed sets. */
function report(v: unknown): SyncReport {
	const o = obj(v);
	const displayPath = (p: unknown) => str(p, MAX_STRING) as VaultPath;
	const counts = obj(o["counts"]);
	const outCounts = Object.fromEntries(OP_KINDS.map((k) => [k, count(counts[k])])) as Record<PlanOp["kind"], number>;
	return {
		trigger: oneOf(o["trigger"], TRIGGERS),
		startedAt: time(o["startedAt"]),
		finishedAt: time(o["finishedAt"]),
		result: oneOf(o["result"], RESULTS),
		counts: outCounts,
		touched: arr(o["touched"], MAX_REPORT_ROWS).map((t) => {
			const r = obj(t);
			const row: SyncReport["touched"][number] = { kind: oneOf(r["kind"], OP_KINDS), path: displayPath(r["path"]) };
			if (r["to"] !== undefined) row.to = displayPath(r["to"]);
			return row;
		}),
		conflicts: arr(o["conflicts"], MAX_REPORT_ROWS).map((c) => {
			const r = obj(c);
			return { path: displayPath(r["path"]), copyPath: displayPath(r["copyPath"]) };
		}),
		skipped: arr(o["skipped"], MAX_REPORT_ROWS).map((s) => {
			const r = obj(s);
			return { path: displayPath(r["path"]), reason: oneOf(r["reason"], SKIP_REASONS) };
		}),
		errors: arr(o["errors"], MAX_REPORT_ROWS).map((e) => {
			const r = obj(e);
			return { path: r["path"] === null ? null : displayPath(r["path"]), code: str(r["code"], 64) };
		}),
	};
}

function parseOrThrow(raw: unknown, configDir: string): SyncState {
	const o = obj(raw);
	if (o["schemaVersion"] !== 1) fail();
	const remoteIndex: Record<string, RemoteItem> = Object.fromEntries(
		Object.entries(obj(o["remoteIndex"])).map(([k, v]) => {
			const it = remoteItem(v);
			if (it.id !== k) fail();
			return [k, it];
		}),
	);
	let lastReport: SyncReport | null = null;
	if (o["lastReport"] !== null && o["lastReport"] !== undefined) {
		// The report is display-only; a bad one is dropped rather than discarding the whole state.
		try {
			lastReport = report(o["lastReport"]);
		} catch (e) {
			if (!(e instanceof Malformed)) throw e;
		}
	}
	return {
		schemaVersion: 1,
		deviceId: str(o["deviceId"], 128),
		appRootId: o["appRootId"] === null ? null : id(o["appRootId"]),
		deltaLink: o["deltaLink"] === null ? null : str(o["deltaLink"]),
		remoteIndex,
		files: pathMap(o["files"], configDir, (v, k) => fileRecord(v, k, configDir)),
		folders: pathMap(o["folders"], configDir, (v) => id(v)),
		pendingLocal: arr(o["pendingLocal"], MAX_PENDING_LOCAL).map((v) => pendingLocal(v, configDir)),
		uploadSessions: pathMap(o["uploadSessions"], configDir, (v, k) => uploadSession(v, k, configDir)),
		pendingConflicts: pathMap(o["pendingConflicts"], configDir, (v, k) => pendingConflict(v, k, configDir)),
		firstSyncCompleted: bool(o["firstSyncCompleted"]),
		unionPending: bool(o["unionPending"]),
		declinedDeletes: pathMap(o["declinedDeletes"], configDir, (v) => {
			const d = obj(v);
			return { localHash: optHash(d["localHash"]), eTag: optTag(d["eTag"]) };
		}),
		lastReport,
	};
}

/** A fresh state for a device with no sync history: union mode until the first merge finishes (R-FIRST-1). */
export function emptyState(deviceId: string): SyncState {
	return {
		schemaVersion: 1,
		deviceId,
		appRootId: null,
		deltaLink: null,
		remoteIndex: {},
		files: {},
		folders: {},
		pendingLocal: [],
		uploadSessions: {},
		pendingConflicts: {},
		firstSyncCompleted: false,
		unionPending: true,
		declinedDeletes: {},
		lastReport: null,
	};
}

/** The validated state, or null if any field is missing, mistyped, out of range or unsafe (T-T6). */
export function parseSyncState(raw: unknown, configDir: string): SyncState | null {
	try {
		return parseOrThrow(raw, configDir);
	} catch (e) {
		if (e instanceof Malformed) return null;
		throw e;
	}
}

/**
 * The state to run with. A missing or malformed file gives a fresh state, which forces union mode, so acting on a
 * tampered file can never delete (T-T6, T-D1). A valid deviceId in a malformed file is kept.
 */
export function loadState(raw: unknown, configDir: string, newDeviceId: string): SyncState {
	const parsed = parseSyncState(raw, configDir);
	if (parsed) return parsed;
	const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const keep = o["deviceId"];
	return emptyState(typeof keep === "string" && keep.length > 0 && keep.length <= 128 ? keep : newDeviceId);
}

/**
 * Preflight's approot check (design §5.1, D-18). A different approot ID means the App Folder was deleted or
 * replaced: everything learned about the remote is dropped, local files are kept, and the next run is a union
 * merge. Returns a new state; the input is not changed.
 */
export function applyAppRoot(state: SyncState, appRootId: string): SyncState {
	if (state.appRootId === appRootId) return state;
	if (state.appRootId === null) return { ...state, appRootId };
	return {
		...state,
		appRootId,
		deltaLink: null,
		remoteIndex: {},
		files: {},
		folders: {},
		uploadSessions: {},
		pendingConflicts: {},
		declinedDeletes: {},
		unionPending: true,
	};
}
