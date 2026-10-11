import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "..", "scripts", "check-network-apis.sh");

function check(source: string): number | null {
	const dir = mkdtempSync(join(tmpdir(), "mdvs-net-"));
	try {
		writeFileSync(join(dir, "x.ts"), source);
		return spawnSync(script, [dir], { encoding: "utf8" }).status;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("CI network backstop passes the real src/ tree (R-NET-1)", () => {
	assert.equal(spawnSync(script, [], { encoding: "utf8" }).status, 0);
});

test("CI network backstop flags forbidden APIs (R-NET-1)", () => {
	for (const src of [
		'const r = fetch("https://x");',
		"  fetch(url)",
		"await window.fetch(u);",
		"globalThis.fetch(u);",
		"const x = new XMLHttpRequest();",
		"const w = new WebSocket(u);",
	]) {
		assert.equal(check(src), 1, src);
	}
});

test("CI network backstop allows method signatures and member calls named fetch", () => {
	assert.equal(check("interface C {\n  fetch(item: Item, path: P): Promise<R>;\n}\n"), 0);
	assert.equal(check("const r = await content.fetch(item, path);\n"), 0);
});
