// Settings tab (R-UI-1, design §10): Account, Sync, Last sync report, Diagnostics.
//
// One list of sections and rows feeds both rendering paths. Obsidian 1.13+ renders getSettingDefinitions()
// itself (and indexes it for settings search); older versions (minAppVersion is 1.11.4) call display(), which
// renders the same rows through SettingGroup (since 1.11.0). Every row is a `render` definition, because the
// sign-in link and the validated inputs need imperative control.
import { Notice, PluginSettingTab, requireApiVersion, SettingGroup } from "obsidian";
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
import { quotaText } from "./quota.ts";
import { RecentCounter } from "./recent-counter.ts";
import { refreshAction } from "./settings-refresh.ts";
import { renderReport } from "./report-view.ts";

const STATUS_TEXT: Record<AuthStatus, string> = {
	"signed-out": "Signed out.",
	"signed-in": "Signed in to OneDrive.",
	"sign-in-required": "Sign-in required: access expired or was revoked.",
};

interface Row {
	name: string;
	desc?: string;
	render(setting: Setting): void;
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
		// Only while the tab is on screen: rendering prepares a sign-in, and only hide() discards it (R-SEC-1). A
		// closed tab isn't re-rendered (M8 matrix row 10); it renders afresh when it next opens.
		if (refreshAction({ onScreen: this.shown, connected: this.containerEl.isConnected }) === "skip") {
			this.crumb("refresh-skipped");
			return;
		}
		if (requireApiVersion("1.13.0")) this.update();
		else this.renderFallback();
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
		this.plugin.logger.event("ui.settings", count === undefined ? { code } : { code, count });
	}

	/** Wraps a row's render with start and end breadcrumbs, `<section>-<index>`. */
	private tracked(section: string, i: number, r: Row): (setting: Setting) => void {
		return (setting) => {
			// A row renders only while the tab is on screen; hide() clears this again.
			this.shown = true;
			this.crumb(`${section}-${i}`);
			r.render(setting);
			this.crumb(`${section}-${i}-done`);
		};
	}

	override hide(): void {
		this.crumb("hide");
		this.shown = false;
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
		const signedIn = auth.status === "signed-in";
		let signInSetting: Setting | null = null;
		const idDesc = (value: string) => {
			if (signedIn) return "Sign out to change it. The sign-in belongs to this ID.";
			if (value === "") return "From your app registration in Microsoft Entra. See the setup guide in the README.";
			return isValidClientId(value) ? "Saved." : "Not a valid ID. It looks like 00000000-0000-0000-0000-000000000000.";
		};
		const rows: Row[] = [
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
							.setDisabled(signedIn)
							.onChange(async (raw) => {
								const value = raw.trim();
								s.setDesc(idDesc(value));
								if (value === "" || isValidClientId(value)) {
									await this.save({ clientId: value });
									// Rebuild only the sign-in control, so the text field keeps focus.
									if (signInSetting) this.renderSignInControl(signInSetting);
								}
							}),
					);
				},
			},
		];
		if (signedIn) {
			rows.push({
				name: "OneDrive storage",
				render: (s) => this.renderQuota(s),
			});
			rows.push({
				name: "Sign out",
				desc: "Removes the stored sign-in and sync state from this device. Local files are untouched.",
				render: (s) => {
					s.addButton((b) => b.setButtonText("Sign out").onClick(() => void this.plugin.signOut()));
				},
			});
		} else {
			rows.push({
				name: "Sign in",
				desc: "Opens Microsoft's sign-in page in your browser, then returns to Obsidian.",
				render: (s) => {
					signInSetting = s;
					this.renderSignInControl(s);
				},
			});
		}
		rows.push({
			name: "Token storage",
			render: (s) => {
				if (this.plugin.tokenStore.backend === "plugin-data") {
					setDescError(
						s,
						"Obsidian secret storage failed on this device, so the sign-in token is stored unencrypted " +
							"in this plugin's data file. Use device encryption, and sign in again once secret storage works.",
					);
				} else {
					s.setDesc("Stored in Obsidian secret storage. Encryption depends on your device's keyring.");
				}
			},
		});
		return rows;
	}

	/** Used and free space (T-D7) [G-QT-1]. Read at most every 5 minutes (QuotaCache); a failure shows no detail. */
	private renderQuota(setting: Setting): void {
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
				link.setAttribute("href", url);
				link.removeAttribute("aria-disabled");
			},
			(e: unknown) => {
				this.crumb("signin-prepare-failed");
				// A superseded prepare is expected (a newer render or the command won); stay quiet.
				const superseded = e instanceof AuthError && e.code === "superseded";
				if (id === this.renderId && !superseded) this.plugin.reportAuthError(e);
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
				name: "OneDrive capability probe",
				desc: "Checks what OneDrive supports for this account, using a hidden test folder in the app folder.",
				render: (s) => {
					s.addButton((b) => b.setButtonText("Run probe").onClick(() => void this.plugin.runDiagnostics()));
				},
			},
			{
				name: "Log",
				desc: "Copies the recent log. It holds operation names, counts, durations and status codes, never file names, contents or tokens.",
				render: (s) => {
					s.addButton((b) =>
						b.setButtonText("Copy log").onClick(() => {
							navigator.clipboard.writeText(this.plugin.logger.serialize()).then(
								() => new Notice("Log copied."),
								() => new Notice("Couldn't copy the log."),
							);
						}),
					);
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
