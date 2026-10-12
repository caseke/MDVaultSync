// Used by the sign-in command only; the settings tab links straight to Microsoft. Shows the authorize URL as a
// link the user taps. iOS only lets a page open a browser window while it is
// handling a tap, and building the URL awaits the S256 digest, so window.open after it is silently blocked on
// the iPad (M2 manual check 2). Tapping a real link is its own gesture, so nothing is blocked.
import { Modal } from "obsidian";
import type { App } from "obsidian";

export class SignInModal extends Modal {
	private readonly url: string;

	constructor(app: App, url: string) {
		super(app);
		this.url = url;
	}

	override onOpen(): void {
		this.titleEl.setText("Sign in to OneDrive");
		this.contentEl.createEl("p", {
			text: "Sign in with your personal Microsoft account. Your browser opens, then returns to Obsidian.",
		});
		const actions = this.contentEl.createDiv({ cls: "mdvaultsync-signin-actions" });
		actions.createEl("a", {
			text: "Open Microsoft sign-in",
			href: this.url,
			cls: "mdvaultsync-signin-link",
			attr: { rel: "noopener noreferrer" },
		});
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
