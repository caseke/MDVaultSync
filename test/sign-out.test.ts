// Sign-out with the real state store (R-AUTH-7, plan M6): tokens and sync state cleared, local files untouched,
// and a sync that was running can't write state back afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearSession } from "../src/platform/sign-out.ts";
import { PluginStateStore } from "../src/platform/plugin-state-store.ts";
import { probeRename } from "../src/platform/rename-probe.ts";
import { FakeRemote } from "./fakes/fake-remote.ts";
import { Device, vaultFiles } from "./fakes/device.ts";
import { deferred } from "./fakes/fake-http.ts";
import { FakeObsidian } from "./fakes/fake-obsidian.ts";

const DIR = "obs-config/plugins/mdvaultsync";

test("sign-out clears the token and the state file; local files are untouched (R-AUTH-7)", async () => {
	const o = new FakeObsidian();
	const store = new PluginStateStore({ adapter: o.adapter, dir: DIR, configDir: "obs-config", newDeviceId: () => "n" });
	const remote = new FakeRemote();
	const dev = new Device(remote, {}, undefined, undefined);
	dev.vault.write("note.md", "keep me");
	await dev.sync("startup");
	await store.save(JSON.parse(dev.store.json ?? "") as never);
	assert.ok(o.text(`${DIR}/sync-state.json`));
	let signedOut = false;
	const res = await clearSession({ engine: dev.engine, signOut: () => ((signedOut = true), Promise.resolve()), store });
	assert.deepEqual(res, { tokenCleared: true, stateCleared: true });
	assert.ok(signedOut);
	assert.equal(o.text(`${DIR}/sync-state.json`), null);
	assert.deepEqual(vaultFiles(dev.vault), { "note.md": "keep me" });
	assert.equal(remote.contentAt("note.md"), "keep me");
});

test("sign-out during a sync: the running sync can't save state afterwards", async () => {
	const remote = new FakeRemote();
	const gate = deferred<boolean>();
	const dev = new Device(remote, { confirmPlan: () => gate.promise });
	dev.vault.write("a.md", "a");
	const running = dev.sync("startup");
	await new Promise<void>((r) => setImmediate(r));
	const res = await clearSession({ engine: dev.engine, signOut: () => Promise.resolve(), store: dev.store });
	assert.equal(res.stateCleared, true);
	gate.resolve(true);
	await running;
	assert.equal(dev.store.json, null, "nothing written back after the clear");
});

test("a failure to clear either part is reported, and the state is still cleared when the token isn't", async () => {
	const remote = new FakeRemote();
	const dev = new Device(remote);
	await dev.sync("startup");
	const res = await clearSession({ engine: dev.engine, signOut: () => Promise.reject(new Error("x")), store: dev.store });
	assert.deepEqual(res, { tokenCleared: false, stateCleared: true });
	const res2 = await clearSession({ engine: null, signOut: () => Promise.resolve(), store: { load: () => Promise.resolve(null), save: () => Promise.resolve(), clear: () => Promise.reject(new Error("y")) } });
	assert.deepEqual(res2, { tokenCleared: true, stateCleared: false });
});

test("the rename probe reports how adapter.rename treats an existing target (manual check, O-API-10)", async () => {
	for (const [mode, expected] of [
		[true, "replaced"],
		[false, "threw"],
		["keep", "kept-target"],
	] as const) {
		const o = new FakeObsidian();
		o.renameOverwrites = mode;
		const r = await probeRename(o.adapter, DIR);
		assert.equal(r.renameOverExisting, expected);
		assert.equal(r.fallbackWorks, true);
		assert.equal(r.cleanedUp, true);
		assert.equal([...o.entries.keys()].length, 0);
	}
});
