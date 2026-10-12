// The one-line sync state shown in the status bar (desktop) and the ribbon tooltip (the only always-visible
// state on the iPad, which has no status bar [O-API-13]) (R-UI-2, design §5.6). Pure, so it is unit tested.
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
