// In-memory vault implementing VaultPort (plan M5). Case-sensitive like ext4, so case-only collisions can be
// built. `list()` hides what the real port hides (configDir, hidden segments, exclude patterns).
import { exclusionReason } from "../../src/core/exclude.ts";
import { quickXorHash } from "../../src/core/quickxor.ts";
import type { LocalEntry, VaultPath, VaultPort } from "../../src/core/ports.ts";
import type { ScannedEntry } from "../../src/core/planner.ts";

interface FileData {
	data: Uint8Array;
	mtime: number;
}

export interface FakeVaultOptions {
	configDir: string;
	patterns?: readonly string[];
}

function parentsOf(path: string): string[] {
	const segs = path.split("/");
	return segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join("/"));
}

export class FakeVault implements VaultPort {
	readonly files = new Map<string, FileData>();
	readonly folders = new Set<string>();
	readonly trashed: string[] = [];
	private clock = 1;
	private readonly configDir: string;
	private readonly patterns: readonly string[];

	constructor(opts: FakeVaultOptions) {
		this.configDir = opts.configDir;
		this.patterns = opts.patterns ?? [];
	}

	// ---------- VaultPort ----------
	list(): Promise<LocalEntry[]> {
		const out: LocalEntry[] = [];
		for (const p of this.allFolders()) {
			if (exclusionReason(p, this.configDir, this.patterns, true) === null) out.push({ path: p as VaultPath, size: 0, mtime: 0, isFolder: true });
		}
		for (const [p, f] of this.files) {
			if (exclusionReason(p, this.configDir, this.patterns, false) === null) {
				out.push({ path: p as VaultPath, size: f.data.length, mtime: f.mtime, isFolder: false });
			}
		}
		return Promise.resolve(out.sort((a, b) => (a.path < b.path ? -1 : 1)));
	}

	stat(path: VaultPath): Promise<LocalEntry | null> {
		const f = this.files.get(path);
		if (f) return Promise.resolve({ path, size: f.data.length, mtime: f.mtime, isFolder: false });
		return Promise.resolve(this.allFolders().has(path) ? { path, size: 0, mtime: 0, isFolder: true } : null);
	}

	read(path: VaultPath): Promise<ArrayBuffer> {
		const f = this.files.get(path);
		if (!f) return Promise.reject(new Error("not-found"));
		return Promise.resolve(f.data.slice().buffer);
	}

	writeAtomic(path: VaultPath, data: ArrayBuffer): Promise<void> {
		this.write(path, new Uint8Array(data));
		return Promise.resolve();
	}

	mkdirp(path: VaultPath): Promise<void> {
		this.folders.add(path);
		return Promise.resolve();
	}

	move(from: VaultPath, to: VaultPath): Promise<void> {
		if (!this.files.has(from) && !this.allFolders().has(from)) return Promise.reject(new Error("not-found"));
		this.rename(from, to);
		return Promise.resolve();
	}

	trash(path: VaultPath): Promise<void> {
		if (!this.files.delete(path)) return Promise.reject(new Error("not-found"));
		this.trashed.push(path);
		return Promise.resolve();
	}

	removeEmptyFolder(path: VaultPath): Promise<boolean> {
		const prefix = path + "/";
		const busy = [...this.files.keys(), ...this.folders].some((p) => p.startsWith(prefix));
		if (busy) return Promise.resolve(false);
		this.folders.delete(path);
		return Promise.resolve(true);
	}

	// ---------- test helpers ----------
	write(path: string, content: string | Uint8Array): void {
		const data = typeof content === "string" ? new TextEncoder().encode(content) : content.slice();
		this.files.set(path, { data, mtime: this.clock++ });
	}

	remove(path: string): void {
		this.files.delete(path);
		this.folders.delete(path);
	}

	/** Renames a file, or a folder with everything under it. */
	rename(from: string, to: string): void {
		const f = this.files.get(from);
		if (f) {
			this.files.delete(from);
			this.files.set(to, f);
			return;
		}
		const prefix = from + "/";
		for (const [p, d] of [...this.files]) {
			if (!p.startsWith(prefix)) continue;
			this.files.delete(p);
			this.files.set(to + "/" + p.slice(prefix.length), d);
		}
		for (const p of [...this.folders]) {
			if (p !== from && !p.startsWith(prefix)) continue;
			this.folders.delete(p);
			this.folders.add(to + p.slice(from.length));
		}
	}

	contentAt(path: string): string | null {
		const f = this.files.get(path);
		return f ? new TextDecoder().decode(f.data) : null;
	}

	/** What M6's scan will hand the planner: every listed entry with its hashes (identity transform). */
	async scan(): Promise<ScannedEntry[]> {
		const out: ScannedEntry[] = [];
		for (const e of await this.list()) {
			const f = this.files.get(e.path);
			const hash = f ? quickXorHash(f.data.slice().buffer) : null;
			out.push({ path: e.path, isFolder: e.isFolder, size: e.size, mtime: e.mtime, localHash: hash, storedHash: hash });
		}
		return out;
	}

	private allFolders(): Set<string> {
		const out = new Set(this.folders);
		for (const p of [...this.files.keys(), ...this.folders]) for (const a of parentsOf(p)) out.add(a);
		return out;
	}
}
