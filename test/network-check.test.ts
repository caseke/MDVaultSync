import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "..", "scripts", "check-network-apis.sh");

function check(source: string, file = "x.ts"): number | null {
	const dir = mkdtempSync(join(tmpdir(), "mdvs-net-"));
	try {
		mkdirSync(join(dir, "core"), { recursive: true });
		writeFileSync(join(dir, file), source);
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
		"await activeWindow.fetch(u);",
		"await myWindow.fetch(u);",
		"const e = new EventSource(u);",
		"navigator.sendBeacon(u, d);",
		"fetch(u).then((r): Promise<void> => done(r));",
	]) {
		assert.equal(check(src), 1, src);
	}
});

test("CI network backstop allows the RemoteContent.fetch signature in core/ports.ts and member calls", () => {
	const signature = "interface C {\n  fetch(item: RemoteItem, path: VaultPath): Promise<R>;\n}\n";
	assert.equal(check(signature, "core/ports.ts"), 0);
	assert.equal(check(signature, "core/other.ts"), 1);
	assert.equal(check("const r = await content.fetch(item, path);\n"), 0);
});
