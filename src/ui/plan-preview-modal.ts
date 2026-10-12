// The dry-run preview (R-FIRST-2, design §10): every planned change, grouped, with Run and Cancel. Nothing runs
// unless Run is clicked; closing the modal or the 10-minute timeout cancels.
import type { App } from "obsidian";
import type { Plan } from "../core/ports.ts";
import { previewGroups } from "./plan-groups.ts";
import { PromptModal } from "./prompt-modal.ts";
import { renderGroups } from "./report-view.ts";

export class PlanPreviewModal extends PromptModal {
	private readonly plan: Plan;

	constructor(app: App, plan: Plan) {
		super(app);
		this.plan = plan;
	}

	protected build(): void {
		this.titleEl.setText("Preview sync");
		const { contentEl } = this;
		if (this.plan.unionMode) {
			contentEl.createEl("p", {
				text: "This is a first sync for this device, or the OneDrive folder changed. Files from both sides are merged and nothing is deleted.",
			});
		}
		const groups = previewGroups(this.plan);
		if (groups.length === 0) contentEl.createEl("p", { text: "Nothing to change. Run records the current state." });
		else renderGroups(contentEl.createDiv({ cls: "mdvaultsync-preview" }), groups);
		const actions = contentEl.createDiv({ cls: "mdvaultsync-actions" });
		actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.decide(false));
		actions.createEl("button", { text: "Run", cls: "mod-cta" }).addEventListener("click", () => this.decide(true));
	}
}
