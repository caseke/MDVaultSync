// R-AUTH-9 decision (security review): leftover only when the plugin folder holds neither data.json nor
// sync-state.json. A corrupt or unreadable data.json keeps the sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLeftoverInstall } from "../src/platform/leftover-install.ts";
import { FakeObsidian } from "./fakes/fake-obsidian.ts";

const DIR = "obs-config/plugins/mdvaultsync";

test("an empty plugin folder (fresh install after an uninstall) is a leftover install", async () => {
	assert.equal(await isLeftoverInstall(new FakeObsidian().adapter, DIR), true);
});

test("data.json present, even corrupt, empty or literally null, is not a leftover install", async () => {
	for (const body of ["{not json", "", "null", "{}"]) {
		const o = new FakeObsidian();
		o.put(`${DIR}/data.json`, new TextEncoder().encode(body));
		assert.equal(await isLeftoverInstall(o.adapter, DIR), false, JSON.stringify(body));
	}
});

test("sync-state.json without data.json (data.json deleted by hand) is not a leftover install", async () => {
	const o = new FakeObsidian();
	o.put(`${DIR}/sync-state.json`, new TextEncoder().encode("{}"));
	assert.equal(await isLeftoverInstall(o.adapter, DIR), false);
});

test("an unreadable folder (exists throws) keeps the sign-in", async () => {
	assert.equal(await isLeftoverInstall({ exists: () => Promise.reject(new Error("EIO")) }, DIR), false);
});
