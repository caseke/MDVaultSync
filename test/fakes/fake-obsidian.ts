// A minimal in-memory stand-in for Obsidian's Vault, DataAdapter and FileManager, shaped like the structural
// types in src/platform/obsidian-vault.ts and plugin-state-store.ts. `renameOverwrites` models the open question
// O-API-10: whether adapter.rename replaces an existing target (true), throws (false), or leaves it ("keep").
interface Entry {
	data: Uint8Array;
	mtime: number;
}

export interface FakeFile {
	path: string;
	extension: string;
	stat: { size: number; mtime: number; ctime: number };
}
export interface FakeFolder {
	path: string;
	children: (FakeFile | FakeFolder)[];
}

export class FakeObsidian {
	readonly entries = new Map<string, Entry>();
	readonly folderSet = new Set<string>();
	readonly trashed: string[] = [];
	readonly calls: string[] = [];
	renameOverwrites: boolean | "keep" = true;
	configDir = "obs-config";
	private clock = 1;

	readonly adapter = {
		exists: (p: string): Promise<boolean> => Promise.resolve(this.entries.has(p) || this.folderSet.has(p)),
		writeBinary: (p: string, d: ArrayBuffer): Promise<void> => {
			this.calls.push(`writeBinary ${p}`);
			this.put(p, new Uint8Array(d));
			return Promise.resolve();
		},
		write: (p: string, s: string): Promise<void> => {
			this.calls.push(`write ${p}`);
			this.put(p, new TextEncoder().encode(s));
			return Promise.resolve();
		},
		read: (p: string): Promise<string> => {
			const e = this.entries.get(p);
			return e ? Promise.resolve(new TextDecoder().decode(e.data)) : Promise.reject(new Error("ENOENT"));
		},
		rename: (from: string, to: string): Promise<void> => {
			this.calls.push(`rename ${from} -> ${to}`);
			const e = this.entries.get(from);
			if (!e) return Promise.reject(new Error("ENOENT"));
			if (this.entries.has(to)) {
				if (this.renameOverwrites === false) return Promise.reject(new Error("Destination file already exists!"));
				if (this.renameOverwrites === "keep") return Promise.resolve();
			}
			this.entries.delete(from);
			this.entries.set(to, e);
			return Promise.resolve();
		},
		remove: (p: string): Promise<void> => {
			this.calls.push(`remove ${p}`);
			this.entries.delete(p);
			return Promise.resolve();
		},
	};

	readonly fileManager = {
		trashFile: (f: { path: string }): Promise<void> => {
			this.calls.push(`trash ${f.path}`);
			this.trashed.push(f.path);
			this.entries.delete(f.path);
			this.folderSet.delete(f.path);
			return Promise.resolve();
		},
	};

	put(p: string, data: Uint8Array): void {
		this.entries.set(p, { data: data.slice(), mtime: this.clock++ });
	}

	text(p: string): string | null {
		const e = this.entries.get(p);
		return e ? new TextDecoder().decode(e.data) : null;
	}

	private file(p: string): FakeFile | null {
		const e = this.entries.get(p);
		if (!e) return null;
		const name = p.slice(p.lastIndexOf("/") + 1);
		return { path: p, extension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "", stat: { size: e.data.length, mtime: e.mtime, ctime: 0 } };
	}

	private allFolderPaths(): Set<string> {
		const out = new Set(this.folderSet);
		for (const p of this.entries.keys()) {
			const segs = p.split("/");
			for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join("/"));
		}
		return out;
	}

	private folder(p: string): FakeFolder | null {
		if (!this.allFolderPaths().has(p)) return null;
		const children: (FakeFile | FakeFolder)[] = [];
		for (const q of this.entries.keys()) if (q.startsWith(p + "/") && !q.slice(p.length + 1).includes("/")) children.push(this.file(q) as FakeFile);
		for (const q of this.allFolderPaths()) if (q.startsWith(p + "/") && !q.slice(p.length + 1).includes("/")) children.push({ path: q, children: [] });
		return { path: p, children };
	}

	/** The Vault surface (only the files and folders the Vault API sees: no hidden ones [O-API-11]). */
	readonly vault = {
		configDir: this.configDir,
		adapter: this.adapter,
		getFiles: (): FakeFile[] =>
			[...this.entries.keys()].filter((p) => !p.split("/").some((s) => s.startsWith("."))).map((p) => this.file(p) as FakeFile),
		getAllFolders: (): FakeFolder[] =>
			[...this.allFolderPaths()].filter((p) => !p.split("/").some((s) => s.startsWith("."))).map((p) => this.folder(p) as FakeFolder),
		getAbstractFileByPath: (p: string): FakeFile | FakeFolder | null => this.file(p) ?? this.folder(p),
		readBinary: (f: { path: string }): Promise<ArrayBuffer> => {
			const e = this.entries.get(f.path);
			return e ? Promise.resolve(e.data.slice().buffer) : Promise.reject(new Error("ENOENT"));
		},
		createFolder: (p: string): Promise<void> => {
			this.calls.push(`createFolder ${p}`);
			if (this.allFolderPaths().has(p)) return Promise.reject(new Error("Folder already exists."));
			this.folderSet.add(p);
			return Promise.resolve();
		},
		rename: (f: { path: string }, to: string): Promise<void> => {
			this.calls.push(`vault.rename ${f.path} -> ${to}`);
			const e = this.entries.get(f.path);
			if (e) {
				this.entries.delete(f.path);
				this.entries.set(to, e);
				return Promise.resolve();
			}
			const prefix = f.path + "/";
			for (const [p, d] of [...this.entries]) {
				if (!p.startsWith(prefix)) continue;
				this.entries.delete(p);
				this.entries.set(to + "/" + p.slice(prefix.length), d);
			}
			for (const p of [...this.folderSet]) {
				if (p !== f.path && !p.startsWith(prefix)) continue;
				this.folderSet.delete(p);
				this.folderSet.add(to + p.slice(f.path.length));
			}
			return Promise.resolve();
		},
	};
}

/** Obsidian's normalizePath, for the parts these tests use: slashes, duplicate separators, NFC [O-API-16]. */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").normalize("NFC");
}
