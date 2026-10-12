// What never syncs (R-SCOPE-2, D-6, design §7 step 2): configDir, any hidden segment, and the user's
// gitignore-style exclude patterns. Our own matcher, no dependency, and no RegExp built from user input, so a
// pattern can't cause catastrophic backtracking.
//
// Supported pattern syntax (a subset of gitignore):
// - `*` matches any run of characters except `/`; `?` matches one character except `/`.
// - `**` as a whole segment matches zero or more folders (`**/tmp`, `a/**/b`); a trailing `/**` matches
//   everything inside the folder, but not the folder itself.
// - A pattern with no `/` except a trailing one matches a name at any depth; otherwise it is anchored to the
//   vault root (a leading `/` is dropped).
// - A trailing `/` matches folders only. A pattern that matches a folder excludes everything under it.
// - Blank lines and lines starting with `#` are ignored. `!` negation is not supported and such lines are
//   ignored; `[` has no special meaning. Matching is case-sensitive, on NFC-normalized text.
import { caseKey } from "./paths.ts";

interface Rule {
	segs: string[];
	dirOnly: boolean;
}

function parseRule(line: string): Rule | null {
	let p = line.normalize("NFC").trim();
	if (p === "" || p.startsWith("#") || p.startsWith("!")) return null;
	let dirOnly = false;
	while (p.endsWith("/")) {
		dirOnly = true;
		p = p.slice(0, -1);
	}
	const anchored = p.includes("/");
	const parts = p.split("/").filter((s) => s !== "");
	if (parts.length === 0) return null;
	const segs = anchored ? [] : ["**"];
	for (const s of parts) if (!(s === "**" && segs[segs.length - 1] === "**")) segs.push(s);
	return { segs, dirOnly };
}

/** `*` and `?` within one segment. Greedy with one backtrack point: O(pattern × name) worst case. */
function globSegment(pat: string, name: string): boolean {
	let p = 0;
	let n = 0;
	let star = -1;
	let mark = 0;
	while (n < name.length) {
		if (p < pat.length && (pat[p] === "?" || pat[p] === name[n])) {
			p++;
			n++;
		} else if (p < pat.length && pat[p] === "*") {
			star = p++;
			mark = n;
		} else if (star !== -1) {
			p = star + 1;
			n = ++mark;
		} else {
			return false;
		}
	}
	while (pat[p] === "*") p++;
	return p === pat.length;
}

/** Whole-segment match with `**`, by dynamic programming over (pattern segment, path segment). */
function matchSegments(pat: readonly string[], segs: readonly string[]): boolean {
	const m = pat.length;
	const n = segs.length;
	// next[j] = pat[i+1..] matches segs[j..]; cur[j] = pat[i..] matches segs[j..].
	let next: boolean[] = Array.from({ length: n + 1 }, (_, j) => j === n);
	for (let i = m - 1; i >= 0; i--) {
		const cur: boolean[] = new Array<boolean>(n + 1).fill(false);
		const ps = pat[i] ?? "";
		for (let j = n; j >= 0; j--) {
			if (ps === "**") {
				cur[j] = i === m - 1 ? j < n : (next[j] ?? false) || (j < n && (cur[j + 1] ?? false));
			} else {
				cur[j] = j < n && (next[j + 1] ?? false) && globSegment(ps, segs[j] ?? "");
			}
		}
		next = cur;
	}
	return next[0] ?? false;
}

/**
 * Why `path` must not sync, or null. `hidden` covers configDir (first segment, compared case-insensitively
 * because the iPad's file system is) and any segment starting with `.`; `excluded` covers user patterns.
 */
export function exclusionReason(path: string, configDir: string, patterns: readonly string[], isFolder = false): "hidden" | "excluded" | null {
	const segs = path.split("/");
	if (segs.some((s) => s.startsWith("."))) return "hidden";
	if (caseKey(segs[0] ?? "") === caseKey(configDir.normalize("NFC"))) return "hidden";
	for (const line of patterns) {
		const rule = parseRule(line);
		if (!rule) continue;
		for (let k = 1; k <= segs.length; k++) {
			// Every proper prefix is a folder; the path itself is one only if isFolder.
			if (rule.dirOnly && k === segs.length && !isFolder) continue;
			if (matchSegments(rule.segs, segs.slice(0, k))) return "excluded";
		}
	}
	return null;
}

export function isExcluded(path: string, configDir: string, patterns: readonly string[], isFolder = false): boolean {
	return exclusionReason(path, configDir, patterns, isFolder) !== null;
}
