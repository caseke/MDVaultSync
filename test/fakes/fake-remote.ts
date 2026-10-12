// In-memory OneDrive App Folder implementing RemotePort (plan M5). It follows the OneDrive rules the planner and
// executor depend on:
// - names are unique per folder, compared case-insensitively [G-NM-5]; a clash is 409 nameAlreadyExists;
// - every change bumps the eTag; only content changes bump the cTag [G-TAG-1];
// - a stale If-Match is 412 [G-TAG-2]; delete moves the item (recursively for folders) to a recycle bin [G-DEL-1];
// - delta returns pages of `pageSize` items, and an item changed twice since the cursor appears twice [G-DL-6];
// - a zero-byte file reports no quickXorHash [G-DL-8].
// Methods are async (like GraphClient's), so a GraphError arrives as a rejection, never a synchronous throw.
import { quickXorHash } from "../../src/core/quickxor.ts";
import { caseKey } from "../../src/core/paths.ts";
import type {
	AppRoot,
	DeltaPage,
	RemoteItem,
	RemotePort,
	UploadSessionInfo,
	UploadStatus,
	UploadTarget,
	UploadTargetReplace,
} from "../../src/core/ports.ts";
import { GraphError } from "../../src/remote/errors.ts";

export const APPROOT_ID = "approot";
export const PATH_PREFIX = "/Apps/MDVaultSync";

interface Node {
	id: string;
	parentId: string | null;
	name: string;
	isFolder: boolean;
	data: Uint8Array;
	etagN: number;
	ctagN: number;
	modified: number;
}

interface Session {
	target: UploadTarget | UploadTargetReplace;
	total: number;
	buf: Uint8Array;
	next: number;
}

export interface FakeRemoteOptions {
	pageSize?: number;
	/** OneDrive omits the hash of zero-byte files [G-DL-8]. */
	nullHashForEmpty?: boolean;
}

function bytes(s: string | Uint8Array): Uint8Array {
	return typeof s === "string" ? new TextEncoder().encode(s) : s;
}

function toBuffer(b: Uint8Array): ArrayBuffer {
	return b.slice().buffer;
}

export class FakeRemote implements RemotePort {
	readonly recycleBin: RemoteItem[] = [];
	private readonly nodes = new Map<string, Node>();
	private readonly log: RemoteItem[] = [];
	private readonly sessions = new Map<string, Session>();
	private nextId = 1;
	private clock = 1;
	private readonly pageSize: number;
	private readonly nullHashForEmpty: boolean;

	constructor(opts: FakeRemoteOptions = {}) {
		this.pageSize = opts.pageSize ?? 1000;
		this.nullHashForEmpty = opts.nullHashForEmpty ?? true;
		this.nodes.set(APPROOT_ID, { id: APPROOT_ID, parentId: null, name: "MDVaultSync", isFolder: true, data: new Uint8Array(), etagN: 1, ctagN: 1, modified: 0 });
	}

	// ---------- RemotePort ----------
	async getAppRoot(): Promise<AppRoot> {
		return { item: this.toItem(this.node(APPROOT_ID)), pathPrefix: PATH_PREFIX };
	}

	async delta(link: string | null): Promise<DeltaPage> {
		let from: number | null = null;
		let offset = 0;
		if (link !== null) {
			const parts = link.split("|");
			if (parts[0] === "delta") from = Number(parts[1]);
			else if (parts[0] === "next") {
				from = parts[1] === "init" ? null : Number(parts[1]);
				offset = Number(parts[2]);
			} else throw new GraphError(400, "invalidRequest");
		}
		const all = from === null ? this.liveItems() : this.log.slice(from);
		const items = all.slice(offset, offset + this.pageSize);
		const end = offset + this.pageSize;
		if (end < all.length) return { items, nextLink: `next|${from ?? "init"}|${end}` };
		return { items, deltaLink: `delta|${this.log.length}` };
	}

	async listChildren(folderId: string): Promise<RemoteItem[]> {
		return this.children(folderId).map((n) => this.toItem(n));
	}

	async getItem(id: string): Promise<RemoteItem | null> {
		const n = this.nodes.get(id);
		return n ? this.toItem(n) : null;
	}

	async getChildByName(parentId: string, name: string): Promise<RemoteItem | null> {
		const n = this.childByName(parentId, name);
		return n ? this.toItem(n) : null;
	}

	async createUploadSession(target: UploadTarget | UploadTargetReplace, ifMatch: string | null, size: number): Promise<UploadSessionInfo> {
		if (target.kind === "replace") {
			const n = this.node(target.id);
			if (ifMatch === null) throw new GraphError(400, "invalidRequest");
			this.checkMatch(n, ifMatch);
		} else {
			this.folder(target.parentId);
			if (this.childByName(target.parentId, target.name)) throw new GraphError(409, "nameAlreadyExists");
		}
		const uploadUrl = `https://api.onedrive.com/up/${this.nextId++}`;
		this.sessions.set(uploadUrl, { target, total: size, buf: new Uint8Array(size), next: 0 });
		return { uploadUrl, expiresAt: "2099-01-01T00:00:00Z" };
	}

	async putFragment(uploadUrl: string, start: number, total: number, data: ArrayBuffer): Promise<RemoteItem | null> {
		const s = this.sessions.get(uploadUrl);
		if (!s) throw new GraphError(404, "itemNotFound");
		if (start !== s.next || total !== s.total || start + data.byteLength > total) throw new GraphError(416, "invalidRange");
		s.buf.set(new Uint8Array(data), start);
		s.next += data.byteLength;
		if (s.next < s.total) return null;
		this.sessions.delete(uploadUrl);
		// Graph checks If-Match only at session creation [G-UP-5]; the commit has no precondition.
		if (s.target.kind === "replace") return this.toItem(this.setContent(s.target.id, s.buf));
		if (this.childByName(s.target.parentId, s.target.name)) throw new GraphError(409, "nameAlreadyExists");
		return this.toItem(this.create(s.target.parentId, s.target.name, false, s.buf));
	}

	async getUploadStatus(uploadUrl: string): Promise<UploadStatus> {
		const s = this.sessions.get(uploadUrl);
		return s ? { nextExpectedStart: s.next, expiresAt: "2099-01-01T00:00:00Z" } : { nextExpectedStart: null, expiresAt: "" };
	}

	async cancelUpload(uploadUrl: string): Promise<void> {
		this.sessions.delete(uploadUrl);
		return;
	}

	async download(id: string): Promise<ArrayBuffer> {
		const n = this.node(id);
		if (n.isFolder) throw new GraphError(400, "invalidRequest");
		return toBuffer(n.data);
	}

	async createFolder(parentId: string, name: string): Promise<RemoteItem> {
		this.folder(parentId);
		if (this.childByName(parentId, name)) throw new GraphError(409, "nameAlreadyExists");
		return this.toItem(this.create(parentId, name, true, new Uint8Array()));
	}

	async uploadNew(parentId: string, name: string, data: ArrayBuffer): Promise<RemoteItem> {
		this.folder(parentId);
		if (this.childByName(parentId, name)) throw new GraphError(409, "nameAlreadyExists");
		return this.toItem(this.create(parentId, name, false, new Uint8Array(data)));
	}

	async uploadReplace(id: string, ifMatch: string, data: ArrayBuffer): Promise<RemoteItem> {
		this.checkMatch(this.node(id), ifMatch);
		return this.toItem(this.setContent(id, new Uint8Array(data)));
	}

	async move(id: string, ifMatch: string, newParentId: string, newName: string): Promise<RemoteItem> {
		const n = this.node(id);
		this.checkMatch(n, ifMatch);
		this.folder(newParentId);
		const clash = this.childByName(newParentId, newName);
		if (clash && clash.id !== id) throw new GraphError(409, "nameAlreadyExists");
		n.parentId = newParentId;
		n.name = newName;
		this.touch(n, false);
		return this.toItem(n);
	}

	async delete(id: string, ifMatch: string): Promise<void> {
		const n = this.node(id);
		if (id === APPROOT_ID) throw new GraphError(403, "accessDenied");
		this.checkMatch(n, ifMatch);
		this.removeTree(n);
		return;
	}

	async quota(): Promise<{ total: number; used: number; remaining: number } | null> {
		return { total: 5 * 2 ** 30, used: 0, remaining: 5 * 2 ** 30 };
	}

	// ---------- test helpers (path based) ----------
	/** Live items keyed by id, approot included: what a full pull leaves in `SyncState.remoteIndex`. */
	index(): Record<string, RemoteItem> {
		const out: Record<string, RemoteItem> = {};
		for (const it of this.liveItems()) out[it.id] = it;
		return out;
	}

	itemAt(path: string): RemoteItem | null {
		const n = this.nodeAt(path);
		return n ? this.toItem(n) : null;
	}

	contentAt(path: string): string | null {
		const n = this.nodeAt(path);
		return n && !n.isFolder ? new TextDecoder().decode(n.data) : null;
	}

	/** Creates or overwrites a file, creating parent folders (as another device or the OneDrive web UI would). */
	putFile(path: string, content: string | Uint8Array, id?: string): RemoteItem {
		const { parentId, name } = this.ensureParent(path);
		const existing = this.childByName(parentId, name);
		if (existing) return this.toItem(this.setContent(existing.id, bytes(content)));
		return this.toItem(this.create(parentId, name, false, bytes(content), id));
	}

	mkdir(path: string): RemoteItem {
		const { parentId, name } = this.ensureParent(path);
		const existing = this.childByName(parentId, name);
		return this.toItem(existing ?? this.create(parentId, name, true, new Uint8Array()));
	}

	/** Moves or renames by path, creating the target's parent folders. */
	rename(from: string, to: string): RemoteItem {
		const n = this.mustAt(from);
		const { parentId, name } = this.ensureParent(to);
		n.parentId = parentId;
		n.name = name;
		this.touch(n, false);
		return this.toItem(n);
	}

	remove(path: string): void {
		this.removeTree(this.mustAt(path));
	}

	/** Bumps only the eTag, as a metadata change on OneDrive's web UI does. */
	touchMetadata(path: string): RemoteItem {
		const n = this.mustAt(path);
		this.touch(n, false);
		return this.toItem(n);
	}

	// ---------- internals ----------
	private toItem(n: Node): RemoteItem {
		const hash = n.isFolder || (n.data.length === 0 && this.nullHashForEmpty) ? null : quickXorHash(toBuffer(n.data));
		return {
			id: n.id,
			parentId: n.parentId,
			name: n.name,
			isFolder: n.isFolder,
			eTag: `"{${n.id}},${n.etagN}"`,
			cTag: n.isFolder ? null : `"c:{${n.id}},${n.ctagN}"`,
			size: n.data.length,
			quickXorHash: hash,
			lastModified: new Date(n.modified * 1000).toISOString(),
			deleted: false,
		};
	}

	private liveItems(): RemoteItem[] {
		const out: RemoteItem[] = [];
		const walk = (id: string) => {
			const n = this.node(id);
			out.push(this.toItem(n));
			for (const c of this.children(id)) walk(c.id);
		};
		walk(APPROOT_ID);
		return out;
	}

	private node(id: string): Node {
		const n = this.nodes.get(id);
		if (!n) throw new GraphError(404, "itemNotFound");
		return n;
	}

	private folder(id: string): Node {
		const n = this.node(id);
		if (!n.isFolder) throw new GraphError(400, "invalidRequest");
		return n;
	}

	private children(id: string): Node[] {
		return [...this.nodes.values()].filter((n) => n.parentId === id).sort((a, b) => (a.name < b.name ? -1 : 1));
	}

	private childByName(parentId: string, name: string): Node | undefined {
		const key = caseKey(name);
		return this.children(parentId).find((n) => caseKey(n.name) === key);
	}

	private nodeAt(path: string): Node | undefined {
		let cur: Node | undefined = this.node(APPROOT_ID);
		for (const seg of path.split("/")) {
			if (!cur) return undefined;
			cur = this.childByName(cur.id, seg);
		}
		return cur;
	}

	private mustAt(path: string): Node {
		const n = this.nodeAt(path);
		if (!n) throw new GraphError(404, "itemNotFound");
		return n;
	}

	private ensureParent(path: string): { parentId: string; name: string } {
		const segs = path.split("/");
		const name = segs.pop() ?? "";
		let parentId = APPROOT_ID;
		for (const seg of segs) {
			const existing = this.childByName(parentId, seg);
			parentId = existing ? existing.id : this.create(parentId, seg, true, new Uint8Array()).id;
		}
		return { parentId, name };
	}

	private create(parentId: string, name: string, isFolder: boolean, data: Uint8Array, id?: string): Node {
		const n: Node = { id: id ?? `item${this.nextId++}`, parentId, name, isFolder, data: data.slice(), etagN: 1, ctagN: 1, modified: this.clock++ };
		this.nodes.set(n.id, n);
		this.log.push(this.toItem(n));
		return n;
	}

	private setContent(id: string, data: Uint8Array): Node {
		const n = this.node(id);
		n.data = data.slice();
		this.touch(n, true);
		return n;
	}

	private touch(n: Node, content: boolean): void {
		n.etagN++;
		if (content) n.ctagN++;
		n.modified = this.clock++;
		this.log.push(this.toItem(n));
	}

	private checkMatch(n: Node, ifMatch: string): void {
		if (this.toItem(n).eTag !== ifMatch) throw new GraphError(412, "preconditionFailed");
	}

	private removeTree(n: Node): void {
		for (const c of this.children(n.id)) this.removeTree(c);
		const item = this.toItem(n);
		this.nodes.delete(n.id);
		this.recycleBin.push(item);
		// Deleted items on consumer OneDrive omit size, cTag and often name [G-DL-5].
		this.log.push({ ...item, name: "", eTag: "", cTag: null, size: 0, quickXorHash: null, deleted: true });
	}
}
