// The sync planner (design §5.4): a three-way diff of base (FileRecord), local scan and remote index into a
// Plan. Pure and deterministic: no I/O, no clock reads, no Obsidian import. The executor (M6) runs the plan.
//
// Order of work:
//  1. Filter every local, remote and base path (exclusions, path rules, size cap, collisions). A rejected path
//     becomes a `skip` op and *blocks its key*: nothing at a blocked key is ever transferred or deleted, so a skip
//     can never delete the other side (T-D1).
//  2. Folder renames collapse into one move (local → remote-move, remote → local-move).
//  3. File renames and moves are matched by item id (remote) and by vault events or a unique hash match (local).
//  4. The three-way table runs on what is left, keyed by `caseKey`, since OneDrive names are case-insensitive.
//  5. Folders: create, adopt, delete only when empty (R-DEL-3), forget.
// Union mode (first sync, resync, approot change) turns every delete into a restore (R-FIRST-1).
import { conflictCopyPath } from "./conflict-name.ts";
import { exclusionReason } from "./exclude.ts";
import { caseKey, containmentProblem, findCollisions, toVaultPath, validatePath } from "./paths.ts";
import type { FileRecord, PendingConflict, Plan, PlanOp, RemoteItem, SkipReason, SyncState, VaultPath } from "./ports.ts";
import { buildRemoteTree } from "./remote-tree.ts";

/** One entry from the local scan (M6). `path` is as the vault reported it, before NFC. */
export interface ScannedEntry {
	path: string;
	isFolder: boolean;
	size: number;
	mtime: number;
	/** QuickXorHash of the plaintext. Required for files that aren't skipped; null for folders. */
	localHash: string | null;
	/** Hash the bytes would have remotely: `RemoteContent.storedHashOf` (D-10). Equals localHash under identity. */
	storedHash: string | null;
}

export interface PlanSettings {
	configDir: string;
	excludePatterns: readonly string[];
	/** Size cap in bytes (R-SCOPE-3). */
	maxFileSize: number;
	/** `AppRoot.pathPrefix` length without its leading "/" [G-NM-4]. */
	pathPrefixLen: number;
	/** For conflict copy names (R-CONF-1). */
	deviceName: string;
	/** For conflict copy names; passed in so the planner never reads the clock. */
	now: Date;
	/** "Sync now" re-offers deletes the user declined before (R-GUARD-1). */
	reofferDeclined: boolean;
}

interface Local {
	path: VaultPath;
	isFolder: boolean;
	size: number;
	localHash: string;
	storedHash: string;
}

interface Remote {
	item: RemoteItem;
	path: VaultPath;
}

interface Base {
	rec: FileRecord;
	/** The record's path, rewritten when a folder collapse moves it. */
	path: VaultPath;
}

interface FolderBase {
	id: string;
	path: VaultPath;
}

interface Emitted {
	sort: string;
	seq: number;
	op: PlanOp;
}

const nfc = (s: string) => s.normalize("NFC");
/** Own-key lookup (ES2021 has no Object.hasOwn): a note named "constructor" must not find the prototype's. */
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const keyOf = (p: string) => caseKey(nfc(p));
const isUnder = (key: string, prefixKey: string) => key.startsWith(prefixKey + "/");

function replacePrefix(path: VaultPath, prefixSegments: number, newPrefix: string): VaultPath {
	return [newPrefix, ...path.split("/").slice(prefixSegments)].join("/") as VaultPath;
}

/** Remote content changed since the base (design §5.4 "Changed R"): hash, then cTag, then size and eTag. */
function changedR(rec: FileRecord, r: RemoteItem): boolean {
	if (r.id !== rec.remoteId) return true; // a different item now holds the path
	if (r.quickXorHash !== null) return r.quickXorHash !== rec.remoteHash;
	if (r.cTag !== null && rec.cTag !== null) return r.cTag !== rec.cTag;
	return r.size !== rec.size || r.eTag !== rec.eTag;
}

/** Same stored bytes on both sides. A null remote hash is equal only for zero-byte files [G-DL-8]. */
function sameContent(l: Local, r: RemoteItem): boolean {
	if (r.quickXorHash !== null) return l.storedHash === r.quickXorHash;
	return l.size === 0 && r.size === 0;
}

/** True when the plan's deletes need the user's confirmation: deletes > max(1, ceil(tracked × pct)) (R-GUARD-1). */
export function exceedsDeleteGuard(plan: Plan, thresholdPct: number): boolean {
	return plan.deleteCount > Math.max(1, Math.ceil((plan.trackedCount * thresholdPct) / 100));
}

export function plan(state: SyncState, local: readonly ScannedEntry[], remoteIndex: Readonly<Record<string, RemoteItem>>, settings: PlanSettings): Plan {
	const { configDir, excludePatterns, maxFileSize, pathPrefixLen } = settings;
	// Without an approot id the remote view is empty; acting on that could only delete (security review).
	const union = state.unionPending || !state.firstSyncCompleted || state.appRootId === null;

	const skips: Emitted[] = [];
	const ops: Emitted[] = [];
	const skipSeen = new Set<string>();
	let seq = 0;
	let deleteCount = 0;
	let differsNoHistory = 0;

	const blocked = new Map<string, SkipReason>();
	const skip = (path: string, reason: SkipReason) => {
		const id = `${path}\u0000${reason}`;
		if (skipSeen.has(id)) return;
		skipSeen.add(id);
		skips.push({ sort: keyOf(path), seq: seq++, op: { kind: "skip", path: path as VaultPath, reason } });
	};
	const block = (key: string, reason: SkipReason) => {
		if (!blocked.has(key)) blocked.set(key, reason);
	};
	const emit = (sortPath: string, op: PlanOp) => ops.push({ sort: keyOf(sortPath), seq: seq++, op });

	// ---------- 1a. local entries ----------
	const tracked = new Set<string>(Object.keys(state.files));
	const collisions = findCollisions(
		local.map((e) => e.path),
		tracked,
	);
	const localFiles = new Map<string, Local>();
	const localFolders = new Map<string, Local>();
	const localSkips: { key: string; entry: ScannedEntry; reason: SkipReason }[] = [];
	/** Keys of every local entry and all their ancestors, skipped ones included: "this folder isn't empty". */
	const localAncestors = new Set<string>();
	for (const e of local) {
		const segs = keyOf(e.path).split("/");
		for (let i = 1; i < segs.length; i++) localAncestors.add(segs.slice(0, i).join("/"));

		const p = toVaultPath(e.path);
		let reason: SkipReason | null = collisions.get(e.path) ?? null;
		if (!reason && (p === null || containmentProblem(p, configDir) === "outside-vault")) reason = "outside-vault";
		if (!reason && p) reason = exclusionReason(p, configDir, excludePatterns, e.isFolder) ?? validatePath(p, pathPrefixLen, e.isFolder);
		if (!reason && !e.isFolder && e.size > maxFileSize) reason = "too-large";
		if (reason || !p) {
			skip(e.path, reason ?? "outside-vault");
			localSkips.push({ key: keyOf(e.path), entry: e, reason: reason ?? "outside-vault" });
			continue;
		}
		if (e.isFolder) {
			localFolders.set(keyOf(p), { path: p, isFolder: true, size: 0, localHash: "", storedHash: "" });
			continue;
		}
		if (e.localHash === null || e.storedHash === null) throw new Error("scan-incomplete");
		localFiles.set(keyOf(p), { path: p, isFolder: false, size: e.size, localHash: e.localHash, storedHash: e.storedHash });
	}
	for (const s of localSkips) if (!localFiles.has(s.key) && !localFolders.has(s.key)) block(s.key, s.reason);

	// ---------- 1b. remote items ----------
	const tree = buildRemoteTree(remoteIndex, state.appRootId, configDir, pathPrefixLen);
	const skippedRemoteIds = new Map(tree.skippedIds);
	for (const s of tree.skipped) {
		skip(s.displayPath, s.reason);
		if (s.mapped) block(keyOf(s.mapped), s.reason);
	}
	const remoteFiles = new Map<string, Remote>();
	const remoteFolders = new Map<string, Remote>();
	const remoteById = new Map<string, Remote>();
	for (const { item, path } of tree.byId.values()) {
		const reason = exclusionReason(path, configDir, excludePatterns, item.isFolder) ?? (!item.isFolder && item.size > maxFileSize ? "too-large" : null);
		if (reason) {
			skip(path, reason);
			block(keyOf(path), reason);
			skippedRemoteIds.set(item.id, reason);
			continue;
		}
		const r: Remote = { item, path };
		(item.isFolder ? remoteFolders : remoteFiles).set(keyOf(path), r);
		remoteById.set(item.id, r);
	}

	// ---------- 1c. bases ----------
	const fileBases = new Map<string, Base>();
	const folderBases = new Map<string, FolderBase>();
	// A live item the tree couldn't place (parent missing from the index, or a cycle) isn't known to be deleted:
	// its base is blocked, never trashed (security review). It is outside the approot tree as far as we know.
	const baseProblem = (path: VaultPath, isFolder: boolean, remoteId: string): SkipReason | null =>
		exclusionReason(path, configDir, excludePatterns, isFolder) ??
		validatePath(path, pathPrefixLen, isFolder) ??
		skippedRemoteIds.get(remoteId) ??
		(tree.unresolvedIds.has(remoteId) ? "outside-vault" : null);
	for (const rec of Object.values(state.files)) {
		const key = keyOf(rec.path);
		const reason = baseProblem(rec.path, false, rec.remoteId);
		if (reason) {
			skip(rec.path, reason);
			block(key, reason);
			continue;
		}
		if (fileBases.has(key)) {
			// Two records that fold to one name can't both be synced (corrupt or hand-edited state).
			skip(rec.path, "case-collision");
			block(key, "case-collision");
			continue;
		}
		fileBases.set(key, { rec, path: rec.path });
	}
	for (const [p, id] of Object.entries(state.folders)) {
		const path = p as VaultPath;
		const key = keyOf(path);
		const reason = baseProblem(path, true, id);
		if (reason) {
			skip(path, reason);
			block(key, reason);
			continue;
		}
		if (folderBases.has(key)) {
			skip(path, "case-collision");
			block(key, "case-collision");
			continue;
		}
		folderBases.set(key, { id, path });
	}
	const blockedUnder = (key: string) => [...blocked.keys()].some((b) => b === key || isUnder(b, key));

	// ---------- vault rename events, chained (a→b, b→c gives a→c) ----------
	const renames = new Map<string, string>();
	for (const ev of state.pendingLocal) {
		if (ev.kind !== "renamed") continue;
		const from = nfc(ev.from);
		const to = nfc(ev.to);
		let chained = false;
		for (const [origin, cur] of renames) {
			if (cur === from) {
				renames.set(origin, to);
				chained = true;
			}
		}
		if (!chained) renames.set(from, to);
	}
	for (const [origin, target] of [...renames]) if (keyOf(origin) === keyOf(target)) renames.delete(origin);

	// A tracked file renamed to a name we skip is still the user's file: block its record instead of deleting the
	// remote copy (skips never delete, T-D1). Matched by the rename event, or by a unique hash and size. Only name
	// and size skips count: moving a note into a hidden or excluded folder (Obsidian's ".trash") is a delete.
	const KEEPS_RECORD = new Set<SkipReason>(["invalid-name", "reserved-name", "path-too-long", "case-collision", "unicode-collision", "too-large"]);
	const renamedAway = localSkips.filter((x) => KEEPS_RECORD.has(x.reason));
	const missingBases = () => [...fileBases.entries()].filter(([k]) => !localFiles.has(k) && !blocked.has(k));
	for (const [origin, target] of renames) {
		const s = renamedAway.find((x) => x.key === keyOf(target));
		const b = fileBases.get(keyOf(origin));
		if (s && b && !localFiles.has(keyOf(origin))) {
			skip(b.path, s.reason);
			block(keyOf(origin), s.reason);
		}
	}
	for (const s of renamedAway) {
		if (s.entry.isFolder || s.entry.localHash === null) continue;
		const same = (h: string | null, size: number) => h === s.entry.localHash && size === s.entry.size;
		const bases = missingBases().filter(([, b]) => same(b.rec.localHash, b.rec.size));
		const twins = renamedAway.filter((x) => same(x.entry.localHash, x.entry.size));
		if (bases.length === 1 && twins.length === 1) {
			const [k, b] = bases[0] as [string, Base];
			skip(b.path, s.reason);
			block(k, s.reason);
		}
	}

	// ---------- 2. folder rename collapse ----------
	const moveKeys = <T extends { path: VaultPath }>(map: Map<string, T>, fromKey: string, fromSegments: number, newPrefix: string) => {
		for (const [k, v] of [...map]) {
			if (k !== fromKey && !isUnder(k, fromKey)) continue;
			map.delete(k);
			v.path = replacePrefix(v.path, fromSegments, newPrefix);
			map.set(keyOf(v.path), v);
		}
	};
	const anyAtOrUnder = (maps: Map<string, unknown>[], key: string) => maps.some((m) => [...m.keys()].some((k) => k === key || isUnder(k, key)));

	const folderOrder = [...folderBases.entries()].sort(([a], [b]) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
	for (const [dk, fb] of folderOrder) {
		if (folderBases.get(dk) !== fb) continue; // moved by an outer collapse
		const r = remoteById.get(fb.id);
		if (!r || !r.item.isFolder) continue;
		const rk = keyOf(r.path);

		// Local folder rename: one remote-move of the folder.
		const target = [...renames].find(([origin]) => keyOf(origin) === dk)?.[1];
		if (target !== undefined && rk === dk) {
			const ek = keyOf(target);
			const le = localFolders.get(ek);
			const childBases = [...fileBases.entries()].filter(([k]) => isUnder(k, dk));
			const ok =
				le !== undefined &&
				!blockedUnder(dk) &&
				!blockedUnder(ek) &&
				!localFolders.has(dk) &&
				!localAncestors.has(dk) &&
				!anyAtOrUnder([fileBases, folderBases, remoteFiles, remoteFolders], ek) &&
				childBases.every(([k]) => localFiles.has(ek + k.slice(dk.length)));
			if (ok) {
				const segs = fb.path.split("/").length;
				emit(le.path, { kind: "remote-move", id: fb.id, ifMatch: r.item.eTag, from: fb.path, to: le.path });
				moveKeys(remoteFiles, dk, segs, le.path);
				moveKeys(remoteFolders, dk, segs, le.path);
				moveKeys(fileBases, dk, segs, le.path);
				moveKeys(folderBases, dk, segs, le.path);
				continue;
			}
		}

		// Remote folder rename: one local-move of the folder.
		if (rk !== dk) {
			const le = localFolders.get(dk);
			const childOk = (remoteId: string, k: string) => {
				const cr = remoteById.get(remoteId);
				return !cr || keyOf(cr.path) === rk + k.slice(dk.length);
			};
			const ok =
				le !== undefined &&
				!blockedUnder(dk) &&
				!blockedUnder(rk) &&
				!localSkips.some((s) => isUnder(s.key, dk)) &&
				!anyAtOrUnder([localFiles, localFolders, fileBases], rk) &&
				![...folderBases.keys()].some((k) => k === rk || isUnder(k, rk)) &&
				[...fileBases.entries()].filter(([k]) => isUnder(k, dk)).every(([k, b]) => childOk(b.rec.remoteId, k)) &&
				[...folderBases.entries()].filter(([k]) => isUnder(k, dk)).every(([k, b]) => childOk(b.id, k));
			if (ok) {
				const segs = le.path.split("/").length;
				emit(r.path, { kind: "local-move", from: le.path, to: r.path });
				moveKeys(localFiles, dk, segs, r.path);
				moveKeys(localFolders, dk, segs, r.path);
				moveKeys(fileBases, dk, fb.path.split("/").length, r.path);
				moveKeys(folderBases, dk, fb.path.split("/").length, r.path);
			}
		}
	}

	// ---------- 3a. local file renames: vault events first, then a unique hash and size match ----------
	const pairs = new Map<string, Local>(); // base key → local entry at its new path
	const pairedLocal = new Set<string>();
	const canPairTarget = (k: string) => !fileBases.has(k) && !remoteFiles.has(k) && !blocked.has(k) && !pairedLocal.has(k);
	const canPairBase = (k: string) => {
		const b = fileBases.get(k);
		return b !== undefined && !localFiles.has(k) && !blocked.has(k) && !pairs.has(k) && remoteById.has(b.rec.remoteId);
	};
	for (const [origin, target] of renames) {
		const bk = keyOf(origin);
		const lk = keyOf(target);
		const l = localFiles.get(lk);
		if (l && canPairBase(bk) && canPairTarget(lk)) {
			pairs.set(bk, l);
			pairedLocal.add(lk);
		}
	}
	const sig = (hash: string, size: number) => `${hash}:${size}`;
	const missing = new Map<string, string[]>();
	for (const [k, b] of fileBases) if (canPairBase(k)) missing.set(sig(b.rec.localHash, b.rec.size), [...(missing.get(sig(b.rec.localHash, b.rec.size)) ?? []), k]);
	const fresh = new Map<string, string[]>();
	for (const [k, l] of localFiles) if (canPairTarget(k)) fresh.set(sig(l.localHash, l.size), [...(fresh.get(sig(l.localHash, l.size)) ?? []), k]);
	for (const [s, bks] of missing) {
		const lks = fresh.get(s);
		if (bks.length !== 1 || lks?.length !== 1) continue;
		const l = localFiles.get(lks[0] as string);
		if (!l) continue;
		pairs.set(bks[0] as string, l);
		pairedLocal.add(lks[0] as string);
	}

	// ---------- conflict copies ----------
	const taken = new Set<string>();
	for (const e of local) taken.add(keyOf(e.path));
	for (const r of tree.byId.values()) taken.add(keyOf(r.path));
	for (const s of tree.skipped) taken.add(keyOf(s.displayPath));
	// A crash mid-conflict leaves pendingConflicts[path] (design §5.5 step 1). Its copy path is reused only for the
	// same pair, and only if nothing but that copy can be there: the state file is untrusted (T-T6), and a stale
	// or forged copyPath must never point the copy write at another file (security review).
	const pendingCopyUsable = (pc: PendingConflict, l: Local, r: Remote): boolean => {
		const ck = keyOf(pc.copyPath);
		if (pc.localHash !== l.localHash || pc.remoteId !== r.item.id || ck === keyOf(l.path)) return false;
		if (exclusionReason(pc.copyPath, configDir, excludePatterns, false) || validatePath(pc.copyPath, pathPrefixLen, false)) return false;
		if (fileBases.has(ck) || remoteFiles.has(ck) || localFolders.has(ck) || remoteFolders.has(ck) || blocked.has(ck)) return false;
		const there = localFiles.get(ck);
		return there === undefined || there.localHash === pc.localHash;
	};
	const conflict = (l: Local, r: Remote, noHistory: boolean) => {
		let copyPath: VaultPath | undefined;
		const pending = own(state.pendingConflicts, l.path) ? state.pendingConflicts[l.path] : undefined;
		if (pending && pendingCopyUsable(pending, l, r)) copyPath = pending.copyPath;
		if (copyPath === undefined) {
			try {
				copyPath = conflictCopyPath(l.path, settings.deviceName, settings.now, (p) => taken.has(keyOf(p)), pathPrefixLen);
			} catch (e) {
				if (!(e instanceof RangeError)) throw e;
				// No room for a copy name: keep both sides untouched and report it (M4 carry-in).
				skip(l.path, "path-too-long");
				return;
			}
		}
		taken.add(keyOf(copyPath));
		if (noHistory) differsNoHistory++;
		emit(l.path, { kind: "conflict", path: l.path, id: r.item.id, copyPath });
	};

	// ---------- 4. the three-way table (design §5.4) ----------
	const declined = (path: VaultPath, localHash: string | null, eTag: string | null) => {
		if (settings.reofferDeclined) return false;
		const d = own(state.declinedDeletes, path) ? state.declinedDeletes[path] : undefined;
		return d !== undefined && d.localHash === localHash && d.eTag === eTag;
	};

	const decideFile = (b: Base | undefined, l: Local | undefined, r: Remote | undefined) => {
		if (!b) {
			if (l && !r) emit(l.path, { kind: "upload-new", path: l.path });
			else if (!l && r) emit(r.path, { kind: "download", id: r.item.id, path: r.path, reason: "new" });
			else if (l && r) {
				if (sameContent(l, r.item)) emit(l.path, { kind: "adopt", path: l.path, id: r.item.id });
				else conflict(l, r, true);
			}
			return;
		}
		const cL = l !== undefined && l.localHash !== b.rec.localHash;
		const cR = r !== undefined && changedR(b.rec, r.item);
		if (l && r) {
			if (!cL && !cR) {
				// A case-only local rename travels as a move; a case-only remote rename is left alone (no loop).
				if (l.path !== b.path && r.path !== l.path) emit(l.path, { kind: "remote-move", id: r.item.id, ifMatch: b.rec.eTag, from: b.path, to: l.path });
			} else if (cL && !cR) emit(l.path, { kind: "upload-replace", path: l.path, id: r.item.id, ifMatch: b.rec.eTag });
			else if (sameContent(l, r.item)) emit(l.path, { kind: "adopt", path: l.path, id: r.item.id });
			else if (!cL) emit(l.path, { kind: "download", id: r.item.id, path: l.path, reason: "changed" });
			else conflict(l, r, false);
		} else if (r) {
			// Deleted locally. A remote edit beats the delete (R-DEL-2); union mode restores (R-FIRST-1).
			if (cR) emit(r.path, { kind: "download", id: r.item.id, path: r.path, reason: "edit-wins" });
			else if (union) emit(r.path, { kind: "download", id: r.item.id, path: r.path, reason: "restore" });
			else if (!declined(b.path, null, r.item.eTag)) {
				deleteCount++;
				emit(b.path, { kind: "remote-delete", id: r.item.id, ifMatch: b.rec.eTag, path: b.path });
			}
		} else if (l) {
			// Deleted remotely. A local edit beats the delete; union mode restores.
			if (cL || union) emit(l.path, { kind: "upload-new", path: l.path });
			else if (!declined(l.path, l.localHash, null)) {
				deleteCount++;
				emit(l.path, { kind: "local-trash", path: l.path });
			}
		} else emit(b.path, { kind: "forget", path: b.path });
	};

	// ---------- 3b. moves of tracked files ----------
	const doneBase = new Set<string>();
	const doneLocal = new Set<string>();
	const doneRemote = new Set<string>();
	for (const [bk, b] of [...fileBases].sort(([a], [c]) => (a < c ? -1 : 1))) {
		if (blocked.has(bk)) continue;
		const r = remoteById.get(b.rec.remoteId);
		if (!r) continue;
		const nk = keyOf(r.path);
		const paired = pairs.get(bk);
		if (nk !== bk) {
			// Moved remotely (by id). The remote path wins over a different local rename.
			if (blocked.has(nk)) {
				skip(b.path, blocked.get(nk) as SkipReason);
				block(bk, blocked.get(nk) as SkipReason);
				continue;
			}
			const lOld = localFiles.get(bk);
			const occupant = localFiles.get(nk);
			const sameTarget = !lOld && !paired && occupant !== undefined && !pairedLocal.has(nk);
			const free = !fileBases.has(nk) && (!occupant || occupant === paired || sameTarget);
			if (!free) continue; // the table keeps both files (no move onto another file)
			doneBase.add(bk);
			doneRemote.add(r.item.id);
			let l: Local | undefined;
			let moved = false;
			const src = lOld ?? paired;
			if (src) {
				doneLocal.add(keyOf(src.path));
				if (keyOf(src.path) !== nk) {
					emit(r.path, { kind: "local-move", from: src.path, to: r.path });
					moved = true;
				}
				l = { ...src, path: moved ? r.path : src.path };
			} else if (occupant) l = occupant;
			if (occupant) doneLocal.add(nk);
			if (!l) {
				// Deleted here, renamed there: restore at the new path rather than delete (edits win).
				emit(r.path, { kind: "download", id: r.item.id, path: r.path, reason: "restore" });
				continue;
			}
			const before = ops.length;
			decideFile({ rec: b.rec, path: l.path }, l, r);
			if (!moved && ops.length === before) emit(l.path, { kind: "adopt", path: l.path, id: r.item.id });
		} else if (paired) {
			// Renamed locally, in place remotely.
			doneBase.add(bk);
			doneRemote.add(r.item.id);
			doneLocal.add(keyOf(paired.path));
			if (!changedR(b.rec, r.item)) {
				emit(paired.path, { kind: "remote-move", id: r.item.id, ifMatch: b.rec.eTag, from: b.path, to: paired.path });
				decideFile({ rec: b.rec, path: paired.path }, paired, { item: r.item, path: paired.path });
			} else {
				// The remote content changed too: the remote path wins, then the content rules apply.
				emit(r.path, { kind: "local-move", from: paired.path, to: r.path });
				decideFile(b, { ...paired, path: r.path }, r);
			}
		}
	}

	const fileKeys = new Set<string>([...localFiles.keys(), ...remoteFiles.keys(), ...fileBases.keys()]);
	// A skipped local file (a case-collision loser) shares its key with the tracked keeper. Once the keeper has
	// moved away, nothing may be written at that key: it would land on the skipped file (property test).
	const localSkipKeys = new Set(localSkips.map((x) => x.key));
	for (const k of [...fileKeys].sort()) {
		if (blocked.has(k)) continue;
		const b = doneBase.has(k) ? undefined : fileBases.get(k);
		const l = doneLocal.has(k) ? undefined : localFiles.get(k);
		if (!l && localSkipKeys.has(k)) continue;
		const rr = remoteFiles.get(k);
		const r = rr && !doneRemote.has(rr.item.id) ? rr : undefined;
		if (b || l || r) decideFile(b, l, r);
	}

	// ---------- 5. folders ----------
	const folderKeys = new Set<string>([...localFolders.keys(), ...remoteFolders.keys(), ...folderBases.keys()]);
	for (const k of [...folderKeys].sort()) {
		if (blocked.has(k)) continue;
		const b = folderBases.get(k);
		const l = localFolders.get(k);
		const r = remoteFolders.get(k);
		const sameId = b !== undefined && r !== undefined && r.item.id === b.id;
		if (!b || (r && !sameId)) {
			if (l && !r) emit(l.path, { kind: "upload-new", path: l.path });
			else if (!l && r) emit(r.path, { kind: "download", id: r.item.id, path: r.path, reason: "new" });
			else if (l && r) emit(l.path, { kind: "adopt", path: l.path, id: r.item.id });
			continue;
		}
		if (l && r) continue;
		if (r) {
			// Gone locally. Graph folder deletes are recursive, so only an empty folder is deleted (R-DEL-3).
			if (union) emit(r.path, { kind: "download", id: r.item.id, path: r.path, reason: "restore" });
			else if ((tree.childCount.get(r.item.id) ?? 0) === 0 && !localAncestors.has(k)) {
				emit(b.path, { kind: "remote-delete", id: r.item.id, ifMatch: r.item.eTag, path: b.path });
			}
		} else if (l) {
			// Gone remotely. Removed locally only when nothing is left under it (M6: removeEmptyFolder).
			if (union) emit(l.path, { kind: "upload-new", path: l.path });
			else if (!localAncestors.has(k)) emit(l.path, { kind: "local-trash", path: l.path });
		} else emit(b.path, { kind: "forget", path: b.path });
	}

	const order = (a: Emitted, b: Emitted) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : a.seq - b.seq);
	// Moves come before every other op: a write at a move's source or destination must never run before the
	// move (security review: a new remote item at a vacated path would otherwise be downloaded over the file
	// that is about to move away, with its unsynced edit).
	const isMove = (e: Emitted) => e.op.kind === "local-move" || e.op.kind === "remote-move";
	return {
		ops: [...skips.sort(order), ...ops.filter(isMove).sort(order), ...ops.filter((e) => !isMove(e)).sort(order)].map((e) => e.op),
		deleteCount,
		trackedCount: Object.keys(state.files).length,
		unionMode: union,
		differsNoHistory,
	};
}
