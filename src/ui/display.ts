// How file names are shown in the preview, report and notices (M4 carry-in "Showing names"). Bidi controls,
// C0/C1 controls, DEL and line/paragraph separators pass the OneDrive name rules, so a name can hold them; they
// can't escape the vault, but they can disguise a name (U+202E turns "fdp.exe" around). They are shown as \u{XXXX}.
// Every control (Cc) and format character (Cf: zero-width, soft hyphen, BOM, bidi, tags), and every default-ignorable
// code point (blank fillers, variation selectors, U+034F), can make two names look alike, so they are escaped too
// (M7 reviews). Display only: the real path is never changed.

const DISGUISING = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

export function displayPath(p: string): string {
	return p.replace(DISGUISING, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`);
}
