// Names shown in the preview, report and notices (M4 carry-in "Showing names"): characters that can disguise a
// name are shown escaped; everything else is shown as is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayPath } from "../src/ui/display.ts";

test("bidi overrides, isolates and marks are escaped", () => {
	assert.equal(displayPath("invoice\u202Efdp.md"), "invoice\\u{202E}fdp.md");
	for (const cp of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
		const hex = cp.toString(16).toUpperCase().padStart(4, "0");
		assert.equal(displayPath(`a${String.fromCodePoint(cp)}b`), `a\\u{${hex}}b`, hex);
	}
});

test("C0 and C1 controls, DEL and line/paragraph separators are escaped", () => {
	assert.equal(displayPath("a\u0000b"), "a\\u{0000}b");
	assert.equal(displayPath("a\u001Fb"), "a\\u{001F}b");
	assert.equal(displayPath("a\u007Fb"), "a\\u{007F}b");
	assert.equal(displayPath("a\u0085b\u009Fc"), "a\\u{0085}b\\u{009F}c");
	assert.equal(displayPath("a\u2028b\u2029c"), "a\\u{2028}b\\u{2029}c");
});

test("ordinary Unicode is untouched", () => {
	for (const s of ["Notes/café.md", "日本語/メモ.md", "emoji 🎉.md", "a b/c-d_e (1).md", "e\u0301.md"]) assert.equal(displayPath(s), s);
});

test("invisible format characters are escaped too (M7 review): zero-width, soft hyphen, BOM, tags", () => {
	for (const cp of [0x00ad, 0x180e, 0x200b, 0x200c, 0x200d, 0x2060, 0x2064, 0xfeff, 0xfff9, 0xfffb]) {
		const hex = cp.toString(16).toUpperCase().padStart(4, "0");
		assert.equal(displayPath(`a${String.fromCodePoint(cp)}b`), `a\\u{${hex}}b`, hex);
	}
	assert.equal(displayPath(`a${String.fromCodePoint(0xe0041)}b`), "a\\u{E0041}b", "tag characters, as one code point");
	assert.equal(displayPath("Invoice​.md") === displayPath("Invoice.md"), false);
});

test("other blank and format characters are escaped (M7 re-review)", () => {
	for (const cp of [0x206a, 0x206f, 0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0x1d173, 0x1d17a]) {
		const hex = cp.toString(16).toUpperCase().padStart(4, "0");
		assert.equal(displayPath(`a${String.fromCodePoint(cp)}b`), `a\\u{${hex}}b`, hex);
	}
});
