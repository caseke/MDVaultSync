// Which Account rows show for each sign-in state (M8 matrix row 10). Obsidian 1.13+ caches the setting
// definitions built at load, so the rows must decide at render time; these are the predicates they use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_ROWS, accountRowVisible, isQuietPrepareError, type AccountRow } from "../src/ui/account-rows.ts";

const shown = (status: Parameters<typeof accountRowVisible>[1]): AccountRow[] => ACCOUNT_ROWS.filter((r) => accountRowVisible(r, status));

test("signed in: storage and Sign out, no Sign in", () => {
	assert.deepEqual(shown("signed-in"), ["status", "client-id", "storage", "sign-out", "token-storage"]);
});

test("signed out and sign-in required: Sign in, never storage or Sign out (the stale layout that froze, row 10)", () => {
	for (const s of ["signed-out", "sign-in-required"] as const) {
		assert.deepEqual(shown(s), ["status", "client-id", "sign-in", "token-storage"], s);
	}
});

test("prepare rejections that mean the state moved under the render stay quiet; real failures don't (0.6.4)", () => {
	assert.equal(isQuietPrepareError("superseded"), true);
	assert.equal(isQuietPrepareError("already-signed-in"), true, "a hidden Sign in row rendered while signed in");
	for (const c of ["no-client-id", "network", "expired", "signed-out"] as const) assert.equal(isQuietPrepareError(c), false, c);
});
