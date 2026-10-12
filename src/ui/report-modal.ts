// The last sync report, opened from the status bar (design §10).
import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { SyncReport } from "../core/ports.ts";
import { renderReport } from "./report-view.ts";

export class ReportModal extends Modal {
	private readonly report: SyncReport | null;

	constructor(app: App, report: SyncReport | null) {
		super(app);
		this.report = report;
	}

	override onOpen(): void {
		this.titleEl.setText("Last sync");
		renderReport(this.contentEl.createDiv({ cls: "mdvaultsync-preview" }), this.report, Date.now());
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
