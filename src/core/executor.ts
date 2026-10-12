// The executor (design §5.5): runs a Plan against the vault and the App Folder. Pure core: no Obsidian import.
//
// Order [R-ORDER]: every pull-side op, then every push-side op. Within a side, moves run first, one at a time and
// in plan order (M5 review: no write may touch a move's source or destination before the move); then folder
// creation, shallowest first; then file ops at concurrency 4; then deletes, folders deepest first.
//
// Safety:
// - Every local write, move or trash re-checks containment and the name rules on the final path (T-T1).
// - Every local overwrite, move or trash re-checks the file against the scan (R-CONF-4). An edit since the scan
//   turns a download into a conflict and defers a trash or move.
// - Bytes move only through RemoteContent, which checks hashes (T-T4, R-ENG-4).
// - State is saved immediately before every destructive op and at most a second after any other (R-RES-3).
// - A 412 is re-read: a metadata-only change retries once with the fresh eTag, anything else is a conflict
//   (R-CC-2). Conflicts never lose bytes: the local version is copied first (R-CONF-1, D-9).
import { conflictCopyPath } from "./conflict-name.ts";
import { runOutcome, UnsafePath, type ErrorClassifier, type RemoteFailure } from "./failure.ts";
import type { Logger } from "./logger.ts";
import { caseKey, containmentProblem, toVaultPath, validatePath } from "./paths.ts";
import type { ScannedEntry } from "./planner.ts";
import type { FileRecord, LocalEntry, Plan, PlanOp, RemoteContent, RemoteItem, RemotePort, SyncState, UploadSessionInfo, UploadTarget, UploadTargetReplace, VaultPath, VaultPort } from "./ports.ts";
import { quickXorHash } from "./quickxor.ts";
import {
	baseName,
	defineEntry,
	fileAt,
	fileById,
	folderAt,
	own,
	parentOf,
	putFile,
	putFolder,
	removeFile,
	removeFolder,
	removeItemTree,
	repathUnder,
	upsertItem,
} from "./records.ts";
import { buildRemoteTree } from "./remote-tree.ts";
import type { OpResult } from "./report.ts";
import type { Saver } from "./saver.ts";

export const CONCURRENCY = 4;

export interface ExecSettings {
	configDir: string;
	/** `AppRoot.pathPrefix` without its leading "/" [G-NM-4]. */
	pathPrefixLen: number;
	maxFileSize: number;
	deviceName: string;
	/** For conflict copy names. */
	now: Date;
	/** ContentTransform.id, recorded per file (D-10). */
	transformId: string;
}

export interface ExecContext {
	/** The working state; the executor updates it in place as ops succeed. */
	state: SyncState;
	plan: Plan;
	/** The scan the plan was made from. */
	scan: readonly ScannedEntry[];
	vault: VaultPort;
	/** Non-content calls only (getItem, createFolder, move, delete…); bytes go through `content`. */
	remote: RemotePort;
	content: RemoteContent;
	classify: ErrorClassifier;
	settings: ExecSettings;
	saver: Saver;
	/** (path → hash of the bytes we write), for the echo filter (design §3). */
	expectedWrites?: Map<VaultPath, string>;
	logger?: Logger;
	concurrency?: number;
}

export interface ExecOutcome {
	results: OpResult[];
	conflicts: { path: VaultPath; copyPath: VaultPath }[];
	/** Set when a failure ended the run early (auth, 403, quota, budget, network). */
	fatal: RemoteFailure | null;
}

interface Scanned {
	entry: ScannedEntry;
	path: VaultPath;
}

type LocalNow = "same" | "changed" | "gone";

const nfc = (s: string) => s.normalize("NFC");
const depth = (p: string) => p.split("/").length;
const ok = (op: PlanOp): OpResult => ({ op, ok: true });
const fail = (op: PlanOp, code: string): OpResult => ({ op, ok: false, code });

/** Thrown inside a handler to fail the op with a fixed code. */
class OpFailed extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "OpFailed";
		this.code = code;
	}
}

function sameStored(rec: FileRecord, item: RemoteItem): boolean {
	return item.quickXorHash !== null ? item.quickXorHash === rec.remoteHash : item.cTag !== null && item.cTag === rec.cTag;
}

/** A 412 caused by a rename or other metadata change: the content (cTag and hash) is what we last synced. */
function metadataOnly(rec: FileRecord, fresh: RemoteItem): boolean {
	return fresh.cTag === rec.cTag && (fresh.quickXorHash === null || fresh.quickXorHash === rec.remoteHash);
}

export async function executePlan(ctx: ExecContext): Promise<ExecOutcome> {
	return new Execution(ctx).run();
}

class Execution {
	private readonly ctx: ExecContext;
	private readonly state: SyncState;
	private readonly scan = new Map<string, Scanned>();
	private readonly remoteByPath = new Map<string, RemoteItem>();
	private readonly taken = new Set<string>();
	private readonly plannedUploads = new Set<string>();
	private readonly etags = new Map<string, string>();
	private readonly folderJobs = new Map<string, Promise<string>>();
	private readonly results: OpResult[] = [];
	private readonly conflicts: { path: VaultPath; copyPath: VaultPath }[] = [];
	private readonly pushFiles: PlanOp[] = [];
	private fatal: RemoteFailure | null = null;

	constructor(ctx: ExecContext) {
		this.ctx = ctx;
		this.state = ctx.state;
		for (const e of ctx.scan) {
			const p = toVaultPath(e.path);
			if (p) this.scan.set(caseKey(p), { entry: e, path: p });
			this.taken.add(caseKey(nfc(e.path)));
		}
		const tree = buildRemoteTree(this.state.remoteIndex, this.state.appRootId, ctx.settings.configDir, ctx.settings.pathPrefixLen);
		for (const { item, path } of tree.byId.values()) {
			this.remoteByPath.set(caseKey(path), item);
			this.taken.add(caseKey(path));
		}
		for (const s of tree.skipped) this.taken.add(caseKey(s.displayPath));
		for (const op of ctx.plan.ops) {
			if (op.kind === "conflict") this.taken.add(caseKey(op.copyPath));
			if (op.kind === "upload-new") this.plannedUploads.add(caseKey(op.path));
		}
	}

	async run(): Promise<ExecOutcome> {
		const pull = { moves: [] as PlanOp[], mkdirs: [] as PlanOp[], files: [] as PlanOp[], trash: [] as PlanOp[], trashFolders: [] as PlanOp[] };
		const push = { moves: [] as PlanOp[], mkdirs: [] as PlanOp[], deletes: [] as PlanOp[], deleteFolders: [] as PlanOp[] };
		for (const op of this.ctx.plan.ops) {
			switch (op.kind) {
				case "skip":
					break;
				case "local-move":
					pull.moves.push(op);
					break;
				case "download":
					(this.remoteIsFolder(op.id) ? pull.mkdirs : pull.files).push(op);
					break;
				case "conflict":
				case "adopt":
				case "forget":
					pull.files.push(op);
					break;
				case "local-trash":
					(this.localIsFolder(op.path) ? pull.trashFolders : pull.trash).push(op);
					break;
				case "remote-move":
					push.moves.push(op);
					break;
				case "upload-new":
					(this.localIsFolder(op.path) ? push.mkdirs : this.pushFiles).push(op);
					break;
				case "upload-replace":
					this.pushFiles.push(op);
					break;
				case "remote-delete":
					(this.remoteIsFolder(op.id) ? push.deleteFolders : push.deletes).push(op);
					break;
			}
		}
		const shallow = (a: PlanOp, b: PlanOp) => depth(opTarget(a)) - depth(opTarget(b));
		const deep = (a: PlanOp, b: PlanOp) => depth(opTarget(b)) - depth(opTarget(a));
		const n = this.ctx.concurrency ?? CONCURRENCY;

		// Pull side.
		await this.pool(pull.moves, 1);
		await this.pool(pull.mkdirs.sort(shallow), 1);
		await this.pool(pull.files, n);
		await this.pool(pull.trash, n);
		await this.pool(pull.trashFolders.sort(deep), 1);
		// Push side. Conflict copies queued above join pushFiles.
		await this.pool(push.moves, 1);
		await this.pool(push.mkdirs.sort(shallow), 1);
		await this.pool(this.pushFiles, n);
		await this.pool(push.deletes, n);
		await this.pool(push.deleteFolders.sort(deep), 1);

		await this.ctx.saver.flush();
		return { results: this.results, conflicts: this.conflicts, fatal: this.fatal };
	}

	/** Runs ops with `n` workers. Items appended while it runs (conflict copies) are picked up too. */
	private async pool(items: PlanOp[], n: number): Promise<void> {
		let i = 0;
		const worker = async () => {
			while (this.fatal === null && i < items.length) {
				const op = items[i++] as PlanOp;
				await this.runOp(op);
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
	}

	private async runOp(op: PlanOp): Promise<void> {
		let result: OpResult;
		try {
			result = await this.dispatch(op);
		} catch (e) {
			if (e instanceof OpFailed) result = fail(op, e.code);
			else {
				const f = this.ctx.classify(e);
				if (runOutcome(f.kind) !== null && this.fatal === null) this.fatal = f;
				result = fail(op, f.code);
			}
		}
		if (!result.ok) this.ctx.logger?.event(`op.${result.op.kind}`, { code: result.code });
		this.results.push(result);
		this.ctx.saver.dirty();
	}

	private dispatch(op: PlanOp): Promise<OpResult> {
		switch (op.kind) {
			case "download":
				return this.pullFile(op);
			case "upload-new":
				return this.pushNew(op);
			case "upload-replace":
				return this.pushReplace(op);
			case "remote-move":
				return this.remoteMove(op);
			case "local-move":
				return this.localMove(op);
			case "remote-delete":
				return this.remoteDelete(op);
			case "local-trash":
				return this.localTrash(op);
			case "conflict":
				return this.conflict(op.path, op.id, op.copyPath);
			case "adopt":
				return Promise.resolve(this.adopt(op));
			case "forget":
				if (fileAt(this.state, op.path)) removeFile(this.state, op.path);
				else removeFolder(this.state, op.path);
				return Promise.resolve(ok(op));
			case "skip":
				return Promise.resolve(ok(op));
		}
	}

	// ---------- lookups ----------

	private remoteIsFolder(id: string): boolean {
		return own(this.state.remoteIndex, id) && this.state.remoteIndex[id]?.isFolder === true;
	}

	private localIsFolder(path: string): boolean {
		const s = this.scan.get(caseKey(path));
		if (s) return s.entry.isFolder;
		return folderAt(this.state, path) !== undefined && fileAt(this.state, path) === undefined;
	}

	private scanAt(path: string): Scanned | undefined {
		return this.scan.get(caseKey(path));
	}

	private indexItem(id: string): RemoteItem | undefined {
		return own(this.state.remoteIndex, id) ? this.state.remoteIndex[id] : undefined;
	}

	// ---------- safety checks ----------

	/** Containment and name rules on the final path, right before a local write (T-T1, M4 carry-in). */
	private checkPath(path: string, isFolder: boolean): void {
		const s = this.ctx.settings;
		if (toVaultPath(path) !== path || containmentProblem(path, s.configDir) !== null || validatePath(path, s.pathPrefixLen, isFolder) !== null) {
			throw new UnsafePath();
		}
	}

	/** The file now, against what the scan saw (design §5.5 pre-write check). */
	private async localNow(path: VaultPath): Promise<LocalNow> {
		const seen = this.scanAt(path);
		const st = await this.ctx.vault.stat(path);
		if (!st) return "gone";
		if (st.isFolder) return "changed";
		if (!seen || seen.entry.isFolder) return "changed"; // appeared since the scan
		if (st.size === seen.entry.size && st.mtime === seen.entry.mtime) return "same";
		const hash = quickXorHash(await this.ctx.vault.read(path));
		return hash === seen.entry.localHash ? "same" : "changed";
	}

	private async hashOf(path: VaultPath): Promise<string | null> {
		const st = await this.ctx.vault.stat(path);
		if (!st || st.isFolder) return null;
		return quickXorHash(await this.ctx.vault.read(path));
	}

	// ---------- local writes and records ----------

	private async writeLocal(path: VaultPath, plain: ArrayBuffer): Promise<void> {
		this.checkPath(path, false);
		const parent = parentOf(path);
		if (parent !== "") {
			this.checkPath(parent, true);
			await this.ctx.vault.mkdirp(parent as VaultPath);
		}
		// Overwriting a file is destructive: the journal must be on disk first (R-RES-3).
		if (await this.ctx.vault.stat(path)) await this.ctx.saver.flush();
		this.ctx.expectedWrites?.set(path, quickXorHash(plain));
		await this.ctx.vault.writeAtomic(path, plain);
		this.taken.add(caseKey(path));
	}

	/** Records B after a download (design §5.5 step 4). A stat that doesn't match the bytes leaves mtime 0. */
	private async recordDownload(path: VaultPath, item: RemoteItem, plain: ArrayBuffer, remoteHash: string): Promise<void> {
		const st = await this.ctx.vault.stat(path);
		putFile(this.state, {
			path,
			remoteId: item.id,
			eTag: item.eTag,
			cTag: item.cTag,
			size: plain.byteLength,
			mtime: st && !st.isFolder && st.size === plain.byteLength ? st.mtime : 0,
			localHash: quickXorHash(plain),
			remoteHash,
			transformId: this.ctx.settings.transformId,
		});
		upsertItem(this.state, item);
		this.recordAncestors(path, item.parentId);
	}

	/**
	 * Records after an upload. `before` is the stat taken before the read: if the file changed since (another
	 * stat differs), mtime 0 forces the next scan to re-hash, so an edit made during the upload is never masked.
	 */
	private async recordUpload(path: VaultPath, item: RemoteItem, plain: ArrayBuffer, localHash: string, remoteHash: string, before: LocalEntry): Promise<void> {
		const after = await this.ctx.vault.stat(path);
		const steady = after !== null && after.size === before.size && after.mtime === before.mtime && before.size === plain.byteLength;
		putFile(this.state, {
			path,
			remoteId: item.id,
			eTag: item.eTag,
			cTag: item.cTag,
			size: plain.byteLength,
			mtime: steady ? before.mtime : 0,
			localHash,
			remoteHash,
			transformId: this.ctx.settings.transformId,
		});
		upsertItem(this.state, item);
		this.etags.set(item.id, item.eTag);
		delete this.state.uploadSessions[path];
	}

	/** Folder records for the parents of `path`, from the remote parent chain (folders created on demand). */
	private recordAncestors(path: string, parentId: string | null): void {
		let p = parentOf(path);
		let id = parentId;
		while (p !== "" && id !== null && id !== this.state.appRootId) {
			if (folderAt(this.state, p) === undefined) putFolder(this.state, p, id);
			id = this.indexItem(id)?.parentId ?? null;
			p = parentOf(p);
		}
	}

	private async persistSession(path: VaultPath, target: UploadTarget | UploadTargetReplace, ifMatch: string | null, size: number, localHash: string, s: UploadSessionInfo): Promise<void> {
		defineEntry(this.state.uploadSessions, path, { path, uploadUrl: s.uploadUrl, expiresAt: s.expiresAt, totalSize: size, localHash, ifMatch, target });
		await this.ctx.saver.flush();
	}

	/** Drops a session after a failure that isn't run-ending; a run-ending one keeps it for resume (R-RES-2). */
	private async dropSession(path: VaultPath, e: unknown): Promise<void> {
		if (runOutcome(this.ctx.classify(e).kind) !== null) return;
		const rec = own(this.state.uploadSessions, path) ? this.state.uploadSessions[path] : undefined;
		if (!rec) return;
		delete this.state.uploadSessions[path];
		try {
			await this.ctx.remote.cancelUpload(rec.uploadUrl);
		} catch {
			// Best effort: an abandoned session expires on its own.
		}
	}

	// ---------- remote folders ----------

	private ensureParent(path: string): Promise<string> {
		const parent = parentOf(path);
		if (parent === "") {
			if (this.state.appRootId === null) return Promise.reject(new OpFailed("no-approot"));
			return Promise.resolve(this.state.appRootId);
		}
		return this.ensureRemoteFolder(parent);
	}

	/** The remote folder id for `path`, creating missing folders on the way (design §5.5: moves and uploads). */
	private ensureRemoteFolder(path: string): Promise<string> {
		const known = folderAt(this.state, path);
		if (known !== undefined && this.indexItem(known)?.isFolder) return Promise.resolve(known);
		const key = caseKey(path);
		const running = this.folderJobs.get(key);
		if (running) return running;
		const job = (async () => {
			const parentId = await this.ensureParent(path);
			const name = baseName(path);
			let item: RemoteItem;
			try {
				item = await this.ctx.remote.createFolder(parentId, name);
			} catch (e) {
				if (this.ctx.classify(e).kind !== "name-exists") throw e;
				const there = await this.ctx.remote.getChildByName(parentId, name);
				if (!there || !there.isFolder) throw e;
				item = there;
			}
			upsertItem(this.state, item);
			putFolder(this.state, path, item.id);
			return item.id;
		})();
		this.folderJobs.set(key, job);
		job.catch(() => this.folderJobs.delete(key));
		return job;
	}

	// ---------- ops ----------

	private async pullFile(op: Extract<PlanOp, { kind: "download" }>): Promise<OpResult> {
		if (this.remoteIsFolder(op.id)) {
			this.checkPath(op.path, true);
			await this.ctx.vault.mkdirp(op.path);
			putFolder(this.state, op.path, op.id);
			return ok(op);
		}
		// A fresh read: current eTag and hash for the record, and the size cap before any bytes are buffered (T-D6).
		const fresh = await this.ctx.remote.getItem(op.id);
		if (!fresh || fresh.deleted || fresh.isFolder) return fail(op, "not-found");
		if (fresh.size > this.ctx.settings.maxFileSize) return fail(op, "too-large");
		this.checkPath(op.path, false);
		if ((await this.localNow(op.path)) === "changed") return this.conflict(op.path, op.id, null);
		const { plain, remoteHash } = await this.ctx.content.fetch(fresh, op.path);
		// The transfer can take a while: check again right before the write (R-CONF-4).
		if ((await this.localNow(op.path)) === "changed") return this.conflict(op.path, op.id, null);
		await this.writeLocal(op.path, plain);
		await this.recordDownload(op.path, fresh, plain, remoteHash);
		return ok(op);
	}

	private newCopyPath(path: VaultPath): VaultPath {
		const s = this.ctx.settings;
		try {
			return conflictCopyPath(path, s.deviceName, s.now, (p) => this.taken.has(caseKey(p)), s.pathPrefixLen);
		} catch (e) {
			// No room for a copy name: keep both sides untouched and report it (M4 carry-in).
			if (e instanceof RangeError) throw new OpFailed("path-too-long");
			throw e;
		}
	}

	/**
	 * The conflict procedure (design §5.5, D-9, R-CONF-1): save pendingConflicts, write the local bytes to the copy,
	 * then download the remote version over the original, then queue the copy's upload.
	 */
	private async conflict(path: VaultPath, id: string, plannedCopy: VaultPath | null): Promise<OpResult> {
		const fresh = await this.ctx.remote.getItem(id);
		const pending = { kind: "conflict" as const, path, id, copyPath: plannedCopy ?? path };
		if (!fresh || fresh.deleted || fresh.isFolder) return fail(pending, "not-found");
		if (fresh.size > this.ctx.settings.maxFileSize) return fail(pending, "too-large");
		this.checkPath(path, false);
		const st = await this.ctx.vault.stat(path);
		if (!st || st.isFolder) {
			// Nothing local to keep any more: a plain download.
			return this.pullFile({ kind: "download", id, path, reason: "changed" });
		}
		const mine = await this.ctx.vault.read(path);
		const mineHash = quickXorHash(mine);

		let copyPath = plannedCopy;
		const pc = own(this.state.pendingConflicts, path) ? this.state.pendingConflicts[path] : undefined;
		// A crash mid-procedure: reuse the same copy for the same pair (step 1). The planner already vetted a planned one.
		if (!copyPath && pc && pc.remoteId === id && pc.localHash === mineHash) copyPath = pc.copyPath;
		copyPath ??= this.newCopyPath(path);
		this.checkPath(copyPath, false);
		const there = await this.hashOf(copyPath);
		if (there !== mineHash) {
			if (there !== null || (await this.ctx.vault.stat(copyPath)) !== null) {
				// Something else is at that name: pick a fresh one, never overwrite it.
				this.taken.add(caseKey(copyPath));
				copyPath = this.newCopyPath(path);
				this.checkPath(copyPath, false);
				if ((await this.ctx.vault.stat(copyPath)) !== null) return fail(pending, "conflict-name");
			}
			defineEntry(this.state.pendingConflicts, path, { path, copyPath, localHash: mineHash, remoteId: id });
			await this.ctx.saver.flush();
			await this.writeLocal(copyPath, mine);
		} else if (!pc) {
			defineEntry(this.state.pendingConflicts, path, { path, copyPath, localHash: mineHash, remoteId: id });
		}
		this.taken.add(caseKey(copyPath));
		const done = { kind: "conflict" as const, path, id, copyPath };

		const { plain, remoteHash } = await this.ctx.content.fetch(fresh, path);
		// Step 4's pre-write check compares against the bytes the copy now preserves.
		const now = await this.hashOf(path);
		if (now !== null && now !== mineHash) return fail(done, "changed-during-sync");
		await this.writeLocal(path, plain);
		await this.recordDownload(path, fresh, plain, remoteHash);
		delete this.state.pendingConflicts[path];
		// The copy reaches every device (D-9); once only, even when a resumed plan already uploads it.
		const key = caseKey(copyPath);
		if (!this.plannedUploads.has(key)) {
			this.plannedUploads.add(key);
			this.pushFiles.push({ kind: "upload-new", path: copyPath });
		}
		this.conflicts.push({ path, copyPath });
		return ok(done);
	}

	private async readForUpload(path: VaultPath): Promise<{ st: LocalEntry; plain: ArrayBuffer; localHash: string }> {
		const st = await this.ctx.vault.stat(path);
		if (!st || st.isFolder) throw new OpFailed("changed-during-sync");
		if (st.size > this.ctx.settings.maxFileSize) throw new OpFailed("too-large");
		const plain = await this.ctx.vault.read(path);
		if (plain.byteLength > this.ctx.settings.maxFileSize) throw new OpFailed("too-large");
		return { st, plain, localHash: quickXorHash(plain) };
	}

	private async pushNew(op: Extract<PlanOp, { kind: "upload-new" }>): Promise<OpResult> {
		const seen = this.scanAt(op.path);
		if (seen?.entry.isFolder || (!seen && (await this.ctx.vault.stat(op.path))?.isFolder)) {
			await this.ensureRemoteFolder(op.path);
			return ok(op);
		}
		const { st, plain, localHash } = await this.readForUpload(op.path);
		const parentId = await this.ensureParent(op.path);
		const target: UploadTarget = { kind: "new", parentId, name: baseName(op.path) };
		try {
			const res = await this.ctx.content.store(target, null, plain, op.path, (s) => this.persistSession(op.path, target, null, plain.byteLength, localHash, s));
			await this.recordUpload(op.path, res.item, plain, localHash, res.remoteHash, st);
			return ok(op);
		} catch (e) {
			await this.dropSession(op.path, e);
			if (this.ctx.classify(e).kind !== "name-exists") throw e;
			// Something appeared at that name since the pull (design §5.5 upload-new step 2).
			const there = await this.ctx.remote.getChildByName(parentId, target.name);
			if (!there || there.isFolder) throw e;
			const stored = await this.ctx.content.storedHashOf(plain, op.path);
			const same = there.quickXorHash !== null ? there.quickXorHash === stored : there.size === 0 && plain.byteLength === 0;
			if (same) {
				await this.recordUpload(op.path, there, plain, localHash, there.quickXorHash ?? stored, st);
				return ok({ kind: "adopt", path: op.path, id: there.id });
			}
			return this.conflict(op.path, there.id, null);
		}
	}

	private async pushReplace(op: Extract<PlanOp, { kind: "upload-replace" }>): Promise<OpResult> {
		const { st, plain, localHash } = await this.readForUpload(op.path);
		const rec = fileAt(this.state, op.path);
		// Unchanged after all (design §5.5 upload-replace step 2): record only.
		if (rec && rec.remoteId === op.id && rec.localHash === localHash && rec.transformId === this.ctx.settings.transformId) {
			putFile(this.state, { ...rec, path: op.path, size: plain.byteLength, mtime: st.mtime });
			return ok({ kind: "adopt", path: op.path, id: op.id });
		}
		// eTag chaining: an earlier op in this run (a remote-move) may have changed it (M5 carry-in).
		let ifMatch = this.etags.get(op.id) ?? op.ifMatch;
		const target: UploadTargetReplace = { kind: "replace", id: op.id };
		for (let attempt = 0; ; attempt++) {
			try {
				const res = await this.ctx.content.store(target, ifMatch, plain, op.path, (s) => this.persistSession(op.path, target, ifMatch, plain.byteLength, localHash, s));
				await this.recordUpload(op.path, res.item, plain, localHash, res.remoteHash, st);
				return ok(op);
			} catch (e) {
				await this.dropSession(op.path, e);
				const kind = this.ctx.classify(e).kind;
				if (kind === "raced") return this.conflict(op.path, op.id, null);
				if (kind !== "precondition" && kind !== "not-found") throw e;
				const fresh = kind === "not-found" ? null : await this.ctx.remote.getItem(op.id);
				if (!fresh || fresh.deleted) {
					// Deleted remotely meanwhile: the local edit wins over the delete (R-DEL-2).
					removeFile(this.state, op.path);
					return this.pushNew({ kind: "upload-new", path: op.path });
				}
				if (attempt === 0 && rec && metadataOnly(rec, fresh)) {
					ifMatch = fresh.eTag;
					continue;
				}
				return this.conflict(op.path, op.id, null);
			}
		}
	}

	private async remoteMove(op: Extract<PlanOp, { kind: "remote-move" }>): Promise<OpResult> {
		const isFolder = this.remoteIsFolder(op.id);
		const parentId = await this.ensureParent(op.to);
		const name = baseName(op.to);
		let moved: RemoteItem;
		try {
			moved = await this.ctx.remote.move(op.id, this.etags.get(op.id) ?? op.ifMatch, parentId, name);
		} catch (e) {
			if (this.ctx.classify(e).kind !== "precondition") throw e;
			const fresh = await this.ctx.remote.getItem(op.id);
			const rec = fileAt(this.state, op.from);
			// A metadata-only change retries once; changed content is re-planned by the next run.
			if (!fresh || !(isFolder || (rec && metadataOnly(rec, fresh)))) throw e;
			moved = await this.ctx.remote.move(op.id, fresh.eTag, parentId, name);
		}
		this.etags.set(op.id, moved.eTag);
		upsertItem(this.state, moved);
		if (isFolder) {
			repathUnder(this.state, op.from, op.to);
			putFolder(this.state, op.to, op.id);
		} else {
			const rec = fileAt(this.state, op.from) ?? fileById(this.state, op.id);
			if (rec) putFile(this.state, { ...rec, path: op.to, eTag: moved.eTag, cTag: moved.cTag });
		}
		return ok(op);
	}

	private async localMove(op: Extract<PlanOp, { kind: "local-move" }>): Promise<OpResult> {
		const seen = this.scanAt(op.from);
		const isFolder = seen?.entry.isFolder ?? (await this.ctx.vault.stat(op.from))?.isFolder ?? false;
		this.checkPath(op.from, isFolder);
		this.checkPath(op.to, isFolder);
		if (!isFolder && (await this.localNow(op.from)) !== "same") return fail(op, "changed-during-sync");
		if ((await this.ctx.vault.stat(op.to)) !== null && caseKey(op.to) !== caseKey(op.from)) return fail(op, "changed-during-sync");
		const parent = parentOf(op.to);
		if (parent !== "") {
			this.checkPath(parent, true);
			await this.ctx.vault.mkdirp(parent as VaultPath);
		}
		await this.ctx.saver.flush();
		await this.ctx.vault.move(op.from, op.to);
		this.moveScan(op.from, op.to);
		this.taken.add(caseKey(op.to));

		const target = this.remoteByPath.get(caseKey(op.to));
		if (isFolder) {
			repathUnder(this.state, op.from, op.to);
			if (target) putFolder(this.state, op.to, target.id);
		} else {
			const rec = fileAt(this.state, op.from) ?? (target ? fileById(this.state, target.id) : undefined);
			if (rec) {
				const next: FileRecord = { ...rec, path: op.to };
				// The remote rename bumped the eTag; the content is what we last synced, so take it.
				if (target && target.id === rec.remoteId && sameStored(rec, target)) {
					next.eTag = target.eTag;
					next.cTag = target.cTag;
				}
				putFile(this.state, next);
			}
		}
		if (target) this.recordAncestors(op.to, target.parentId);
		return ok(op);
	}

	/** Moves scan entries with a local move, so later ops at the new path see what the scan saw. */
	private moveScan(from: string, to: string): void {
		const fromKey = caseKey(from);
		const segs = from.split("/").length;
		for (const [k, v] of [...this.scan]) {
			if (k !== fromKey && !k.startsWith(fromKey + "/")) continue;
			this.scan.delete(k);
			const path = [to, ...v.path.split("/").slice(segs)].join("/") as VaultPath;
			this.scan.set(caseKey(path), { entry: { ...v.entry, path }, path });
		}
	}

	private async localTrash(op: Extract<PlanOp, { kind: "local-trash" }>): Promise<OpResult> {
		if (this.localIsFolder(op.path)) {
			this.checkPath(op.path, true);
			// Only an empty folder is removed (design §5.4); something new in it defers the removal.
			if (!(await this.ctx.vault.removeEmptyFolder(op.path))) return fail(op, "changed-during-sync");
			removeFolder(this.state, op.path);
			return ok(op);
		}
		this.checkPath(op.path, false);
		const now = await this.localNow(op.path);
		if (now === "gone") {
			removeFile(this.state, op.path);
			return ok({ kind: "forget", path: op.path });
		}
		if (now === "changed") return fail(op, "changed-during-sync");
		await this.ctx.saver.flush();
		await this.ctx.vault.trash(op.path);
		removeFile(this.state, op.path);
		return ok(op);
	}

	private async remoteDelete(op: Extract<PlanOp, { kind: "remote-delete" }>): Promise<OpResult> {
		const isFolder = this.remoteIsFolder(op.id);
		await this.ctx.saver.flush();
		try {
			await this.ctx.remote.delete(op.id, this.etags.get(op.id) ?? op.ifMatch);
		} catch (e) {
			const kind = this.ctx.classify(e).kind;
			if (kind === "not-found") {
				if (isFolder) removeFolder(this.state, op.path);
				else removeFile(this.state, op.path);
				removeItemTree(this.state, op.id);
				return ok({ kind: "forget", path: op.path });
			}
			// Changed remotely since the pull: bring that edit back instead of deleting it (R-DEL-2).
			if (kind === "precondition" && !isFolder) return this.pullFile({ kind: "download", id: op.id, path: op.path, reason: "edit-wins" });
			throw e;
		}
		if (isFolder) removeFolder(this.state, op.path);
		else removeFile(this.state, op.path);
		removeItemTree(this.state, op.id);
		return ok(op);
	}

	private adopt(op: Extract<PlanOp, { kind: "adopt" }>): OpResult {
		const item = this.indexItem(op.id);
		if (!item) return fail(op, "not-found");
		if (item.isFolder) {
			putFolder(this.state, op.path, op.id);
			return ok(op);
		}
		const seen = this.scanAt(op.path);
		if (!seen || seen.entry.localHash === null || seen.entry.storedHash === null) return fail(op, "not-found");
		putFile(this.state, {
			path: op.path,
			remoteId: item.id,
			eTag: item.eTag,
			cTag: item.cTag,
			size: seen.entry.size,
			mtime: seen.entry.mtime,
			localHash: seen.entry.localHash,
			remoteHash: item.quickXorHash ?? seen.entry.storedHash,
			transformId: this.ctx.settings.transformId,
		});
		this.recordAncestors(op.path, item.parentId);
		return ok(op);
	}
}

/** The path an op writes to: the destination of a move, otherwise its path. */
function opTarget(op: PlanOp): string {
	return op.kind === "remote-move" || op.kind === "local-move" ? op.to : op.path;
}
