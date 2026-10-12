// Remote paths from the delta index (design §5.2): each item's path is rebuilt from its parentId chain up to the
// approot [G-DL-6], [G-DL-7]. Items whose chain doesn't reach the approot (orphans, cycles) are dropped. Every
// rebuilt name chain goes through remoteToVaultPath, so a hostile name becomes a skip, never a write (T-T1, T-E1).
// Pure: no Obsidian import.
import { caseKey, remoteToVaultPath } from "./paths.ts";
import type { RemoteItem, SkipReason, VaultPath } from "./ports.ts";

export interface RemoteEntry {
	item: RemoteItem;
	path: VaultPath;
}

export interface RemoteSkip {
	id: string;
	/** For the report only: the names joined with "/". Never used as a write target. */
	displayPath: VaultPath;
	reason: SkipReason;
	isFolder: boolean;
	/** The vault path the item would have had, when it has one (collisions); used to block that path. */
	mapped: VaultPath | null;
}

export interface RemoteTree {
	/** Live, valid items (approot excluded), by id. */
	byId: Map<string, RemoteEntry>;
	skipped: RemoteSkip[];
	skippedIds: Map<string, SkipReason>;
	/** Live children per folder id, skipped ones included (R-DEL-3). */
	childCount: Map<string, number>;
	/**
	 * Live items whose parent chain doesn't reach the approot and ends at a missing id or a cycle. They are not known
	 * to be deleted, so the planner must not treat their absence from the tree as a delete. Items under a deleted
	 * (tombstoned) folder are not in this set: they are gone with the folder.
	 */
	unresolvedIds: Set<string>;
}

interface Pending {
	item: RemoteItem;
	segments: string[];
	/** Inherited from a skipped ancestor: a child of a folder we can't create can't be written either. */
	inherited: SkipReason | null;
}

/**
 * Builds the tree under `appRootId`. Sibling names that collide after NFC (`unicode-collision`) or after
 * `caseKey` (`case-collision`) are all skipped (M4 carry-in); a skipped folder takes its descendants with it.
 */
export function buildRemoteTree(index: Readonly<Record<string, RemoteItem>>, appRootId: string | null, configDir: string, pathPrefixLen: number): RemoteTree {
	const tree: RemoteTree = { byId: new Map(), skipped: [], skippedIds: new Map(), childCount: new Map(), unresolvedIds: new Set() };
	const children = new Map<string, RemoteItem[]>();
	for (const it of Object.values(index)) {
		if (it.deleted || it.parentId === null || it.id === appRootId) continue;
		const list = children.get(it.parentId) ?? [];
		list.push(it);
		children.set(it.parentId, list);
	}
	for (const [parentId, list] of children) tree.childCount.set(parentId, list.length);
	const live = Object.values(index).filter((it) => !it.deleted && it.id !== appRootId);
	if (appRootId === null) {
		for (const it of live) tree.unresolvedIds.add(it.id);
		return tree;
	}

	const skip = (p: Pending, reason: SkipReason, mapped: VaultPath | null) => {
		tree.skipped.push({ id: p.item.id, displayPath: p.segments.join("/") as VaultPath, reason, isFolder: p.item.isFolder, mapped });
		tree.skippedIds.set(p.item.id, reason);
	};

	// Breadth-first from the approot; `seen` stops cycles (a cycle can't reach the approot anyway).
	const seen = new Set<string>([appRootId]);
	let level: { id: string; segments: string[]; inherited: SkipReason | null }[] = [{ id: appRootId, segments: [], inherited: null }];
	while (level.length > 0) {
		const next: typeof level = [];
		for (const parent of level) {
			const kids = (children.get(parent.id) ?? []).filter((k) => !seen.has(k.id));
			for (const k of kids) seen.add(k.id);
			const pending: Pending[] = kids
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
				.map((item) => ({ item, segments: [...parent.segments, item.name], inherited: parent.inherited }));

			const mapped = new Map<Pending, VaultPath>();
			for (const p of pending) {
				if (p.inherited) {
					skip(p, p.inherited, null);
					continue;
				}
				const r = remoteToVaultPath(p.segments, configDir, pathPrefixLen, p.item.isFolder);
				if (r.ok) mapped.set(p, r.path);
				else skip(p, r.reason, null);
			}
			// Collisions among siblings. Distinct parents can't share a path: colliding parents are skipped above.
			const byPath = new Map<string, Pending[]>();
			const byCase = new Map<string, Pending[]>();
			for (const [p, path] of mapped) {
				byPath.set(path, [...(byPath.get(path) ?? []), p]);
				byCase.set(caseKey(path), [...(byCase.get(caseKey(path)) ?? []), p]);
			}
			const losers = new Map<Pending, SkipReason>();
			for (const group of byPath.values()) if (group.length > 1) for (const p of group) losers.set(p, "unicode-collision");
			for (const group of byCase.values()) if (group.length > 1) for (const p of group) if (!losers.has(p)) losers.set(p, "case-collision");

			for (const p of pending) {
				const path = mapped.get(p);
				const reason = losers.get(p);
				if (reason) skip(p, reason, path ?? null);
				else if (path) tree.byId.set(p.item.id, { item: p.item, path });
				if (p.item.isFolder) next.push({ id: p.item.id, segments: p.segments, inherited: reason ?? (path ? null : tree.skippedIds.get(p.item.id) ?? null) });
			}
		}
		level = next;
	}
	// A live item the walk didn't reach is "unresolved" only if its chain ends at a missing id or a cycle. Under a
	// tombstoned ancestor it is gone with that folder (a real delete), so it stays out of the set (security review).
	const underTombstone = (it: RemoteItem): boolean => {
		const visited = new Set<string>();
		let parentId = it.parentId;
		while (parentId !== null && !visited.has(parentId)) {
			visited.add(parentId);
			// Own keys only: an id like "constructor" passes ID_RE and must not find Object.prototype's.
			const parent = Object.prototype.hasOwnProperty.call(index, parentId) ? index[parentId] : undefined;
			if (!parent || parentId === appRootId) return false;
			if (parent.deleted) return true;
			parentId = parent.parentId;
		}
		return false;
	};
	for (const it of live) if (!seen.has(it.id) && !underTombstone(it)) tree.unresolvedIds.add(it.id);
	return tree;
}
