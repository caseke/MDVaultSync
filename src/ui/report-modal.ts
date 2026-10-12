// Sync status: the current state with the last sync time, then the last report. Opened by the status-bar click
// and the "Show sync status" command, which is how the iPad sees it (no status bar, no hover; R-UI-2, design §10).
import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { SyncReport } from "../core/ports.ts";
import { renderReport } from "./report-view.ts";

export class ReportModal extends Modal {
	private readonly report: SyncReport | null;
	private readonly status: string;

	constructor(app: App, report: SyncReport | null, status: string) {
		super(app);
		this.report = report;
		this.status = status;
	}

	override onOpen(): void {
		this.titleEl.setText("Sync status");
		this.contentEl.createEl("p", { text: this.status, cls: "mdvaultsync-report-heading" });
		renderReport(this.contentEl.createDiv({ cls: "mdvaultsync-preview" }), this.report, Date.now());
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
