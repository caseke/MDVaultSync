// How file names are shown in the preview, report and notices (M4 carry-in "Showing names"). Bidi controls,
// C0/C1 controls, DEL and line/paragraph separators pass the OneDrive name rules, so a name can hold them; they
// can't escape the vault, but they can disguise a name (U+202E turns "fdp.exe" around). They are shown as \u{XXXX}.
// Display only: the real path is never changed.

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const DISGUISING = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

export function displayPath(p: string): string {
	return p.replace(DISGUISING, (c) => `\\u{${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}}`);
}
