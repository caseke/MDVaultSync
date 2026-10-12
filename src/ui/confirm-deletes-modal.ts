// The mass-delete guard's prompt (R-GUARD-1, design §5.4): lists every delete. "Skip deletes this time" syncs
// everything else and remembers the deletes; closing the modal or the 10-minute timeout skips them too.
import type { App } from "obsidian";
import type { PlanOp } from "../core/ports.ts";
import { previewGroups } from "./plan-groups.ts";
import { PromptModal } from "./prompt-modal.ts";
import { renderGroups } from "./report-view.ts";

export class ConfirmDeletesModal extends PromptModal {
	private readonly ops: PlanOp[];
	private readonly thresholdPct: number;

	constructor(app: App, ops: PlanOp[], thresholdPct: number) {
		super(app);
		this.ops = ops;
		this.thresholdPct = thresholdPct;
	}

	protected build(): void {
		const n = this.ops.length;
		this.titleEl.setText("Confirm deletes");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text:
				`This sync would delete more than ${this.thresholdPct} % of the synced files. ` +
				"Deleted files go to this device's trash or to the OneDrive recycle bin. If you skip, everything else still syncs, " +
				"and these deletes aren't proposed again until the file changes or you run Sync now.",
		});
		renderGroups(contentEl.createDiv({ cls: "mdvaultsync-preview" }), previewGroups({ ops: this.ops, deleteCount: n, trackedCount: 0, unionMode: false, differsNoHistory: 0 }));
		const actions = contentEl.createDiv({ cls: "mdvaultsync-actions" });
		actions.createEl("button", { text: "Skip deletes this time", cls: "mod-cta" }).addEventListener("click", () => this.decide(false));
		actions.createEl("button", { text: `Delete ${n} file${n === 1 ? "" : "s"}`, cls: "mod-warning" }).addEventListener("click", () => this.decide(true));
	}
}
