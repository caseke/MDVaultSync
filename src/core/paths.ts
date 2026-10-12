// Path rules (design §7) and remote-to-vault containment (design §8, T-T1, T-E1). Pure: no Obsidian import.
// Functions return a SkipReason instead of throwing, so the planner can report every rejected path (R-PATH-3).
import type { SkipReason, VaultPath } from "./ports.ts";

/**
 * Longest name we accept for sync, in UTF-16 units [G-NM-6]. Same value as `src/remote/capabilities.ts`
 * NAME_MAX; core can't import remote, so a test asserts they match.
 */
export const NAME_MAX = 255;
/** Full decoded path limit, including the App Folder prefix [G-NM-4]. */
export const PATH_MAX = 400;

export type NameProblem = "invalid-name" | "reserved-name";
export type ContainmentProblem = "outside-vault" | "hidden";
export type CollisionReason = "unicode-collision" | "case-collision";
export type RemotePathResult = { ok: true; path: VaultPath } | { ok: false; reason: SkipReason };

// [G-NM-1]: `" * : < > ? / \ |`, plus control characters U+0000–U+001F (design §7 step 3).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVALID_CHAR = /["*:<>?/\\|\u0000-\u001f]/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_OR_SEPARATOR = /[/\\\u0000-\u001f]/;
// [G-NM-2]: reserved device names, with or without an extension, compared case-insensitively.
// Obsidian's normalizePath is believed to map U+00A0 and U+202F to a space (undocumented in obsidian.d.ts; M4
// security review). Two remote names that differ only there would then share one local file, and " x" would
// gain a leading space, so such names are skipped on both sides rather than mapped.
const NBSP = /[\u00a0\u202f]/;
const RESERVED_DEVICE = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\..*)?$/i;
const DRIVE_PREFIX = /^[A-Za-z]:/;

/** Case-folded key for collision checks; OneDrive names are case-insensitive [G-NM-5] (design §7.5). */
export function caseKey(path: string): string {
	return path.toLocaleLowerCase("en-US");
}

/**
 * True when `name` equals configDir under either fold. `toLocaleLowerCase` alone misses case-insensitive
 * file systems that fold like Unicode case folding (U+017F "ſ" → "s"), so the upper-then-lower fold is
 * checked too (T-E1, M4 security review). Used only for configDir; collision keys stay `caseKey`.
 */
export function isConfigDirName(name: string, configDir: string): boolean {
	const a = nfc(name);
	const b = nfc(configDir);
	// lower→upper→lower also catches U+1E9E "ẞ", which full case folding maps to "ss".
	const folds = (s: string) => [caseKey(s), s.toUpperCase().toLowerCase(), s.toLowerCase().toUpperCase().toLowerCase()];
	const fb = folds(b);
	return folds(a).some((f, i) => f === fb[i]);
}

function nfc(s: string): string {
	return s.normalize("NFC");
}

/**
 * Brands a local path from the Vault API: NFC (as Obsidian's normalizePath does [O-API-16]), no leading or
 * trailing `/`, and no empty, `.` or `..` segments. Name rules are checked separately by `validatePath`.
 */
export function toVaultPath(raw: string): VaultPath | null {
	const p = nfc(raw);
	if (p === "") return null;
	for (const seg of p.split("/")) if (seg === "" || seg === "." || seg === "..") return null;
	return p as VaultPath;
}

/** OneDrive naming rules for one segment [G-NM-1]–[G-NM-3], [G-NM-6]. Never rewrites the name (D-17). */
export function validateSegment(name: string, isFolder: boolean): NameProblem | null {
	if (name.length === 0 || name.length > NAME_MAX) return "invalid-name";
	if (INVALID_CHAR.test(name) || NBSP.test(name)) return "invalid-name";
	if (name.startsWith(" ") || name.endsWith(" ")) return "invalid-name";
	if (name.startsWith("~")) return "invalid-name"; // covers OneDrive personal's `~$` too
	if (isFolder && name.endsWith(".")) return "invalid-name";
	const lower = name.toLowerCase();
	if (RESERVED_DEVICE.test(name) || lower === ".lock" || lower === "desktop.ini" || lower.includes("_vti_")) {
		return "reserved-name";
	}
	return null;
}

/**
 * Checks every segment (ancestors are folders) and the full-path limit:
 * `pathPrefixLen + 1 + path.length ≤ 400`, where `pathPrefixLen` is `AppRoot.pathPrefix` without its leading
 * `/` (16 for `Apps/MDVaultSync`) [G-NM-4].
 */
export function validatePath(path: string, pathPrefixLen: number, isFolder: boolean): NameProblem | "path-too-long" | null {
	const segs = path.split("/");
	for (let i = 0; i < segs.length; i++) {
		const problem = validateSegment(segs[i] ?? "", i < segs.length - 1 || isFolder);
		if (problem) return problem;
	}
	if (pathPrefixLen + 1 + path.length > PATH_MAX) return "path-too-long";
	return null;
}

function containmentOfSegments(segs: readonly string[], configDir: string): ContainmentProblem | null {
	if (segs.length === 0) return "outside-vault";
	for (const seg of segs) {
		if (seg === "" || seg === "." || seg === ".." || CONTROL_OR_SEPARATOR.test(seg)) return "outside-vault";
	}
	if (DRIVE_PREFIX.test(segs[0] ?? "")) return "outside-vault";
	if (segs.some((s) => s.startsWith("."))) return "hidden";
	// configDir may be renamed and need not start with a dot. Compared case-insensitively: on a case-insensitive
	// file system (the iPad), a remote "Config/" would land inside a configDir named "config" (T-E1).
	if (isConfigDirName(segs[0] ?? "", configDir)) return "hidden";
	return null;
}

/**
 * Containment of a joined vault path (design §8). M6 calls this again right before every local write
 * (T-T1 defense in depth). A path that isn't NFC isn't a VaultPath, so it is refused too.
 */
export function containmentProblem(path: string, configDir: string): ContainmentProblem | null {
	if (path !== nfc(path)) return "outside-vault";
	return containmentOfSegments(path.split("/"), configDir);
}

/**
 * Maps the names on a remote item's parent chain (approot excluded) to a vault path. Order: containment
 * (`outside-vault`, `hidden`), then every name through `validateSegment` and the path limit (M3 carry-in:
 * names up to 400 characters arrive from Graph and must be skipped here, not written), then a round-trip
 * check that the joined path is already a normalized VaultPath. Anything rejected is a skip (R-SCOPE-4, R-PATH-4).
 */
export function remoteToVaultPath(segments: readonly string[], configDir: string, pathPrefixLen: number, isFolder: boolean): RemotePathResult {
	const segs = segments.map(nfc);
	const contained = containmentOfSegments(segs, configDir);
	if (contained) return { ok: false, reason: contained };
	const joined = segs.join("/");
	const invalid = validatePath(joined, pathPrefixLen, isFolder);
	if (invalid) return { ok: false, reason: invalid };
	const path = toVaultPath(joined);
	if (path === null || path !== joined || containmentProblem(path, configDir)) return { ok: false, reason: "outside-vault" };
	return { ok: true, path };
}

function ancestorsAndSelf(path: string): string[] {
	const segs = path.split("/");
	return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
}

/**
 * Local paths that must be skipped because they collide (design §7 steps 1 and 5), keyed by the raw input path.
 * - Paths equal after NFC: every member is skipped as `unicode-collision`.
 * - Paths equal after `caseKey` (possible on ext4): the one tracked in `files` keeps syncing and the rest are
 *   skipped as `case-collision`; if none or several are tracked, all are skipped.
 * - Folders count too, including folders implied by file paths. A losing folder's descendants are skipped
 *   with the same reason, because OneDrive would merge the two folders into one.
 * `tracked` holds NFC vault paths of files with a FileRecord.
 */
export function findCollisions(rawPaths: readonly string[], tracked: ReadonlySet<string>): Map<string, CollisionReason> {
	const prefixes = new Set<string>();
	for (const p of rawPaths) for (const a of ancestorsAndSelf(p)) prefixes.add(a);

	const losers = new Map<string, CollisionReason>();
	const byNfc = new Map<string, string[]>();
	for (const p of prefixes) {
		const key = nfc(p);
		byNfc.set(key, [...(byNfc.get(key) ?? []), p]);
	}
	for (const group of byNfc.values()) {
		if (group.length > 1) for (const p of group) losers.set(p, "unicode-collision");
	}

	const isTracked = (p: string) => {
		if (tracked.has(p)) return true;
		for (const t of tracked) if (t.startsWith(p + "/")) return true;
		return false;
	};
	const byCase = new Map<string, string[]>();
	for (const key of byNfc.keys()) {
		const ck = caseKey(key);
		byCase.set(ck, [...(byCase.get(ck) ?? []), key]);
	}
	for (const group of byCase.values()) {
		if (group.length < 2) continue;
		const keepers = group.filter(isTracked);
		const keep = keepers.length === 1 ? keepers[0] : undefined;
		for (const key of group) {
			if (key === keep) continue;
			for (const raw of byNfc.get(key) ?? []) if (!losers.has(raw)) losers.set(raw, "case-collision");
		}
	}

	const result = new Map<string, CollisionReason>();
	for (const p of rawPaths) {
		for (const a of ancestorsAndSelf(p)) {
			const reason = losers.get(a);
			if (reason) {
				result.set(p, reason);
				break;
			}
		}
	}
	return result;
}
