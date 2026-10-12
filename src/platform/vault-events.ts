// Vault events → PendingLocalOp (R-CD-2, design §3). Registered in onLayoutReady only: before it, Obsidian sends
// a create event for every file while it indexes the vault [O-API-12]. Events for syncable paths are never dropped,
// including the echoes of our own writes; the scan resolves those by hash (T-D8). Only hidden, configDir and
// excluded paths are ignored, because they are never synced. A rename to a name OneDrive refuses stays a rename
// hint: the planner decides (it keeps the record instead of deleting the remote copy, design §5.4).
//
// Structural types only, so this runs under node --test; main.ts passes app.vault.
import { exclusionReason } from "../core/exclude.ts";
import { toVaultPath } from "../core/paths.ts";
import type { PendingLocalOp, VaultPath } from "../core/ports.ts";

export type VaultEvent =
	| { type: "create" | "modify" | "delete"; path: string; isFolder: boolean }
	| { type: "rename"; path: string; oldPath: string; isFolder: boolean };

export interface VaultEventEmitter {
	on(name: "create" | "modify" | "delete" | "rename", callback: (file: unknown, oldPath?: unknown) => unknown): unknown;
}

export interface VaultEventOptions {
	configDir: string;
	patterns: () => readonly string[];
	sink: (op: PendingLocalOp) => void;
}

function syncable(path: string, isFolder: boolean, configDir: string, patterns: readonly string[]): boolean {
	const p = toVaultPath(path);
	return p !== null && exclusionReason(p, configDir, patterns, isFolder) === null;
}

export function eventToOps(ev: VaultEvent, configDir: string, patterns: readonly string[]): PendingLocalOp[] {
	const to = syncable(ev.path, ev.isFolder, configDir, patterns);
	const path = ev.path as VaultPath;
	if (ev.type !== "rename") {
		if (!to) return [];
		return [ev.type === "delete" ? { kind: "deleted", path } : { kind: "dirty", path }];
	}
	const from = syncable(ev.oldPath, ev.isFolder, configDir, patterns);
	if (from && to) return [{ kind: "renamed", from: ev.oldPath as VaultPath, to: path }];
	// Moving a note into .trash or an excluded folder is a delete; moving one out of it is a new file.
	if (from) return [{ kind: "deleted", path: ev.oldPath as VaultPath }];
	if (to) return [{ kind: "dirty", path }];
	return [];
}

function fileInfo(f: unknown): { path: string; isFolder: boolean } | null {
	if (typeof f !== "object" || f === null || !("path" in f) || typeof f.path !== "string") return null;
	return { path: f.path, isFolder: "children" in f };
}

/** Wires the four vault events; each handler goes through `register` (Plugin.registerEvent) for cleanup. */
export function registerVaultEvents(vault: VaultEventEmitter, register: (ref: unknown) => void, opts: VaultEventOptions): void {
	const emit = (ev: VaultEvent) => {
		for (const op of eventToOps(ev, opts.configDir, opts.patterns())) opts.sink(op);
	};
	for (const type of ["create", "modify", "delete"] as const) {
		register(
			vault.on(type, (file) => {
				const f = fileInfo(file);
				if (f) emit({ type, ...f });
			}),
		);
	}
	register(
		vault.on("rename", (file, oldPath) => {
			const f = fileInfo(file);
			if (f && typeof oldPath === "string") emit({ type: "rename", oldPath, ...f });
		}),
	);
}
