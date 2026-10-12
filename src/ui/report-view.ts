// Renders a sync report (design §10, T-R1) with createEl only [O-GL-3]. The grouping is in plan-groups.ts.
import type { SyncReport } from "../core/ports.ts";
import { reportSummary, type Group } from "./plan-groups.ts";

/** Collapsible groups: `open` when a group is short enough to read at a glance. */
export function renderGroups(el: HTMLElement, groups: readonly Group[], openUpTo = 20): void {
	for (const g of groups) {
		const details = el.createEl("details", { cls: "mdvaultsync-group" });
		if (g.count <= openUpTo) details.setAttr("open", "");
		details.createEl("summary", { text: `${g.label} (${g.count})` });
		const list = details.createEl("ul", { cls: "mdvaultsync-list" });
		for (const line of g.lines) list.createEl("li", { text: line });
	}
}

export function renderReport(el: HTMLElement, report: SyncReport | null, now: number): void {
	el.empty();
	if (!report) {
		el.createEl("p", { text: "No sync has run on this device yet." });
		return;
	}
	const s = reportSummary(report, now);
	el.createEl("p", { text: s.heading, cls: "mdvaultsync-report-heading" });
	el.createEl("p", { text: s.counts.join(", ") });
	renderGroups(el, s.groups);
}
