// Whether the settings tab re-renders after an auth or sync change (design §10). Pure, so it is unit tested.
// M8 matrix row 10: a revoked grant flips the status during a background sync, the one status change that
// happens while the tab is closed. `containerEl.isConnected` alone can't tell a closed tab from an open one on
// Obsidian 1.13+ (M7 note: unverified), so the tab also tracks whether it is on screen: set when a row renders,
// cleared by hide().
export interface RefreshState {
	/** A row rendered since the last hide(). */
	onScreen: boolean;
	connected: boolean;
}

/** "render": update() on 1.13+, the fallback renderer before (the caller checks the API version inline). */
export function refreshAction(s: RefreshState): "render" | "skip" {
	return s.onScreen && s.connected ? "render" : "skip";
}
