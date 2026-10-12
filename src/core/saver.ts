// Batched state saves (R-RES-3, design §5.5): progress is saved at most one second after each completed op,
// immediately before every destructive op (flush), and at the end. Saves are serialized; each one hands the
// store the live state, which StateStore.save must serialize before its first await.
import type { Logger } from "./logger.ts";
import type { Clock, StateStore, SyncState } from "./ports.ts";

export interface SaverOptions {
	store: StateStore;
	clock: Clock;
	state: () => SyncState | null;
	intervalMs?: number;
	/** False after sign-out: a run that started before it must not write state back (R-AUTH-7). */
	live?: () => boolean;
	logger?: Logger;
}

export class Saver {
	private readonly store: StateStore;
	private readonly clock: Clock;
	private readonly state: () => SyncState | null;
	private readonly interval: number;
	private readonly live: () => boolean;
	private readonly logger: Logger | undefined;
	private scheduled = false;
	private lastSave = Number.NEGATIVE_INFINITY;
	private chain: Promise<void> = Promise.resolve();

	constructor(opts: SaverOptions) {
		this.store = opts.store;
		this.clock = opts.clock;
		this.state = opts.state;
		this.interval = opts.intervalMs ?? 1000;
		this.live = opts.live ?? (() => true);
		this.logger = opts.logger;
	}

	/** Something changed: save within `intervalMs`. */
	dirty(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		const wait = Math.max(0, this.interval - (this.clock.now() - this.lastSave));
		void this.clock
			.sleep(wait)
			.then(() => (this.scheduled ? this.flush() : undefined))
			// A failed background save is retried by the next flush; the error is logged by flush.
			.catch(() => undefined);
	}

	/** Saves now (after any save in progress). Rejects if the store does. */
	flush(): Promise<void> {
		this.scheduled = false;
		const run = this.chain.catch(() => undefined).then(async () => {
			if (!this.live()) return;
			const s = this.state();
			if (!s) return;
			const t0 = this.clock.now();
			try {
				await this.store.save(s);
			} catch (e) {
				this.logger?.event("state.save", { code: "failed" });
				throw e;
			}
			this.lastSave = this.clock.now();
			this.logger?.event("state.save", { durationMs: this.lastSave - t0 });
		});
		this.chain = run;
		return run;
	}
}
