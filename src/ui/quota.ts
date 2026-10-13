// OneDrive storage for the settings tab (T-D7, design §10) [G-QT-1]. Pure: the text, and a small cache so that
// re-rendering settings doesn't call Graph each time. Recycle-bin bytes count toward the quota [G-DEL-2].
export interface Quota {
	total: number;
	used: number;
	remaining: number;
}

/** Warn when this share of the drive or less is free. */
export const LOW_SPACE_FRACTION = 0.1;
/** How long a read is reused (5 minutes). */
export const QUOTA_TTL_MS = 5 * 60_000;

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** Binary units (1 GB = 1024³ bytes), one decimal below 10. */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 1) return "0 bytes";
	if (n < 1024) return n === 1 ? "1 byte" : `${Math.floor(n)} bytes`;
	let v = n;
	let unit: string = UNITS[0];
	for (const u of UNITS) {
		v /= 1024;
		unit = u;
		if (v < 1024) break;
	}
	const s = v < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toString();
	return `${s} ${unit}`;
}

export function quotaText(q: Quota | null): { text: string; warn: boolean } {
	if (q === null) return { text: "Not available for this sign-in.", warn: false };
	const base = `${formatBytes(q.used)} used of ${formatBytes(q.total)} (${formatBytes(q.remaining)} free).`;
	if (q.remaining <= 0) {
		return { text: `${base} OneDrive is full. Sync stops uploading until you free up space, including the recycle bin.`, warn: true };
	}
	if (q.remaining <= q.total * LOW_SPACE_FRACTION) {
		return { text: `${base} OneDrive is almost full. Free up space, including the recycle bin, before sync stops uploading.`, warn: true };
	}
	return { text: `${base} The recycle bin counts toward this.`, warn: false };
}

/** Reuses one read for QUOTA_TTL_MS and shares a read in flight. Failures aren't cached. */
export class QuotaCache {
	private readonly fetch: () => Promise<Quota | null>;
	private readonly now: () => number;
	private value: { at: number; q: Quota | null } | null = null;
	private inflight: Promise<Quota | null> | null = null;
	/** Bumped by invalidate(); a read started before it doesn't fill the cache. */
	private gen = 0;

	constructor(fetch: () => Promise<Quota | null>, now: () => number) {
		this.fetch = fetch;
		this.now = now;
	}

	get(): Promise<Quota | null> {
		if (this.value && this.now() - this.value.at < QUOTA_TTL_MS) return Promise.resolve(this.value.q);
		if (this.inflight) return this.inflight;
		const gen = this.gen;
		const p = this.fetch().then(
			(q) => {
				if (gen === this.gen) {
					this.value = { at: this.now(), q };
					this.inflight = null;
				}
				return q;
			},
			(e: unknown) => {
				if (gen === this.gen) this.inflight = null;
				throw e;
			},
		);
		this.inflight = p;
		return p;
	}

	/** After sign-out (another account may follow) or a sync that found the drive full. */
	invalidate(): void {
		this.gen++;
		this.value = null;
		this.inflight = null;
	}
}
