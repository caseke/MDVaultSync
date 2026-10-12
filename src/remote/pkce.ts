// PKCE (RFC 7636) and OAuth state helpers. WebCrypto only, so it runs on iOS and desktop [I-AC-2], [O-SUB-4].

const VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const VERIFIER_LENGTH = 64;
// Largest multiple of the alphabet size (66) below 256; bytes at or above it are rejected so every
// character is equally likely.
const REJECT_AT = 256 - (256 % VERIFIER_ALPHABET.length);

/** A 64-character code_verifier from the RFC 7636 unreserved alphabet. */
export function createVerifier(): string {
	let out = "";
	const buf = new Uint8Array(VERIFIER_LENGTH * 2);
	while (out.length < VERIFIER_LENGTH) {
		crypto.getRandomValues(buf);
		for (const b of buf) {
			if (b >= REJECT_AT) continue;
			out += VERIFIER_ALPHABET[b % VERIFIER_ALPHABET.length];
			if (out.length === VERIFIER_LENGTH) break;
		}
	}
	return out;
}

/** code_challenge = base64url(SHA-256(ASCII(verifier))), method S256. */
export async function challengeFromVerifier(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

/** OAuth `state`: 32 random bytes, base64url (43 characters). */
export function createState(): string {
	const buf = new Uint8Array(32);
	crypto.getRandomValues(buf);
	return base64url(buf);
}

/** Compares two strings without an early exit on the first differing character (R-SEC-1). */
export function timingSafeEqual(a: string, b: string): boolean {
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}

function base64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
