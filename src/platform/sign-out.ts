// Sign-out's clearing steps (R-AUTH-7, design §4 "Sign-out"), apart from main.ts so they can be tested: stop the
// engine from saving, clear the token, then clear the sync state. Local files are never touched. The state is
// cleared even if the token couldn't be: a later sync then starts in union mode, which never deletes.
import type { StateStore } from "../core/ports.ts";

export interface ClearSessionDeps {
	/** The sync engine, if one exists; reset() stops a running sync from saving state again. */
	engine: { reset(): void } | null;
	signOut(): Promise<void>;
	store: StateStore;
}

export async function clearSession(deps: ClearSessionDeps): Promise<{ tokenCleared: boolean; stateCleared: boolean }> {
	deps.engine?.reset();
	let tokenCleared = true;
	let stateCleared = true;
	try {
		await deps.signOut();
	} catch (e) {
		tokenCleared = false;
		console.error(`MDVaultSync: sign-out could not clear the token (${e instanceof Error ? e.name : "unknown"})`);
	}
	try {
		await deps.store.clear();
	} catch (e) {
		stateCleared = false;
		console.error(`MDVaultSync: sign-out could not clear sync state (${e instanceof Error ? e.name : "unknown"})`);
	}
	return { tokenCleared, stateCleared };
}
