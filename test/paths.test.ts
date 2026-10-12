import { test } from "node:test";
import assert from "node:assert/strict";
import {
	NAME_MAX,
	PATH_MAX,
	caseKey,
	containmentProblem,
	findCollisions,
	remoteToVaultPath,
	toVaultPath,
	validatePath,
	validateSegment,
} from "../src/core/paths.ts";
import { NAME_MAX as REMOTE_NAME_MAX } from "../src/remote/capabilities.ts";

// "Apps/MDVaultSync", the observed approot pathPrefix without its leading "/" [G-AF-1].
const PREFIX = 16;
// The default configDir; tests also cover a renamed one.
const CFG = ".obsidian";
const NFC_E = "\u00e9"; // é precomposed
const NFD_E = "e\u0301"; // é decomposed

test("core NAME_MAX matches the remote client's NAME_MAX", () => {
	assert.equal(NAME_MAX, REMOTE_NAME_MAX);
	assert.equal(PATH_MAX, 400);
});

// ---------- toVaultPath ----------
test("toVaultPath normalizes to NFC", () => {
	assert.equal(toVaultPath(`caf${NFD_E}/n.md`), `caf${NFC_E}/n.md`);
	assert.equal(toVaultPath("a/b.md"), "a/b.md");
});
for (const bad of ["", "/abs.md", "a/", "a//b", "./a", "a/./b", "a/../b", "..", "."]) {
	test(`toVaultPath rejects ${JSON.stringify(bad)}`, () => {
		assert.equal(toVaultPath(bad), null);
	});
}

// ---------- validateSegment ----------
test("validateSegment accepts ordinary names", () => {
	for (const n of ["note.md", "My Note (1).md", "a", "emoji 🎉.md", `caf${NFC_E}.md`, "x".repeat(NAME_MAX), "file."]) {
		assert.equal(validateSegment(n, false), null, n);
	}
	assert.equal(validateSegment("folder", true), null);
});
for (const ch of ['"', "*", ":", "<", ">", "?", "\\", "|", "/"]) {
	test(`validateSegment rejects the character ${JSON.stringify(ch)}`, () => {
		assert.equal(validateSegment(`a${ch}b.md`, false), "invalid-name");
	});
}
test("validateSegment rejects every control character U+0000–U+001F", () => {
	for (let c = 0; c <= 0x1f; c++) {
		assert.equal(validateSegment(`a${String.fromCharCode(c)}b`, false), "invalid-name", `U+${c.toString(16)}`);
	}
});
test("validateSegment rejects leading and trailing spaces", () => {
	assert.equal(validateSegment(" a.md", false), "invalid-name");
	assert.equal(validateSegment("a.md ", false), "invalid-name");
	assert.equal(validateSegment(" dir", true), "invalid-name");
	assert.equal(validateSegment("dir ", true), "invalid-name");
});
test("validateSegment rejects a folder ending in a period, but not a file", () => {
	assert.equal(validateSegment("dir.", true), "invalid-name");
	assert.equal(validateSegment("file.", false), null);
});
test("validateSegment rejects a leading tilde (including ~$)", () => {
	assert.equal(validateSegment("~a.md", false), "invalid-name");
	assert.equal(validateSegment("~$doc.docx", false), "invalid-name");
	assert.equal(validateSegment("a~b.md", false), null);
});
const RESERVED = ["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 10 }, (_, i) => `COM${i}`), ...Array.from({ length: 10 }, (_, i) => `LPT${i}`)];
for (const r of RESERVED) {
	test(`validateSegment rejects reserved name ${r} with and without an extension`, () => {
		assert.equal(validateSegment(r, false), "reserved-name");
		assert.equal(validateSegment(`${r}.md`, false), "reserved-name");
		assert.equal(validateSegment(`${r.toLowerCase()}.tar.gz`, false), "reserved-name");
		assert.equal(validateSegment(r[0] + r.slice(1).toLowerCase(), true), "reserved-name");
		assert.equal(validateSegment(`${r}x.md`, false), null);
		assert.equal(validateSegment(`x${r}.md`, false), null);
	});
}
test("validateSegment rejects .lock, desktop.ini and _vti_", () => {
	assert.equal(validateSegment(".lock", false), "reserved-name");
	assert.equal(validateSegment("desktop.ini", false), "reserved-name");
	assert.equal(validateSegment("Desktop.INI", false), "reserved-name");
	assert.equal(validateSegment("a_vti_b.md", false), "reserved-name");
	assert.equal(validateSegment("_vti_", true), "reserved-name");
	assert.equal(validateSegment("_VTI_x", false), "reserved-name");
});
test("validateSegment rejects empty names and names over 255 (256–400 included)", () => {
	assert.equal(validateSegment("", false), "invalid-name");
	for (const len of [256, 299, 300, 399, 400]) {
		assert.equal(validateSegment("a".repeat(len), false), "invalid-name", String(len));
	}
});

// ---------- validatePath ----------
test("validatePath checks every segment; ancestors are folders", () => {
	assert.equal(validatePath("a/b/c.md", PREFIX, false), null);
	assert.equal(validatePath("dir./c.md", PREFIX, false), "invalid-name");
	assert.equal(validatePath("a/CON/c.md", PREFIX, false), "reserved-name");
	assert.equal(validatePath("a/b:c.md", PREFIX, false), "invalid-name");
	assert.equal(validatePath("a/dir.", PREFIX, true), "invalid-name");
	assert.equal(validatePath("a/file.", PREFIX, false), null);
});
test("validatePath: 400 characters including the prefix pass, 401 fail", () => {
	// PREFIX + "/" + path = 400
	const seg = (n: number) => "a".repeat(n);
	const p400 = `${seg(200)}/${seg(400 - PREFIX - 1 - 201)}`;
	assert.equal(PREFIX + 1 + p400.length, 400);
	assert.equal(validatePath(p400, PREFIX, false), null);
	const p401 = `${seg(200)}/${seg(400 - PREFIX - 1 - 200)}`;
	assert.equal(PREFIX + 1 + p401.length, 401);
	assert.equal(validatePath(p401, PREFIX, false), "path-too-long");
});

// ---------- caseKey ----------
test("caseKey folds case", () => {
	assert.equal(caseKey("Notes/A.md"), caseKey("notes/a.md"));
	assert.notEqual(caseKey("a.md"), caseKey("b.md"));
});

// ---------- findCollisions ----------
test("findCollisions: NFC/NFD pair skips both as unicode-collision", () => {
	const r = findCollisions([`${NFC_E}.md`, `${NFD_E}.md`, "other.md"], new Set());
	assert.equal(r.get(`${NFC_E}.md`), "unicode-collision");
	assert.equal(r.get(`${NFD_E}.md`), "unicode-collision");
	assert.equal(r.has("other.md"), false);
});
test("findCollisions: a lone NFD path is not a collision", () => {
	assert.equal(findCollisions([`${NFD_E}.md`], new Set()).size, 0);
});
test("findCollisions: case collision keeps the tracked path", () => {
	const r = findCollisions(["Note.md", "note.md"], new Set(["Note.md"]));
	assert.equal(r.has("Note.md"), false);
	assert.equal(r.get("note.md"), "case-collision");
});
test("findCollisions: case collision with neither tracked skips both", () => {
	const r = findCollisions(["Note.md", "note.md", "NOTE.md"], new Set());
	assert.deepEqual([...r.values()], ["case-collision", "case-collision", "case-collision"]);
});
test("findCollisions: a losing folder takes its descendants with it", () => {
	const r = findCollisions(["Notes/a.md", "notes/b.md", "notes/sub/c.md", "Other/x.md"], new Set(["Notes/a.md"]));
	assert.equal(r.has("Notes/a.md"), false);
	assert.equal(r.get("notes/b.md"), "case-collision");
	assert.equal(r.get("notes/sub/c.md"), "case-collision");
	assert.equal(r.has("Other/x.md"), false);
});
test("findCollisions: folders that differ only by NFC form skip their children", () => {
	const r = findCollisions([`${NFC_E}/a.md`, `${NFD_E}/b.md`], new Set());
	assert.equal(r.get(`${NFC_E}/a.md`), "unicode-collision");
	assert.equal(r.get(`${NFD_E}/b.md`), "unicode-collision");
});
test("findCollisions: no collisions in distinct paths", () => {
	assert.equal(findCollisions(["a.md", "b.md", "a/b.md", "b/a.md"], new Set()).size, 0);
});

// ---------- remoteToVaultPath / containmentProblem ----------
function remote(segs: string[], configDir = CFG, isFolder = false) {
	return remoteToVaultPath(segs, configDir, PREFIX, isFolder);
}
test("remoteToVaultPath accepts and NFC-normalizes a normal path", () => {
	assert.deepEqual(remote(["Notes", `caf${NFD_E}.md`]), { ok: true, path: `Notes/caf${NFC_E}.md` });
});
const OUTSIDE: [string, string[]][] = [
	["no segments", []],
	["..", [".."]],
	["a/../../x as segments", ["a", "..", "..", "x"]],
	["a/../../x as one name", ["a/../../x"]],
	[".", ["a", ".", "b"]],
	["empty segment", ["a", "", "b"]],
	["/abs", ["/abs"]],
	["C:\\x", ["C:\\x"]],
	["C: drive", ["C:", "x.md"]],
	["backslash", ["a\\b.md"]],
	["NUL", ["a\0b.md"]],
	["control char", ["a\nb.md"]],
	["slash inside a name", ["a/b.md"]],
];
for (const [label, segs] of OUTSIDE) {
	test(`remoteToVaultPath rejects ${label} as outside-vault`, () => {
		assert.deepEqual(remote(segs), { ok: false, reason: "outside-vault" });
	});
}
test("remoteToVaultPath rejects <configDir>/plugins/x/main.js as hidden (plugin planting, T-E1)", () => {
	assert.deepEqual(remote([CFG, "plugins", "x", "main.js"]), { ok: false, reason: "hidden" });
});
test("remoteToVaultPath rejects a renamed configDir, in any case", () => {
	assert.deepEqual(remote(["config", "plugins", "x", "main.js"], "config"), { ok: false, reason: "hidden" });
	assert.deepEqual(remote(["Config", "plugins", "x", "main.js"], "config"), { ok: false, reason: "hidden" });
	assert.deepEqual(remote(["CONFIG"], "config", true), { ok: false, reason: "hidden" });
	// A nested folder with the configDir's name is not the configDir.
	assert.equal(remote(["notes", "config", "a.md"], "config").ok, true);
});
test("remoteToVaultPath rejects hidden segments at any depth", () => {
	assert.deepEqual(remote([".trash", "a.md"]), { ok: false, reason: "hidden" });
	assert.deepEqual(remote(["a", ".git", "config"]), { ok: false, reason: "hidden" });
	assert.deepEqual(remote(["a", ".hidden.md"]), { ok: false, reason: "hidden" });
	assert.deepEqual(remote(["a", ".mdvaultsync-tmp-123"]), { ok: false, reason: "hidden" });
});
test("remoteToVaultPath runs every remote name through validateSegment (M3 carry-in)", () => {
	for (const len of [256, 300, 400]) {
		assert.deepEqual(remote(["a", "x".repeat(len)]), { ok: false, reason: "invalid-name" }, String(len));
	}
	assert.deepEqual(remote(["a.md "]), { ok: false, reason: "invalid-name" });
	assert.deepEqual(remote(["dir.", "a.md"]), { ok: false, reason: "invalid-name" });
	assert.deepEqual(remote(["a?.md"]), { ok: false, reason: "invalid-name" });
	assert.deepEqual(remote(["NUL.md"]), { ok: false, reason: "reserved-name" });
	assert.deepEqual(remote(["~lock.md"]), { ok: false, reason: "invalid-name" });
});
test("remoteToVaultPath enforces the 400-character full path", () => {
	const deep = Array.from({ length: 8 }, () => "a".repeat(50));
	assert.deepEqual(remote(deep), { ok: false, reason: "path-too-long" });
});
test("hostile names never produce an ok result that escapes the vault", () => {
	const hostile = ["..", ".", "", "/", "\\", "..\\..", "a/..", "\0", CFG, "%2e%2e", "\u2024\u2024", "C:", "\\\\server\\share"];
	for (const a of hostile) {
		for (const b of hostile) {
			const r = remote([a, b, "x.md"]);
			if (r.ok) {
				assert.equal(containmentProblem(r.path, CFG), null);
				assert.ok(!r.path.split("/").some((s: string) => s === ".." || s === "." || s === "" || s.startsWith(".")));
			}
		}
	}
});

test("containmentProblem is the pre-write re-check on a joined path", () => {
	assert.equal(containmentProblem("a/b.md", CFG), null);
	assert.equal(containmentProblem("../x", CFG), "outside-vault");
	assert.equal(containmentProblem("a/../../x", CFG), "outside-vault");
	assert.equal(containmentProblem("/abs", CFG), "outside-vault");
	assert.equal(containmentProblem("C:\\x", CFG), "outside-vault");
	assert.equal(containmentProblem("a\\b", CFG), "outside-vault");
	assert.equal(containmentProblem("a\0b", CFG), "outside-vault");
	assert.equal(containmentProblem("a//b", CFG), "outside-vault");
	assert.equal(containmentProblem("a/", CFG), "outside-vault");
	assert.equal(containmentProblem("", CFG), "outside-vault");
	assert.equal(containmentProblem(`caf${NFD_E}`, CFG), "outside-vault"); // not NFC: not a VaultPath
	assert.equal(containmentProblem(`${CFG}/plugins/x/main.js`, CFG), "hidden");
	assert.equal(containmentProblem("Cfg/x", "cfg"), "hidden");
	assert.equal(containmentProblem("a/.git/x", CFG), "hidden");
});
