// Vault events → pendingLocal (R-CD-2, design §3). Events are never dropped for syncable paths; only hidden and
// excluded paths, which are never synced, are ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventToOps, registerVaultEvents, type VaultEvent } from "../src/platform/vault-events.ts";
import type { PendingLocalOp } from "../src/core/ports.ts";

const CFG = "obs-config";
const ops = (ev: VaultEvent, patterns: string[] = []) => eventToOps(ev, CFG, patterns);

test("create and modify mark a path dirty; delete records a delete", () => {
	assert.deepEqual(ops({ type: "create", path: "a.md", isFolder: false }), [{ kind: "dirty", path: "a.md" }]);
	assert.deepEqual(ops({ type: "modify", path: "dir/b.md", isFolder: false }), [{ kind: "dirty", path: "dir/b.md" }]);
	assert.deepEqual(ops({ type: "delete", path: "c.md", isFolder: false }), [{ kind: "deleted", path: "c.md" }]);
});

test("a rename between syncable paths is a rename hint, even to a name OneDrive refuses (the planner decides)", () => {
	assert.deepEqual(ops({ type: "rename", path: "b.md", oldPath: "a.md", isFolder: false }), [{ kind: "renamed", from: "a.md", to: "b.md" }]);
	assert.deepEqual(ops({ type: "rename", path: "a:b.md", oldPath: "a.md", isFolder: false }), [{ kind: "renamed", from: "a.md", to: "a:b.md" }]);
});

test("hidden, configDir and excluded paths are ignored", () => {
	for (const p of [".trash/a.md", `${CFG}/plugins/x/data.json`, "dir/.mdvaultsync-tmp-0123", "Private/a.md"]) {
		assert.deepEqual(ops({ type: "modify", path: p, isFolder: false }, ["Private/"]), [], p);
		assert.deepEqual(ops({ type: "delete", path: p, isFolder: false }, ["Private/"]), [], p);
	}
	assert.deepEqual(ops({ type: "create", path: "Private", isFolder: true }, ["Private/"]), [], "a folder-only pattern matches the folder");
});

test("renames into or out of an ignored path become a delete or a new file", () => {
	assert.deepEqual(ops({ type: "rename", path: ".trash/a.md", oldPath: "a.md", isFolder: false }), [{ kind: "deleted", path: "a.md" }]);
	assert.deepEqual(ops({ type: "rename", path: "a.md", oldPath: ".trash/a.md", isFolder: false }), [{ kind: "dirty", path: "a.md" }]);
	assert.deepEqual(ops({ type: "rename", path: ".x/b.md", oldPath: ".x/a.md", isFolder: false }), []);
	assert.deepEqual(ops({ type: "rename", path: "Private/a.md", oldPath: "a.md", isFolder: false }, ["Private/"]), [{ kind: "deleted", path: "a.md" }]);
});

test("malformed paths are ignored", () => {
	assert.deepEqual(ops({ type: "modify", path: "", isFolder: false }), []);
	assert.deepEqual(ops({ type: "modify", path: "a//b.md", isFolder: false }), []);
	assert.deepEqual(ops({ type: "rename", path: "b.md", oldPath: "../a.md", isFolder: false }), [{ kind: "dirty", path: "b.md" }]);
});

test("registerVaultEvents wires create, modify, delete and rename and registers each handler for cleanup", () => {
	const handlers = new Map<string, (...a: unknown[]) => unknown>();
	const refs: unknown[] = [];
	const vault = {
		on(name: string, cb: (...a: unknown[]) => unknown) {
			handlers.set(name, cb);
			return { name };
		},
	};
	const seen: PendingLocalOp[] = [];
	registerVaultEvents(vault, (r) => refs.push(r), { configDir: CFG, patterns: () => ["skip.md"], sink: (op) => seen.push(op) });
	assert.deepEqual([...handlers.keys()].sort(), ["create", "delete", "modify", "rename"]);
	assert.equal(refs.length, 4);
	const file = (path: string) => ({ path, stat: { size: 1, mtime: 1 }, extension: "md" });
	const folder = (path: string) => ({ path, children: [] });
	handlers.get("create")?.(file("a.md"));
	handlers.get("modify")?.(file("skip.md"));
	handlers.get("create")?.(folder("dir"));
	handlers.get("delete")?.(file("c.md"));
	handlers.get("rename")?.(file("n.md"), "o.md");
	assert.deepEqual(seen, [
		{ kind: "dirty", path: "a.md" },
		{ kind: "dirty", path: "dir" },
		{ kind: "deleted", path: "c.md" },
		{ kind: "renamed", from: "o.md", to: "n.md" },
	]);
});
