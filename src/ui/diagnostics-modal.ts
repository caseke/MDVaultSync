// Shows a diagnostics result as JSON so the owner can copy it into docs/plan.md: the Graph capability probe
// (plan M3, src/remote/probe.ts) and the file-replace check (plan M6, src/platform/rename-probe.ts). Neither
// result holds vault names, URLs or tokens.
import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";

export interface DiagnosticsText {
	title: string;
	running: string;
	done: string;
}

export const PROBE_TEXT: DiagnosticsText = {
	title: "OneDrive capability probe",
	running: "Running. This creates and deletes a hidden test folder in the app folder, and uploads a 12 megabyte test file. It can take a minute.",
	done: "Done. Copy the result and paste it into docs/plan.md under milestone 3.",
};

export const FILE_REPLACE_TEXT: DiagnosticsText = {
	title: "File replace check",
	running: "Running. This writes, renames and removes two small test files in the plugin's folder.",
	done: "Done. Copy the result and paste it into docs/plan.md under milestone 6.",
};

export class DiagnosticsModal extends Modal {
	private body: HTMLElement | null = null;
	private readonly text: DiagnosticsText;

	constructor(app: App, text: DiagnosticsText = PROBE_TEXT) {
		super(app);
		this.text = text;
	}

	override onOpen(): void {
		this.titleEl.setText(this.text.title);
		this.body = this.contentEl.createDiv();
		this.body.createEl("p", { text: this.text.running });
	}

	/** Replaces the running text with the result and a copy button. */
	showResult(json: string): void {
		const body = this.body;
		if (!body) return;
		body.empty();
		body.createEl("p", { text: this.text.done });
		body.createEl("pre", { text: json, cls: "mdvaultsync-diagnostics-json" });
		const actions = body.createDiv({ cls: "mdvaultsync-signin-actions" });
		const copy = actions.createEl("button", { text: "Copy result", cls: "mod-cta" });
		copy.addEventListener("click", () => {
			navigator.clipboard.writeText(json).then(
				() => new Notice("Result copied."),
				() => new Notice("Couldn't copy. Select the text and copy it instead."),
			);
		});
	}

	override onClose(): void {
		this.body = null;
		this.contentEl.empty();
	}
}
