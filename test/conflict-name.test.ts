import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictCopyPath, sanitizeDeviceName } from "../src/core/conflict-name.ts";
import { NAME_MAX, PATH_MAX, caseKey, validatePath } from "../src/core/paths.ts";
import type { VaultPath } from "../src/core/ports.ts";

// Local time, so the expected strings don't depend on the machine's time zone.
const DATE = new Date(2026, 0, 5, 7, 8, 9);
const none = () => false;
const vp = (s: string) => s as VaultPath;

test("formats stem (conflict Device YYYY-MM-DD HHmmss).ext with zero padding, in the same folder", () => {
	assert.equal(conflictCopyPath(vp("Notes/Plan.md"), "iPad", DATE, none, 16), "Notes/Plan (conflict iPad 2026-01-05 070809).md");
	assert.equal(conflictCopyPath(vp("Plan.md"), "Ubuntu", new Date(2026, 11, 31, 23, 59, 58), none, 16), "Plan (conflict Ubuntu 2026-12-31 235958).md");
});

test("handles no extension and multiple dots", () => {
	assert.equal(conflictCopyPath(vp("a/README"), "iPad", DATE, none, 16), "a/README (conflict iPad 2026-01-05 070809)");
	assert.equal(conflictCopyPath(vp("a/x.tar.gz"), "iPad", DATE, none, 16), "a/x.tar (conflict iPad 2026-01-05 070809).gz");
});

test("appends 2, 3 on collision", () => {
	const taken = new Set([caseKey("n (conflict iPad 2026-01-05 070809).md"), caseKey("n (conflict iPad 2026-01-05 070809) 2.md")]);
	const exists = (p: VaultPath) => taken.has(caseKey(p));
	assert.equal(conflictCopyPath(vp("n.md"), "iPad", DATE, exists, 16), "n (conflict iPad 2026-01-05 070809) 3.md");
});

test("gives up after a bounded number of attempts", () => {
	assert.throws(() => conflictCopyPath(vp("n.md"), "iPad", DATE, () => true, 16), RangeError);
});

test("sanitizes the device name with the path rules", () => {
	assert.equal(sanitizeDeviceName('My:"Pad"/<1>|?*\\'), "My--Pad---1-----");
	assert.equal(sanitizeDeviceName("  a\tb\nc  "), "a-b-c");
	assert.equal(sanitizeDeviceName(""), "device");
	assert.equal(sanitizeDeviceName("   "), "device");
	assert.equal(sanitizeDeviceName("x".repeat(60)).length, 40);
	assert.equal(sanitizeDeviceName("🎉".repeat(30)), "🎉".repeat(20));
	assert.equal(conflictCopyPath(vp("a.md"), "a/b", DATE, none, 16), "a (conflict a-b 2026-01-05 070809).md");
});

test("the result always passes validatePath", () => {
	for (const p of ["a.md", "dir/sub/b.txt", "x", "dir/y.tar.gz"]) {
		const out = conflictCopyPath(vp(p), 'bad:name"', DATE, none, 16);
		assert.equal(validatePath(out, 16, false), null, out);
	}
});

test("shortens the copy's stem to fit the 255-character name limit", () => {
	const name = "s".repeat(250) + ".md";
	const out = conflictCopyPath(vp(`d/${name}`), "iPad", DATE, none, 16);
	const base = out.slice(2);
	assert.ok(base.length <= NAME_MAX, String(base.length));
	assert.ok(base.endsWith(" (conflict iPad 2026-01-05 070809).md"));
	assert.equal(validatePath(out, 16, false), null);
});

test("shortens the copy's stem to fit the 400-character path limit", () => {
	const dir = Array.from({ length: 6 }, () => "d".repeat(55)).join("/");
	const out = conflictCopyPath(vp(`${dir}/${"n".repeat(30)}.md`), "iPad", DATE, none, 16);
	assert.ok(16 + 1 + out.length <= PATH_MAX, String(out.length));
	assert.ok(out.startsWith(dir + "/n"));
	assert.equal(validatePath(out, 16, false), null);
});

test("never splits a surrogate pair when shortening", () => {
	const out = conflictCopyPath(vp("🎉".repeat(127) + ".md"), "iPad", DATE, none, 16);
	assert.ok(out.length <= NAME_MAX);
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out));
});

test("throws when the folder alone leaves no room", () => {
	const dir = Array.from({ length: 7 }, () => "d".repeat(54)).join("/");
	assert.throws(() => conflictCopyPath(vp(`${dir}/a.md`), "iPad", DATE, none, 16), RangeError);
});

test("a device name containing _vti_ still yields an uploadable copy (review fix)", () => {
	assert.equal(sanitizeDeviceName("lab_vti_pad"), "lab-vti-pad");
	assert.equal(sanitizeDeviceName("a\u00a0b"), "a b");
	for (const dev of ["lab_vti_pad", "_VTI_", "x\u202fy"]) {
		assert.equal(validatePath(conflictCopyPath(vp("a/b.md"), dev, DATE, none, 16), 16, false), null, dev);
	}
});
