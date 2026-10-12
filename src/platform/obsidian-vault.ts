// VaultPort over Obsidian (plan M6, design §2). The Vault API is used for everything the user sees: listing,
// reading, creating folders, Vault.rename for moves (not FileManager.renameFile: the device that made the rename
// already rewrote links, D-16) [O-API-8], and FileManager.trashFile for deletes, which honors the user's "Deleted
// files" setting [O-API-7]. The adapter is used only for the hidden temp file of an atomic write (R-IO-1).
//
// Obsidian objects come in through structural types, so this file has no runtime `obsidian` import and runs under
// node --test; main.ts passes app.vault and app.fileManager.
import { exclusionReason } from "../core/exclude.ts";
import { UnsafePath } from "../core/failure.ts";
import { containmentProblem, toVaultPath, validatePath } from "../core/paths.ts";
import type { LocalEntry, VaultPath, VaultPort } from "../core/ports.ts";
import { replaceInto, TargetRemoved } from "./atomic.ts";

export interface FileLike {
	path: string;
	extension: string;
	stat: { size: number; mtime: number };
}
export interface FolderLike {
	path: string;
	children: readonly unknown[];
}
export interface AdapterLike {
	exists(path: string): Promise<boolean>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
}
export interface VaultLike {
	configDir: string;
	adapter: AdapterLike;
	getFiles(): FileLike[];
	getAllFolders(includeRoot?: boolean): FolderLike[];
	getAbstractFileByPath(path: string): unknown;
	readBinary(file: FileLike): Promise<ArrayBuffer>;
	createFolder(path: string): Promise<unknown>;
	rename(file: FileLike | FolderLike, newPath: string): Promise<void>;
}
export interface FileManagerLike {
	trashFile(file: FileLike | FolderLike): Promise<void>;
}

export interface ObsidianVaultOptions {
	vault: VaultLike;
	fileManager: FileManagerLike;
	normalizePath: (p: string) => string;
	excludePatterns: () => readonly string[];
	/** `AppRoot.pathPrefix` length without its leading "/", for the name and length re-check (T-T1). */
	pathPrefixLen: () => number;
	/** Random suffix for temp files; crypto.getRandomValues by default. */
	randomHex?: () => string;
}

const TEMP_PREFIX = ".mdvaultsync-tmp-";

function isFile(f: unknown): f is FileLike {
	return typeof f === "object" && f !== null && "stat" in f && "extension" in f;
}

function isFolder(f: unknown): f is FolderLike {
	return typeof f === "object" && f !== null && "children" in f;
}

function parentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? "" : p.slice(0, i);
}

function randomHex(): string {
	const b = new Uint8Array(8);
	crypto.getRandomValues(b);
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class ObsidianVault implements VaultPort {
	private readonly vault: VaultLike;
	private readonly fileManager: FileManagerLike;
	private readonly normalize: (p: string) => string;
	private readonly patterns: () => readonly string[];
	private readonly prefixLen: () => number;
	private readonly random: () => string;

	constructor(opts: ObsidianVaultOptions) {
		this.vault = opts.vault;
		this.fileManager = opts.fileManager;
		this.normalize = opts.normalizePath;
		this.patterns = opts.excludePatterns;
		this.prefixLen = opts.pathPrefixLen;
		this.random = opts.randomHex ?? randomHex;
	}

	list(): Promise<LocalEntry[]> {
		const out: LocalEntry[] = [];
		const { configDir } = this.vault;
		const patterns = this.patterns();
		// Paths are returned as the vault reports them; the planner normalizes and detects NFC collisions (R-PATH-1).
		for (const f of this.vault.getAllFolders(false)) {
			const p = toVaultPath(f.path);
			if (p && exclusionReason(p, configDir, patterns, true) === null) out.push({ path: f.path as VaultPath, size: 0, mtime: 0, isFolder: true });
		}
		for (const f of this.vault.getFiles()) {
			const p = toVaultPath(f.path);
			if (p && exclusionReason(p, configDir, patterns, false) === null) {
				out.push({ path: f.path as VaultPath, size: f.stat.size, mtime: f.stat.mtime, isFolder: false });
			}
		}
		return Promise.resolve(out);
	}

	/** The vault object for an NFC path; a name stored in another Unicode form (ext4) is found by comparison. */
	private find(path: string): unknown {
		const direct = this.vault.getAbstractFileByPath(path);
		if (direct) return direct;
		// Only a non-ASCII name can differ in normalization form.
		if (![...path].some((c) => c.charCodeAt(0) > 0x7f)) return null;
		for (const f of this.vault.getFiles()) if (f.path.normalize("NFC") === path) return f;
		for (const f of this.vault.getAllFolders(false)) if (f.path.normalize("NFC") === path) return f;
		return null;
	}

	/** The path to use for `path` on disk: an existing entry's own spelling, else the path itself. */
	private real(path: string): string {
		const f = this.find(path);
		return isFile(f) || isFolder(f) ? f.path : path;
	}

	/** Containment and name rules on the final path, right before a write (T-T1, M4 carry-in). */
	private check(path: string, isFolder: boolean): void {
		if (
			toVaultPath(path) !== path ||
			this.normalize(path) !== path ||
			containmentProblem(path, this.vault.configDir) !== null ||
			validatePath(path, this.prefixLen(), isFolder) !== null
		) {
			throw new UnsafePath();
		}
	}

	stat(path: VaultPath): Promise<LocalEntry | null> {
		const f = this.find(path);
		if (isFile(f)) return Promise.resolve({ path, size: f.stat.size, mtime: f.stat.mtime, isFolder: false });
		if (isFolder(f)) return Promise.resolve({ path, size: 0, mtime: 0, isFolder: true });
		return Promise.resolve(null);
	}

	read(path: VaultPath): Promise<ArrayBuffer> {
		const f = this.find(path);
		if (!isFile(f)) return Promise.reject(new Error("not-found"));
		return this.vault.readBinary(f);
	}

	async writeAtomic(path: VaultPath, data: ArrayBuffer): Promise<void> {
		this.check(path, false);
		const target = this.real(path);
		const parent = parentOf(target);
		if (parent !== "") await this.mkdirp(parent as VaultPath);
		const tmp = `${parent === "" ? "" : parent + "/"}${TEMP_PREFIX}${this.random()}`;
		const adapter = this.vault.adapter;
		await adapter.writeBinary(tmp, data);
		try {
			await replaceInto(adapter, tmp, target);
		} catch (e) {
			// Once the target is gone the temp file holds the only copy of these bytes: leave it (security review).
			// The next run sees "deleted here, changed there" and downloads the file again (R-DEL-2).
			if (e instanceof TargetRemoved) throw e;
			try {
				if (await adapter.exists(tmp)) await adapter.remove(tmp);
			} catch {
				// The temp file is hidden and never synced; a leftover is harmless.
			}
			throw e;
		}
	}

	async mkdirp(path: VaultPath): Promise<void> {
		this.check(path, true);
		const segs = path.split("/");
		for (let i = 1; i <= segs.length; i++) {
			const p = segs.slice(0, i).join("/");
			if (this.find(p)) continue;
			try {
				await this.vault.createFolder(p);
			} catch (e) {
				if (!this.find(p)) throw e;
			}
		}
	}

	async move(from: VaultPath, to: VaultPath): Promise<void> {
		const f = this.find(from);
		if (!isFile(f) && !isFolder(f)) throw new Error("not-found");
		this.check(to, isFolder(f));
		const parent = parentOf(to);
		if (parent !== "") await this.mkdirp(parent as VaultPath);
		await this.vault.rename(f, to);
	}

	async trash(path: VaultPath): Promise<void> {
		this.check(path, false);
		const f = this.find(path);
		if (!isFile(f) && !isFolder(f)) throw new Error("not-found");
		await this.fileManager.trashFile(f);
	}

	async removeEmptyFolder(path: VaultPath): Promise<boolean> {
		this.check(path, true);
		const f = this.find(path);
		if (!f) return true;
		if (!isFolder(f) || f.children.length > 0) return false;
		await this.fileManager.trashFile(f);
		return true;
	}
}
