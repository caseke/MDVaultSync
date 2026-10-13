// One device for engine tests: a FakeVault, a MemoryStateStore and an Engine over a shared FakeRemote, plus
// crash injection (a "killed process": after N mutating calls every call throws and no state is saved).
import { Engine, DEFAULT_ENGINE_SETTINGS, type EngineSettings } from "../../src/core/engine.ts";
import { TransformedRemoteContent } from "../../src/core/remote-content.ts";
import { IdentityTransform } from "../../src/core/transform.ts";
import type { ContentTransform, EngineStatus, Plan, PlanOp, RemotePort, SyncReport, Trigger, VaultPort } from "../../src/core/ports.ts";
import { classifyError } from "../../src/remote/classify.ts";
import type { FakeRemote } from "./fake-remote.ts";
import { FakeVault } from "./fake-vault.ts";
import { CFG } from "./plan-fixtures.ts";
import { ManualClock, MemoryStateStore } from "./sync-fakes.ts";

export const UNIT = 327_680;

export class Crash extends Error {
	constructor() {
		super("crash");
		this.name = "Crash";
	}
}

const VAULT_MUTATORS = new Set(["writeAtomic", "mkdirp", "move", "trash", "removeEmptyFolder"]);
const REMOTE_MUTATORS = new Set(["createFolder", "uploadNew", "uploadReplace", "move", "delete", "createUploadSession", "putFragment"]);

/** Counts mutating calls across a vault and a remote; after `limit` of them the process "dies". */
export class CrashSwitch {
	limit = Number.POSITIVE_INFINITY;
	count = 0;
	dead = false;
	onDeath: (() => void)[] = [];

	wrap<T extends object>(target: T, mutators: Set<string>): T {
		return new Proxy(target, {
			get: (t, prop) => {
				const v = Reflect.get(t, prop, t) as unknown;
				if (typeof v !== "function") return v;
				return (...args: unknown[]) => {
					if (this.dead) return Promise.reject(new Crash());
					if (mutators.has(String(prop))) {
						if (this.count >= this.limit) {
							this.dead = true;
							for (const f of this.onDeath) f();
							return Promise.reject(new Crash());
						}
						this.count++;
					}
					return (v as (...a: unknown[]) => unknown).apply(t, args);
				};
			},
		});
	}
}

export interface DeviceOptions {
	name?: string;
	transform?: ContentTransform;
	settings?: Partial<EngineSettings>;
	confirmPlan?: (p: Plan) => Promise<boolean>;
	confirmDeletes?: (ops: PlanOp[]) => Promise<boolean>;
	/** Wraps the remote this device talks to (fault injection). */
	remote?: (r: RemotePort) => RemotePort;
	crash?: CrashSwitch | undefined;
	putHonorsIfMatch?: boolean;
	concurrency?: number;
}

export class Device {
	readonly vault: FakeVault;
	readonly store: MemoryStateStore;
	readonly clock = new ManualClock();
	readonly statuses: EngineStatus[] = [];
	readonly plans: Plan[] = [];
	readonly deletePrompts: PlanOp[][] = [];
	readonly reports: SyncReport[] = [];
	engine!: Engine;
	private readonly shared: FakeRemote;
	private readonly opts: DeviceOptions;

	constructor(remote: FakeRemote, opts: DeviceOptions = {}, vault?: FakeVault, store?: MemoryStateStore) {
		this.shared = remote;
		this.opts = opts;
		this.vault = vault ?? new FakeVault({ configDir: CFG });
		this.store = store ?? new MemoryStateStore(CFG);
		this.restart();
	}

	/** A fresh Engine over the same vault, remote and saved state: what a restarted Obsidian would have. */
	restart(opts: Partial<DeviceOptions> = {}): Engine {
		const o = { ...this.opts, ...opts };
		let remote: RemotePort = o.remote ? o.remote(this.shared) : this.shared;
		let vault: VaultPort = this.vault;
		if (o.crash) {
			remote = o.crash.wrap(remote, REMOTE_MUTATORS);
			vault = o.crash.wrap(vault, VAULT_MUTATORS);
			o.crash.onDeath.push(() => (this.store.dead = true));
		} else this.store.dead = false;
		const transform = o.transform ?? new IdentityTransform();
		this.engine = new Engine({
			remote,
			content: new TransformedRemoteContent(remote, transform, {
				putHonorsIfMatch: o.putHonorsIfMatch ?? true,
				classify: classifyError,
				simpleMax: UNIT,
				fragmentSize: UNIT,
			}),
			vault,
			store: this.store,
			hooks: {
				confirmPlan: (p) => {
					this.plans.push(p);
					return o.confirmPlan ? o.confirmPlan(p) : Promise.resolve(true);
				},
				confirmDeletes: (ops) => {
					this.deletePrompts.push(ops);
					return o.confirmDeletes ? o.confirmDeletes(ops) : Promise.resolve(true);
				},
				onStatus: (s) => this.statuses.push(s),
				onReport: (r) => this.reports.push(r),
			},
			clock: this.clock,
			classify: classifyError,
			configDir: CFG,
			transformId: transform.id,
			ensureSignedIn: () => Promise.resolve(),
			resetBudget: () => {},
			settings: () => ({ ...DEFAULT_ENGINE_SETTINGS, deviceName: o.name ?? "iPad", ...o.settings }),
			newDeviceId: () => "device-" + (o.name ?? "iPad"),
			...(o.concurrency !== undefined ? { concurrency: o.concurrency } : {}),
		});
		return this.engine;
	}

	sync(trigger: Trigger = "command"): Promise<SyncReport> {
		return this.engine.requestSync(trigger);
	}
}

/** Path → text for every file in a vault. */
export function vaultFiles(v: FakeVault): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [p, f] of [...v.files].sort(([a], [b]) => (a < b ? -1 : 1))) out[p] = new TextDecoder().decode(f.data);
	return out;
}

/** Path → text for every file in the remote (stored bytes, decoded as UTF-8). */
export function remoteFiles(r: FakeRemote): Record<string, string> {
	const idx = r.index();
	const out: Record<string, string> = {};
	const pathOf = (id: string): string => {
		const it = idx[id];
		if (!it || it.parentId === null) return "";
		const parent = pathOf(it.parentId);
		return parent === "" ? it.name : `${parent}/${it.name}`;
	};
	const entries: [string, string][] = [];
	for (const it of Object.values(idx)) if (!it.isFolder) entries.push([pathOf(it.id), r.contentAt(pathOf(it.id)) ?? ""]);
	for (const [p, c] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) out[p] = c;
	return out;
}
