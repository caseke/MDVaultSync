import { getIcon, normalizePath, Notice, Platform, Plugin, requestUrl, setIcon, setTooltip, TFile, TFolder } from "obsidian";
import type { App, EventRef, ObsidianProtocolData, TAbstractFile } from "obsidian";
import { Engine } from "./core/engine.ts";
import { RingLogger } from "./core/logger.ts";
import type { Clock, EngineStatus, StateStore, SyncReport, Trigger } from "./core/ports.ts";
import { TransformedRemoteContent } from "./core/remote-content.ts";
import { IdentityTransform } from "./core/transform.ts";
import { Diagnostics, platformName } from "./platform/diagnostics.ts";
import { ObsidianVault, type FileManagerLike, type VaultLike } from "./platform/obsidian-vault.ts";
import { registerVaultEvents, type VaultEventEmitter } from "./platform/vault-events.ts";
import { PluginStateStore } from "./platform/plugin-state-store.ts";
import { probeRename } from "./platform/rename-probe.ts";
import { clearSession } from "./platform/sign-out.ts";
import { isLeftoverInstall } from "./platform/leftover-install.ts";
import { createRequestUrlTransport } from "./platform/request-url-transport.ts";
import { PluginTokenStore, TokenClearError } from "./platform/token-store.ts";
import { AuthClient, AuthError } from "./remote/auth.ts";
import { PUT_HONORS_IF_MATCH, type DeltaForm } from "./remote/capabilities.ts";
import { classifyError } from "./remote/classify.ts";
import { GraphClient } from "./remote/graph.ts";
import { AuthorizingTransport } from "./remote/http.ts";
import { RetryPolicy } from "./remote/retry.ts";
import { TimeoutTransport } from "./remote/timeout.ts";
import { defaultDeviceName, isValidClientId, pauseFromData, parseData, snapshotForSave, toEngineSettings, type PluginData } from "./settings.ts";
import { AUTH_ERROR_MESSAGES, authErrorText } from "./ui/auth-messages.ts";
import { ConfirmDeletesModal } from "./ui/confirm-deletes-modal.ts";
import { DiagnosticsModal, FILE_REPLACE_TEXT } from "./ui/diagnostics-modal.ts";
import { noticesFor, type NoticeSpec } from "./ui/notices.ts";
import { PlanPreviewModal } from "./ui/plan-preview-modal.ts";
import { QuotaCache } from "./ui/quota.ts";
import type { PromptModal } from "./ui/prompt-modal.ts";
import { ReportModal } from "./ui/report-modal.ts";
import { MDVaultSyncSettingTab } from "./ui/settings-tab.ts";
import { SignInModal } from "./ui/sign-in-modal.ts";
import { DEFAULT_ICON, statusIcon, statusText } from "./ui/status.ts";
import { PATTERNS_TEXT, STUCK_TEXT, triggerDecision } from "./ui/triggers.ts";

/**
 * ObsidianVault's structural view of app.vault and app.fileManager. It only ever hands back the TFile and TFolder
 * objects these APIs gave it, so the instanceof checks narrow without a cast.
 */
function vaultPorts(app: App): { vault: VaultLike; fileManager: FileManagerLike } {
	const v = app.vault;
	const abstract = (f: unknown): TAbstractFile => {
		if (f instanceof TFile || f instanceof TFolder) return f;
		throw new TypeError("not-a-vault-file");
	};
	return {
		vault: {
			get configDir() {
				return v.configDir;
			},
			adapter: v.adapter,
			getFiles: () => v.getFiles(),
			getAllFolders: (includeRoot) => v.getAllFolders(includeRoot),
			getAbstractFileByPath: (p) => v.getAbstractFileByPath(p),
			readBinary: (f) => {
				if (!(f instanceof TFile)) return Promise.reject(new TypeError("not-a-file"));
				return v.readBinary(f);
			},
			createFolder: (p) => v.createFolder(p),
			rename: (f, to) => v.rename(abstract(f), to),
		},
		fileManager: { trashFile: (f) => app.fileManager.trashFile(abstract(f)) },
	};
}

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
	engine!: Engine;
	/** OneDrive storage for the settings tab (T-D7): one read per 5 minutes at most. */
	quota!: QuotaCache;
	/** Every request goes through it; its `stuck` count pauses unattended runs (ui/triggers.ts). */
	private timeouts!: TimeoutTransport;
	/** The stuck-requests notice showed during the current pause (reset once a trigger runs again). */
	private stuckNoticeShown = false;
	/** The latest sync report (design §5.6), for the settings tab, the report modal and repeat-notice checks. */
	lastReport: SyncReport | null = null;
	/** Device name used when the setting is empty: "iPad" or "Ubuntu" on the owner's devices (design §11). */
	defaultDeviceName = "Device";
	private pluginDir = "";
	private diagnostics!: Diagnostics;
	private statusBarEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private timerId: number | null = null;
	private layoutReady = false;
	private readonly prompts = new Set<PromptModal>();
	/** data.json held unusable exclude patterns: sync is paused until they're saved again (T-I6, fail closed). */
	patternsInvalid = false;
	/** The unreadable excludePatterns value from data.json, written back by every save while paused. */
	private pausedPatterns: unknown = undefined;
	/** The readable lines of the unusable value, to pre-fill the settings field. */
	pausedReadable: string[] = [];
	private pauseNotice: Notice | null = null;
	/** Set in onunload: no prompt opens after it. */
	private disposed = false;
	/** Every data.json write goes through one queue and snapshots `data` when it runs (M7 review). */
	private saveChain: Promise<void> = Promise.resolve();

	override async onload(): Promise<void> {
		const raw: unknown = await this.loadData();
		this.data = parseData(raw);
		this.defaultDeviceName = defaultDeviceName(platformName());
		const { configDir } = this.app.vault;
		this.pluginDir = normalizePath(this.manifest.dir ?? `${configDir}/plugins/${this.manifest.id}`);
		// Unknown exclude patterns pause sync (T-I6). Checked on disk, like R-AUTH-9: a corrupt data.json loads as null.
		const pause = pauseFromData(raw, await this.app.vault.adapter.exists(`${this.pluginDir}/data.json`));
		if (pause.paused) {
			this.patternsInvalid = true;
			this.pausedPatterns = pause.raw;
			this.pausedReadable = pause.readable;
		}
		this.stateStore = new PluginStateStore({
			adapter: this.app.vault.adapter,
			dir: this.pluginDir,
			configDir,
			newDeviceId: () => crypto.randomUUID(),
		});
		this.tokenStore = new PluginTokenStore(this.app.secretStorage, {
			get: () => this.data,
			save: () => this.persist(),
		});
		// Before AuthClient reads the token: a sign-in left by an uninstalled copy is removed (R-AUTH-9).
		await this.clearLeftoverSignIn(!(await isLeftoverInstall(this.app.vault.adapter, this.pluginDir)));
		// requestUrl has no timeout: every request, the token endpoint's included, races a timer (design §6.1).
		const transport = (this.timeouts = new TimeoutTransport(createRequestUrlTransport((p) => requestUrl(p)), (ms, fn) => {
			const id = window.setTimeout(fn, ms);
			return () => window.clearTimeout(id);
		}));
		const clock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)) };
		// Before AuthClient, which logs refresh breadcrumbs. "Verbose logging" mirrors events to the console (design §9).
		this.logger = new RingLogger({ now: () => Date.now(), debug: () => this.data.verboseLogging });
		this.auth = new AuthClient({
			transport,
			tokens: this.tokenStore,
			clock,
			getClientId: () => this.data.clientId,
			logger: this.logger,
		});
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
		// Quota reads send once (no backoff, no Retry-After wait, no pause, no budget): a settings render never stalls
		// or throttles a sync (M8 review). A failure is reused for a minute by QuotaCache.
		const quotaGraph = new GraphClient({
			transport: graphTransport,
			transferTransport: transport,
			retry: new RetryPolicy({ clock, logger: this.logger, singleAttempt: true }),
			clock,
			logger: this.logger,
		});
		this.quota = new QuotaCache(() => quotaGraph.quota(), () => Date.now());

		// The sync engine (design §1): every byte passes the transform seam (R-ENG-4); v1 is the identity transform.
		const transform = new IdentityTransform();
		const vault = new ObsidianVault({
			...vaultPorts(this.app),
			normalizePath,
			excludePatterns: () => this.data.excludePatterns,
			// Before the first preflight no write can happen; 0 keeps the re-check as strict as the name rules alone.
			pathPrefixLen: () => this.engine.pathPrefixLen ?? 0,
		});
		this.engine = new Engine({
			remote: this.graph,
			content: new TransformedRemoteContent(this.graph, transform, { putHonorsIfMatch: PUT_HONORS_IF_MATCH, classify: classifyError }),
			vault,
			store: this.stateStore,
			hooks: {
				confirmPlan: (plan) => this.ask(new PlanPreviewModal(this.app, plan)),
				confirmDeletes: (ops) => this.ask(new ConfirmDeletesModal(this.app, ops, this.data.massDeleteThresholdPct)),
				onStatus: () => this.updateStatus(),
				onReport: (r) => this.onReport(r),
			},
			clock,
			classify: classifyError,
			configDir,
			transformId: transform.id,
			ensureSignedIn: async () => {
				await this.auth.getAccessToken();
			},
			resetBudget: () => retry.resetBudget(),
			settings: () => toEngineSettings(this.data, this.defaultDeviceName),
			newDeviceId: () => crypto.randomUUID(),
			logger: this.logger,
		});

		this.diagnostics = new Diagnostics(
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
				this.updateStatus();
			}),
		);

		// Triggers (R-TRIG-3): the ribbon button and "Sync now" run the same action. The ribbon icon shows the state
		// everywhere; the iPad has no status bar [O-API-13] and no hover for the tooltip [O-API-20] (R-UI-2).
		this.ribbonEl = this.addRibbonIcon("refresh-cw", "Sync now", () => void this.sync("ribbon"));
		if (!Platform.isMobile) {
			this.statusBarEl = this.addStatusBarItem();
			this.statusBarEl.addClass("mod-clickable");
			this.statusBarEl.addEventListener("click", () => this.showStatus());
		}
		this.updateStatus();
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.sync("command"),
		});
		// The iPad has no status bar and no hover (R-UI-2 as amended in M7): state and last sync time on demand.
		this.addCommand({
			id: "show-status",
			name: "Show sync status",
			callback: () => this.showStatus(),
		});
		this.addCommand({
			id: "sync-preview",
			name: "Preview sync",
			callback: () => void this.sync("preview"),
		});
		this.app.workspace.onLayoutReady(() => void this.onLayoutReady());

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
			callback: () => void this.runDiagnostics(),
		});
		// M6 manual check [O-API-10]: does adapter.rename replace an existing file on this device?
		this.addCommand({
			id: "test-file-replace",
			name: "Test file replace on this device",
			callback: () => void this.testFileReplace(),
		});
	}

	override onunload(): void {
		// Handlers, commands, events and timers are released through register* above. A live sign-in link would
		// outlive its callback handler, so close it. Open prompts answer "no", and a running sync starts no new op.
		this.disposed = true;
		this.closeSignInModal();
		for (const m of [...this.prompts]) m.close();
		// Undefined only if onload failed before constructing it.
		(this.engine as Engine | undefined)?.reset();
	}

	/**
	 * After the workspace is ready (R-TRIG-1, R-CD-2): vault events, the startup sync 5 s later, and the timer.
	 * Vault events registered earlier would report every file as created while Obsidian indexes the vault [O-API-12].
	 */
	private async onLayoutReady(): Promise<void> {
		this.layoutReady = true;
		const vault = this.app.vault;
		const emitter: VaultEventEmitter = {
			on: (name, cb) => {
				if (name === "rename") return vault.on("rename", (f: TAbstractFile, oldPath: string) => cb(f, oldPath));
				if (name === "create") return vault.on("create", (f: TAbstractFile) => cb(f));
				if (name === "modify") return vault.on("modify", (f: TAbstractFile) => cb(f));
				return vault.on("delete", (f: TAbstractFile) => cb(f));
			},
		};
		registerVaultEvents(emitter, (ref) => this.registerEvent(ref as EventRef), {
			configDir: vault.configDir,
			patterns: () => this.data.excludePatterns,
			sink: (op) => this.engine.noteLocalChange(op),
		});
		if (this.patternsInvalid) this.pauseNotice = new Notice(PATTERNS_TEXT, 0);
		const startup = window.setTimeout(() => void this.sync("startup"), 5000);
		this.register(() => window.clearTimeout(startup));
		this.restartTimer();
		// The saved report, for the status line and settings before this session's first run. Read-only.
		try {
			const saved = await this.stateStore.load();
			if (this.lastReport === null) this.lastReport = saved?.lastReport ?? null;
		} catch (e) {
			console.error(`MDVaultSync: could not read the last sync report (${e instanceof Error ? e.name : "unknown"})`);
		}
		this.updateStatus();
		this.settingTab.refreshReport();
	}

	/** The interval timer (R-TRIG-2): restarted when the setting changes; 0 turns it off. */
	restartTimer(): void {
		if (this.timerId !== null) window.clearInterval(this.timerId);
		this.timerId = null;
		if (!this.layoutReady || this.data.intervalMinutes === 0) return;
		this.timerId = this.registerInterval(window.setInterval(() => void this.sync("interval"), this.data.intervalMinutes * 60_000));
	}

	/** Every trigger comes here; the engine's single-flight lock keeps runs sequential (R-TRIG-4). */
	async sync(trigger: Trigger): Promise<void> {
		const d = triggerDecision(trigger, this.auth.status, isValidClientId(this.data.clientId), !this.patternsInvalid, this.timeouts.stuck);
		if (d.action === "skip") {
			if (d.reason === "stuck" && !this.stuckNoticeShown) {
				this.stuckNoticeShown = true;
				new Notice(STUCK_TEXT, 0);
			}
			return;
		}
		if (d.action === "run") this.stuckNoticeShown = false;
		if (d.action === "notice") {
			new Notice(d.text);
			return;
		}
		try {
			await this.engine.requestSync(trigger);
		} catch (e) {
			// The engine reports failures in the report; this is a bug guard. Name only (T-I3).
			console.error(`MDVaultSync: sync failed unexpectedly (${e instanceof Error ? e.name : "unknown"})`);
			new Notice("Sync failed unexpectedly.");
		}
	}

	async runDiagnostics(): Promise<void> {
		await this.diagnostics.run();
	}

	/** Shows a prompt the engine waits on; the engine applies its own 10-minute timeout too (design §5.4). */
	private ask(modal: PromptModal): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		this.prompts.add(modal);
		void modal.answer.finally(() => this.prompts.delete(modal));
		modal.open();
		return modal.answer;
	}

	/**
	 * Applies `patch` and writes data.json. Writes are serialized, and each one snapshots `data` when it runs, so
	 * an older snapshot can never land after a newer one; for example, a settings save can't put back a fallback
	 * token that sign-out just removed (R-AUTH-7). Memory is updated only after the write, so a client ID is on
	 * disk before it can be used (R-AUTH-9).
	 */
	persist(patch: Partial<PluginData> = {}): Promise<void> {
		const run = this.saveChain
			.catch(() => undefined)
			.then(async () => {
				await this.saveData(snapshotForSave(this.data, patch, this.patternsInvalid ? this.pausedPatterns : undefined));
				Object.assign(this.data, patch);
				// Saving patterns is the user's explicit fix: sync resumes (T-I6).
				if (patch.excludePatterns !== undefined) {
					this.patternsInvalid = false;
					this.pausedPatterns = undefined;
					this.pausedReadable = [];
					this.pauseNotice?.hide();
					this.pauseNotice = null;
				}
			});
		this.saveChain = run;
		return run;
	}

	/** After every run (reruns included): notices for conflicts and errors only (R-UI-3, R-CONF-2). */
	private onReport(report: SyncReport): void {
		const previous = this.lastReport;
		this.lastReport = report;
		// A full drive: the storage line in settings reads again rather than showing a stale figure.
		if (report.errors.some((e) => e.code === "quota")) this.quota.invalidate();
		for (const n of noticesFor(report, previous)) this.showNotice(n);
		this.settingTab.refreshReport();
	}

	private showNotice(n: NoticeSpec): void {
		const msg = createFragment((f) => {
			f.appendText(n.message);
			if (n.lines.length > 0) {
				const ul = f.createEl("ul", { cls: "mdvaultsync-list" });
				for (const line of n.lines) ul.createEl("li", { text: line });
			}
		});
		new Notice(msg, n.persistent ? 0 : 10_000);
	}

	private currentStatus(): { status: EngineStatus; text: string } {
		const status: EngineStatus = this.auth.status === "sign-in-required" ? { state: "sign-in-required" } : this.engine.status;
		const last = this.lastReport;
		const text = statusText(status, {
			now: Date.now(),
			lastSyncAt: last && (last.result === "ok" || last.result === "partial") ? last.finishedAt : null,
			signedIn: this.auth.status === "signed-in",
		});
		return { status, text };
	}

	/** Status bar (desktop), ribbon icon (every platform) and ribbon tooltip (desktop hover) (R-UI-2, design §5.6). */
	private updateStatus(): void {
		const { status, text } = this.currentStatus();
		this.statusBarEl?.setText(`MDVaultSync: ${text}`);
		if (this.ribbonEl) {
			// The first candidate this Obsidian build has; a missing name would leave the button blank.
			const icon = statusIcon(status, this.auth.status === "signed-in").find((n) => getIcon(n) !== null) ?? DEFAULT_ICON;
			setIcon(this.ribbonEl, icon);
			setTooltip(this.ribbonEl, `Sync now. ${text}`);
		}
	}

	/** The "Show sync status" command and the status-bar click: state, last sync time and the last report. */
	private showStatus(): void {
		new ReportModal(this.app, this.lastReport, this.currentStatus().text).open();
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

	/**
	 * Obsidian has no uninstall hook [O-API-19], and uninstalling leaves SecretStorage alone. A refresh token in an
	 * empty plugin folder is therefore left over from a removed copy: clear it, and say where to revoke the grant
	 * itself, which a public client can't do [I-TL-4] (R-AUTH-9).
	 */
	private async clearLeftoverSignIn(hasPluginData: boolean): Promise<void> {
		try {
			if (!(await this.tokenStore.clearOrphan(hasPluginData))) return;
		} catch (e) {
			console.error(`MDVaultSync: could not clear a leftover sign-in (${e instanceof Error ? e.name : "unknown"})`);
			const failed = createFragment((f) => {
				f.appendText("A OneDrive sign-in from an earlier install of this plugin couldn't be removed. Sign out in the plugin settings, or remove this app's access at ");
				f.createEl("a", { text: APP_ACCESS_URL, href: APP_ACCESS_URL });
				f.appendText(".");
			});
			new Notice(failed, 0);
			return;
		}
		const msg = createFragment((f) => {
			f.appendText("Removed a OneDrive sign-in left over from an earlier install of this plugin. To also remove this app's access to your account, visit ");
			f.createEl("a", { text: APP_ACCESS_URL, href: APP_ACCESS_URL });
			f.appendText(".");
		});
		new Notice(msg, 0);
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
		// An open preview or delete prompt belongs to a run that can no longer act.
		for (const m of [...this.prompts]) m.close();
		// The engine is reset first, so a running sync can't save state after the clear.
		const { tokenCleared, stateCleared } = await clearSession({ engine: this.engine, signOut: () => this.auth.signOut(), store: this.stateStore });
		this.lastReport = null;
		// The next sign-in may be another account.
		this.quota.invalidate();
		this.settingTab.refresh();
		this.updateStatus();
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
