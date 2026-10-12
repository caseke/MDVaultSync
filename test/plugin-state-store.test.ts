// PluginStateStore (plan M6, design §12): sync-state.json written atomically through the adapter; a damaged
// file loads as a fresh union state that keeps the device id (T-T6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PluginStateStore } from "../src/platform/plugin-state-store.ts";
import { emptyState } from "../src/core/state.ts";
import type { VaultPath } from "../src/core/ports.ts";
import { FakeObsidian } from "./fakes/fake-obsidian.ts";

const DIR = "obs-config/plugins/mdvaultsync";

function store(o: FakeObsidian) {
	return new PluginStateStore({ adapter: o.adapter, dir: DIR, configDir: "obs-config", newDeviceId: () => "new-id" });
}

test("save writes a temp file and renames it into place; load round-trips", async () => {
	const o = new FakeObsidian();
	const s = store(o);
	assert.equal(await s.load(), null);
	const st = emptyState("dev-1");
	st.unionPending = false;
	st.firstSyncCompleted = true;
	st.appRootId = "approot";
	await s.save(st);
	assert.deepEqual(o.calls, [`write ${DIR}/sync-state.json.tmp`, `rename ${DIR}/sync-state.json.tmp -> ${DIR}/sync-state.json`]);
	assert.deepEqual(await s.load(), st);
	o.renameOverwrites = false;
	st.deltaLink = "https://graph.microsoft.com/v1.0/x";
	await s.save(st);
	assert.equal((await s.load())?.deltaLink, st.deltaLink, "the overwrite fallback works for the state file too");
});

test("save serializes before its first await, so later in-memory changes can't leak into that save", async () => {
	const o = new FakeObsidian();
	const s = store(o);
	const st = emptyState("dev-1");
	const p = s.save(st);
	st.deviceId = "changed";
	await p;
	assert.equal((await s.load())?.deviceId, "dev-1");
});

test("a damaged or edited state file loads as a fresh union state with the device id kept (T-T6)", async () => {
	const o = new FakeObsidian();
	const s = store(o);
	o.put(`${DIR}/sync-state.json`, new TextEncoder().encode('{"schemaVersion":1,"deviceId":"keep-me","files":{"../x":1}}'));
	const loaded = await s.load();
	assert.equal(loaded?.deviceId, "keep-me");
	assert.equal(loaded?.unionPending, true);
	assert.deepEqual(loaded?.files, {});
	o.put(`${DIR}/sync-state.json`, new TextEncoder().encode("{not json"));
	assert.equal((await s.load())?.deviceId, "new-id");
});

test("clear removes the state file and any temp file", async () => {
	const o = new FakeObsidian();
	const s = store(o);
	const st = emptyState("d");
	st.files["a.md" as VaultPath] = { path: "a.md" as VaultPath, remoteId: "x", eTag: "e", cTag: null, size: 1, mtime: 1, localHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=", remoteHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=", transformId: "identity" };
	await s.save(st);
	o.put(`${DIR}/sync-state.json.tmp`, new Uint8Array());
	await s.clear();
	assert.equal(o.text(`${DIR}/sync-state.json`), null);
	assert.equal(o.text(`${DIR}/sync-state.json.tmp`), null);
	assert.equal(await s.load(), null);
});
