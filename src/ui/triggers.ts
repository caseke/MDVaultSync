// Whether a trigger starts a sync (R-TRIG-1…3). Startup and interval runs never nag a user who isn't signed in
// (and never create a state file for them); a user action explains why nothing happened.
import type { Trigger } from "../core/ports.ts";
import type { AuthStatus } from "../remote/auth.ts";
import { AUTH_ERROR_MESSAGES } from "./auth-messages.ts";

export type TriggerDecision = { action: "run" } | { action: "skip" } | { action: "notice"; text: string };

const UNATTENDED = new Set<Trigger>(["startup", "interval", "rerun"]);

export function triggerDecision(trigger: Trigger, auth: AuthStatus, hasClientId: boolean): TriggerDecision {
	if (auth === "signed-in") return { action: "run" };
	if (UNATTENDED.has(trigger)) return { action: "skip" };
	if (auth === "sign-in-required") return { action: "notice", text: AUTH_ERROR_MESSAGES["sign-in-required"] };
	if (!hasClientId) return { action: "notice", text: AUTH_ERROR_MESSAGES["no-client-id"] };
	return { action: "notice", text: "Sign in to OneDrive in the MDVaultSync settings first." };
}
