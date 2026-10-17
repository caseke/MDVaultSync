// Persisted plugin data (`data.json` via loadData/saveData [O-API-15]): the client ID, the sync settings
// (design §11, R-UI-1) and, only when SecretStorage failed, the fallback refresh token (D-5).
import type { EngineSettings } from "./core/engine.ts";
import { validateSegment } from "./core/paths.ts";
import { DELTA_FORM, type DeltaForm } from "./remote/capabilities.ts";

export interface PluginData {
	/** Entra application (client) ID. A user setting with no default (R-AUTH-8, D-14). */
	clientId: string;
	/** Refresh token, present only when SecretStorage threw (D-5). */
	fallbackRefreshToken?: string;
	/** Name used in conflict copies (D-9). "" means the platform default (see effectiveDeviceName). */
	deviceName: string;
	/** Minutes between syncs; 0 turns the timer off (R-TRIG-2). */
	intervalMinutes: number;
	/** Size cap in MiB (R-SCOPE-3, D-12). */
	maxFileSizeMiB: number;
	/** Gitignore-style lines (design §7, R-SCOPE-2). */
	excludePatterns: string[];
	/** "Preview changes before every sync" (R-FIRST-2). */
	previewEveryRun: boolean;
	/** Mass-delete guard, percent of tracked files (R-GUARD-1). */
	massDeleteThresholdPct: number;
	/** Mirror log events to the developer console (design §9). Codes only, like the log itself (R-SEC-3). */
	verboseLogging: boolean;
}

export const MAX_PATTERN_LINES = 200;
const MAX_PATTERN_LENGTH = 1000;
const MAX_DEVICE_NAME = 40;

/** Interval floor: 1 minute, or 15 on the children-listing fallback, which costs more per run (design §5.2). */
export function intervalFloor(form: DeltaForm): number {
	return form === "children-walk" ? 15 : 1;
}

const FLOOR = intervalFloor(DELTA_FORM);

export const DEFAULT_DATA: Readonly<PluginData> = Object.freeze({
	clientId: "",
	deviceName: "",
	intervalMinutes: Math.max(5, FLOOR),
	maxFileSizeMiB: 100,
	excludePatterns: Object.freeze([]) as unknown as string[],
	previewEveryRun: false,
	massDeleteThresholdPct: 25,
	verboseLogging: false,
});

function wholeNumber(raw: string): number | null {
	const s = raw.trim();
	return /^\d{1,5}$/.test(s) ? Number(s) : null;
}

function inRange(n: unknown, min: number, max: number): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
}

/** 0 (off) or floor–1440 whole minutes; null if invalid. */
export function parseInterval(raw: string, floor = FLOOR): number | null {
	const n = wholeNumber(raw);
	return n !== null && (n === 0 || (n >= floor && n <= 1440)) ? n : null;
}

export function parseMaxFileSize(raw: string): number | null {
	const n = wholeNumber(raw);
	return n !== null && n >= 1 && n <= 1024 ? n : null;
}

export function parseThreshold(raw: string): number | null {
	const n = wholeNumber(raw);
	return n !== null && n >= 1 && n <= 100 ? n : null;
}

/** One pattern per line; trailing blank lines dropped; null if over 200 lines or a line is absurdly long. */
export function parseExcludePatterns(text: string): string[] | null {
	const lines = text.split(/\r?\n/);
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
	if (lines.length > MAX_PATTERN_LINES || lines.some((l) => l.length > MAX_PATTERN_LENGTH)) return null;
	return lines;
}

/** 1–40 characters that make a valid OneDrive name: it ends up inside conflict copy names (design §5.5). */
export function parseDeviceName(raw: string): string | null {
	const s = raw.trim().normalize("NFC");
	if (s.length === 0 || s.length > MAX_DEVICE_NAME) return null;
	return validateSegment(s, false) === null ? s : null;
}

/** Design §11: "iPad" or "Ubuntu" for the owner's devices; platformName() from platform/diagnostics.ts. */
export function defaultDeviceName(platform: string): string {
	const names: Record<string, string> = { ios: "iPad", linux: "Ubuntu", macos: "Mac", windows: "Windows", android: "Android" };
	return Object.prototype.hasOwnProperty.call(names, platform) ? (names[platform] ?? "Device") : "Device";
}

export function effectiveDeviceName(data: PluginData, platformDefault: string): string {
	return data.deviceName === "" ? platformDefault : data.deviceName;
}

function validPatterns(v: unknown): v is string[] {
	return Array.isArray(v) && v.length <= MAX_PATTERN_LINES && v.every((p) => typeof p === "string" && p.length <= MAX_PATTERN_LENGTH);
}

/**
 * True when data.json holds exclude patterns that can't be used. Every other bad field falls back to a safe
 * default, but "no exclusions" is the unsafe default here: it would upload what the user meant to keep off
 * OneDrive (T-I6). So sync pauses until the patterns are saved again in settings (M7 review).
 */
export function excludePatternsInvalid(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("excludePatterns" in raw)) return false;
	return !validPatterns((raw as Record<string, unknown>)["excludePatterns"]);
}

export type PauseState = { paused: false } | { paused: true; raw: unknown; readable: string[] };

/**
 * Whether sync must pause for unknown exclude patterns (T-I6): the patterns are present but unusable, or a
 * data.json exists on disk but didn't load as an object (corrupt or truncated: Obsidian then hands back nothing,
 * O-API-19). `raw` is what every save writes back while paused; `readable` pre-fills the settings field.
 */
export function pauseFromData(raw: unknown, fileExists: boolean): PauseState {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return fileExists ? { paused: true, raw: null, readable: [] } : { paused: false };
	}
	if (!excludePatternsInvalid(raw)) return { paused: false };
	const value = (raw as Record<string, unknown>)["excludePatterns"];
	const readable = Array.isArray(value) ? value.filter((p): p is string => typeof p === "string" && p.length <= MAX_PATTERN_LENGTH).slice(0, MAX_PATTERN_LINES) : [];
	return { paused: true, raw: value, readable };
}

/**
 * What a save writes to data.json. While sync is paused for unreadable patterns (`pausedRaw` is the value read
 * at load), every save that doesn't set new patterns writes that value back unchanged, so a restart is still
 * paused instead of loading the parsed fallback (no exclusions) as if it were the user's choice (T-I6).
 */
export function snapshotForSave(data: PluginData, patch: Partial<PluginData>, pausedRaw: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = { ...data, ...patch };
	if (pausedRaw !== undefined && patch.excludePatterns === undefined) out["excludePatterns"] = pausedRaw;
	return out;
}

/** data.json can be edited by hand or by another plugin (T-T6): keep only well-typed, in-range fields. */
export function parseData(raw: unknown): PluginData {
	const out: PluginData = { ...DEFAULT_DATA, excludePatterns: [] };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	const o = raw as Record<string, unknown>;
	if (typeof o["clientId"] === "string") out.clientId = o["clientId"];
	const rt = o["fallbackRefreshToken"];
	if (typeof rt === "string" && rt.length > 0) out.fallbackRefreshToken = rt;
	const name = o["deviceName"];
	if (typeof name === "string" && parseDeviceName(name) === name) out.deviceName = name;
	const iv = o["intervalMinutes"];
	if (inRange(iv, 0, 1440) && (iv === 0 || iv >= FLOOR)) out.intervalMinutes = iv;
	if (inRange(o["maxFileSizeMiB"], 1, 1024)) out.maxFileSizeMiB = o["maxFileSizeMiB"];
	const pats = o["excludePatterns"];
	if (validPatterns(pats)) out.excludePatterns = [...pats];
	if (typeof o["previewEveryRun"] === "boolean") out.previewEveryRun = o["previewEveryRun"];
	if (inRange(o["massDeleteThresholdPct"], 1, 100)) out.massDeleteThresholdPct = o["massDeleteThresholdPct"];
	if (typeof o["verboseLogging"] === "boolean") out.verboseLogging = o["verboseLogging"];
	return out;
}

/** What the engine reads at the start of each run. Copies, so a later settings change can't alter a running sync. */
export function toEngineSettings(data: PluginData, platformDefault: string): EngineSettings {
	return {
		excludePatterns: [...data.excludePatterns],
		maxFileSize: data.maxFileSizeMiB * 1024 * 1024,
		deviceName: effectiveDeviceName(data, platformDefault),
		previewEveryRun: data.previewEveryRun,
		massDeleteThresholdPct: data.massDeleteThresholdPct,
	};
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidClientId(id: string): boolean {
	return GUID_RE.test(id);
}
