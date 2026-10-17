// Settings tab (R-UI-1, design §10): Account, Sync, Last sync report, Diagnostics.
//
// One list of sections and rows feeds both rendering paths. Obsidian 1.13+ renders getSettingDefinitions()
// itself (and indexes it for settings search); older versions (minAppVersion is 1.11.4) call display(), which
// renders the same rows through SettingGroup (since 1.11.0). Every row is a `render` definition, because the
// sign-in link and the validated inputs need imperative control.
import { PluginSettingTab, requireApiVersion, SettingGroup } from "obsidian";
import type { App, Setting, SettingDefinitionItem } from "obsidian";
import type MDVaultSyncPlugin from "../main.ts";
import { AuthError, type AuthStatus } from "../remote/auth.ts";
import {
	isValidClientId,
	parseDeviceName,
	parseExcludePatterns,
	parseInterval,
	parseMaxFileSize,
	parseThreshold,
	type PluginData,
} from "../settings.ts";
import { accountRowVisible, isQuietPrepareError, type AccountRow } from "./account-rows.ts";
import { quotaText } from "./quota.ts";
import { RecentCounter } from "./recent-counter.ts";
import { refreshAction } from "./settings-refresh.ts";
import { LogModal } from "./log-modal.ts";
import { renderReport } from "./report-view.ts";

/** The Token storage row when Obsidian's secret storage didn't keep the sign-in (D-5). */
const TOKEN_WARNING_TEXT: Record<"memory" | "memory-stale" | "older-secret", string> = {
	memory:
		"Obsidian secret storage isn't working on this device, so your sign-in is kept in memory only, never on disk. " +
		"You'll need to sign in again each time Obsidian starts.",
	"memory-stale":
		"Obsidian secret storage isn't working on this device, so your sign-in is kept in memory only, never on disk. " +
		"An older sign-in is still in secret storage and couldn't be replaced; Sign out removes it once secret storage works, or remove this app's access at your Microsoft account.",
	"older-secret":
		"Signed in with an older sign-in found in Obsidian secret storage: last session's sign-in couldn't replace it. " +
		"If sync reports a sign-in problem, sign out and sign in again.",
};

const STATUS_TEXT: Record<AuthStatus, string> = {
	"signed-out": "Signed out.",
	"signed-in": "Signed in to OneDrive.",
	"sign-in-required": "Sign-in required: access expired or was revoked.",
};

interface Row {
	name: string;
	desc?: string;
	/**
	 * Evaluated at render time (Obsidian 1.13+ evaluates `visible` on every render; the fallback renderer when it
	 * builds). Obsidian reuses the definitions built at load, so nothing that depends on state may be decided
	 * when the rows are listed (M8 matrix row 10).
	 */
	visible?: () => boolean;
	/** May return a cleanup, run before the row is torn down (1.13+). */
	render(setting: Setting): void | (() => void);
}

interface Section {
	/** Breadcrumb prefix (a fixed code). */
	id: string;
	heading: string;
	rows: Row[];
}

function setDescError(setting: Setting, text: string): void {
	setting.descEl.empty();
	setting.descEl.createSpan({ cls: "mdvaultsync-warning", text });
}

export class MDVaultSyncSettingTab extends PluginSettingTab {
	private readonly plugin: MDVaultSyncPlugin;
	private shown = false;
	/** Bumped on every sign-in control render, so a slow prepare can't fill in an outdated link. */
	private renderId = 0;
	/** The Sign in row, so a client ID change can rebuild just its control. */
	private signInSetting: Setting | null = null;
	/** The rendered report, refreshed alone after each sync so typing in another field keeps its focus. */
	private reportEl: HTMLElement | null = null;
	private readonly refreshes = new RecentCounter(1_000);

	constructor(app: App, plugin: MDVaultSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Re-render after auth or sync changes: update() on 1.13+, the fallback renderer before. */
	refresh(): void {
		this.crumb("refresh", this.refreshes.hit(Date.now()));
		// 1.13+: always rebuild the definitions Obsidian caches, even while the tab is closed. It reuses them when
		// the tab opens (it doesn't call getSettingDefinitions() again; observed on 1.14.4, M8 matrix row 10) [O-API-21].
		// update() on a closed tab should only store them ("Stores the result…", obsidian.d.ts); that is observed
		// only before the first display, so a prepare that lands on a detached link discards itself (below).
		if (requireApiVersion("1.13.0")) {
			// A settings failure must never break the auth flow that called us (notify() has no try/catch).
			try {
				this.update();
			} catch (e) {
				console.error(`MDVaultSync: settings refresh failed (${e instanceof Error ? e.name : "unknown"})`);
			}
			return;
		}
		// The fallback renderer draws at once, which prepares a sign-in that only hide() discards (R-SEC-1): only
		// while the tab is on screen.
		const connected = this.containerEl.isConnected;
		if (refreshAction({ onScreen: this.shown, connected }) === "skip") {
			this.crumb(connected ? "refresh-skipped-hidden" : "refresh-skipped-detached");
			return;
		}
		this.renderFallback();
	}

	/** After a sync: re-render only the report, if it is on screen. */
	refreshReport(): void {
		if (this.reportEl?.isConnected) renderReport(this.reportEl, this.plugin.lastReport, Date.now());
	}

	/**
	 * Breadcrumbs (M8 matrix row 10: the tab froze in the sign-in-required state with nothing in the console).
	 * Fixed codes only; with Verbose logging on, the last console line names the step that didn't return.
	 */
	private crumb(code: string, count?: number): void {
		// Only with Verbose logging on: a busy tab must not push the sync lines out of the 500-entry log.
		if (!this.plugin.data.verboseLogging) return;
		this.plugin.logger.event("ui.settings", count === undefined ? { code } : { code, count });
	}

	/** Wraps a row's render with start and end breadcrumbs, `<section>-<index>`. */
	private tracked(section: string, i: number, r: Row): (setting: Setting) => void | (() => void) {
		return (setting) => {
			// A row renders only while the tab is on screen; hide() clears this again.
			this.shown = true;
			this.crumb(`${section}-${i}`);
			const cleanup = r.render(setting);
			this.crumb(`${section}-${i}-done`);
			return cleanup;
		};
	}

	override hide(): void {
		this.crumb("hide");
		this.shown = false;
		this.signInSetting = null;
		// Invalidate in-flight prepares and drop the untapped link's verifier and state.
		this.renderId++;
		this.plugin.auth.discardPrepared();
		super.hide();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		this.crumb("defs");
		const defs: SettingDefinitionItem[] = this.sections().map((s) => ({
			type: "group",
			heading: s.heading,
			items: s.rows.map((r, i) => ({
				name: r.name,
				...(r.desc !== undefined ? { desc: r.desc } : {}),
				...(r.visible !== undefined ? { visible: r.visible } : {}),
				render: this.tracked(s.id, i, r),
			})),
		}));
		this.crumb("defs-done");
		return defs;
	}

	/** Obsidian before 1.13 only; 1.13+ renders getSettingDefinitions() instead and never calls this. */
	override display(): void {
		this.crumb("display");
		this.renderFallback();
	}

	private renderFallback(): void {
		this.shown = true;
		const { containerEl } = this;
		containerEl.empty();
		for (const s of this.sections()) {
			const group = new SettingGroup(containerEl).setHeading(s.heading);
			for (const [i, r] of s.rows.entries()) {
				if (r.visible && !r.visible()) continue;
				group.addSetting((setting) => {
					setting.setName(r.name);
					if (r.desc !== undefined) setting.setDesc(r.desc);
					this.tracked(s.id, i, r)(setting);
				});
			}
		}
	}

	private sections(): Section[] {
		return [
			{ id: "account", heading: "Account", rows: this.accountRows() },
			{ id: "sync", heading: "Sync", rows: this.syncRows() },
			{ id: "report", heading: "Last sync report", rows: this.reportRows() },
			{ id: "diag", heading: "Diagnostics", rows: this.diagnosticsRows() },
		];
	}

	/** Through the plugin's serialized write queue: data.json first, then memory (R-AUTH-9). */
	private save(patch: Partial<PluginData>): Promise<void> {
		return this.plugin.persist(patch);
	}

	// ---------- Account ----------

	private accountRows(): Row[] {
		const auth = this.plugin.auth;
		// Read at render time, never here: these definitions outlive the state they were built in (row 10).
		const signedIn = () => auth.status === "signed-in";
		const shows = (row: AccountRow) => () => accountRowVisible(row, auth.status);
		// Obsidian 1.14 renders hidden rows too (and only hides them), so each state-dependent row checks first.
		const hidden = (row: AccountRow) => !accountRowVisible(row, auth.status);
		const idDesc = (value: string) => {
			if (signedIn()) return "Sign out to change it. The sign-in belongs to this ID.";
			if (value === "") return "From your app registration in Microsoft Entra. See the setup guide in the README.";
			return isValidClientId(value) ? "Saved." : "Not a valid ID. It looks like 00000000-0000-0000-0000-000000000000.";
		};
		return [
			{
				name: "Status",
				render: (s) => {
					s.setDesc(STATUS_TEXT[auth.status]);
				},
			},
			{
				name: "Application (client) ID",
				render: (s) => {
					s.setDesc(idDesc(this.plugin.data.clientId));
					s.addText((text) =>
						text
							.setPlaceholder("00000000-0000-0000-0000-000000000000")
							.setValue(this.plugin.data.clientId)
							.setDisabled(signedIn())
							.onChange(async (raw) => {
								const value = raw.trim();
								s.setDesc(idDesc(value));
								if (value === "" || isValidClientId(value)) {
									await this.save({ clientId: value });
									// Rebuild only the sign-in control, so the text field keeps focus.
									if (this.signInSetting?.settingEl.isConnected && !signedIn()) this.renderSignInControl(this.signInSetting);
								}
							}),
					);
				},
			},
			{
				name: "OneDrive storage",
				visible: shows("storage"),
				render: (s) => {
					if (hidden("storage")) return;
					this.renderQuota(s);
				},
			},
			{
				name: "Sign out",
				desc: "Removes the stored sign-in and sync state from this device. Local files are untouched.",
				visible: shows("sign-out"),
				render: (s) => {
					if (hidden("sign-out")) return;
					s.addButton((b) => b.setButtonText("Sign out").onClick(() => void this.plugin.signOut()));
				},
			},
			{
				name: "Sign in",
				desc: "Opens Microsoft's sign-in page in your browser, then returns to Obsidian.",
				visible: shows("sign-in"),
				render: (s) => {
					// While signed in this row is hidden but still rendered: no prepare (R-SEC-1), no notice.
					if (hidden("sign-in")) return;
					this.signInSetting = s;
					this.renderSignInControl(s);
					// Torn down (a re-render, or the tab closing): drop the untapped link's verifier and state (R-SEC-1).
					// Only while no newer render has claimed the row: a cleanup that runs after its replacement rendered
					// must not kill the new link.
					return () => {
						if (this.signInSetting !== s) return;
						this.signInSetting = null;
						this.renderId++;
						this.plugin.auth.discardPrepared();
					};
				},
			},
			{
				name: "Token storage",
				render: (s) => {
					const warning = this.plugin.tokenStore.storageWarning;
					if (warning !== "none") {
						setDescError(s, TOKEN_WARNING_TEXT[warning]);
					} else {
						s.setDesc("Stored in Obsidian secret storage. Encryption depends on your device's keyring.");
					}
				},
			},
		];
	}

	/** Used and free space (T-D7) [G-QT-1]. Read at most every 5 minutes (QuotaCache); a failure shows no detail. */
	private renderQuota(setting: Setting): void {
		// Never a Graph read without a sign-in: in the stale layout this read was the last step before the freeze.
		if (this.plugin.auth.status !== "signed-in") {
			setting.setDesc("Sign in to see storage.");
			return;
		}
		setting.setDesc("Loading…");
		this.plugin.quota.get().then(
			(q) => {
				const { text, warn } = quotaText(q);
				if (warn) setDescError(setting, text);
				else setting.setDesc(text);
			},
			() => setting.setDesc("Couldn't read the storage figures. They're read again when settings reopen."),
		);
	}

	/**
	 * The Sign in control is a real link whose URL is built before the tap. iOS opens a browser only from the
	 * tap itself, so nothing may await between the tap and the navigation (M2 check 2). The click handler starts
	 * the sign-in synchronously and lets the link's default navigation open the default browser [I-BR-1].
	 */
	private renderSignInControl(setting: Setting): void {
		const id = ++this.renderId;
		setting.controlEl.empty();
		if (!isValidClientId(this.plugin.data.clientId)) {
			setting.addButton((b) => b.setButtonText("Enter the client ID first").setDisabled(true));
			return;
		}
		const link = setting.controlEl.createEl("a", {
			text: "Sign in",
			cls: "mdvaultsync-signin-link",
			attr: { rel: "noopener noreferrer", "aria-disabled": "true" },
		});
		link.addEventListener("click", (evt) => {
			const href = link.getAttribute("href");
			if (!href) {
				evt.preventDefault();
				return;
			}
			try {
				this.plugin.auth.activateSignIn(href);
			} catch (e) {
				evt.preventDefault();
				evt.stopImmediatePropagation();
				this.plugin.reportAuthError(e);
				// Replace the dead link with a fresh one.
				this.renderSignInControl(setting);
			}
		});
		this.crumb("signin-prepare");
		this.plugin.auth.prepareSignIn().then(
			(url) => {
				this.crumb("signin-prepare-ok");
				if (id !== this.renderId) return;
				// Rendered into a closed tab: nothing can tap this link, so drop its verifier and state (R-SEC-1).
				if (!link.isConnected) {
					this.plugin.auth.discardPrepared();
					return;
				}
				link.setAttribute("href", url);
				link.removeAttribute("aria-disabled");
			},
			(e: unknown) => {
				this.crumb("signin-prepare-failed");
				// The state moved under this render (a newer render, the command, or a sign-in that completed): stay quiet.
				const quiet = e instanceof AuthError && isQuietPrepareError(e.code);
				if (id === this.renderId && !quiet) this.plugin.reportAuthError(e);
			},
		);
	}

	// ---------- Sync ----------

	/** A text field that saves only valid values; an invalid one shows why in the description. */
	private validatedText(s: Setting, desc: string, value: string, parse: (raw: string) => Partial<PluginData> | null, after?: () => void, invalid = "Not a valid value."): void {
		s.setDesc(desc);
		s.addText((text) =>
			text.setValue(value).onChange(async (raw) => {
				const patch = parse(raw);
				if (patch === null) {
					setDescError(s, `${invalid} ${desc}`);
					return;
				}
				s.setDesc(desc);
				await this.save(patch);
				after?.();
			}),
		);
	}

	private syncRows(): Row[] {
		const d = this.plugin.data;
		const fallbackName = this.plugin.defaultDeviceName;
		return [
			{
				name: "Device name",
				render: (s) => {
					const desc = `Used in conflict copy names, like "Note (conflict ${fallbackName} 2026-10-12 140200).md". Leave empty for "${fallbackName}".`;
					s.setDesc(desc);
					s.addText((text) =>
						text
							.setPlaceholder(fallbackName)
							.setValue(d.deviceName)
							.onChange(async (raw) => {
								if (raw.trim() === "") {
									s.setDesc(desc);
									await this.save({ deviceName: "" });
									return;
								}
								const name = parseDeviceName(raw);
								if (name === null) {
									setDescError(s, `Use 1 to 40 characters that are allowed in a file name. ${desc}`);
									return;
								}
								s.setDesc(desc);
								await this.save({ deviceName: name });
							}),
					);
				},
			},
			{
				name: "Sync interval",
				render: (s) =>
					this.validatedText(
						s,
						"Minutes between automatic syncs, 1 to 1440. 0 turns automatic sync off; a sync still runs at startup.",
						String(d.intervalMinutes),
						(raw) => {
							const n = parseInterval(raw);
							return n === null ? null : { intervalMinutes: n };
						},
						() => this.plugin.restartTimer(),
					),
			},
			{
				name: "Maximum file size",
				render: (s) =>
					this.validatedText(s, "In megabytes, 1 to 1024. Larger files are skipped and listed in the sync report.", String(d.maxFileSizeMiB), (raw) => {
						const n = parseMaxFileSize(raw);
						return n === null ? null : { maxFileSizeMiB: n };
					}),
			},
			{
				name: "Exclude patterns",
				render: (s) => {
					const desc = createFragment((f) => {
						f.appendText("One pattern per line, like a .gitignore file: ");
						f.createEl("code", { text: "*" });
						f.appendText(", ");
						f.createEl("code", { text: "**" });
						f.appendText(" and ");
						f.createEl("code", { text: "?" });
						f.appendText(" work, a trailing ");
						f.createEl("code", { text: "/" });
						f.appendText(" matches folders only, and ");
						f.createEl("code", { text: "#" });
						f.appendText(" starts a comment. Lines starting with ");
						f.createEl("code", { text: "!" });
						f.appendText(
							" and backslash escapes aren't supported; such patterns never match. Matching is case-sensitive: on the iPad, " +
								"a pattern for a folder doesn't exclude a folder from OneDrive whose name differs only in letter case. " +
								"Hidden files and the settings folder are always excluded. At most 200 lines.",
						);
					});
					const paused = this.plugin.patternsInvalid;
					if (paused) setDescError(s, "The saved patterns couldn't be read, so sync is paused. The lines that could be read are shown. Check them, then select Save and resume sync.");
					else s.setDesc(desc);
					let text = (paused ? this.plugin.pausedReadable : d.excludePatterns).join("\n");
					const tooLong = "Too many lines (at most 200) or a line over 1000 characters. Not saved.";
					s.addTextArea((ta) => {
						ta.inputEl.rows = 6;
						ta.setPlaceholder("Private/")
							.setValue(text)
							.onChange(async (raw) => {
								text = raw;
								// While paused, a half-typed list must not resume sync: only the button saves (T-I6).
								if (this.plugin.patternsInvalid) return;
								const lines = parseExcludePatterns(raw);
								if (lines === null) {
									setDescError(s, tooLong);
									return;
								}
								s.setDesc(desc);
								await this.save({ excludePatterns: lines });
							});
					});
					if (paused) {
						s.addButton((b) =>
							b
								.setButtonText("Save and resume sync")
								.setCta()
								.onClick(async () => {
									const lines = parseExcludePatterns(text);
									if (lines === null) {
										setDescError(s, tooLong);
										return;
									}
									try {
										await this.save({ excludePatterns: lines });
									} catch {
										setDescError(s, "Couldn't save. Sync is still paused.");
										return;
									}
									this.refresh();
								}),
						);
					}
				},
			},
			{
				name: "Preview changes before every sync",
				desc: "Shows every planned change and waits for Run. The first sync on a device always shows it.",
				render: (s) => {
					s.addToggle((t) => t.setValue(d.previewEveryRun).onChange((v) => this.save({ previewEveryRun: v })));
				},
			},
			{
				name: "Confirm large deletes",
				render: (s) =>
					this.validatedText(
						s,
						"Ask first when a sync would delete more than this percentage of the synced files, 1 to 100.",
						String(d.massDeleteThresholdPct),
						(raw) => {
							const n = parseThreshold(raw);
							return n === null ? null : { massDeleteThresholdPct: n };
						},
					),
			},
		];
	}

	// ---------- Last sync report ----------

	private reportRows(): Row[] {
		return [
			{
				name: "Last sync",
				render: (s) => {
					this.reportEl = s.descEl.createDiv({ cls: "mdvaultsync-report" });
					renderReport(this.reportEl, this.plugin.lastReport, Date.now());
					s.addButton((b) => b.setButtonText("Sync now").onClick(() => void this.plugin.sync("command")));
				},
			},
		];
	}

	// ---------- Diagnostics ----------

	private diagnosticsRows(): Row[] {
		return [
			{
				name: "Log",
				desc: "The recent log, to copy into a bug report. It holds operation names, counts, durations and status codes, never file names, contents or tokens.",
				render: (s) => {
					s.addButton((b) => b.setButtonText("Show log").onClick(() => new LogModal(this.app, this.plugin.logger.serialize()).open()));
				},
			},
			{
				name: "Verbose logging",
				desc: "Also writes each log line to the developer console, for troubleshooting. Same content as the log: no file names, contents or tokens.",
				render: (s) => {
					s.addToggle((t) => t.setValue(this.plugin.data.verboseLogging).onChange((v) => this.save({ verboseLogging: v })));
				},
			},
		];
	}
}
