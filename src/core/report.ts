// The per-run sync report (design §5.6, T-R1): what the run did, path by path, for the user. It lives only in
// local plugin state and is never logged (design §9). Pure: no Obsidian import.
import { LOG_CODE_RE } from "./logger.ts";
import type { Plan, PlanOp, SyncReport, Trigger, VaultPath } from "./ports.ts";

/** How one planned op ended. `code` is a short identifier (an error class or Graph code), never a message. */
export type OpResult = { op: PlanOp; ok: true } | { op: PlanOp; ok: false; code: string };

export interface ReportInput {
	trigger: Trigger;
	startedAt: number;
	finishedAt: number;
	plan: Plan;
	results: readonly OpResult[];
	/** Set when the run ended early; otherwise the result is `ok`, or `partial` if any op failed. */
	outcome?: "failed" | "cancelled";
	/** Errors outside any op (preflight, pull), e.g. `{ path: null, code: "network" }`. */
	runErrors?: readonly { path: VaultPath | null; code: string }[];
}

const KINDS: readonly PlanOp["kind"][] = [
	"download",
	"upload-new",
	"upload-replace",
	"remote-move",
	"local-move",
	"remote-delete",
	"local-trash",
	"conflict",
	"adopt",
	"forget",
	"skip",
];
/** Ops that change a file or folder; adopt and forget change only sync state. */
const CHANGES_A_PATH = new Set<PlanOp["kind"]>(["download", "upload-new", "upload-replace", "remote-move", "local-move", "remote-delete", "local-trash", "conflict"]);

function safeCode(code: string): string {
	return LOG_CODE_RE.test(code) ? code : "other";
}

/** The path an op is about: the source of a move, otherwise its path. */
export function opPath(op: PlanOp): VaultPath {
	return op.kind === "remote-move" || op.kind === "local-move" ? op.from : op.path;
}

export function buildReport(input: ReportInput): SyncReport {
	const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<PlanOp["kind"], number>;
	const report: SyncReport = {
		trigger: input.trigger,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		result: "ok",
		counts,
		touched: [],
		conflicts: [],
		skipped: [],
		errors: (input.runErrors ?? []).map((e) => ({ path: e.path, code: safeCode(e.code) })),
	};
	// Skips are never executed; they come from the plan itself.
	for (const op of input.plan.ops) {
		if (op.kind !== "skip") continue;
		counts.skip++;
		report.skipped.push({ path: op.path, reason: op.reason });
	}
	for (const r of input.results) {
		const op = r.op;
		if (op.kind === "skip") continue;
		if (!r.ok) {
			report.errors.push({ path: opPath(op), code: safeCode(r.code) });
			continue;
		}
		counts[op.kind]++;
		if (CHANGES_A_PATH.has(op.kind)) {
			if (op.kind === "remote-move" || op.kind === "local-move") report.touched.push({ kind: op.kind, path: op.from, to: op.to });
			else report.touched.push({ kind: op.kind, path: op.path });
		}
		if (op.kind === "conflict") report.conflicts.push({ path: op.path, copyPath: op.copyPath });
	}
	report.result = input.outcome ?? (report.errors.length > 0 ? "partial" : "ok");
	return report;
}
