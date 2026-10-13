// Whether a trigger starts a sync (R-TRIG-1…3). Startup and interval runs never nag a user who isn't signed in
// (and never create a state file for them); a user action explains why nothing happened.
import type { Trigger } from "../core/ports.ts";
import type { AuthStatus } from "../remote/auth.ts";
import { AUTH_ERROR_MESSAGES } from "./auth-messages.ts";

export type TriggerDecision = { action: "run" } | { action: "skip" } | { action: "notice"; text: string };

const UNATTENDED = new Set<Trigger>(["startup", "interval", "rerun"]);

/**
 * Timed-out requests still hanging (TimeoutTransport.stuck) at which unattended runs pause: each holds a body and
 * a connection, and a new run would add more (M8 review, T-D6). A user action still runs.
 */
export const STUCK_LIMIT = 2;

export const PATTERNS_TEXT =
	"Sync is paused: the exclude patterns saved on this device couldn't be read. In the MDVaultSync settings, check Exclude patterns, then select Save and resume sync.";

/** `patternsOk` false: data.json held unusable exclude patterns; nothing syncs until they're saved again (T-I6). */
export function triggerDecision(trigger: Trigger, auth: AuthStatus, hasClientId: boolean, patternsOk: boolean, stuckRequests = 0): TriggerDecision {
	if (auth === "signed-in" && patternsOk) return UNATTENDED.has(trigger) && stuckRequests >= STUCK_LIMIT ? { action: "skip" } : { action: "run" };
	if (UNATTENDED.has(trigger)) return { action: "skip" };
	if (!patternsOk) return { action: "notice", text: PATTERNS_TEXT };
	if (auth === "sign-in-required") return { action: "notice", text: AUTH_ERROR_MESSAGES["sign-in-required"] };
	if (!hasClientId) return { action: "notice", text: AUTH_ERROR_MESSAGES["no-client-id"] };
	return { action: "notice", text: "Sign in to OneDrive in the MDVaultSync settings first." };
}
