// Shows the Graph capability probe's JSON (plan M3) so the owner can copy it into docs/plan.md. The JSON holds no
// vault names, URLs or tokens (src/remote/probe.ts).
import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";

export class DiagnosticsModal extends Modal {
	private body: HTMLElement | null = null;

	constructor(app: App) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("OneDrive capability probe");
		this.body = this.contentEl.createDiv();
		this.body.createEl("p", {
			text: "Running. This creates and deletes a hidden test folder in the app folder, and uploads a 12 megabyte test file. It can take a minute.",
		});
	}

	/** Replaces the running text with the result and a copy button. */
	showResult(json: string): void {
		const body = this.body;
		if (!body) return;
		body.empty();
		body.createEl("p", { text: "Done. Copy the result and paste it into docs/plan.md under milestone 3." });
		body.createEl("pre", { text: json, cls: "mdvaultsync-diagnostics-json" });
		const actions = body.createDiv({ cls: "mdvaultsync-signin-actions" });
		const copy = actions.createEl("button", { text: "Copy result", cls: "mod-cta" });
		copy.addEventListener("click", () => {
			navigator.clipboard.writeText(json).then(
				() => new Notice("Probe result copied."),
				() => new Notice("Couldn't copy. Select the text and copy it instead."),
			);
		});
	}

	override onClose(): void {
		this.body = null;
		this.contentEl.empty();
	}
}
