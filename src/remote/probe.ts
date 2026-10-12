// Graph capability probe (plan M3 "Probes", research.md §6). Runs inside the hidden App Folder subfolder
// PROBE_DIR, which normal sync excludes (design §7), then deletes it. The result holds statuses, codes, counts,
// durations, hostnames, and the App Folder's own name and parent drive path (set by Microsoft and the app
// registration, not vault data). No vault names, URLs, tokens or contents (T-I3). Every name it creates is fixed.
import type { Clock, RemoteItem } from "../core/ports.ts";
import type { DeltaForm } from "./capabilities.ts";
import { GraphError, sanitizeGraphCode, toGraphError } from "./errors.ts";
import { GRAPH_BASE, encodeSegment, type GraphClient } from "./graph.ts";
import { fragmentRanges } from "./upload-session.ts";
import { MAX_JSON_BODY, parseItemExtras, parseJsonObject } from "./validate.ts";

export const PROBE_DIR = ".mdvaultsync-probe";
export const LARGE_SIZE = 12 * 1024 * 1024;
export const LARGE_SEED = 0x4d445653;
export const SEQ_SIZE = 1000;
export const SEQ_SEED = 7;
export const PROBE_TEXT = "MDVaultSync probe\n";

export interface ProbeDeps {
	graph: GraphClient;
	/** A client using the given delta form, for probe 2. */
	graphFor(form: DeltaForm): GraphClient;
	clock: Clock;
	platform: string;
	pluginVersion: string;
}

export interface Outcome {
	status?: number;
	code?: string;
}
export interface DeltaResult extends Outcome {
	ok: boolean;
	pages?: number;
	items?: number;
	approotListed?: boolean;
	filesWithHash?: number;
	filesWithoutHash?: number;
}
export interface HashVector {
	file: string;
	size: number;
	generator: string;
	seed?: number;
	quickXorHash: string | null;
}
export interface ProbeResult {
	probeVersion: 1;
	platform: string;
	pluginVersion: string;
	startedAt: string;
	durationMs: number;
	approot: ({ ok: true; parentPath: string; name: string; pathPrefixLength: number }) | ({ ok: false } & Outcome);
	leftoverRemoved: boolean;
	delta: Record<"approot-colon" | "items-id", DeltaResult>;
	putIfMatch: { honored: boolean | null; staleStatus?: number; staleCode?: string };
	caseInsensitive: { confirmed: boolean | null } & Outcome;
	nameLength: { len255: Outcome; len256: Outcome; nameMax: number | null };
	patchIfMatch: { currentStatus?: number; staleStatus?: number };
	deleteIfMatch: { staleStatus?: number; currentStatus?: number };
	quota: { readable: boolean | null } & Outcome;
	largeFile: {
		ok: boolean;
		size: number;
		fragments: number;
		uploadMs?: number;
		downloadMs?: number;
		bytesMatch?: boolean;
		uploadHost?: string;
		downloadHost?: string;
	} & Outcome;
	hashVectors: HashVector[];
	cleanup: { ok: boolean } & Outcome;
	/** Steps that failed unexpectedly. */
	errors: number;
}

/** Deterministic xorshift32 bytes, so M4 can recompute the probe files and compare QuickXorHash vectors. */
export function probeBytes(n: number, seed: number): ArrayBuffer {
	const out = new Uint8Array(n);
	let x = seed >>> 0 || 1;
	for (let i = 0; i < n; i++) {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		out[i] = x & 0xff;
	}
	return out.buffer;
}

function text(s: string): ArrayBuffer {
	const u8 = new TextEncoder().encode(s);
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** Status and sanitized code of a failure; never the message (T-I3). */
function outcomeOf(e: unknown): Outcome {
	if (e instanceof GraphError) return { status: e.status, code: e.code };
	return { code: sanitizeGraphCode(e instanceof Error ? e.name : "unknown") };
}

function hostOf(url: string): string {
	return new URL(url).hostname;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

export async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
	const { graph, clock } = deps;
	const t0 = clock.now();
	let errors = 0;
	const fail = (e: unknown): Outcome => {
		errors++;
		return outcomeOf(e);
	};
	/** A raw request whose status is the finding; errors become {status, code}. */
	const raw = async (method: string, url: string, headers: Record<string, string> = {}, body?: ArrayBuffer): Promise<Outcome> => {
		const res = await graph.sendRaw({ url, method, headers, ...(body !== undefined ? { body } : {}) });
		if (res.status >= 200 && res.status < 300) return { status: res.status };
		const e = toGraphError(res);
		return { status: e.status, code: e.code };
	};
	const item = (id: string) => `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(id)}`;
	const childPut = (parentId: string, name: string) =>
		`${item(parentId)}:/${encodeSegment(name)}:/content?@microsoft.graph.conflictBehavior=fail`;

	const notRun: DeltaResult = { ok: false, code: "not-run" };
	const result: ProbeResult = {
		probeVersion: 1,
		platform: deps.platform,
		pluginVersion: deps.pluginVersion,
		startedAt: new Date(t0).toISOString(),
		durationMs: 0,
		approot: { ok: false, code: "not-run" },
		leftoverRemoved: false,
		delta: { "approot-colon": notRun, "items-id": notRun },
		putIfMatch: { honored: null },
		caseInsensitive: { confirmed: null },
		nameLength: { len255: {}, len256: {}, nameMax: null },
		patchIfMatch: {},
		deleteIfMatch: {},
		quota: { readable: null },
		largeFile: { ok: false, size: LARGE_SIZE, fragments: fragmentRanges(LARGE_SIZE).length },
		hashVectors: [],
		cleanup: { ok: true },
		errors: 0,
	};

	// 1. The App Folder [G-AF-1].
	let approot: RemoteItem;
	try {
		const ar = await graph.getAppRoot();
		approot = ar.item;
		const parentPath = ar.pathPrefix.slice(0, ar.pathPrefix.length - ar.item.name.length - 1);
		result.approot = { ok: true, parentPath: `/drive/root:${parentPath}`, name: ar.item.name, pathPrefixLength: ar.pathPrefix.length - 1 };
	} catch (e) {
		result.approot = { ok: false, ...fail(e) };
		result.errors = errors;
		result.durationMs = clock.now() - t0;
		return result;
	}

	let folder: RemoteItem | null = null;
	try {
		const old = await graph.getChildByName(approot.id, PROBE_DIR);
		// Only a leftover folder is ours to remove; a file of that name stops the probe instead.
		if (old && !old.isFolder) throw new GraphError(409, "probe-name-taken");
		if (old) {
			await graph.delete(old.id, old.eTag);
			result.leftoverRemoved = true;
		}
		folder = await graph.createFolder(approot.id, PROBE_DIR);
		const dir = folder.id;

		// Files whose hashes become M4's QuickXorHash vectors.
		const vectors: [string, ArrayBuffer, string, number | undefined][] = [
			["probe.md", text(PROBE_TEXT), `utf8:${JSON.stringify(PROBE_TEXT)}`, undefined],
			["empty.bin", new ArrayBuffer(0), "empty", undefined],
			["seq.bin", probeBytes(SEQ_SIZE, SEQ_SEED), `probeBytes(${SEQ_SIZE}, seed)`, SEQ_SEED],
		];
		for (const [file, data, generator, seed] of vectors) {
			const it = await graph.uploadNew(dir, file, data);
			result.hashVectors.push({ file, size: data.byteLength, generator, ...(seed !== undefined ? { seed } : {}), quickXorHash: it.quickXorHash });
		}

		// 4. Case-insensitive names [G-NM-5]: PROBE.md next to probe.md with conflictBehavior=fail.
		try {
			const r = await raw("PUT", childPut(dir, "PROBE.md"), { "Content-Type": "application/octet-stream" }, text("x"));
			result.caseInsensitive = { confirmed: r.status === 409 ? true : r.status === 200 || r.status === 201 ? false : null, ...r };
		} catch (e) {
			result.caseInsensitive = { confirmed: null, ...fail(e) };
		}

		// 3. Does PUT /content honor a stale If-Match [G-UP-3] (D-11)?
		try {
			const v1 = await graph.uploadNew(dir, "ifmatch.md", text("v1"));
			await graph.uploadReplace(v1.id, v1.eTag, text("v2"));
			const r = await raw("PUT", `${item(v1.id)}/content`, { "Content-Type": "application/octet-stream", "If-Match": v1.eTag }, text("v3"));
			const honored = r.status === 412 ? true : r.status === 200 || r.status === 201 ? false : null;
			result.putIfMatch = { honored, ...(r.status !== undefined ? { staleStatus: r.status } : {}), ...(r.code ? { staleCode: r.code } : {}) };
		} catch (e) {
			result.putIfMatch = { honored: null, ...fail(e) };
		}

		// 5. Per-name length limit [G-NM-6].
		try {
			const len255 = await raw("PUT", childPut(dir, `${"n".repeat(251)}.txt`), { "Content-Type": "application/octet-stream" }, text("x"));
			const len256 = await raw("PUT", childPut(dir, `${"m".repeat(252)}.txt`), { "Content-Type": "application/octet-stream" }, text("x"));
			const ok = (o: Outcome) => o.status === 200 || o.status === 201;
			result.nameLength = { len255, len256, nameMax: ok(len255) && !ok(len256) ? 255 : null };
		} catch (e) {
			result.nameLength = { len255: fail(e), len256: {}, nameMax: null };
		}

		// 6. PATCH and DELETE with If-Match under the AppFolder scope [G-AF-5], [G-MV-1], [G-DEL-1].
		try {
			const c = await graph.uploadNew(dir, "move.md", text("m"));
			const moved = await graph.move(c.id, c.eTag, dir, "moved.md");
			result.patchIfMatch.currentStatus = 200;
			const stalePatch = await raw("PATCH", item(c.id), { "Content-Type": "application/json", "If-Match": c.eTag }, text(JSON.stringify({ name: "moved2.md" })));
			if (stalePatch.status !== undefined) result.patchIfMatch.staleStatus = stalePatch.status;
			const staleDelete = await raw("DELETE", item(c.id), { "If-Match": c.eTag });
			if (staleDelete.status !== undefined) result.deleteIfMatch.staleStatus = staleDelete.status;
			const fresh = (await graph.getItem(c.id)) ?? moved;
			const del = await raw("DELETE", item(c.id), { "If-Match": fresh.eTag });
			if (del.status !== undefined) result.deleteIfMatch.currentStatus = del.status;
		} catch (e) {
			fail(e);
		}

		// 2. Delta forms on the App Folder, and hashes in delta [G-DL-1], [G-DL-8].
		for (const form of ["approot-colon", "items-id"] as const) {
			try {
				const d = await deps.graphFor(form).deltaAll(null);
				const files = d.items.filter((i) => !i.isFolder && !i.deleted);
				result.delta[form] = {
					ok: true,
					pages: d.pages,
					items: d.items.length,
					approotListed: d.items.some((i) => i.id === approot.id),
					filesWithHash: files.filter((i) => i.quickXorHash !== null).length,
					filesWithoutHash: files.filter((i) => i.quickXorHash === null).length,
				};
			} catch (e) {
				// An unsupported form is a finding, not an error.
				result.delta[form] = { ok: false, ...outcomeOf(e) };
			}
		}

		// 7. Quota under the AppFolder scope [G-QT-1].
		try {
			result.quota = { readable: (await graph.quota()) !== null };
		} catch (e) {
			result.quota = { readable: null, ...fail(e) };
		}

		// 8. 12 MiB round trip through an upload session (10 + 2 MiB) and the download URL [O-API-2] (T-D6).
		try {
			const data = probeBytes(LARGE_SIZE, LARGE_SEED);
			const tUp = clock.now();
			const s = await graph.createUploadSession({ kind: "new", parentId: dir, name: "large.bin" }, null, LARGE_SIZE);
			result.largeFile.uploadHost = hostOf(s.uploadUrl);
			let done: RemoteItem | null = null;
			for (const r of fragmentRanges(LARGE_SIZE)) done = await graph.putFragment(s.uploadUrl, r.start, LARGE_SIZE, data.slice(r.start, r.end));
			if (!done) throw new GraphError(0, "upload-incomplete");
			result.largeFile.uploadMs = clock.now() - tUp;
			result.hashVectors.push({ file: "large.bin", size: LARGE_SIZE, generator: `probeBytes(${LARGE_SIZE}, seed)`, seed: LARGE_SEED, quickXorHash: done.quickXorHash });
			const meta = await graph.sendRaw({ url: `${item(done.id)}?$select=id,@microsoft.graph.downloadUrl`, method: "GET" });
			if (meta.status !== 200) throw toGraphError(meta);
			const dl = parseItemExtras(parseJsonObject(meta.body, MAX_JSON_BODY)).downloadUrl;
			if (dl) result.largeFile.downloadHost = hostOf(dl);
			const tDown = clock.now();
			const back = await graph.download(done.id);
			result.largeFile.downloadMs = clock.now() - tDown;
			result.largeFile.bytesMatch = sameBytes(data, back);
			result.largeFile.ok = result.largeFile.bytesMatch;
		} catch (e) {
			Object.assign(result.largeFile, { ok: false }, fail(e));
		}
	} catch (e) {
		// Setup (leftover removal, folder or vector files) failed; later steps didn't run.
		fail(e);
	} finally {
		if (folder) {
			try {
				const fresh = await graph.getItem(folder.id);
				if (fresh) await graph.delete(fresh.id, fresh.eTag);
				result.cleanup = { ok: true };
			} catch (e) {
				result.cleanup = { ok: false, ...fail(e) };
			}
		}
	}
	result.errors = errors;
	result.durationMs = clock.now() - t0;
	return result;
}
