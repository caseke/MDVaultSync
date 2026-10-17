// Refresh token storage: Obsidian SecretStorage. If it fails, the token is kept in memory for this session only,
// never written to disk (R-AUTH-5, D-5, changed in M9). The non-secret `sessionOnlySignIn` flag in data.json
// records that, so the next launch can say why a sign-in is needed. SecretStorage and data access are injected so
// this runs under node --test.
import type { TokenStore } from "../core/ports.ts";
import type { PluginData } from "../settings.ts";

/** Lowercase alphanumeric plus dashes, or setSecret throws [O-API-4]. */
export const SECRET_ID = "mdvaultsync-refresh-token";

/** The subset of Obsidian's SecretStorage used here. Both methods are synchronous [O-API-4]. */
export interface SecretStorageLike {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

export interface PluginDataAccess {
	get(): PluginData;
	save(): Promise<void>;
}

/** The secret couldn't be overwritten, so a refresh token may remain in SecretStorage (R-AUTH-7). */
export class TokenClearError extends Error {
	constructor() {
		super("token-clear-failed");
		this.name = "TokenClearError";
	}
}

export class PluginTokenStore implements TokenStore {
	private readonly secrets: SecretStorageLike;
	private readonly data: PluginDataAccess;
	private current: TokenStore["backend"] = "secret-storage";
	/** The refresh token while `current` is "memory". Never persisted. */
	private memory: string | null = null;

	constructor(secrets: SecretStorageLike, data: PluginDataAccess) {
		this.secrets = secrets;
		this.data = data;
	}

	get backend(): TokenStore["backend"] {
		return this.current;
	}

	/** This session's sign-in, or the last one, could be kept in memory only (settings warning, launch notice). */
	get sessionOnly(): boolean {
		return this.current === "memory" || this.data.get().sessionOnlySignIn;
	}

	get(): string | null {
		if (this.current === "memory") return this.memory;
		try {
			return this.secrets.getSecret(SECRET_ID) || null;
		} catch {
			return null;
		}
	}

	/** Tries SecretStorage first on every write, so a keyring that starts working takes the token over. */
	async set(refreshToken: string): Promise<void> {
		if (this.trySecret(refreshToken) && this.readSecret() === refreshToken) {
			this.current = "secret-storage";
			this.memory = null;
			await this.setFlag(false);
			return;
		}
		// SecretStorage threw or didn't keep the value. Don't leave an older token behind in it.
		this.trySecret("");
		this.memory = refreshToken;
		this.current = "memory";
		await this.setFlag(true);
	}

	/**
	 * Migrates a plaintext token a 0.x version left in data.json: into SecretStorage if it works now, otherwise into
	 * memory for this session. A token already in SecretStorage wins. The caller then saves data.json without it.
	 */
	async adoptLegacy(refreshToken: string): Promise<void> {
		if (refreshToken === "" || this.readSecret()) return;
		await this.set(refreshToken);
	}

	/**
	 * There is no delete method, so the secret is overwritten with "" [O-API-4]. The in-memory token is dropped
	 * either way; if a token is still readable afterwards, this throws so sign-out never reports a false success.
	 */
	async clear(): Promise<void> {
		this.trySecret("");
		this.memory = null;
		this.current = "secret-storage";
		await this.setFlag(false);
		if (this.readSecret()) throw new TokenClearError();
	}

	/**
	 * R-AUTH-9. Obsidian has no uninstall hook [O-API-19]: uninstalling deletes the plugin folder but not
	 * SecretStorage, so a reinstall would find the old refresh token. `hasPluginData` is false only when the plugin
	 * folder holds neither data.json nor sync-state.json (leftover-install.ts); then the token is cleared. Returns
	 * true if one was.
	 */
	async clearOrphan(hasPluginData: boolean): Promise<boolean> {
		if (hasPluginData || !this.readSecret()) return false;
		await this.clear();
		return true;
	}

	private async setFlag(on: boolean): Promise<void> {
		const data = this.data.get();
		if (data.sessionOnlySignIn === on) return;
		data.sessionOnlySignIn = on;
		await this.data.save();
	}

	private trySecret(value: string): boolean {
		try {
			this.secrets.setSecret(SECRET_ID, value);
			return true;
		} catch {
			return false;
		}
	}

	private readSecret(): string | null {
		try {
			return this.secrets.getSecret(SECRET_ID);
		} catch {
			return null;
		}
	}
}
