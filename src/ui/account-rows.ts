// Which Account rows show for a sign-in state (design §10, M8 matrix row 10). Obsidian 1.13+ builds the setting
// definitions once (at load) and reuses them when the tab opens [O-API-21], so a row list chosen at build time went stale
// after a revoke or a sign-out made with settings closed: the signed-in rows showed, and the tab froze. Every
// row is therefore always defined, and these predicates decide at render time. Pure, so it is unit tested.
import type { AuthErrorCode, AuthStatus } from "../remote/auth.ts";

export const ACCOUNT_ROWS = ["status", "client-id", "storage", "sign-out", "sign-in", "token-storage"] as const;
export type AccountRow = (typeof ACCOUNT_ROWS)[number];

/**
 * Obsidian 1.14 also calls `render` for a row whose `visible` is false and only hides it [O-API-22] (0.6.3:
 * the hidden Sign in row prepared a sign-in while signed in). So every state-dependent row checks this itself
 * at the top of its render; `visible` only hides it.
 */
export function accountRowVisible(row: AccountRow, status: AuthStatus): boolean {
	const signedIn = status === "signed-in";
	if (row === "storage" || row === "sign-out") return signedIn;
	if (row === "sign-in") return !signedIn;
	return true;
}

/**
 * A sign-in prepare that failed because the state moved under the render (a newer render, or a sign-in that
 * completed meanwhile) is expected; it raises no notice. Anything else is a real failure.
 */
export function isQuietPrepareError(code: AuthErrorCode): boolean {
	return code === "superseded" || code === "already-signed-in";
}
