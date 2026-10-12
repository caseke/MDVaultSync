import { test } from "node:test";
import assert from "node:assert/strict";
import { PluginTokenStore, SECRET_ID, TokenClearError, type SecretStorageLike } from "../src/platform/token-store.ts";
import { DEFAULT_DATA, type PluginData } from "../src/settings.ts";

class FakeSecrets implements SecretStorageLike {
	readonly map = new Map<string, string>();
	failSet = false;
	failGet = false;
	/** Simulates a provider that accepts the write but doesn't keep it. */
	dropWrites = false;
	setSecret(id: string, secret: string): void {
		if (this.failSet) throw new Error("no secret storage provider");
		if (!/^[a-z0-9-]+$/.test(id)) throw new Error("bad id");
		if (!this.dropWrites) this.map.set(id, secret);
	}
	getSecret(id: string): string | null {
		if (this.failGet) throw new Error("unavailable");
		return this.map.get(id) ?? null;
	}
}

function setup(initial: Partial<PluginData> = {}) {
	const secrets = new FakeSecrets();
	const data: PluginData = { ...DEFAULT_DATA, ...initial };
	let saves = 0;
	const store = new PluginTokenStore(secrets, {
		get: () => data,
		save: () => {
			saves++;
			return Promise.resolve();
		},
	});
	return { secrets, data, store, saves: () => saves };
}

test("the secret ID is a valid SecretStorage ID", () => {
	assert.match(SECRET_ID, /^[a-z0-9-]+$/);
	assert.equal(SECRET_ID, "mdvaultsync-refresh-token");
});

test("stores in SecretStorage and never in plugin data", async () => {
	const { secrets, data, store } = setup();
	await store.set("RT1");
	assert.equal(secrets.map.get(SECRET_ID), "RT1");
	assert.equal(data.fallbackRefreshToken, undefined);
	assert.equal(store.get(), "RT1");
	assert.equal(store.backend, "secret-storage");
});

test("falls back to plugin data when setSecret throws", async () => {
	const { secrets, data, store, saves } = setup();
	secrets.failSet = true;
	await store.set("RT1");
	assert.equal(store.backend, "plugin-data");
	assert.equal(data.fallbackRefreshToken, "RT1");
	assert.equal(saves(), 1);
	assert.equal(store.get(), "RT1");
});

test("falls back when SecretStorage doesn't keep the value", async () => {
	const { secrets, data, store } = setup();
	secrets.dropWrites = true;
	await store.set("RT1");
	assert.equal(store.backend, "plugin-data");
	assert.equal(data.fallbackRefreshToken, "RT1");
});

test("moves back to SecretStorage once it works and removes the fallback", async () => {
	const { secrets, data, store } = setup({ fallbackRefreshToken: "OLD" });
	assert.equal(store.backend, "plugin-data");
	assert.equal(store.get(), "OLD");
	await store.set("RT2");
	assert.equal(store.backend, "secret-storage");
	assert.equal(secrets.map.get(SECRET_ID), "RT2");
	assert.ok(!("fallbackRefreshToken" in data));
	assert.equal(store.get(), "RT2");
});

test("clear empties both stores", async () => {
	const { secrets, data, store } = setup({ fallbackRefreshToken: "OLD" });
	secrets.map.set(SECRET_ID, "RT");
	await store.clear();
	assert.equal(secrets.map.get(SECRET_ID), "");
	assert.ok(!("fallbackRefreshToken" in data));
	assert.equal(store.get(), null);
	assert.equal(store.backend, "secret-storage");
});

test("clear still removes the fallback when setSecret throws", async () => {
	const { secrets, data, store } = setup({ fallbackRefreshToken: "OLD" });
	secrets.failSet = true;
	await store.clear();
	assert.ok(!("fallbackRefreshToken" in data));
	assert.equal(store.get(), null);
});

test("an empty secret reads as null, and a throwing getSecret reads as null", () => {
	const { secrets, store } = setup();
	secrets.map.set(SECRET_ID, "");
	assert.equal(store.get(), null);
	secrets.failGet = true;
	assert.equal(store.get(), null);
});

test("clear throws when SecretStorage can't overwrite the token, after removing the fallback", async () => {
	const { secrets, data, store } = setup({ fallbackRefreshToken: "OLD" });
	secrets.map.set(SECRET_ID, "RT");
	secrets.failSet = true;
	await assert.rejects(store.clear(), (e: unknown) => e instanceof TokenClearError);
	assert.ok(!("fallbackRefreshToken" in data));
	assert.equal(store.get(), "RT");
});
