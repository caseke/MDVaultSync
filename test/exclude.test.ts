import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusionReason, isExcluded } from "../src/core/exclude.ts";

// The default configDir; tests also cover a renamed one.
const CFG = ".obsidian";

test("configDir is hidden, default and renamed, in any case", () => {
	assert.equal(exclusionReason(`${CFG}/plugins/x/main.js`, CFG, []), "hidden");
	assert.equal(exclusionReason(CFG, CFG, [], true), "hidden");
	assert.equal(exclusionReason("cfg/app.json", "cfg", []), "hidden");
	assert.equal(exclusionReason("CFG/app.json", "cfg", []), "hidden");
	assert.equal(exclusionReason("notes/cfg/a.md", "cfg", []), null);
});

test("any segment starting with a dot is hidden, at any depth", () => {
	for (const p of [".trash/a.md", "a/.git/HEAD", "a/b/.hidden.md", ".mdvaultsync-tmp", "a/.b/c/d.md"]) {
		assert.equal(exclusionReason(p, CFG, []), "hidden", p);
	}
	assert.equal(exclusionReason("a/b.c/d.md", CFG, []), null);
	assert.equal(exclusionReason("a.b", CFG, []), null);
});

test("hidden wins over a user pattern", () => {
	assert.equal(exclusionReason(".trash/a.md", CFG, ["*.md"]), "hidden");
});

function ex(path: string, patterns: string[], isFolder = false): boolean {
	return isExcluded(path, CFG, patterns, isFolder);
}

test("a pattern without a slash matches the basename at any depth", () => {
	assert.ok(ex("a.pdf", ["*.pdf"]));
	assert.ok(ex("x/y/a.pdf", ["*.pdf"]));
	assert.ok(!ex("a.pdf.md", ["*.pdf"]));
	assert.ok(ex("deep/secret.md", ["secret.md"]));
});

test("a pattern with a slash is anchored to the vault root; a leading slash is stripped", () => {
	assert.ok(ex("root-only.md", ["/root-only.md"]));
	assert.ok(!ex("sub/root-only.md", ["/root-only.md"]));
	assert.ok(ex("a/b.md", ["a/b.md"]));
	assert.ok(!ex("x/a/b.md", ["a/b.md"]));
	assert.ok(ex("a/x.md", ["a/*.md"]));
	assert.ok(!ex("a/y/x.md", ["a/*.md"]));
});

test("a trailing slash matches a directory and everything under it, not a file", () => {
	assert.ok(ex("drafts/a.md", ["drafts/"]));
	assert.ok(ex("x/drafts/sub/a.md", ["drafts/"]));
	assert.ok(ex("drafts", ["drafts/"], true));
	assert.ok(!ex("drafts", ["drafts/"], false));
	assert.ok(!ex("drafts.md", ["drafts/"]));
});

test("a pattern matching a folder excludes its contents", () => {
	assert.ok(ex("private/a/b.md", ["private"]));
	assert.ok(ex("x/private/b.md", ["private"]));
});

test("** forms", () => {
	assert.ok(ex("tmp/a.md", ["**/tmp"]));
	assert.ok(ex("a/b/tmp/c.md", ["**/tmp"]));
	assert.ok(ex("a/b", ["a/**/b"]));
	assert.ok(ex("a/x/y/b", ["a/**/b"]));
	assert.ok(!ex("a/x/y/c", ["a/**/b"]));
	assert.ok(ex("x/a.md", ["x/**"]));
	assert.ok(ex("x/y/z.md", ["x/**"]));
	assert.ok(!ex("x", ["x/**"], true));
	assert.ok(ex("a/b/c.pdf", ["**/*.pdf"]));
	assert.ok(ex("a/b/c.pdf", ["a/**/*.pdf"]));
});

test("? matches exactly one character, never a slash", () => {
	assert.ok(ex("a1.md", ["a?.md"]));
	assert.ok(!ex("a12.md", ["a?.md"]));
	assert.ok(!ex("a/b", ["a?b"]));
	assert.ok(!ex("a/b", ["a*b"]));
});

test("blank lines, comments and unsupported negations are ignored", () => {
	assert.ok(!ex("a.md", ["", "   ", "# *.md", "!a.md"]));
	assert.ok(ex("a.md", ["!a.md", "*.md"]));
});

test("[ is literal (character classes are not supported)", () => {
	assert.ok(ex("[x].md", ["[x].md"]));
	assert.ok(!ex("x.md", ["[x].md"]));
});

test("matching is case-sensitive", () => {
	assert.ok(!ex("A.PDF", ["*.pdf"]));
	assert.ok(!ex("Drafts/a.md", ["drafts/"]));
});

test("patterns are NFC-normalized like paths", () => {
	assert.ok(ex("café.md", ["café.md"]));
});

test("no match returns null", () => {
	assert.equal(exclusionReason("notes/a.md", CFG, ["*.pdf", "drafts/"]), null);
	assert.equal(exclusionReason("notes/a.pdf", CFG, ["*.pdf"]), "excluded");
});

test("a pathological pattern finishes quickly (no exponential backtracking)", () => {
	const path = "a".repeat(250) + "/" + "a".repeat(140);
	const start = performance.now();
	assert.ok(!ex(path, ["*a*a*a*a*a*a*a*a*a*a*b", "**/**/**/**/**/**/b", "a*/**/*a*a*a*a*a*c"]));
	assert.ok(performance.now() - start < 1000);
});

test("an NFD path is normalized before matching (review fix)", () => {
	assert.ok(ex("cafe\u0301.md", ["caf\u00e9.md"]));
	assert.ok(ex("cafe\u0301/x.md", ["caf\u00e9/"]));
});

test("configDir fold variants are hidden (review fix)", () => {
	assert.equal(exclusionReason("\u017fettings/a.json", "settings", []), "hidden");
});
