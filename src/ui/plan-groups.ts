// What the preview modal (R-FIRST-2) and the report view (T-R1) list, as plain groups of display-escaped lines.
// Pure, so the grouping is unit tested; the modals only render it with createEl.
import type { Plan, PlanOp, SkipReason, SyncReport } from "../core/ports.ts";
import { displayPath } from "./display.ts";
import { errorText } from "./notices.ts";
import { formatSyncTime } from "./status.ts";

export interface Group {
	id: string;
	label: string;
	count: number;
	lines: string[];
}

export const SKIP_TEXT: Readonly<Record<SkipReason, string>> = Object.freeze({
	"too-large": "larger than the size limit",
	"invalid-name": "name not allowed in OneDrive",
	"path-too-long": "path too long for OneDrive",
	"case-collision": "differs from another name only in letter case",
	"reserved-name": "name reserved by OneDrive",
	"outside-vault": "would land outside the vault",
	hidden: "hidden or in the settings folder",
	excluded: "matches an exclude pattern",
	"unicode-collision": "same name as another file after Unicode normalization",
});

const d = displayPath;
const conflictLine = (path: string, copyPath: string) => `${d(path)} (this device's version kept as ${d(copyPath)})`;
const skipLine = (path: string, reason: SkipReason) => `${d(path)} (${SKIP_TEXT[reason]})`;

/** Preview groups in display order; empty groups are left out, and so are adopt and forget (no visible change). */
export function previewGroups(plan: Plan): Group[] {
	const groups: Group[] = [
		{ id: "download", label: "Download from OneDrive", count: 0, lines: [] },
		{ id: "upload", label: "Upload to OneDrive", count: 0, lines: [] },
		{ id: "move", label: "Move or rename", count: 0, lines: [] },
		{ id: "delete", label: "Delete", count: 0, lines: [] },
		{ id: "conflict", label: "Conflicts", count: 0, lines: [] },
		// R-CONF-3: no-base pairs that differ each get a conflict copy; shown on their own so it's no surprise.
		{ id: "no-history", label: "Differs on both sides, no sync history", count: 0, lines: [] },
		{ id: "skip", label: "Skipped", count: 0, lines: [] },
	];
	const add = (id: string, line: string) => {
		const g = groups.find((x) => x.id === id);
		if (!g) return;
		g.count++;
		g.lines.push(line);
	};
	for (const op of plan.ops) {
		switch (op.kind) {
			case "download":
				add("download", d(op.path));
				break;
			case "upload-new":
			case "upload-replace":
				add("upload", d(op.path));
				break;
			case "local-move":
				add("move", `${d(op.from)} → ${d(op.to)} (on this device)`);
				break;
			case "remote-move":
				add("move", `${d(op.from)} → ${d(op.to)} (in OneDrive)`);
				break;
			case "local-trash":
				add("delete", `${d(op.path)} (to this device's trash)`);
				break;
			case "remote-delete":
				add("delete", `${d(op.path)} (to the OneDrive recycle bin)`);
				break;
			case "conflict":
				add(op.noHistory ? "no-history" : "conflict", conflictLine(op.path, op.copyPath));
				break;
			case "skip":
				add("skip", skipLine(op.path, op.reason));
				break;
			case "adopt":
			case "forget":
				break;
		}
	}
	return groups.filter((g) => g.count > 0);
}

export interface ReportSummary {
	heading: string;
	counts: string[];
	groups: Group[];
}

const RESULT_TEXT: Readonly<Record<SyncReport["result"], string>> = {
	ok: "synced",
	partial: "some files didn't sync",
	failed: "sync failed",
	cancelled: "cancelled",
};

const TOUCH_TEXT: Readonly<Record<PlanOp["kind"], string>> = {
	download: "downloaded",
	"upload-new": "uploaded",
	"upload-replace": "uploaded",
	"remote-move": "moved in OneDrive",
	"local-move": "moved on this device",
	"remote-delete": "deleted in OneDrive",
	"local-trash": "moved to trash",
	conflict: "conflict",
	adopt: "recorded",
	forget: "forgotten",
	skip: "skipped",
};

/** The last sync report for the settings tab and the report modal (design §10, T-R1). */
export function reportSummary(r: SyncReport, now: number): ReportSummary {
	const c = r.counts;
	const counts: string[] = [];
	const add = (n: number, one: string, many = one) => {
		if (n > 0) counts.push(`${n} ${n === 1 ? one : many}`);
	};
	add(c.download, "downloaded");
	add(c["upload-new"] + c["upload-replace"], "uploaded");
	add(c["local-move"] + c["remote-move"], "moved or renamed");
	add(c["local-trash"] + c["remote-delete"], "deleted");
	add(c.conflict, "conflict", "conflicts");
	add(c.skip, "skipped");
	if (counts.length === 0) counts.push("Nothing changed");

	const groups: Group[] = [];
	const push = (id: string, label: string, lines: string[]) => {
		if (lines.length > 0) groups.push({ id, label, count: lines.length, lines });
	};
	push(
		"changed",
		"Changed",
		r.touched.filter((t) => t.kind !== "conflict").map((t) => (t.to !== undefined ? `${d(t.path)} → ${d(t.to)} (${TOUCH_TEXT[t.kind]})` : `${d(t.path)} (${TOUCH_TEXT[t.kind]})`)),
	);
	push("conflict", "Conflicts", r.conflicts.map((x) => conflictLine(x.path, x.copyPath)));
	push("skip", "Skipped", r.skipped.map((x) => skipLine(x.path, x.reason)));
	push("error", "Problems", r.errors.map((e) => `${e.path === null ? "Whole sync" : d(e.path)}: ${errorText(e.code)}`));
	return { heading: `${formatSyncTime(r.finishedAt, now)}: ${RESULT_TEXT[r.result]}`, counts, groups };
}
