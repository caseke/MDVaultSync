import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import globals from "globals";
import { projectRules } from "../eslint/project-rules.ts";

// Exercises only the project rules (plan M1), without type-aware parsing, so each case is fast and isolated.
const eslint = new ESLint({
	cwd: join(import.meta.dirname, ".."),
	overrideConfigFile: true,
	overrideConfig: [
		{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser, sourceType: "module", globals: globals.browser } },
		...projectRules,
	],
});

async function ruleIds(code: string, filePath: string): Promise<string[]> {
	const [result] = await eslint.lintText(code, { filePath });
	assert.ok(result, "eslint returned a result");
	assert.equal(result.messages.filter((m) => m.fatal).length, 0, "no parse errors");
	return result.messages.map((m) => m.ruleId ?? "fatal");
}

async function assertFlags(code: string, filePath: string, rule: string): Promise<void> {
	const ids = await ruleIds(code, filePath);
	assert.ok(ids.includes(rule), `${filePath}: expected ${rule}, got [${ids.join(", ")}]`);
}

async function assertClean(code: string, filePath: string): Promise<void> {
	assert.deepEqual(await ruleIds(code, filePath), [], filePath);
}

test("obsidian is banned in src/core and src/remote (R-ENG-3)", async () => {
	const code = 'import { requestUrl } from "obsidian";\nexport const r = requestUrl;\n';
	await assertFlags(code, "src/core/x.ts", "no-restricted-imports");
	await assertFlags(code, "src/remote/x.ts", "no-restricted-imports");
	await assertFlags('import type { App } from "obsidian";\nexport type A = App;\n', "src/core/y.ts", "no-restricted-imports");
	await assertClean(code, "src/platform/x.ts");
	await assertClean(code, "src/main.ts");
});

test("Node network, process and fs modules are banned in src (R-NET-1)", async () => {
	for (const mod of ["http", "https", "net", "child_process", "fs", "node:http", "node:https", "node:net", "node:child_process", "node:fs", "fs/promises", "node:fs/promises"]) {
		const code = `import * as m from "${mod}";\nexport const x = m;\n`;
		await assertFlags(code, "src/platform/x.ts", "no-restricted-imports");
		await assertFlags(code, "src/core/x.ts", "no-restricted-imports");
	}
});

test("fetch, XMLHttpRequest and WebSocket are banned in src (R-NET-1)", async () => {
	await assertFlags('export const p = fetch("https://example.com");\n', "src/platform/x.ts", "no-restricted-globals");
	await assertFlags('export const p = window.fetch("https://example.com");\n', "src/platform/x.ts", "no-restricted-properties");
	await assertFlags('export const p = globalThis.fetch("https://example.com");\n', "src/core/x.ts", "no-restricted-properties");
	await assertFlags("export const x = new XMLHttpRequest();\n", "src/platform/x.ts", "no-restricted-globals");
	await assertFlags('export const w = new WebSocket("wss://example.com");\n', "src/ui/x.ts", "no-restricted-globals");
});

test("Obsidian's activeWindow and other window aliases can't reach network APIs (R-NET-1)", async () => {
	for (const obj of ["window", "globalThis", "self", "activeWindow"]) {
		await assertFlags(`export const p = ${obj}.fetch("https://x");\n`, "src/platform/x.ts", "no-restricted-properties");
		await assertFlags(`export const x = new ${obj}.XMLHttpRequest();\n`, "src/platform/x.ts", "no-restricted-properties");
		await assertFlags(`export const w = new ${obj}.WebSocket("wss://x");\n`, "src/ui/x.ts", "no-restricted-properties");
		await assertFlags(`export const e = new ${obj}.EventSource("https://x");\n`, "src/core/x.ts", "no-restricted-properties");
	}
	await assertFlags('export const e = new EventSource("https://x");\n', "src/platform/x.ts", "no-restricted-globals");
	await assertFlags('export const b = navigator.sendBeacon("https://x", "d");\n', "src/platform/x.ts", "no-restricted-properties");
	await assertFlags('export const h: unknown = window.require("https");\n', "src/platform/x.ts", "no-restricted-properties");
	await assertFlags('export const h: unknown = require("https");\n', "src/platform/x.ts", "no-restricted-globals");
});

test("dynamic import is banned in src (T-E3)", async () => {
	await assertFlags('export const m = import("https://example.com/x.js");\n', "src/platform/x.ts", "no-restricted-syntax");
	await assertFlags('export const m = import("./y.ts");\n', "src/core/x.ts", "no-restricted-syntax");
	await assertFlags('export const m = import("./y.ts");\n', "src/core/remote-content.ts", "no-restricted-syntax");
	await assertFlags('export const m = import("./y.ts");\n', "src/remote/graph.ts", "no-restricted-syntax");
});

test("eval, implied eval and new Function are banned in src (T-E3)", async () => {
	await assertFlags('export const v: unknown = eval("1");\n', "src/core/x.ts", "no-eval");
	await assertFlags('setTimeout("alert(1)", 1);\n', "src/platform/x.ts", "no-implied-eval");
	await assertFlags('export const f = new Function("return 1");\n', "src/ui/x.ts", "no-new-func");
});

test("RemotePort content methods are banned outside remote-content.ts and src/remote (R-ENG-4)", async () => {
	const calls = ["download(id)", "uploadNew(p, n, d)", "uploadReplace(id, e, d)", "createUploadSession(t, null, 1)", "putFragment(u, 0, 1, d)"];
	for (const call of calls) {
		const code = `declare const remote: any, id: any, p: any, n: any, d: any, e: any, t: any, u: any;\nexport const r = remote.${call};\n`;
		await assertFlags(code, "src/core/executor.ts", "no-restricted-syntax");
		await assertFlags(code, "src/main.ts", "no-restricted-syntax");
		await assertFlags(code, "src/platform/obsidian-vault.ts", "no-restricted-syntax");
		await assertClean(code, "src/core/remote-content.ts");
		await assertClean(code, "src/remote/graph.ts");
		await assertClean(code, "test/fakes/fake-remote.ts");
	}
});

test("tests and fakes may use Node modules", async () => {
	await assertClean('import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n', "test/x.test.ts");
});

// The full project config (with type information) must reject disable comments for the rules above, or
// `// eslint-disable-next-line <rule> -- reason` would switch them off silently.
const full = new ESLint({ cwd: join(import.meta.dirname, "..") });

test("project rules can't be switched off with eslint-disable comments", async () => {
	const cases: [string, string][] = [
		["no-restricted-syntax", 'export const m = import("https://example.com/x.js");'],
		["no-restricted-properties", 'export const p = window.fetch("https://x");'],
		["no-restricted-imports", 'import { requestUrl } from "obsidian";\nexport const r = requestUrl;'],
		["no-restricted-globals", 'export const p = fetch("https://x");'],
		["no-implied-eval", 'setTimeout("alert(1)", 1);'],
		["no-new-func", 'export const f = new Function("return 1");'],
	];
	for (const [rule, code] of cases) {
		const text = `// eslint-disable-next-line ${rule} -- probe\n${code}\n`;
		const [result] = await full.lintText(text, { filePath: "src/core/ports.ts" });
		assert.ok(result);
		const ids = result.messages.map((m) => m.ruleId);
		assert.ok(ids.includes("eslint-comments/no-restricted-disable"), `${rule}: got [${ids.join(", ")}]`);
	}
});
