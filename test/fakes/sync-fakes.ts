// Fakes shared by the M6 executor, engine and resume tests.
import { parseSyncState } from "../../src/core/state.ts";
import { loadState } from "../../src/core/state.ts";
import type { Clock, ContentTransform, StateStore, SyncState, TransformContext } from "../../src/core/ports.ts";

/** A clock whose sleeps resolve only when the test advances time past them. */
export class ManualClock implements Clock {
	t: number;
	private timers: { at: number; resolve: () => void }[] = [];
	constructor(t = Date.UTC(2026, 0, 5, 7, 8, 9)) {
		this.t = t;
	}
	now(): number {
		return this.t;
	}
	sleep(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise((resolve) => this.timers.push({ at: this.t + ms, resolve }));
	}
	/** Moves time forward and fires every sleep that is due. */
	async advance(ms: number): Promise<void> {
		this.t += ms;
		const due = this.timers.filter((x) => x.at <= this.t);
		this.timers = this.timers.filter((x) => x.at > this.t);
		for (const d of due) d.resolve();
		// Let the woken continuations run.
		for (let i = 0; i < 20; i++) await Promise.resolve();
	}
	get pending(): number {
		return this.timers.length;
	}
}

/**
 * In-memory StateStore holding the JSON a real store would write. Every save is checked with the real parser, so
 * a state the executor writes that `loadState` would reject (and silently replace with a union state) fails the
 * test instead.
 */
export class MemoryStateStore implements StateStore {
	json: string | null = null;
	saves = 0;
	/** When set, saves are dropped: models a killed process. */
	dead = false;
	private readonly configDir: string;
	constructor(configDir: string) {
		this.configDir = configDir;
	}
	load(): Promise<SyncState | null> {
		if (this.json === null) return Promise.resolve(null);
		return Promise.resolve(loadState(JSON.parse(this.json), this.configDir, "fresh-device"));
	}
	save(s: SyncState): Promise<void> {
		if (this.dead) return Promise.resolve();
		const json = JSON.stringify(s);
		if (parseSyncState(JSON.parse(json), this.configDir) === null) return Promise.reject(new Error("state-would-not-parse"));
		this.json = json;
		this.saves++;
		return Promise.resolve();
	}
	clear(): Promise<void> {
		this.json = null;
		return Promise.resolve();
	}
	get state(): SyncState | null {
		return this.json === null ? null : (JSON.parse(this.json) as SyncState);
	}
}

/** Non-identity test transform: XOR every byte (R-ENG-4). Deterministic, so resume stays valid. */
export class XorTransform implements ContentTransform {
	readonly id = "xor-test";
	encode(plain: ArrayBuffer, _ctx: TransformContext): Promise<ArrayBuffer> {
		return Promise.resolve(xor(plain));
	}
	decode(stored: ArrayBuffer, _ctx: TransformContext): Promise<ArrayBuffer> {
		return Promise.resolve(xor(stored));
	}
}

export function xor(b: ArrayBuffer): ArrayBuffer {
	const out = new Uint8Array(b.slice(0));
	for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) ^ 0x5a;
	return out.buffer;
}

export const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
export const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

/**
 * `target` with some methods replaced. Every other member is read from `target` and methods are bound to it, so the
 * fake's own state (ids, clocks) is never shadowed.
 */
export function withOverrides<T extends object>(target: T, overrides: Partial<Record<keyof T, unknown>>): T {
	return new Proxy(target, {
		get(t, prop) {
			if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop as keyof T];
			const v = Reflect.get(t, prop, t) as unknown;
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
		},
	});
}
