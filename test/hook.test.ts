import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const hook = join(root, ".claude", "hooks", "check.sh");

function run(stdin: string, args: string[] = []): { code: number | null; stdout: string; stderr: string } {
	const r = spawnSync(hook, args, { cwd: root, input: stdin, encoding: "utf8" });
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// The lint-error → exit 2 path runs full tsc, so it is shown in the M1 Verify block instead.

test("hook ignores files that are not .ts or .mts", () => {
	const r = run(JSON.stringify({ tool_input: { file_path: join(root, "README.md") } }));
	assert.equal(r.code, 0);
	assert.equal(r.stdout + r.stderr, "");
});

test("hook does not block on empty or malformed input", () => {
	assert.equal(run("").code, 0);
	assert.equal(run("{not json").code, 0);
	assert.equal(run(JSON.stringify({ tool_input: {} })).code, 0);
});

test("hook ignores TypeScript files outside the repository", () => {
	const r = run(JSON.stringify({ tool_input: { file_path: "/etc/outside.ts" } }));
	assert.equal(r.code, 0);
	assert.equal(r.stdout + r.stderr, "");
});

test("hook ignores TypeScript under node_modules", () => {
	const r = run("", ["node_modules/typescript/lib/typescript.d.ts"]);
	assert.equal(r.code, 0);
});
