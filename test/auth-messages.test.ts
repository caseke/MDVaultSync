import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTH_ERROR_CODES } from "../src/remote/auth.ts";
import { AUTH_ERROR_MESSAGES, authErrorText } from "../src/ui/auth-messages.ts";

test("every auth error code has a message", () => {
	assert.deepEqual(Object.keys(AUTH_ERROR_MESSAGES).sort(), [...AUTH_ERROR_CODES].sort());
	for (const code of AUTH_ERROR_CODES) assert.ok(AUTH_ERROR_MESSAGES[code].length > 0);
});

test("the provider code is appended only when present", () => {
	assert.equal(authErrorText("network", undefined), AUTH_ERROR_MESSAGES.network);
	assert.match(authErrorText("provider-error", "access_denied"), /\(access_denied\)$/);
});
