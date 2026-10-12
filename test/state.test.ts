// SyncState validation (plan M5, T-T6): a malformed or tampered state file is "no state", which forces union mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ID_RE, QXH_RE, applyAppRoot, emptyState, loadState, parseSyncState } from "../src/core/state.ts";
import { buildReport } from "../src/core/report.ts";
import { isValidId, parseDriveItem } from "../src/remote/validate.ts";
import type { SyncState, VaultPath } from "../src/core/ports.ts";
import { CFG, hashOf, vp, world } from "./fakes/plan-fixtures.ts";

function fullState(): SyncState {
	const w = world({ "a.md": "A", "D/b.md": "B" });
	const s = w.state;
	const a = s.files[vp("a.md")];
	assert.ok(a);
	s.deltaLink = "https://graph.microsoft.com/v1.0/me/drive/items/approot/delta?token=x";
	s.pendingLocal = [
		{ kind: "dirty", path: vp("a.md") },
		{ kind: "deleted", path: vp("gone.md") },
		{ kind: "renamed", from: vp("x.md"), to: vp("y.md") },
	];
	s.uploadSessions = {
		[vp("a.md")]: { path: vp("a.md"), uploadUrl: "https://api.onedrive.com/up/1", expiresAt: "2099-01-01T00:00:00Z", totalSize: 1, localHash: a.localHash, ifMatch: a.eTag, target: { kind: "replace", id: a.remoteId } },
		[vp("n.md")]: { path: vp("n.md"), uploadUrl: "https://api.onedrive.com/up/2", expiresAt: "2099-01-01T00:00:00Z", totalSize: 2, localHash: hashOf("n"), ifMatch: null, target: { kind: "new", parentId: "approot", name: "n.md" } },
	};
	s.pendingConflicts = { [vp("a.md")]: { path: vp("a.md"), copyPath: vp("a (conflict iPad 2026-01-05 070809).md"), localHash: hashOf("x"), remoteId: a.remoteId } };
	s.declinedDeletes = { [vp("a.md")]: { localHash: null, eTag: a.eTag }, [vp("D/b.md")]: { localHash: hashOf("B"), eTag: null } };
	const p = { ops: [{ kind: "skip" as const, path: vp("big.bin"), reason: "too-large" as const }], deleteCount: 0, trackedCount: 2, unionMode: false, differsNoHistory: 0 };
	s.lastReport = buildReport({
		trigger: "interval",
		startedAt: 1,
		finishedAt: 2,
		plan: p,
		results: [
			{ op: { kind: "local-move", from: vp("a.md"), to: vp("c.md") }, ok: true },
			{ op: { kind: "upload-new", path: vp("n.md") }, ok: false, code: "network" },
		],
	});
	return s;
}

/** JSON round trip, as the state file stores it, then a mutation. */
function mutated(edit: (o: Record<string, unknown>) => void): unknown {
	const o = JSON.parse(JSON.stringify(fullState())) as Record<string, unknown>;
	edit(o);
	return o;
}

function at(o: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
	let cur: unknown = o;
	for (const k of keys) cur = (cur as Record<string, unknown>)[k];
	return cur as Record<string, unknown>;
}

test("emptyState starts in union mode with nothing recorded (R-FIRST-1)", () => {
	const s = emptyState("dev");
	assert.equal(s.schemaVersion, 1);
	assert.equal(s.deviceId, "dev");
	assert.equal(s.unionPending, true);
	assert.equal(s.firstSyncCompleted, false);
	assert.deepEqual(s.files, {});
	assert.equal(parseSyncState(JSON.parse(JSON.stringify(s)), CFG)?.deviceId, "dev");
});

test("a full state survives the JSON round trip unchanged", () => {
	const s = fullState();
	assert.deepEqual(parseSyncState(JSON.parse(JSON.stringify(s)), CFG), s);
});

const BAD: [string, (o: Record<string, unknown>) => void][] = [
	["not an object", (o) => Object.keys(o).forEach((k) => delete o[k])],
	["schemaVersion 2", (o) => (o["schemaVersion"] = 2)],
	["missing deviceId", (o) => delete o["deviceId"]],
	["appRootId with a slash", (o) => (o["appRootId"] = "../x")],
	["dot-only appRootId", (o) => (o["appRootId"] = "..")],
	["deltaLink not a string", (o) => (o["deltaLink"] = 5)],
	["unionPending as a string", (o) => (o["unionPending"] = "yes")],
	["firstSyncCompleted missing", (o) => delete o["firstSyncCompleted"]],
	["files key differs from its path", (o) => (at(o, "files", "a.md")["path"] = "b.md")],
	["file record under configDir", (o) => (at(o, "files")[`${CFG}/plugins/x/main.js`] = { ...at(o, "files", "a.md"), path: `${CFG}/plugins/x/main.js` })],
	["file record under configDir, other case", (o) => (at(o, "files")[`${CFG.toUpperCase()}/x.md`] = { ...at(o, "files", "a.md"), path: `${CFG.toUpperCase()}/x.md` })],
	["file record in a hidden folder", (o) => (at(o, "files")[".git/x"] = { ...at(o, "files", "a.md"), path: ".git/x" })],
	["file record with ..", (o) => (at(o, "files")["a/../b.md"] = { ...at(o, "files", "a.md"), path: "a/../b.md" })],
	["file record path not NFC", (o) => (at(o, "files")["café.md"] = { ...at(o, "files", "a.md"), path: "café.md" })],
	["eTag with a newline", (o) => (at(o, "files", "a.md")["eTag"] = '"x"\r\nX-Evil: 1')],
	["eTag too long", (o) => (at(o, "files", "a.md")["eTag"] = "x".repeat(513))],
	["bad localHash", (o) => (at(o, "files", "a.md")["localHash"] = "not-a-hash")],
	["negative size", (o) => (at(o, "files", "a.md")["size"] = -1)],
	["fractional size", (o) => (at(o, "files", "a.md")["size"] = 1.5)],
	["NaN mtime", (o) => (at(o, "files", "a.md")["mtime"] = "NaN")],
	["bad remoteId", (o) => (at(o, "files", "a.md")["remoteId"] = "a/b")],
	["remoteIndex key differs from id", (o) => (at(o, "remoteIndex")["other"] = at(o, "remoteIndex", "approot"))],
	["remote item name with a slash", (o) => (at(o, "remoteIndex", "approot")["name"] = "a/b")],
	["remote item name ..", (o) => (at(o, "remoteIndex", "approot")["name"] = "..")],
	[
		"remote item bad hash",
		(o) => {
			const file = Object.values(at(o, "remoteIndex")).find((i) => (i as Record<string, unknown>)["quickXorHash"]) as Record<string, unknown>;
			file["quickXorHash"] = "zz";
		},
	],
	["folder id bad", (o) => (at(o, "folders")["D"] = "")],
	["folder under a hidden path", (o) => (at(o, "folders")[".trash"] = "item1")],
	["pendingLocal unknown kind", (o) => (o["pendingLocal"] = [{ kind: "eval", path: "a.md" }])],
	["pendingLocal into configDir", (o) => (o["pendingLocal"] = [{ kind: "renamed", from: "a.md", to: `${CFG}/x` }])],
	["pendingLocal not an array", (o) => (o["pendingLocal"] = {})],
	["replace session without If-Match (R-CC-1)", (o) => (at(o, "uploadSessions", "a.md")["ifMatch"] = null)],
	["session target kind unknown", (o) => (at(o, "uploadSessions", "n.md", "target")["kind"] = "overwrite")],
	["session target name with a slash", (o) => (at(o, "uploadSessions", "n.md", "target")["name"] = "../n.md")],
	["pending conflict copy into a hidden folder", (o) => (at(o, "pendingConflicts", "a.md")["copyPath"] = ".x/copy.md")],
	["pending conflict copy onto the original", (o) => (at(o, "pendingConflicts", "a.md")["copyPath"] = "A.md")],
	[
		"two pending conflicts sharing one copy path (M6 re-review)",
		(o) => {
			const first = at(o, "pendingConflicts", "a.md");
			at(o, "pendingConflicts")["b.md"] = { ...first, path: "b.md", copyPath: String(first["copyPath"]).toUpperCase() };
		},
	],
	[
		"a pending conflict whose copy path is another's original",
		(o) => (at(o, "pendingConflicts")["b.md"] = { ...at(o, "pendingConflicts", "a.md"), path: "b.md", copyPath: "a.md" }),
	],
	["declined delete with a bad hash", (o) => (at(o, "declinedDeletes", "D/b.md")["localHash"] = 7)],
];
for (const [name, edit] of BAD) {
	test(`malformed state is rejected: ${name}`, () => {
		assert.equal(parseSyncState(mutated(edit), CFG), null);
	});
}

test("non-object state files are rejected", () => {
	for (const raw of [null, undefined, 1, "x", [], [fullState()]]) assert.equal(parseSyncState(raw, CFG), null);
});

test("a key like __proto__ stays plain data", () => {
	const json = JSON.stringify(fullState());
	assert.ok(json.includes('"folders":{"D":'));
	const s = parseSyncState(JSON.parse(json.replace('"folders":{"D":', '"folders":{"__proto__":')), CFG);
	assert.ok(s);
	assert.equal(Object.getPrototypeOf(s.folders), Object.prototype);
	assert.ok(Object.keys(s.folders).includes("__proto__"));
});

test("a malformed report is dropped; the rest of the state is kept", () => {
	for (const edit of [
		(o: Record<string, unknown>) => (at(o, "lastReport")["result"] = "great"),
		(o: Record<string, unknown>) => (at(o, "lastReport", "counts")["download"] = -1),
		(o: Record<string, unknown>) => (at(o, "lastReport")["skipped"] = [{ path: "x", reason: "because" }]),
	]) {
		const s = parseSyncState(mutated(edit), CFG);
		assert.ok(s);
		assert.equal(s.lastReport, null);
		assert.equal(Object.keys(s.files).length, 2);
	}
});

test("loadState: a malformed file gives union mode and keeps a valid deviceId (T-T6)", () => {
	const kept = loadState(mutated((o) => (o["schemaVersion"] = 9)), CFG, "new-id");
	assert.equal(kept.deviceId, "device-1");
	assert.equal(kept.unionPending, true);
	assert.deepEqual(kept.files, {});
	assert.equal(loadState("garbage", CFG, "new-id").deviceId, "new-id");
	assert.equal(loadState({ deviceId: "" }, CFG, "new-id").deviceId, "new-id");
	assert.equal(loadState(null, CFG, "new-id").unionPending, true);
	const good = fullState();
	assert.deepEqual(loadState(JSON.parse(JSON.stringify(good)), CFG, "new-id"), good);
});

test("applyAppRoot: same id is a no-op; first id is recorded; a changed id resets remote state into union mode (D-18)", () => {
	const s = fullState();
	assert.equal(applyAppRoot(s, "approot"), s);
	const fresh = applyAppRoot(emptyState("d"), "root-1");
	assert.equal(fresh.appRootId, "root-1");
	assert.equal(fresh.unionPending, true);
	const noRoot = { ...fullState(), appRootId: null, unionPending: false };
	assert.equal(applyAppRoot(noRoot, "root-1").unionPending, true, "records without an approot id force a merge");
	assert.equal(applyAppRoot({ ...emptyState("d"), unionPending: false }, "root-1").unionPending, false);
	const changed = applyAppRoot(s, "root-2");
	assert.equal(changed.appRootId, "root-2");
	assert.equal(changed.unionPending, true);
	assert.equal(changed.deltaLink, null);
	for (const k of ["remoteIndex", "files", "folders", "uploadSessions", "pendingConflicts", "declinedDeletes"] as const) assert.deepEqual(changed[k], {}, k);
	assert.deepEqual(changed.pendingLocal, s.pendingLocal, "local events are kept");
	assert.equal(changed.deviceId, s.deviceId);
	assert.ok(Object.keys(s.files).length > 0, "the input is not changed");
});

test("core's id and hash rules agree with src/remote/validate.ts", () => {
	const ids = ["a", "A-b_c.d!", "x".repeat(256), "x".repeat(257), "..", ".", "a..b", "", "a/b", "a b", "é", "%2e%2e"];
	for (const v of ids) assert.equal(ID_RE.test(v), isValidId(v), JSON.stringify(v));
	const hashes = [hashOf("x"), "A".repeat(27) + "=", "A".repeat(28), "A".repeat(26) + "==", "", "+/" + "A".repeat(25) + "=", "-".repeat(27) + "="];
	for (const h of hashes) {
		let remoteOk = true;
		try {
			parseDriveItem({ id: "i", name: "n", eTag: "e", size: 0, file: { hashes: { quickXorHash: h } } });
		} catch {
			remoteOk = false;
		}
		assert.equal(QXH_RE.test(h), remoteOk, h);
	}
});

test("VaultPath keys are type-only brands", () => {
	const k: VaultPath = vp("a.md");
	assert.equal(typeof k, "string");
});
