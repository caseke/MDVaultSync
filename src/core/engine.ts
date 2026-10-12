// The sync engine (design §3 single-flight lock, §5 phases, §6.2 journal). Pure core: no Obsidian import; the
// vault, Graph, state file and UI come in through ports and hooks (R-ENG-3).
//
// One run: preflight (token, approot, union selection) → resume upload sessions → pull (delta into remoteIndex,
// saved with the deltaLink) → scan → plan → preview → mass-delete guard → execute → report. The persisted state
// is the journal: an interrupted run resumes by running again, and the fresh plan holds only what is left.
import { executePlan } from "./executor.ts";
import { runOutcome, type ErrorClassifier, type RemoteFailure } from "./failure.ts";
import { NULL_LOGGER, type Logger } from "./logger.ts";
import { exceedsDeleteGuard, plan as makePlan, type ScannedEntry } from "./planner.ts";
import type {
	Clock,
	EngineStatus,
	PendingLocalOp,
	Plan,
	PlanOp,
	RemoteContent,
	RemoteItem,
	RemotePort,
	StateStore,
	SyncEngine,
	SyncHooks,
	SyncReport,
	SyncState,
	Trigger,
	VaultPath,
	VaultPort,
} from "./ports.ts";
import { quickXorHash } from "./quickxor.ts";
import { defineEntry, own } from "./records.ts";
import { buildReport, type OpResult } from "./report.ts";
import { Saver } from "./saver.ts";
import { applyAppRoot, emptyState } from "./state.ts";
import { resumeUploads } from "./upload-resume.ts";

/** Sync settings the engine reads at the start of each run (design §11). */
export interface EngineSettings {
	excludePatterns: readonly string[];
	/** Size cap in bytes (R-SCOPE-3). */
	maxFileSize: number;
	deviceName: string;
	previewEveryRun: boolean;
	massDeleteThresholdPct: number;
}

export const DEFAULT_ENGINE_SETTINGS: Readonly<EngineSettings> = Object.freeze({
	excludePatterns: [],
	maxFileSize: 100 * 1024 * 1024,
	deviceName: "device",
	previewEveryRun: false,
	massDeleteThresholdPct: 25,
});

export interface EngineDeps {
	remote: RemotePort;
	content: RemoteContent;
	vault: VaultPort;
	store: StateStore;
	hooks: SyncHooks;
	clock: Clock;
	classify: ErrorClassifier;
	configDir: string;
	/** ContentTransform.id of `content` (D-10). */
	transformId: string;
	/** Throws (an auth error) when there is no usable token: the run stops as "sign-in required". */
	ensureSignedIn(): Promise<void>;
	/** RetryPolicy.resetBudget: each run gets its own backoff budget (design §6.1). */
	resetBudget(): void;
	settings(): EngineSettings;
	newDeviceId(): string;
	logger?: Logger;
	concurrency?: number;
	/** How long an unanswered preview or delete prompt waits (design §5.4: 10 minutes). */
	promptTimeoutMs?: number;
	saveIntervalMs?: number;
}

export const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DELTA_PAGES = 10_000;
/** The children-walk fallback's sentinel link (src/remote/graph.ts CHILDREN_WALK_LINK): always a full listing. */
const FULL_LISTING_PREFIX = "mdvaultsync:";

const EMPTY_PLAN: Plan = { ops: [], deleteCount: 0, trackedCount: 0, unionMode: false, differsNoHistory: 0 };

/** Ends the run with a failure that is already classified. */
class RunStop extends Error {
	readonly failure: RemoteFailure;
	constructor(failure: RemoteFailure) {
		super(failure.code);
		this.name = "RunStop";
		this.failure = failure;
	}
}

const isDelete = (op: PlanOp) => op.kind === "remote-delete" || op.kind === "local-trash";

export class Engine implements SyncEngine {
	/** (path → hash of bytes this plugin wrote): the echo filter M7's vault events consult (design §3). */
	readonly expectedWrites = new Map<VaultPath, string>();
	private readonly deps: EngineDeps;
	private readonly logger: Logger;
	private state: SyncState | null = null;
	private epoch = 0;
	private running: Promise<SyncReport> | null = null;
	private rerunRequested = false;
	private current: EngineStatus = { state: "idle", lastSyncAt: null };
	private readonly early: PendingLocalOp[] = [];

	constructor(deps: EngineDeps) {
		this.deps = deps;
		this.logger = deps.logger ?? NULL_LOGGER;
	}

	get status(): EngineStatus {
		return this.current;
	}

	/**
	 * Single-flight (R-TRIG-4, design §3): with no run going, start one; during a run, ask for one follow-up and
	 * get the running promise. Runs never overlap, and any number of overlapping requests add at most one run.
	 */
	requestSync(trigger: Trigger): Promise<SyncReport> {
		if (this.running) {
			this.rerunRequested = true;
			return this.running;
		}
		const run = this.loop(trigger).finally(() => {
			this.running = null;
		});
		this.running = run;
		return run;
	}

	/** A vault event (M7). Kept in memory with the state and saved with it. */
	noteLocalChange(op: PendingLocalOp): void {
		if (this.state) this.state.pendingLocal.push(op);
		else this.early.push(op);
	}

	/**
	 * Sign-out (R-AUTH-7): forget the in-memory state. A run that started earlier can no longer save, so it can't
	 * write state back after StateStore.clear().
	 */
	reset(): void {
		this.epoch++;
		this.state = null;
		this.early.length = 0;
		this.expectedWrites.clear();
		this.setStatus({ state: "idle", lastSyncAt: null });
	}

	private setStatus(s: EngineStatus): void {
		this.current = s;
		this.deps.hooks.onStatus(s);
	}

	private async loop(trigger: Trigger): Promise<SyncReport> {
		let t = trigger;
		let report: SyncReport;
		do {
			this.rerunRequested = false;
			report = await this.runOnce(t);
			t = "rerun";
		} while (this.rerunRequested);
		return report;
	}

	/** Resolves false if the user doesn't answer in time, or the prompt fails (design §5.4: no answer = cancel/skip). */
	private async ask(prompt: () => Promise<boolean>): Promise<boolean> {
		const timeout = this.deps.clock.sleep(this.deps.promptTimeoutMs ?? PROMPT_TIMEOUT_MS).then(() => false);
		try {
			return await Promise.race([prompt(), timeout]);
		} catch {
			return false;
		}
	}

	private async runOnce(trigger: Trigger): Promise<SyncReport> {
		const { deps } = this;
		const epoch = this.epoch;
		const live = () => this.epoch === epoch;
		const startedAt = deps.clock.now();
		const saver = new Saver({
			store: deps.store,
			clock: deps.clock,
			state: () => (live() ? this.state : null),
			live,
			logger: this.logger,
			...(deps.saveIntervalMs !== undefined ? { intervalMs: deps.saveIntervalMs } : {}),
		});
		const settings = deps.settings();
		let plan = EMPTY_PLAN;
		let results: OpResult[] = [];
		const runErrors: { path: VaultPath | null; code: string }[] = [];
		let outcome: "failed" | "cancelled" | undefined;
		let failure: RemoteFailure | null = null;
		/** Every planned op got its turn (no early stop): only then may union mode end. */
		let completed = false;
		let pendingSeen = 0;

		this.setStatus({ state: "syncing", phase: "preflight" });
		try {
			deps.resetBudget();
			await deps.ensureSignedIn();
			if (!this.state) {
				const loaded = (await deps.store.load()) ?? emptyState(deps.newDeviceId());
				if (!live()) throw new RunStop({ kind: "auth", code: "signed-out" });
				this.state = loaded;
				this.state.pendingLocal.push(...this.early.splice(0));
			}
			// Preflight (design §5.1): a new or changed approot id means a union merge (D-18).
			const root = await deps.remote.getAppRoot();
			if (!live() || !this.state) throw new RunStop({ kind: "auth", code: "signed-out" });
			this.state = applyAppRoot(this.state, root.item.id);
			const state = this.state;
			const pathPrefixLen = root.pathPrefix.replace(/^\//, "").length;
			await saver.flush();

			this.setStatus({ state: "syncing", phase: "resume" });
			await resumeUploads({ state, vault: deps.vault, remote: deps.remote, content: deps.content, classify: deps.classify, saver, transformId: deps.transformId, logger: this.logger });

			this.setStatus({ state: "syncing", phase: "pull" });
			await this.pull(state, saver);

			this.setStatus({ state: "syncing", phase: "scan" });
			pendingSeen = state.pendingLocal.length;
			const scan = await this.scan(state, settings);

			plan = makePlan(state, scan, state.remoteIndex, {
				configDir: deps.configDir,
				excludePatterns: settings.excludePatterns,
				maxFileSize: settings.maxFileSize,
				pathPrefixLen,
				deviceName: settings.deviceName,
				now: new Date(deps.clock.now()),
				// "Sync now" (command or ribbon) re-offers deletes the user declined (R-GUARD-1).
				reofferDeclined: trigger === "command" || trigger === "ribbon",
			});
			this.logger.event("sync.plan", { count: plan.ops.length });

			// Preview (R-FIRST-2): on request, when the setting is on, and always in union mode, even unattended.
			if (trigger === "preview" || settings.previewEveryRun || plan.unionMode) {
				this.setStatus({ state: "waiting-for-user" });
				const shown = plan;
				if (!(await this.ask(() => deps.hooks.confirmPlan(shown)))) {
					outcome = "cancelled";
					throw new RunStop({ kind: "other", code: "cancelled" });
				}
			}
			// Mass-delete guard (R-GUARD-1).
			if (exceedsDeleteGuard(plan, settings.massDeleteThresholdPct)) {
				this.setStatus({ state: "waiting-for-user" });
				const deletes = plan.ops.filter(isDelete);
				if (await this.ask(() => deps.hooks.confirmDeletes(deletes))) {
					for (const op of deletes) delete state.declinedDeletes[op.path];
				} else {
					this.decline(state, deletes, scan);
					plan = { ...plan, ops: plan.ops.filter((o) => !isDelete(o)), deleteCount: 0 };
				}
			}

			this.setStatus({ state: "syncing", phase: "exec" });
			const t0 = deps.clock.now();
			const exec = await executePlan({
				state,
				plan,
				scan,
				vault: deps.vault,
				remote: deps.remote,
				content: deps.content,
				classify: deps.classify,
				settings: {
					configDir: deps.configDir,
					pathPrefixLen,
					maxFileSize: settings.maxFileSize,
					deviceName: settings.deviceName,
					now: new Date(deps.clock.now()),
					transformId: deps.transformId,
				},
				saver,
				expectedWrites: this.expectedWrites,
				logger: this.logger,
				...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {}),
			});
			results = exec.results;
			this.logger.event("sync.exec", { count: results.length, durationMs: deps.clock.now() - t0 });
			if (exec.fatal) {
				failure = exec.fatal;
				runErrors.push({ path: null, code: exec.fatal.code });
				if (runOutcome(exec.fatal.kind) === "failed") outcome = "failed";
			} else completed = true;
		} catch (e) {
			if (e instanceof RunStop) {
				if (outcome !== "cancelled") {
					failure = e.failure;
					runErrors.push({ path: null, code: e.failure.code });
					outcome = "failed";
				}
			} else {
				failure = deps.classify(e);
				runErrors.push({ path: null, code: failure.code });
				// A spent budget or a dead network keeps progress and ends partial (design §6.1).
				if (runOutcome(failure.kind) !== "partial") outcome = "failed";
			}
		}

		const report = buildReport({
			trigger,
			startedAt,
			finishedAt: deps.clock.now(),
			plan,
			results,
			...(outcome ? { outcome } : {}),
			runErrors,
		});
		await this.finish(report, plan, completed, pendingSeen, saver, live);
		this.logger.event("sync.run", { count: results.length, durationMs: report.finishedAt - startedAt, code: report.result });
		if (!live()) return report;
		if (failure?.kind === "auth") this.setStatus({ state: "sign-in-required" });
		else if (report.result === "failed" || report.result === "partial") this.setStatus({ state: "error", code: report.errors[0]?.code ?? "other" });
		else this.setStatus({ state: "idle", lastSyncAt: report.result === "ok" ? report.finishedAt : this.lastSyncAt() });
		return report;
	}

	private lastSyncAt(): number | null {
		const r = this.state?.lastReport;
		return r && (r.result === "ok" || r.result === "partial") ? r.finishedAt : null;
	}

	/** Report, union completion and pendingLocal (design §5.6), then the final save. */
	private async finish(report: SyncReport, plan: Plan, completed: boolean, pendingSeen: number, saver: Saver, live: () => boolean): Promise<void> {
		const state = this.state;
		if (!state || !live()) return;
		// Union mode ends only after a run in which every planned op got its turn (R-FIRST-1). A run cut short
		// (cancelled, failed, or stopped early by the network or the budget) stays union, so it can never delete.
		if (plan.unionMode && completed && (report.result === "ok" || report.result === "partial")) {
			state.unionPending = false;
			state.firstSyncCompleted = true;
		}
		// Events seen by this run are covered; events that arrived during it stay for the next one.
		if (report.result === "ok") state.pendingLocal.splice(0, pendingSeen);
		state.lastReport = report;
		try {
			await saver.flush();
		} catch (e) {
			console.error(`MDVaultSync: could not save sync state (${e instanceof Error ? e.name : "unknown"})`);
		}
	}

	/** Declined deletes are remembered with the state they were declined in (R-GUARD-1, planner `declined`). */
	private decline(state: SyncState, deletes: PlanOp[], scan: readonly ScannedEntry[]): void {
		const hashes = new Map(scan.map((e) => [e.path.normalize("NFC"), e.localHash]));
		for (const op of deletes) {
			if (op.kind === "remote-delete") {
				const item = own(state.remoteIndex, op.id) ? state.remoteIndex[op.id] : undefined;
				if (!item || item.isFolder) continue;
				defineEntry(state.declinedDeletes, op.path, { localHash: null, eTag: item.eTag });
			} else if (op.kind === "local-trash") {
				const h = hashes.get(op.path);
				if (h === undefined || h === null) continue;
				defineEntry(state.declinedDeletes, op.path, { localHash: h, eTag: null });
			}
		}
	}

	// ---------- pull (design §5.2) ----------

	private async pull(state: SyncState, saver: Saver): Promise<void> {
		const t0 = this.deps.clock.now();
		let resynced = false;
		for (;;) {
			try {
				const n = await this.pullOnce(state);
				// The index and the deltaLink are saved together, so the token is never ahead of the index.
				await saver.flush();
				this.logger.event("sync.pull", { count: n, durationMs: this.deps.clock.now() - t0 });
				return;
			} catch (e) {
				if (this.deps.classify(e).kind !== "resync" || resynced) throw e;
				// 410 / resync* [G-DL-4]: re-enumerate in union mode; the bases (files) are kept.
				resynced = true;
				state.unionPending = true;
				state.deltaLink = null;
				state.remoteIndex = {};
				await saver.flush();
			}
		}
	}

	/** Pages delta to its deltaLink and merges the result into remoteIndex. Returns the number of items seen. */
	private async pullOnce(state: SyncState): Promise<number> {
		const start = state.deltaLink;
		const full = start === null || start.startsWith(FULL_LISTING_PREFIX);
		const seen = new Map<string, RemoteItem>();
		let link = start;
		let deltaLink: string | undefined;
		for (let pages = 0; pages < MAX_DELTA_PAGES && deltaLink === undefined; pages++) {
			const page = await this.deps.remote.delta(link);
			// The last occurrence of an id wins [G-DL-6].
			for (const it of page.items) {
				seen.delete(it.id);
				seen.set(it.id, it);
			}
			if (page.deltaLink !== undefined) deltaLink = page.deltaLink;
			else if (page.nextLink !== undefined) link = page.nextLink;
			else throw new RunStop({ kind: "other", code: "delta-no-link" });
		}
		if (deltaLink === undefined) throw new RunStop({ kind: "other", code: "delta-too-many-pages" });

		// A full enumeration is the whole tree: anything not in it is gone. Otherwise merge the changes.
		const index: Record<string, RemoteItem> = {};
		if (!full) for (const [id, it] of Object.entries(state.remoteIndex)) defineEntry(index, id, it);
		const deleted = new Set<string>();
		for (const it of seen.values()) {
			if (it.deleted) {
				delete index[it.id];
				deleted.add(it.id);
			} else {
				defineEntry(index, it.id, it);
				deleted.delete(it.id);
			}
		}
		// A deleted folder takes its descendants with it, listed or not (M5 carry-in, design §5.2).
		if (deleted.size > 0) {
			const gone = new Map<string, boolean>();
			const isGone = (id: string): boolean => {
				const path: string[] = [];
				let cur: string | null = id;
				let result = false;
				while (cur !== null) {
					const known = gone.get(cur);
					if (known !== undefined) {
						result = known;
						break;
					}
					if (deleted.has(cur)) {
						result = true;
						break;
					}
					if (path.includes(cur)) break; // a cycle: leave it to buildRemoteTree (unresolved)
					path.push(cur);
					cur = own(index, cur) ? (index[cur]?.parentId ?? null) : null;
				}
				for (const p of path) gone.set(p, result);
				return result;
			};
			for (const id of Object.keys(index)) if (isGone(id)) delete index[id];
		}
		state.remoteIndex = index;
		state.deltaLink = deltaLink;
		return seen.size;
	}

	// ---------- scan (design §5.3) ----------

	/**
	 * Lists the vault and hashes what may have changed: files with a pending event, files whose size or mtime
	 * differ from their record, and files with no record. Files over the size cap are not read (the planner skips
	 * them). Files skipped for their name are hashed too, so a rename to such a name still matches its record.
	 */
	private async scan(state: SyncState, settings: EngineSettings): Promise<ScannedEntry[]> {
		const t0 = this.deps.clock.now();
		const dirty = new Set<string>();
		for (const ev of state.pendingLocal) {
			if (ev.kind === "dirty") dirty.add(ev.path.normalize("NFC"));
			else if (ev.kind === "renamed") dirty.add(ev.to.normalize("NFC"));
		}
		const out: ScannedEntry[] = [];
		let hashed = 0;
		for (const e of await this.deps.vault.list()) {
			if (e.isFolder) {
				out.push({ path: e.path, isFolder: true, size: 0, mtime: 0, localHash: null, storedHash: null });
				continue;
			}
			if (e.size > settings.maxFileSize) {
				out.push({ path: e.path, isFolder: false, size: e.size, mtime: e.mtime, localHash: null, storedHash: null });
				continue;
			}
			const p = e.path.normalize("NFC");
			const rec = own(state.files, p) ? state.files[p as VaultPath] : undefined;
			if (rec && !dirty.has(p) && rec.size === e.size && rec.mtime === e.mtime && rec.mtime !== 0 && rec.transformId === this.deps.transformId) {
				out.push({ path: e.path, isFolder: false, size: e.size, mtime: e.mtime, localHash: rec.localHash, storedHash: rec.remoteHash });
				continue;
			}
			const plain = await this.deps.vault.read(e.path);
			hashed++;
			out.push({
				path: e.path,
				isFolder: false,
				size: plain.byteLength,
				mtime: e.mtime,
				localHash: quickXorHash(plain),
				storedHash: await this.deps.content.storedHashOf(plain, p as VaultPath),
			});
		}
		this.logger.event("sync.scan", { count: hashed, durationMs: this.deps.clock.now() - t0 });
		return out;
	}
}
