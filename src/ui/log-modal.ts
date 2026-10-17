// The log, shown before it is copied (Settings → Diagnostics → Log). The text is selectable, so it can be copied
// by hand when the clipboard API is refused or never answers (M9 owner note: Ubuntu); copyText always settles.
// Codes only, like the log itself (R-SEC-3).
import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import { copyText } from "./copy-text.ts";

export const MANUAL_COPY_TEXT =
	"Couldn't copy automatically. The log is selected: press Ctrl+C (Cmd+C on a Mac), or touch and hold it and choose Copy.";
/** When the selection didn't take (iPadOS may ignore it outside a tap). */
export const SELECT_YOURSELF_TEXT = "Couldn't copy automatically. Touch and hold the log, choose Select All, then Copy.";

export class LogModal extends Modal {
	private readonly text: string;

	constructor(app: App, text: string) {
		super(app);
		this.text = text;
	}

	override onOpen(): void {
		this.titleEl.setText("Log");
		this.contentEl.createEl("p", { text: "Operation names, counts, durations and status codes. No file names, contents or tokens." });
		const area = this.contentEl.createEl("textarea", { cls: "mdvaultsync-log", attr: { readonly: "true", rows: "12", spellcheck: "false" } });
		area.value = this.text;
		const hint = this.contentEl.createEl("p", { cls: "mdvaultsync-log-hint" });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const copy = buttons.createEl("button", { text: "Copy", cls: "mod-cta" });
		copy.addEventListener("click", () => {
			void copyText(this.text, navigator.clipboard, (ms, fn) => {
				const id = window.setTimeout(fn, ms);
				return () => window.clearTimeout(id);
			}).then((outcome) => {
				if (outcome === "copied") {
					new Notice("Log copied.");
					return;
				}
				area.focus();
				area.select();
				area.setSelectionRange(0, area.value.length);
				hint.setText(area.selectionEnd > 0 ? MANUAL_COPY_TEXT : SELECT_YOURSELF_TEXT);
			});
		});
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
