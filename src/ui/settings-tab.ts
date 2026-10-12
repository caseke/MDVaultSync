// Settings tab. M2 builds the Account section only; M7 adds the rest (design §10).
import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type MDVaultSyncPlugin from "../main.ts";
import { REDIRECT_NATIVE, REDIRECT_PROTOCOL, type AuthStatus } from "../remote/auth.ts";
import { isValidClientId } from "../settings.ts";

const STATUS_TEXT: Record<AuthStatus, string> = {
	"signed-out": "Signed out.",
	"signed-in": "Signed in to OneDrive.",
	"sign-in-required": "Sign-in required: access expired or was revoked.",
};

export class MDVaultSyncSettingTab extends PluginSettingTab {
	private readonly plugin: MDVaultSyncPlugin;
	private pasteOpen = false;
	private shown = false;

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
		this.pasteOpen = false;
		super.hide();
	}

	override display(): void {
		this.shown = true;
		const { containerEl } = this;
		containerEl.empty();
		const auth = this.plugin.auth;
		const status = auth.status;
		const signedIn = status === "signed-in";
		if (signedIn) this.pasteOpen = false;

		new Setting(containerEl).setName("Account").setHeading();

		new Setting(containerEl).setName("Status").setDesc(STATUS_TEXT[status]);

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
						this.plugin.data.clientId = value;
						await this.plugin.saveData(this.plugin.data);
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
			new Setting(containerEl)
				.setName("Sign in")
				.setDesc("Opens Microsoft's sign-in page in your browser, then returns to Obsidian.")
				.addButton((b) =>
					b
						.setButtonText("Sign in")
						.setCta()
						.onClick(() => void this.plugin.startSignIn(REDIRECT_PROTOCOL)),
				);
			new Setting(containerEl)
				.setName("Sign in another way")
				.setDesc("Use this if the browser can't return to Obsidian. You paste the final address back here.")
				.addButton((b) =>
					b.setButtonText("Sign in another way").onClick(async () => {
						if (await this.plugin.startSignIn(REDIRECT_NATIVE)) {
							this.pasteOpen = true;
							this.display();
						}
					}),
				);
			if (this.pasteOpen) this.renderPasteBox(containerEl);
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

	private renderPasteBox(containerEl: HTMLElement): void {
		let pasted = "";
		new Setting(containerEl)
			.setName("Paste the address")
			.setDesc(
				"After you sign in, the browser shows a blank page. Copy the whole address from the address bar " +
					"and paste it here.",
			)
			.addTextArea((ta) =>
				ta.setPlaceholder("Paste the full address here").onChange((v) => {
					pasted = v;
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Finish sign-in")
					.setCta()
					.onClick(() => void this.plugin.finishPastedSignIn(pasted)),
			);
	}
}
