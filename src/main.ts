import { Notice, Plugin, requestUrl } from "obsidian";
import type { ObsidianProtocolData } from "obsidian";
import type { StateStore } from "./core/ports.ts";
import { createRequestUrlTransport } from "./platform/request-url-transport.ts";
import { PluginTokenStore, TokenClearError } from "./platform/token-store.ts";
import { AuthClient, AuthError, REDIRECT_PROTOCOL, type Redirect } from "./remote/auth.ts";
import { isValidClientId, parseData, type PluginData } from "./settings.ts";
import { AUTH_ERROR_MESSAGES, authErrorText } from "./ui/auth-messages.ts";
import { MDVaultSyncSettingTab } from "./ui/settings-tab.ts";

/** Where a personal account removes an app's access [C-MSA-1]. */
const APP_ACCESS_URL = "https://account.microsoft.com/privacy/app-access";

export default class MDVaultSyncPlugin extends Plugin {
	data!: PluginData;
	tokenStore!: PluginTokenStore;
	auth!: AuthClient;
	private settingTab!: MDVaultSyncSettingTab;
	// M2 stub: sign-out clears sync state through this. M6 replaces it with the sync-state.json store.
	private readonly stateStore: StateStore = {
		load: () => Promise.resolve(null),
		save: () => Promise.resolve(),
		clear: () => Promise.resolve(),
	};

	override async onload(): Promise<void> {
		this.data = parseData(await this.loadData());
		this.tokenStore = new PluginTokenStore(this.app.secretStorage, {
			get: () => this.data,
			save: () => this.saveData(this.data),
		});
		const transport = createRequestUrlTransport((p) => requestUrl(p));
		this.auth = new AuthClient({
			transport,
			tokens: this.tokenStore,
			clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)) },
			getClientId: () => this.data.clientId,
		});

		this.settingTab = new MDVaultSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.register(
			this.auth.onStatusChange((s) => {
				if (s === "sign-in-required") new Notice(AUTH_ERROR_MESSAGES["sign-in-required"], 0);
				this.settingTab.refresh();
			}),
		);

		// The redirect may come back with a trailing slash [I-RU-3].
		const onCallback = (params: ObsidianProtocolData) => {
			void this.completeSignIn(() => this.auth.handleCallback(params, "protocol"));
		};
		this.registerObsidianProtocolHandler("mdvaultsync-auth", onCallback);
		this.registerObsidianProtocolHandler("mdvaultsync-auth/", onCallback);

		this.addCommand({
			id: "sign-in",
			name: "Sign in to OneDrive",
			callback: () => void this.startSignIn(REDIRECT_PROTOCOL),
		});
		this.addCommand({
			id: "sign-out",
			name: "Sign out of OneDrive",
			callback: () => void this.signOut(),
		});
	}

	override onunload(): void {
		// Handlers, commands and listeners are released through register* above.
	}

	/** Opens the authorize URL in the system browser [I-BR-1]. Returns false if it couldn't start. */
	async startSignIn(redirect: Redirect): Promise<boolean> {
		if (!isValidClientId(this.data.clientId)) {
			new Notice(AUTH_ERROR_MESSAGES["no-client-id"]);
			return false;
		}
		try {
			const url = await this.auth.buildAuthorizeUrl(redirect);
			window.open(url);
			return true;
		} catch (e) {
			this.reportAuthError(e);
			return false;
		}
	}

	async finishPastedSignIn(pasted: string): Promise<void> {
		await this.completeSignIn(() => this.auth.handleCallback(this.auth.parsePastedUrl(pasted), "paste"));
	}

	/** Clears tokens and sync state; local files stay (R-AUTH-7). */
	async signOut(): Promise<void> {
		let tokenCleared = true;
		let stateCleared = true;
		try {
			await this.auth.signOut();
		} catch (e) {
			tokenCleared = false;
			console.error(`MDVaultSync: sign-out could not clear the token (${e instanceof Error ? e.name : "unknown"})`);
		}
		try {
			// Sync state is cleared even if the token wasn't: a later sync then runs in union mode, which never deletes.
			await this.stateStore.clear();
		} catch (e) {
			stateCleared = false;
			console.error(`MDVaultSync: sign-out could not clear sync state (${e instanceof Error ? e.name : "unknown"})`);
		}
		this.settingTab.refresh();
		if (!tokenCleared) {
			new Notice(
				"Sign-out is incomplete: the stored sign-in couldn't be removed. Try again, or remove this app's access at " +
					`${APP_ACCESS_URL}.`,
				0,
			);
			return;
		}
		if (!stateCleared) {
			new Notice("Signed out, but the sync state couldn't be cleared. Sign out again before you sign in.", 0);
			return;
		}
		const msg = createFragment((f) => {
			f.appendText("Signed out of OneDrive. Local files are untouched. To remove this app's access to your account, visit ");
			f.createEl("a", { text: APP_ACCESS_URL, href: APP_ACCESS_URL });
			f.appendText(".");
		});
		new Notice(msg, 15_000);
	}

	private async completeSignIn(run: () => Promise<void>): Promise<void> {
		try {
			await run();
			new Notice("Signed in to OneDrive.");
		} catch (e) {
			this.reportAuthError(e);
		}
		this.settingTab.refresh();
	}

	/** Shows a notice and logs the code only, never URLs, params or token data (T-I3). */
	private reportAuthError(e: unknown): void {
		if (e instanceof AuthError) {
			console.error(`MDVaultSync: sign-in error ${e.code}${e.providerCode ? ` (${e.providerCode})` : ""}`);
			new Notice(authErrorText(e.code, e.providerCode));
			return;
		}
		if (e instanceof TokenClearError) {
			console.error("MDVaultSync: sign-in error token-clear-failed");
			new Notice("You signed out during sign-in, but the new sign-in couldn't be removed. Sign out again.", 0);
			return;
		}
		console.error(`MDVaultSync: unexpected sign-in error ${e instanceof Error ? e.name : "unknown"}`);
		new Notice("Sign-in failed unexpectedly.");
	}
}
