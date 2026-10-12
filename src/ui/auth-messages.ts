// User-facing text for sign-in errors. Pure, so a test can check every code has a message.
import type { AuthErrorCode } from "../remote/auth.ts";

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
	"no-client-id": "Enter a valid application (client) ID in the MDVaultSync settings first.",
	"already-signed-in": "You're already signed in. Sign out first to use a different account.",
	"no-pending": "That sign-in link is no longer valid. Tap Sign in again.",
	expired: "The sign-in took longer than 10 minutes. Start again.",
	superseded: "That sign-in link was replaced by a newer one. Tap Sign in again.",
	"state-mismatch": "Sign-in link ignored: it doesn't belong to the sign-in in progress.",
	"provider-error": "Microsoft didn't complete the sign-in.",
	"missing-code": "Microsoft's response had no authorization code. Start again.",
	"invalid-response": "Microsoft's token response was not valid. Try again.",
	"token-request-failed": "Microsoft refused the token request.",
	network: "Couldn't reach Microsoft. Check your connection and try again.",
	"sign-in-required": "OneDrive access has expired or was revoked. Sign in again in the MDVaultSync settings.",
	"signed-out": "You're signed out of OneDrive.",
};

/** Message plus the sanitized provider code, which is safe to show (it matches /^[a-z0-9_]+$/). */
export function authErrorText(code: AuthErrorCode, providerCode: string | undefined): string {
	const base = AUTH_ERROR_MESSAGES[code];
	return providerCode ? `${base} (${providerCode})` : base;
}
