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
	assert.ok(!JSON.stringify(data).includes("RT1"));
	assert.equal(store.get(), "RT1");
	assert.equal(store.backend, "secret-storage");
	assert.equal(store.sessionOnly, false);
});

// D-5 (changed in M9): no plaintext fallback. A token SecretStorage can't hold lives in memory only.
test("keeps the token in memory only when setSecret throws; nothing secret reaches plugin data", async () => {
	const { secrets, data, store, saves } = setup();
	secrets.failSet = true;
	await store.set("RT1");
	assert.equal(store.backend, "memory");
	assert.equal(store.get(), "RT1");
	assert.ok(!JSON.stringify(data).includes("RT1"));
	assert.equal(data.sessionOnlySignIn, true);
	assert.equal(store.sessionOnly, true);
	assert.equal(saves(), 1);
});

test("keeps the token in memory only when SecretStorage doesn't keep the value", async () => {
	const { secrets, data, store } = setup();
	secrets.dropWrites = true;
	await store.set("RT1");
	assert.equal(store.backend, "memory");
	assert.equal(store.get(), "RT1");
	assert.ok(!JSON.stringify(data).includes("RT1"));
});

test("a refresh while memory-only replaces the in-memory token", async () => {
	const { secrets, store } = setup();
	secrets.failSet = true;
	await store.set("RT1");
	await store.set("RT2");
	assert.equal(store.get(), "RT2");
});

test("a memory-only sign-in is gone after a restart, and the flag says why", async () => {
	const { secrets, data, store } = setup();
	secrets.failSet = true;
	await store.set("RT1");
	const restarted = new PluginTokenStore(secrets, { get: () => data, save: () => Promise.resolve() });
	assert.equal(restarted.get(), null);
	assert.equal(restarted.backend, "secret-storage");
	assert.equal(restarted.sessionOnly, true);
});

test("moves to SecretStorage once it works and clears the memory-only flag", async () => {
	const { secrets, data, store } = setup();
	secrets.failSet = true;
	await store.set("RT1");
	secrets.failSet = false;
	await store.set("RT2");
	assert.equal(store.backend, "secret-storage");
	assert.equal(secrets.map.get(SECRET_ID), "RT2");
	assert.equal(store.get(), "RT2");
	assert.equal(data.sessionOnlySignIn, false);
	assert.equal(store.sessionOnly, false);
});

test("clear empties SecretStorage and memory, and clears the flag", async () => {
	const { secrets, data, store } = setup();
	secrets.failSet = true;
	await store.set("RT1");
	secrets.failSet = false;
	secrets.map.set(SECRET_ID, "RT");
	await store.clear();
	assert.equal(secrets.map.get(SECRET_ID), "");
	assert.equal(store.get(), null);
	assert.equal(store.backend, "secret-storage");
	assert.equal(data.sessionOnlySignIn, false);
});

test("clear still drops the in-memory token when setSecret throws", async () => {
	const { secrets, store } = setup();
	secrets.failSet = true;
	await store.set("RT1");
	await store.clear();
	assert.equal(store.get(), null);
});

test("a plaintext token left in data.json by 0.x is adopted into SecretStorage", async () => {
	const { secrets, store } = setup();
	await store.adoptLegacy("OLD");
	assert.equal(secrets.map.get(SECRET_ID), "OLD");
	assert.equal(store.get(), "OLD");
	assert.equal(store.backend, "secret-storage");
});

test("a legacy token SecretStorage still can't hold is kept in memory for this session only", async () => {
	const { secrets, data, store } = setup();
	secrets.failSet = true;
	await store.adoptLegacy("OLD");
	assert.equal(store.backend, "memory");
	assert.equal(store.get(), "OLD");
	assert.ok(!JSON.stringify(data).includes("OLD"));
});

test("a legacy token never replaces one already in SecretStorage", async () => {
	const { secrets, store } = setup();
	secrets.map.set(SECRET_ID, "NEW");
	await store.adoptLegacy("OLD");
	assert.equal(store.get(), "NEW");
});

test("an empty secret reads as null, and a throwing getSecret reads as null", () => {
	const { secrets, store } = setup();
	secrets.map.set(SECRET_ID, "");
	assert.equal(store.get(), null);
	secrets.failGet = true;
	assert.equal(store.get(), null);
});

test("clear throws when SecretStorage can't overwrite the token", async () => {
	const { secrets, store } = setup();
	secrets.map.set(SECRET_ID, "RT");
	secrets.failSet = true;
	await assert.rejects(store.clear(), (e: unknown) => e instanceof TokenClearError);
	assert.equal(store.get(), "RT");
});

// R-AUTH-9: Obsidian has no uninstall hook [O-API-19]. Uninstall deletes data.json but not SecretStorage, so a
// reinstall would find the old refresh token. A token with no plugin data is a leftover and is cleared at load.
test("a token left by an uninstalled copy (no plugin data) is cleared at load", async () => {
	const { secrets, store } = setup();
	secrets.map.set(SECRET_ID, "rt-from-old-install");
	assert.equal(await store.clearOrphan(false), true);
	assert.equal(store.get(), null);
	assert.equal(secrets.map.get(SECRET_ID), "");
});

test("a token is kept when plugin data exists (a normal restart or update)", async () => {
	const { secrets, store } = setup({ clientId: "00000000-0000-0000-0000-000000000000" });
	secrets.map.set(SECRET_ID, "rt");
	assert.equal(await store.clearOrphan(true), false);
	assert.equal(store.get(), "rt");
});

test("no plugin data and no token: nothing to clear, nothing written", async () => {
	const { store, saves } = setup();
	assert.equal(await store.clearOrphan(false), false);
	assert.equal(saves(), 0);
});

test("a leftover token that can't be cleared surfaces TokenClearError", async () => {
	const { secrets, store } = setup();
	secrets.map.set(SECRET_ID, "rt");
	secrets.dropWrites = true;
	await assert.rejects(store.clearOrphan(false), TokenClearError);
});
