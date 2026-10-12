import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DATA, isValidClientId, parseData } from "../src/settings.ts";

test("missing or non-object data gives defaults", () => {
	for (const raw of [null, undefined, 42, "x", []]) assert.deepEqual(parseData(raw), DEFAULT_DATA);
});

test("keeps well-typed fields and drops mistyped or unknown ones", () => {
	assert.deepEqual(parseData({ clientId: "abc", fallbackRefreshToken: "RT", extra: 1 }), {
		clientId: "abc",
		fallbackRefreshToken: "RT",
	});
	assert.deepEqual(parseData({ clientId: 5, fallbackRefreshToken: "" }), DEFAULT_DATA);
});

test("parseData returns a fresh object each time", () => {
	const a = parseData(null);
	a.clientId = "changed";
	assert.equal(DEFAULT_DATA.clientId, "");
});

test("client IDs must be GUIDs", () => {
	assert.equal(isValidClientId("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"), true);
	assert.equal(isValidClientId("0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D"), true);
	assert.equal(isValidClientId(""), false);
	assert.equal(isValidClientId(" 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"), false);
	assert.equal(isValidClientId("0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d"), false);
});
