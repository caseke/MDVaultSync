// Helpers that keep SyncState's maps consistent while the executor works (design §2, §5.5). Pure.
// - Maps keyed by vault path or item id are written with defineProperty, so a note named "__proto__" stays data
//   (M5 carry-in); JSON.stringify and the state parser then round-trip it.
// - One file record per remote id: writing a record drops any other record of that item (moves) or at that path
//   under caseKey (OneDrive names are case-insensitive [G-NM-5]).
import { caseKey } from "./paths.ts";
import type { FileRecord, RemoteItem, SyncState, VaultPath } from "./ports.ts";

export function own(o: object, k: string): boolean {
	return Object.prototype.hasOwnProperty.call(o, k);
}

export function defineEntry<T>(o: Record<string, T>, k: string, v: T): void {
	Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

export function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

const under = (key: string, prefixKey: string) => key === prefixKey || key.startsWith(prefixKey + "/");

export function fileAt(state: SyncState, path: string): FileRecord | undefined {
	if (own(state.files, path)) return state.files[path as VaultPath];
	const key = caseKey(path);
	return Object.values(state.files).find((r) => caseKey(r.path) === key);
}

export function fileById(state: SyncState, id: string): FileRecord | undefined {
	return Object.values(state.files).find((r) => r.remoteId === id);
}

export function removeFile(state: SyncState, path: string): void {
	const key = caseKey(path);
	for (const k of Object.keys(state.files)) if (caseKey(k) === key) delete state.files[k as VaultPath];
}

export function putFile(state: SyncState, rec: FileRecord): void {
	const key = caseKey(rec.path);
	for (const [k, r] of Object.entries(state.files)) if (r.remoteId === rec.remoteId || caseKey(k) === key) delete state.files[k as VaultPath];
	defineEntry(state.files, rec.path, rec);
}

export function folderAt(state: SyncState, path: string): string | undefined {
	if (own(state.folders, path)) return state.folders[path as VaultPath];
	const key = caseKey(path);
	return Object.entries(state.folders).find(([k]) => caseKey(k) === key)?.[1];
}

export function removeFolder(state: SyncState, path: string): void {
	const key = caseKey(path);
	for (const k of Object.keys(state.folders)) if (caseKey(k) === key) delete state.folders[k as VaultPath];
}

export function putFolder(state: SyncState, path: string, id: string): void {
	const key = caseKey(path);
	for (const [k, v] of Object.entries(state.folders)) if (v === id || caseKey(k) === key) delete state.folders[k as VaultPath];
	defineEntry(state.folders, path, id);
}

/** Rewrites every file and folder record at or under `from` to sit under `to` (a folder move). */
export function repathUnder(state: SyncState, from: string, to: string): void {
	const fromKey = caseKey(from);
	const segs = from.split("/").length;
	const move = (p: string) => [to, ...p.split("/").slice(segs)].join("/") as VaultPath;
	const files = Object.entries(state.files).filter(([k]) => under(caseKey(k), fromKey));
	const folders = Object.entries(state.folders).filter(([k]) => under(caseKey(k), fromKey));
	for (const [k] of files) delete state.files[k as VaultPath];
	for (const [k] of folders) delete state.folders[k as VaultPath];
	for (const [, r] of files) defineEntry(state.files, move(r.path), { ...r, path: move(r.path) });
	for (const [k, id] of folders) defineEntry(state.folders, move(k), id);
}

export function upsertItem(state: SyncState, item: RemoteItem): void {
	defineEntry(state.remoteIndex, item.id, item);
}

/** Removes an item and everything under it from the index (a deleted folder takes its children, design §5.2). */
export function removeItemTree(state: SyncState, id: string): void {
	const gone = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const it of Object.values(state.remoteIndex)) {
			if (!gone.has(it.id) && it.parentId !== null && gone.has(it.parentId)) {
				gone.add(it.id);
				grew = true;
			}
		}
	}
	for (const g of gone) delete state.remoteIndex[g];
}
