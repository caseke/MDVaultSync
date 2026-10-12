// The sync state for the status bar and the ribbon tooltip (desktop), the ribbon icon (every platform) and the
// Show sync status window. The iPad has no status bar [O-API-13] and no hover [O-API-20], so there the icon and
// the command carry it (R-UI-2 as amended in M7, design §5.6, §10). Pure, so it is unit tested.
import { LOG_CODE_RE } from "../core/logger.ts";
import type { EngineStatus } from "../core/ports.ts";

export interface StatusContext {
	now: number;
	/** Last successful sync from the saved report, for before this session's first run. */
	lastSyncAt: number | null;
	signedIn: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "14:02" for today, otherwise "2026-10-11 09:05" (local time). */
export function formatSyncTime(t: number, now: number): string {
	const d = new Date(t);
	const n = new Date(now);
	const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
	return sameDay ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** The idle icon, and the last resort when this Obsidian build has none of a state's candidates (main.ts). */
export const DEFAULT_ICON = "refresh-cw";

/**
 * Candidate icon names for a state, tried in order (main.ts takes the first this Obsidian build has; Lucide
 * renamed some, such as alert-triangle → triangle-alert). A tooltip needs hover, which a touchscreen doesn't
 * have [O-API-20], so on the iPad the icon itself shows the state (R-UI-2 as amended in M7).
 */
export function statusIcon(s: EngineStatus, signedIn: boolean): readonly string[] {
	switch (s.state) {
		case "syncing":
			return ["loader", "loader-circle", "loader-2", "hourglass"];
		case "waiting-for-user":
			return ["hourglass", "clock"];
		case "error":
			return ["triangle-alert", "alert-triangle", "circle-alert", "alert-circle"];
		case "sign-in-required":
			return ["log-in", "user"];
		case "idle":
			return signedIn ? [DEFAULT_ICON] : ["log-in", "user"];
	}
}

/** R-UI-2 asks for the state and the last sync time: every state but idle appends the last successful sync. */
export function statusText(s: EngineStatus, ctx: StatusContext): string {
	const since = ctx.lastSyncAt === null ? "" : ` (last synced ${formatSyncTime(ctx.lastSyncAt, ctx.now)})`;
	switch (s.state) {
		case "syncing":
			return `Syncing…${since}`;
		case "waiting-for-user":
			return `Waiting for you: open MDVaultSync to review${since}`;
		case "error":
			return `Sync error (${LOG_CODE_RE.test(s.code) ? s.code : "other"})${since}`;
		case "sign-in-required":
			return `Sign-in required${since}`;
		case "idle": {
			if (!ctx.signedIn) return "Signed out";
			const t = s.lastSyncAt ?? ctx.lastSyncAt;
			return t === null ? "Not synced yet" : `Synced ${formatSyncTime(t, ctx.now)}`;
		}
	}
}
