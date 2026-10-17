import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const readJson = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(root, name), "utf8")) as Record<string, unknown>;

test("manifest.json meets the community submission rules [O-SUB-1], [O-SUB-3]", () => {
	const m = readJson("manifest.json");
	assert.equal(m["id"], "mdvaultsync");
	assert.ok(!String(m["id"]).toLowerCase().includes("obsidian"));
	assert.equal(m["name"], "MDVaultSync");
	assert.equal(m["minAppVersion"], "1.11.4"); // R-ENV-3
	assert.equal(m["isDesktopOnly"], false); // R-ENV-2
	assert.match(String(m["version"]), /^\d+\.\d+\.\d+$/);
	const description = String(m["description"]);
	assert.ok(description.length > 0 && description.length <= 250, "description is 1–250 characters");
	assert.ok(description.endsWith("."), "description ends with a period");
	assert.ok(!/obsidian/i.test(description), "description does not say Obsidian");
	assert.ok(!("fundingUrl" in m), "no fundingUrl");
});

test("package.json, manifest.json and versions.json agree on the version", () => {
	const m = readJson("manifest.json");
	const pkg = readJson("package.json");
	const versions = readJson("versions.json");
	assert.equal(pkg["version"], m["version"]);
	assert.equal(versions[String(m["version"])], m["minAppVersion"]);
});

test("package.json has zero runtime dependencies (SPEC §8, D-15)", () => {
	const pkg = readJson("package.json");
	assert.equal(pkg["dependencies"], undefined);
});

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? filesUnder(p) : [p];
	});
}

test("no sample-plugin names remain [O-SUB-3]", () => {
	const banned = /sample-plugin|MyPlugin|SampleSettingTab|SampleModal|mySetting/;
	for (const file of [...filesUnder(join(root, "src")), join(root, "manifest.json"), join(root, "package.json")]) {
		assert.doesNotMatch(readFileSync(file, "utf8"), banned, file);
	}
});

test("CHANGELOG.md has a dated section for the manifest version", () => {
	const version = String(readJson("manifest.json")["version"]);
	const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
	const escaped = version.replace(/\./g, "\\.");
	assert.match(changelog, new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
});
