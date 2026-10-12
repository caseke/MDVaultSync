// OAuth 2.0 authorization code + PKCE against the /consumers endpoints, as a public client (design §4, D-4).
import type { AccessTokenProvider, Clock, HttpResponse, HttpTransport, TokenStore } from "../core/ports.ts";
import { isValidClientId } from "../settings.ts";
import { challengeFromVerifier, createState, createVerifier, timingSafeEqual } from "./pkce.ts";
import { InvalidResponse, parseTokenError, parseTokenResponse, sanitizeErrorCode, type TokenResponse } from "./validate.ts";

/** Least privilege: the App Folder only, plus a refresh token (R-AUTH-4, T-E2) [I-REG-5]. */
export const SCOPE = "Files.ReadWrite.AppFolder offline_access";
/** Personal Microsoft accounts only (R-ENV-1) [I-AC-1]. */
export const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
export const TOKEN_URL = `${AUTHORITY}/token`;
/** Primary redirect, registered without a query string [I-RU-2]. */
export const REDIRECT_PROTOCOL = "obsidian://mdvaultsync-auth";

/** A pending sign-in expires after 10 minutes (R-SEC-1). */
export const PENDING_TTL_MS = 10 * 60_000;
/** Refresh when less than this is left on the access token (design §4), or half its lifetime if shorter. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export const AUTH_ERROR_CODES = [
	"no-client-id",
	"already-signed-in",
	"no-pending",
	"superseded",
	"expired",
	"state-mismatch",
	"provider-error",
	"missing-code",
	"invalid-response",
	"token-request-failed",
	"network",
	"sign-in-required",
	"signed-out",
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** Carries a fixed code and, for provider errors, a sanitized OAuth code. Never URLs, params or descriptions. */
export class AuthError extends Error {
	readonly code: AuthErrorCode;
	readonly providerCode: string | undefined;
	constructor(code: AuthErrorCode, providerCode?: string) {
		super(code);
		this.name = "AuthError";
		this.code = code;
		this.providerCode = providerCode;
	}
}

export type AuthStatus = "signed-out" | "signed-in" | "sign-in-required";

export interface AuthClientOptions {
	transport: HttpTransport;
	tokens: TokenStore;
	clock: Clock;
	getClientId: () => string;
}

interface PendingSignIn {
	verifier: string;
	state: string;
	createdAt: number;
	/** The authorize URL this sign-in was activated from (for a double-tap no-op). */
	url: string;
}

/** Built ahead of the tap, so the tap can navigate with no await in between (iOS user activation). */
interface PreparedSignIn {
	verifier: string;
	state: string;
	url: string;
}

export class AuthClient implements AccessTokenProvider {
	private readonly transport: HttpTransport;
	private readonly tokens: TokenStore;
	private readonly clock: Clock;
	private readonly getClientId: () => string;

	/** In memory only, never persisted (design §4 step 1). */
	private pending: PendingSignIn | null = null;
	/** In memory only; becomes `pending` when the user taps the link. */
	private prepared: PreparedSignIn | null = null;
	/** Bumped by every prepareSignIn and discardPrepared; only the latest prepare may store `prepared`. */
	private prepareSeq = 0;
	/** In memory only (R-AUTH-5). */
	private access: { token: string; expiresAt: number; marginMs: number } | null = null;
	private refreshing: Promise<string> | null = null;
	/** Bumped by signOut; work started under an older epoch must not store tokens. */
	private epoch = 0;
	private signInRequired = false;
	private lastStatus: AuthStatus;
	private readonly listeners = new Set<(s: AuthStatus) => void>();

	constructor(opts: AuthClientOptions) {
		this.transport = opts.transport;
		this.tokens = opts.tokens;
		this.clock = opts.clock;
		const getClientId = opts.getClientId;
		this.getClientId = () => getClientId();
		this.lastStatus = this.status;
	}

	get status(): AuthStatus {
		if (this.signInRequired) return "sign-in-required";
		return this.tokens.get() ? "signed-in" : "signed-out";
	}

	/** Subscribe to status changes. Returns an unsubscribe function. */
	onStatusChange(cb: (s: AuthStatus) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	/**
	 * Builds the authorize URL ahead of the tap and holds its verifier and state in memory. Doesn't start a
	 * sign-in: callbacks stay `no-pending` until `activateSignIn`. Replaces any earlier prepared sign-in.
	 */
	async prepareSignIn(): Promise<string> {
		const clientId = this.requireClientId();
		// Signing in again over a live grant could relink the vault to another account; sign out first.
		if (this.status === "signed-in") throw new AuthError("already-signed-in");
		const epoch = this.epoch;
		const seq = ++this.prepareSeq;
		const verifier = createVerifier();
		const state = createState();
		const challenge = await challengeFromVerifier(verifier);
		if (epoch !== this.epoch) throw new AuthError("signed-out");
		// A newer prepare (or a discard) started meanwhile: let it win, so the UI and the client agree.
		if (seq !== this.prepareSeq) throw new AuthError("superseded");
		// Re-check after the await: a sign-in may have completed meanwhile.
		if (this.isSignedIn()) throw new AuthError("already-signed-in");
		const params: [string, string][] = [
			["client_id", clientId],
			["response_type", "code"],
			["redirect_uri", REDIRECT_PROTOCOL],
			// The code must arrive in the query: Obsidian may drop the fragment [O-API-3].
			["response_mode", "query"],
			["scope", SCOPE],
			["code_challenge", challenge],
			["code_challenge_method", "S256"],
			["state", state],
			["prompt", "select_account"],
		];
		const url = `${AUTHORITY}/authorize?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
		this.prepared = { verifier, state, url };
		return url;
	}

	/**
	 * Starts the sign-in for a prepared URL, synchronously, from the tap that opens it. The 10-minute expiry
	 * runs from here. A second tap on the same link is a no-op; any other URL is refused.
	 */
	activateSignIn(url: string): void {
		if (this.status === "signed-in") throw new AuthError("already-signed-in");
		const p = this.prepared;
		if (p && p.url === url) {
			this.pending = { verifier: p.verifier, state: p.state, createdAt: this.clock.now(), url };
			this.prepared = null;
			return;
		}
		const pending = this.pending;
		if (pending?.url === url) {
			if (this.clock.now() - pending.createdAt > PENDING_TTL_MS) {
				this.pending = null;
				throw new AuthError("expired");
			}
			return;
		}
		throw new AuthError("no-pending");
	}

	/** Drops an untapped link (the settings tab closed), including any prepare still in flight. */
	discardPrepared(): void {
		this.prepared = null;
		this.prepareSeq++;
	}

	/** Prepare and activate in one step (the sign-in command and tests). */
	async buildAuthorizeUrl(): Promise<string> {
		const url = await this.prepareSignIn();
		this.activateSignIn(url);
		return url;
	}

	/**
	 * Validates an obsidian://mdvaultsync-auth callback and redeems its code (design §4 step 3, T-S1).
	 */
	async handleCallback(params: Readonly<Record<string, string>>): Promise<void> {
		const p = this.pending;
		if (!p) throw new AuthError("no-pending");
		if (this.clock.now() - p.createdAt > PENDING_TTL_MS) {
			this.pending = null;
			throw new AuthError("expired");
		}
		const state = params["state"];
		// A wrong state leaves the pending sign-in alone: a forged callback can't cancel the real one.
		if (typeof state !== "string" || !timingSafeEqual(state, p.state)) throw new AuthError("state-mismatch");
		// Consume the state before any await, so it is single-use even for racing callbacks.
		this.pending = null;
		if (params["error"] !== undefined) throw new AuthError("provider-error", sanitizeErrorCode(params["error"]));
		const code = params["code"];
		if (typeof code !== "string" || code.length === 0 || code.length > 8192) throw new AuthError("missing-code");
		await this.redeemCode(code, p.verifier);
	}

	/** Exchanges an authorization code for tokens (design §4 steps 4–5). */
	async redeemCode(code: string, verifier: string): Promise<void> {
		// A new grant supersedes any refresh still in flight for an older one.
		const epoch = ++this.epoch;
		this.refreshing = null;
		this.access = null;
		const clientId = this.requireClientId();
		const res = await this.postToken({
			client_id: clientId,
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_PROTOCOL,
			code_verifier: verifier,
			scope: SCOPE,
		});
		if (epoch !== this.epoch) throw new AuthError("signed-out");
		if (!isSuccess(res)) throw new AuthError("token-request-failed", parseTokenError(res.body));
		const tok = parseOrThrow(res.body, true);
		await this.storeRefreshToken(tok, epoch);
		this.prepared = null;
		this.signInRequired = false;
		this.cacheAccess(tok);
		this.notify();
	}

	/** Cached access token, or a single-flight refresh (R-AUTH-6). */
	getAccessToken(): Promise<string> {
		if (this.access && this.access.expiresAt - this.clock.now() > this.access.marginMs) {
			return Promise.resolve(this.access.token);
		}
		if (!this.refreshing) {
			const p: Promise<string> = this.refresh().finally(() => {
				if (this.refreshing === p) this.refreshing = null;
			});
			this.refreshing = p;
		}
		return this.refreshing;
	}

	/** Clears tokens and any pending sign-in. Sync state is cleared by the caller (design §4 sign-out). */
	async signOut(): Promise<void> {
		this.epoch++;
		this.pending = null;
		this.prepared = null;
		this.access = null;
		this.refreshing = null;
		this.signInRequired = false;
		try {
			await this.tokens.clear();
		} finally {
			this.notify();
		}
	}

	private async refresh(): Promise<string> {
		const epoch = this.epoch;
		if (this.signInRequired) throw new AuthError("sign-in-required");
		const rt = this.tokens.get();
		if (!rt) throw new AuthError("signed-out");
		const clientId = this.requireClientId();
		const res = await this.postToken({
			client_id: clientId,
			grant_type: "refresh_token",
			refresh_token: rt,
			scope: SCOPE,
		});
		if (epoch !== this.epoch) throw new AuthError("signed-out");
		if (!isSuccess(res)) {
			const code = parseTokenError(res.body);
			if (code === "invalid_grant" || code === "interaction_required") {
				// The grant is dead: forget it and ask the user to sign in again. Local state is kept.
				this.access = null;
				this.signInRequired = true;
				// If the clear fails, status still reads sign-in-required and the dead token is never sent again.
				await this.tokens.clear().catch(() => undefined);
				this.notify();
				throw new AuthError("sign-in-required", code);
			}
			throw new AuthError("token-request-failed", code);
		}
		const tok = parseOrThrow(res.body, false);
		// The rotated refresh token replaces the stored one before the access token is used [I-TL-3].
		await this.storeRefreshToken(tok, epoch);
		this.cacheAccess(tok);
		this.notify();
		return tok.accessToken;
	}

	private async storeRefreshToken(tok: TokenResponse, epoch: number): Promise<void> {
		if (tok.refreshToken === null) return;
		await this.tokens.set(tok.refreshToken);
		if (epoch !== this.epoch) {
			// Signed out while the write was in flight: undo it. If the undo fails, let status show the truth.
			try {
				await this.tokens.clear();
			} finally {
				this.notify();
			}
			throw new AuthError("signed-out");
		}
	}

	private cacheAccess(tok: TokenResponse): void {
		const lifetimeMs = tok.expiresInSec * 1000;
		this.access = {
			token: tok.accessToken,
			expiresAt: this.clock.now() + lifetimeMs,
			marginMs: Math.min(REFRESH_MARGIN_MS, lifetimeMs / 2),
		};
	}

	/** Form POST to the token endpoint. No Origin header and no Authorization [I-AC-5], [I-AC-3]. */
	private async postToken(form: Record<string, string>): Promise<HttpResponse> {
		const body = Object.entries(form)
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join("&");
		try {
			return await this.transport.send({
				url: TOKEN_URL,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body,
			});
		} catch {
			throw new AuthError("network");
		}
	}

	private requireClientId(): string {
		const id = this.getClientId();
		if (!isValidClientId(id)) throw new AuthError("no-client-id");
		return id;
	}

	/** A method, not the getter, so TypeScript doesn't carry a narrowing across an await. */
	private isSignedIn(): boolean {
		return this.status === "signed-in";
	}

	private notify(): void {
		const s = this.status;
		if (s === this.lastStatus) return;
		this.lastStatus = s;
		for (const cb of this.listeners) cb(s);
	}
}

function isSuccess(res: HttpResponse): boolean {
	return res.status >= 200 && res.status < 300;
}

function parseOrThrow(body: ArrayBuffer, requireRefreshToken: boolean): TokenResponse {
	try {
		return parseTokenResponse(body, requireRefreshToken);
	} catch (e) {
		if (e instanceof InvalidResponse) throw new AuthError("invalid-response");
		throw e;
	}
}
