import { test } from "node:test";
import assert from "node:assert/strict";
import { IdentityTransform } from "../src/core/transform.ts";
import type { ContentTransform } from "../src/core/transform.ts";
import type { VaultPath } from "../src/core/ports.ts";

const ctx = { path: "a.md" as VaultPath };

test("IdentityTransform has id identity and satisfies ContentTransform", () => {
	const t: ContentTransform = new IdentityTransform();
	assert.equal(t.id, "identity");
});

test("IdentityTransform returns the same bytes both ways", async () => {
	const t = new IdentityTransform();
	const data = new Uint8Array([1, 2, 3, 250]).buffer;
	const enc = await t.encode(data, ctx);
	assert.deepEqual(new Uint8Array(enc), new Uint8Array([1, 2, 3, 250]));
	const dec = await t.decode(enc, ctx);
	assert.deepEqual(new Uint8Array(dec), new Uint8Array([1, 2, 3, 250]));
	assert.equal((await t.encode(new ArrayBuffer(0), ctx)).byteLength, 0);
});
