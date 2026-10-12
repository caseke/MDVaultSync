// Refresh token storage: Obsidian SecretStorage, with a data.json fallback only if it fails (R-AUTH-5, D-5).
// SecretStorage and data access are injected so this runs under node --test.
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

export class PluginTokenStore implements TokenStore {
	private readonly secrets: SecretStorageLike;
	private readonly data: PluginDataAccess;
	private current: TokenStore["backend"];

	constructor(secrets: SecretStorageLike, data: PluginDataAccess) {
		this.secrets = secrets;
		this.data = data;
		this.current = data.get().fallbackRefreshToken ? "plugin-data" : "secret-storage";
	}

	get backend(): TokenStore["backend"] {
		return this.current;
	}

	get(): string | null {
		if (this.current === "plugin-data") return this.data.get().fallbackRefreshToken ?? null;
		try {
			return this.secrets.getSecret(SECRET_ID) || null;
		} catch {
			return null;
		}
	}

	/** Tries SecretStorage first on every write, so a fixed keyring moves the token off data.json. */
	async set(refreshToken: string): Promise<void> {
		const data = this.data.get();
		if (this.trySecret(refreshToken) && this.readSecret() === refreshToken) {
			this.current = "secret-storage";
			if (data.fallbackRefreshToken !== undefined) {
				delete data.fallbackRefreshToken;
				await this.data.save();
			}
			return;
		}
		// SecretStorage threw or didn't keep the value. Don't leave an older token behind in it.
		this.trySecret("");
		data.fallbackRefreshToken = refreshToken;
		this.current = "plugin-data";
		await this.data.save();
	}

	/** There is no delete method, so the secret is overwritten with "" [O-API-4]. */
	async clear(): Promise<void> {
		this.trySecret("");
		delete this.data.get().fallbackRefreshToken;
		this.current = "secret-storage";
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
