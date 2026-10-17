// Whether the fallback settings renderer (Obsidian 1.11.4–1.12) redraws after an auth or sync change (design §10).
// Pure, so it is unit tested. It draws at once, and drawing prepares a sign-in that only hide() discards
// (R-SEC-1), so it redraws only while the tab is on screen: a row rendered since the last hide(), and the
// container attached. On 1.13+ the tab always calls update() instead, which rebuilds Obsidian's cached
// definitions without drawing (M8 matrix row 10).
export interface RefreshState {
	/** A row rendered since the last hide(). */
	onScreen: boolean;
	connected: boolean;
}

/** "render": redraw the fallback renderer now; "skip": it renders afresh when the tab next opens. */
export function refreshAction(s: RefreshState): "render" | "skip" {
	return s.onScreen && s.connected ? "render" : "skip";
}
