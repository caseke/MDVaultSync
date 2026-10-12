// StateStore over `<plugin dir>/sync-state.json` (design §12). Written through the adapter, because the plugin
// folder is under configDir, which the Vault API doesn't serve: a temp file, then a rename into place. The file
// is untrusted on load (T-T6): a missing file is "no state"; a damaged or edited one gives a fresh union state
// that keeps the device id (state.ts loadState).
import { loadState } from "../core/state.ts";
import type { StateStore, SyncState } from "../core/ports.ts";
import { replaceInto } from "./atomic.ts";

export interface StateAdapterLike {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export interface PluginStateStoreOptions {
	adapter: StateAdapterLike;
	/** The plugin's folder, e.g. `<configDir>/plugins/mdvaultsync`. */
	dir: string;
	configDir: string;
	newDeviceId: () => string;
}

export class StateClearError extends Error {
	constructor() {
		super("state-clear-failed");
		this.name = "StateClearError";
	}
}

export class PluginStateStore implements StateStore {
	private readonly adapter: StateAdapterLike;
	private readonly file: string;
	private readonly tmp: string;
	private readonly configDir: string;
	private readonly newDeviceId: () => string;
	/** Saves and clears run one at a time, so a clear can't be overtaken by a save already in progress (R-AUTH-7). */
	private chain: Promise<void> = Promise.resolve();

	constructor(opts: PluginStateStoreOptions) {
		this.adapter = opts.adapter;
		this.file = `${opts.dir}/sync-state.json`;
		this.tmp = `${opts.dir}/sync-state.json.tmp`;
		this.configDir = opts.configDir;
		this.newDeviceId = opts.newDeviceId;
	}

	async load(): Promise<SyncState | null> {
		// A crash inside the rename fallback can leave only the temp file (atomic.ts): it holds the latest save.
		let source = this.file;
		if (!(await this.adapter.exists(source))) {
			if (!(await this.adapter.exists(this.tmp))) return null;
			source = this.tmp;
		}
		let raw: unknown = null;
		try {
			raw = JSON.parse(await this.adapter.read(source));
		} catch {
			raw = null; // unreadable or not JSON: a fresh union state (T-T6)
		}
		return loadState(raw, this.configDir, this.newDeviceId());
	}

	/** Serializes before the first await, so the snapshot is the state at the call (Saver relies on this). */
	save(s: SyncState): Promise<void> {
		const json = JSON.stringify(s);
		return this.queue(() => this.write(json));
	}

	private queue(job: () => Promise<void>): Promise<void> {
		const run = this.chain.catch(() => undefined).then(job);
		this.chain = run;
		return run;
	}

	private async write(json: string): Promise<void> {
		await this.adapter.write(this.tmp, json);
		await replaceInto(this.adapter, this.tmp, this.file);
	}

	clear(): Promise<void> {
		return this.queue(async () => {
			for (const p of [this.file, this.tmp]) if (await this.adapter.exists(p)) await this.adapter.remove(p);
			if ((await this.adapter.exists(this.file)) || (await this.adapter.exists(this.tmp))) throw new StateClearError();
		});
	}
}
