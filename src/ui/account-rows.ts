// Which Account rows show for a sign-in state (design §10, M8 matrix row 10). Obsidian 1.13+ builds the setting
// definitions once (at load) and reuses them when the tab opens, so a row list chosen at build time went stale
// after a revoke or a sign-out made with settings closed: the signed-in rows showed, and the tab froze. Every
// row is therefore always defined, and these predicates decide at render time. Pure, so it is unit tested.
import type { AuthStatus } from "../remote/auth.ts";

export const ACCOUNT_ROWS = ["status", "client-id", "storage", "sign-out", "sign-in", "token-storage"] as const;
export type AccountRow = (typeof ACCOUNT_ROWS)[number];

export function accountRowVisible(row: AccountRow, status: AuthStatus): boolean {
	const signedIn = status === "signed-in";
	if (row === "storage" || row === "sign-out") return signedIn;
	if (row === "sign-in") return !signedIn;
	return true;
}
