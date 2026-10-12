import { normalizePath, Notice, Plugin, requestUrl } from "obsidian";
import type { ObsidianProtocolData } from "obsidian";
import { RingLogger } from "./core/logger.ts";
import type { Clock, StateStore } from "./core/ports.ts";
import { Diagnostics, platformName } from "./platform/diagnostics.ts";
import { PluginStateStore } from "./platform/plugin-state-store.ts";
import { probeRename } from "./platform/rename-probe.ts";
import { clearSession } from "./platform/sign-out.ts";
import { createRequestUrlTransport } from "./platform/request-url-transport.ts";
import { PluginTokenStore, TokenClearError } from "./platform/token-store.ts";
import { AuthClient, AuthError } from "./remote/auth.ts";
import type { DeltaForm } from "./remote/capabilities.ts";
import { GraphClient } from "./remote/graph.ts";
import { AuthorizingTransport } from "./remote/http.ts";
import { RetryPolicy } from "./remote/retry.ts";
import { isValidClientId, parseData, type PluginData } from "./settings.ts";
import { AUTH_ERROR_MESSAGES, authErrorText } from "./ui/auth-messages.ts";
import { DiagnosticsModal, FILE_REPLACE_TEXT } from "./ui/diagnostics-modal.ts";
import { MDVaultSyncSettingTab } from "./ui/settings-tab.ts";
import { SignInModal } from "./ui/sign-in-modal.ts";

/** Where a personal account removes an app's access [C-MSA-1]. */
const APP_ACCESS_URL = "https://account.microsoft.com/privacy/app-access";

export default class MDVaultSyncPlugin extends Plugin {
	data!: PluginData;
	tokenStore!: PluginTokenStore;
	auth!: AuthClient;
	logger!: RingLogger;
	graph!: GraphClient;
	private settingTab!: MDVaultSyncSettingTab;
	private signInModal: SignInModal | null = null;
	/** `sync-state.json` in the plugin folder (design §12). */
	stateStore!: StateStore;
	private pluginDir = "";

	override async onload(): Promise<void> {
		this.data = parseData(await this.loadData());
		const { configDir } = this.app.vault;
		this.pluginDir = normalizePath(this.manifest.dir ?? `${configDir}/plugins/${this.manifest.id}`);
		this.stateStore = new PluginStateStore({
			adapter: this.app.vault.adapter,
			dir: this.pluginDir,
			configDir,
			newDeviceId: () => crypto.randomUUID(),
		});
		this.tokenStore = new PluginTokenStore(this.app.secretStorage, {
			get: () => this.data,
			save: () => this.saveData(this.data),
		});
		const transport = createRequestUrlTransport((p) => requestUrl(p));
		const clock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)) };
		this.auth = new AuthClient({
			transport,
			tokens: this.tokenStore,
			clock,
			getClientId: () => this.data.clientId,
		});
		this.logger = new RingLogger({ now: () => Date.now() });
		// Graph stack: requestUrl → Authorization for graph.microsoft.com only (401 → refresh once) → retry (design §6.1).
		const graphTransport = new AuthorizingTransport(transport, this.auth);
		const retry = new RetryPolicy({ clock, logger: this.logger });
		// Transfer URLs use the bare transport: no auth decorator, so they can never carry the token (T-I4).
		const graphFor = (deltaForm?: DeltaForm) =>
			new GraphClient({
				transport: graphTransport,
				transferTransport: transport,
				retry,
				clock,
				logger: this.logger,
				...(deltaForm ? { deltaForm } : {}),
			});
		this.graph = graphFor();
		const diagnostics = new Diagnostics(
			this.app,
			() => ({ graph: this.graph, graphFor, clock, pluginVersion: this.manifest.version }),
			() => this.auth.status === "signed-in",
			() => retry.resetBudget(),
		);

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
			void this.completeSignIn(() => this.auth.handleCallback(params));
		};
		this.registerObsidianProtocolHandler("mdvaultsync-auth", onCallback);
		this.registerObsidianProtocolHandler("mdvaultsync-auth/", onCallback);

		this.addCommand({
			id: "sign-in",
			name: "Sign in to OneDrive",
			callback: () => void this.startSignIn(),
		});
		this.addCommand({
			id: "sign-out",
			name: "Sign out of OneDrive",
			callback: () => void this.signOut(),
		});
		this.addCommand({
			id: "run-diagnostics",
			name: "Run OneDrive capability probe",
			callback: () => void diagnostics.run(),
		});
		// M6 manual check [O-API-10]: does adapter.rename replace an existing file on this device?
		this.addCommand({
			id: "test-file-replace",
			name: "Test file replace on this device",
			callback: () => void this.testFileReplace(),
		});
	}

	override onunload(): void {
		// Handlers, commands and listeners are released through register* above. A live sign-in link would
		// outlive its callback handler, so close it.
		this.closeSignInModal();
	}

	/**
	 * The sign-in command's path. A command can't hold a link built ahead of time (the settings tab's one-tap
	 * Sign in does), so it shows the authorize URL as a link in SignInModal; tapping it opens the system browser
	 * [I-BR-1]. No window.open: iOS blocks it after the await.
	 */
	async startSignIn(): Promise<void> {
		if (!isValidClientId(this.data.clientId)) {
			new Notice(AUTH_ERROR_MESSAGES["no-client-id"]);
			return;
		}
		try {
			const url = await this.auth.buildAuthorizeUrl();
			this.closeSignInModal();
			this.signInModal = new SignInModal(this.app, url);
			this.signInModal.open();
		} catch (e) {
			this.reportAuthError(e);
		}
	}

	/** Writes, renames and removes two files in the plugin folder and shows what adapter.rename did. */
	private async testFileReplace(): Promise<void> {
		const modal = new DiagnosticsModal(this.app, FILE_REPLACE_TEXT);
		modal.open();
		const result = await probeRename(this.app.vault.adapter, this.pluginDir);
		modal.showResult(JSON.stringify({ ...result, platform: platformName(), pluginVersion: this.manifest.version }, null, 2));
	}

	/** Clears tokens and sync state; local files stay (R-AUTH-7). */
	async signOut(): Promise<void> {
		// M7 passes the sync engine here, so a running sync can't save state after the clear.
		const { tokenCleared, stateCleared } = await clearSession({ engine: null, signOut: () => this.auth.signOut(), store: this.stateStore });
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
			this.closeSignInModal();
			new Notice("Signed in to OneDrive.");
		} catch (e) {
			// A forged or stale link (no-pending, state-mismatch) must not close the user's real sign-in link (T-S1).
			const forged = e instanceof AuthError && (e.code === "no-pending" || e.code === "state-mismatch");
			if (!forged) this.closeSignInModal();
			this.reportAuthError(e);
		}
		this.settingTab.refresh();
	}

	private closeSignInModal(): void {
		this.signInModal?.close();
		this.signInModal = null;
	}

	/** Shows a notice and logs the code only, never URLs, params or token data (T-I3). */
	reportAuthError(e: unknown): void {
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
