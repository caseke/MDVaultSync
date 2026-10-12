// Settings tab. M2 builds the Account section only; M7 adds the rest (design §10).
import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type MDVaultSyncPlugin from "../main.ts";
import { AuthError, type AuthStatus } from "../remote/auth.ts";
import { isValidClientId } from "../settings.ts";

const STATUS_TEXT: Record<AuthStatus, string> = {
	"signed-out": "Signed out.",
	"signed-in": "Signed in to OneDrive.",
	"sign-in-required": "Sign-in required: access expired or was revoked.",
};

export class MDVaultSyncSettingTab extends PluginSettingTab {
	private readonly plugin: MDVaultSyncPlugin;
	private shown = false;
	/** Bumped on every sign-in control render, so a slow prepare can't fill in an outdated link. */
	private renderId = 0;

	constructor(app: App, plugin: MDVaultSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Re-render if the tab is open (called on auth status changes). */
	refresh(): void {
		if (this.shown) this.display();
	}

	override hide(): void {
		this.shown = false;
		// Invalidate in-flight prepares and drop the untapped link's verifier and state.
		this.renderId++;
		this.plugin.auth.discardPrepared();
		super.hide();
	}

	override display(): void {
		this.shown = true;
		this.renderId++;
		const { containerEl } = this;
		containerEl.empty();
		const auth = this.plugin.auth;
		const status = auth.status;
		const signedIn = status === "signed-in";

		new Setting(containerEl).setName("Account").setHeading();

		new Setting(containerEl).setName("Status").setDesc(STATUS_TEXT[status]);

		let signInSetting: Setting | null = null;
		const idSetting = new Setting(containerEl).setName("Application (client) ID");
		const idDesc = (value: string) => {
			if (signedIn) return "Sign out to change it. The sign-in belongs to this ID.";
			if (value === "") return "From your app registration in Microsoft Entra. See the setup guide in the README.";
			return isValidClientId(value) ? "Saved." : "Not a valid ID. It looks like 00000000-0000-0000-0000-000000000000.";
		};
		idSetting.setDesc(idDesc(this.plugin.data.clientId));
		idSetting.addText((text) =>
			text
				.setPlaceholder("00000000-0000-0000-0000-000000000000")
				.setValue(this.plugin.data.clientId)
				.setDisabled(signedIn)
				.onChange(async (raw) => {
					const value = raw.trim();
					idSetting.setDesc(idDesc(value));
					if (value === "" || isValidClientId(value)) {
						// Saved before it is used: a sign-in must never exist without data.json on disk (R-AUTH-9).
						await this.plugin.saveData({ ...this.plugin.data, clientId: value });
						this.plugin.data.clientId = value;
						// Rebuild only the sign-in control, so the text field keeps focus.
						if (signInSetting) this.renderSignInControl(signInSetting);
					}
				}),
		);

		if (signedIn) {
			new Setting(containerEl)
				.setName("Sign out")
				.setDesc("Removes the stored sign-in and sync state from this device. Local files are untouched.")
				.addButton((b) =>
					b
						.setButtonText("Sign out")
						.onClick(() => void this.plugin.signOut()),
				);
		} else {
			signInSetting = new Setting(containerEl)
				.setName("Sign in")
				.setDesc("Opens Microsoft's sign-in page in your browser, then returns to Obsidian.");
			this.renderSignInControl(signInSetting);
		}

		const storage = new Setting(containerEl).setName("Token storage");
		if (this.plugin.tokenStore.backend === "plugin-data") {
			storage.descEl.createSpan({
				cls: "mdvaultsync-warning",
				text:
					"Obsidian secret storage failed on this device, so the sign-in token is stored unencrypted " +
					"in this plugin's data file. Use device encryption, and sign in again once secret storage works.",
			});
		} else {
			storage.setDesc("Stored in Obsidian secret storage. Encryption depends on your device's keyring.");
		}
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
		this.plugin.auth.prepareSignIn().then(
			(url) => {
				if (id !== this.renderId) return;
				link.setAttribute("href", url);
				link.removeAttribute("aria-disabled");
			},
			(e: unknown) => {
				// A superseded prepare is expected (a newer render or the command won); stay quiet.
				const superseded = e instanceof AuthError && e.code === "superseded";
				if (id === this.renderId && !superseded) this.plugin.reportAuthError(e);
			},
		);
	}
}
