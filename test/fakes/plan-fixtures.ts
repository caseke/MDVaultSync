// Shared set-up for the planner tests: one device's FakeVault, the shared FakeRemote, and the SyncState a
// finished sync would have left behind.
import { plan, type PlanSettings, type ScannedEntry } from "../../src/core/planner.ts";
import { emptyState } from "../../src/core/state.ts";
import { quickXorHash } from "../../src/core/quickxor.ts";
import type { FileRecord, Plan, PlanOp, RemoteItem, SyncState, VaultPath } from "../../src/core/ports.ts";
import { APPROOT_ID, FakeRemote } from "./fake-remote.ts";
import { FakeVault } from "./fake-vault.ts";

/** A renamed configDir that doesn't start with a dot, so the planner's configDir check is exercised on its own. */
export const CFG = "obs-config";
export const DATE = new Date(2026, 0, 5, 7, 8, 9);
export const STAMP = "2026-01-05 070809";
export const SETTINGS: PlanSettings = {
	configDir: CFG,
	excludePatterns: [],
	maxFileSize: 100 * 1024 * 1024,
	pathPrefixLen: 16, // "Apps/MDVaultSync"
	deviceName: "iPad",
	now: DATE,
	reofferDeclined: false,
};

export const vp = (s: string) => s as VaultPath;
export const hashOf = (s: string) => quickXorHash(new TextEncoder().encode(s).buffer);

export interface World {
	vault: FakeVault;
	remote: FakeRemote;
	state: SyncState;
}

/** Remote paths of live items, by id (approot excluded). */
export function remotePaths(index: Record<string, RemoteItem>): Map<string, string> {
	const out = new Map<string, string>();
	const pathOf = (id: string): string | null => {
		if (id === APPROOT_ID) return "";
		const it = index[id];
		if (!it || it.parentId === null) return null;
		const parent = pathOf(it.parentId);
		return parent === null ? null : parent === "" ? it.name : `${parent}/${it.name}`;
	};
	for (const id of Object.keys(index)) {
		const p = pathOf(id);
		if (p) out.set(id, p);
	}
	return out;
}

/**
 * Records every path that has the same content locally and remotely, as a completed sync would. The result is a
 * normal (not union) state whose remoteIndex is the remote's current tree.
 */
export function baseline(w: World): void {
	const index = w.remote.index();
	const s = w.state;
	s.appRootId = APPROOT_ID;
	s.unionPending = false;
	s.firstSyncCompleted = true;
	s.remoteIndex = index;
	s.files = {};
	s.folders = {};
	for (const [id, path] of remotePaths(index)) {
		const it = index[id];
		if (!it) continue;
		if (it.isFolder) {
			if (w.vault.folders.has(path) || [...w.vault.files.keys()].some((p) => p.startsWith(path + "/"))) s.folders[vp(path)] = id;
			continue;
		}
		const f = w.vault.files.get(path);
		if (!f) continue;
		const localHash = quickXorHash(f.data.slice().buffer);
		if (it.quickXorHash !== null && it.quickXorHash !== localHash) continue;
		s.files[vp(path)] = recordFor(path, it, localHash, f.data.length, f.mtime);
	}
}

export function recordFor(path: string, it: RemoteItem, localHash: string, size: number, mtime: number): FileRecord {
	return {
		path: vp(path),
		remoteId: it.id,
		eTag: it.eTag,
		cTag: it.cTag,
		size,
		mtime,
		localHash,
		remoteHash: it.quickXorHash ?? localHash,
		transformId: "identity",
	};
}

/** A synced world holding `files` (path → content) on both sides. */
export function world(files: Record<string, string> = {}, folders: string[] = []): World {
	const w: World = { vault: new FakeVault({ configDir: CFG }), remote: new FakeRemote(), state: emptyState("device-1") };
	for (const [p, c] of Object.entries(files)) {
		w.vault.write(p, c);
		w.remote.putFile(p, c);
	}
	for (const f of folders) {
		w.vault.folders.add(f);
		w.remote.mkdir(f);
	}
	baseline(w);
	return w;
}

export async function run(w: World, settings: Partial<PlanSettings> = {}, local?: ScannedEntry[]): Promise<Plan> {
	return plan(w.state, local ?? (await w.vault.scan()), w.remote.index(), { ...SETTINGS, ...settings });
}

/** One readable line per op, so tests compare whole plans. */
export function line(op: PlanOp): string {
	switch (op.kind) {
		case "local-move":
		case "remote-move":
			return `${op.kind} ${op.from} -> ${op.to}`;
		case "conflict":
			return `conflict ${op.path} => ${op.copyPath}`;
		case "skip":
			return `skip ${op.path} (${op.reason})`;
		default:
			return `${op.kind} ${op.path}`;
	}
}

export function lines(p: Plan): string[] {
	return p.ops.map(line);
}
