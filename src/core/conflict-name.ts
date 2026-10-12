// Conflict copy names (R-CONF-1, D-9, design §5.5 step 2):
// `<dir>/<stem> (conflict <device> <YYYY-MM-DD HHmmss>)<.ext>`, with ` 2`, ` 3`… after the `)` on collision.
// This names a new file we create; the user's own file keeps its name (D-17).
import { NAME_MAX, PATH_MAX } from "./paths.ts";
import type { VaultPath } from "./ports.ts";

const DEVICE_MAX = 40; // design §11
const MAX_ATTEMPTS = 1000;
// eslint-disable-next-line no-control-regex -- control characters are among the characters replaced
const DEVICE_BAD = /["*:<>?/\\|\u0000-\u001f]/g;

/** Drops whole code points from the end until `s` fits in `max` UTF-16 units, so no surrogate pair is split. */
function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	const cps = Array.from(s);
	let out = "";
	for (const cp of cps) {
		if (out.length + cp.length > max) break;
		out += cp;
	}
	return out;
}

/** Device name made safe for a file name with the §7 character rules: at most 40 units, never empty. */
export function sanitizeDeviceName(name: string): string {
	const cleaned = truncate(name.normalize("NFC").replace(DEVICE_BAD, "-").trim(), DEVICE_MAX).trim();
	return cleaned === "" ? "device" : cleaned;
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

/** Local time, `YYYY-MM-DD HHmmss`. */
function stamp(d: Date): string {
	return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * The conflict copy path for `path`. `exists` must compare case-insensitively (OneDrive names are
 * [G-NM-5]). If the name would break the 255-unit name or 400-character path limit [G-NM-4], the copy's stem
 * is shortened. Throws RangeError if the folder alone leaves no room, or after 1000 taken names.
 */
export function conflictCopyPath(path: VaultPath, deviceName: string, date: Date, exists: (p: VaultPath) => boolean, pathPrefixLen = 0): VaultPath {
	const slash = path.lastIndexOf("/");
	const dir = slash === -1 ? "" : path.slice(0, slash + 1);
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	const tag = ` (conflict ${sanitizeDeviceName(deviceName)} ${stamp(date)})`;

	for (let n = 1; n <= MAX_ATTEMPTS; n++) {
		const suffix = `${tag}${n === 1 ? "" : ` ${n}`}${ext}`;
		const budget = Math.min(NAME_MAX - suffix.length, PATH_MAX - pathPrefixLen - 1 - dir.length - suffix.length);
		const short = truncate(stem, budget);
		if (budget < 1 || short === "") throw new RangeError("path-too-long");
		const candidate = `${dir}${short}${suffix}` as VaultPath;
		if (!exists(candidate)) return candidate;
	}
	throw new RangeError("conflict-name-exhausted");
}
