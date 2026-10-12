// HTTP-level fake of the Graph endpoints GraphClient uses, with OneDrive personal semantics: case-insensitive
// names, eTag on any change, cTag on content changes, If-Match (412), conflictBehavior=fail (409), upload
// sessions on a non-Graph host, and pre-authenticated download URLs. It records Authorization leaks.
import { createHash } from "node:crypto";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/core/ports.ts";

export const GRAPH = "https://graph.microsoft.com/v1.0";
export const UPLOAD_HOST = "https://api.onedrive.com";
export const DOWNLOAD_HOST = "https://public.dm.files.1drv.com";
/** Appears in every download and upload URL; a test asserts it never reaches a log or probe result. */
export const URL_SECRET = "TEMPAUTH-SECRET";

interface Node {
	id: string;
	name: string;
	parentId: string | null;
	isFolder: boolean;
	content: Uint8Array;
	version: number;
	contentVersion: number;
}

interface Session {
	target: { parentId: string; name: string } | { id: string };
	/** From fileSize when sent, otherwise from the first fragment's Content-Range. */
	total: number | null;
	received: Uint8Array;
	next: number;
}

export interface FakeGraphOptions {
	deltaForms?: ("approot-colon" | "items-id")[];
	putHonorsIfMatch?: boolean;
	quotaReadable?: boolean;
	nameMax?: number;
	pageSize?: number;
	/** Omit file hashes from delta responses (G-DL-8). */
	deltaHashes?: boolean;
	/** Return a download URL on this host instead of the 1drv.com one. */
	downloadHost?: string;
	/** Answer 400 to a createUploadSession body that carries item.fileSize (the 0.3.0 Ubuntu probe result). */
	rejectFileSize?: boolean;
	/** Hand out upload URLs on this origin instead of api.onedrive.com. */
	uploadHost?: string;
}

export function sha1Base64(b: Uint8Array): string {
	return createHash("sha1").update(b).digest("base64");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
	const u8 = new TextEncoder().encode(JSON.stringify(body));
	return { status, headers: { "content-type": "application/json", ...headers }, body: u8.buffer.slice(0) };
}

function err(status: number, code: string, inner?: string): HttpResponse {
	return json(status, { error: { code, message: "fake message with /secret/path", ...(inner ? { innerError: { code: inner } } : {}) } });
}

function toBytes(body: HttpRequest["body"]): Uint8Array {
	if (body === undefined) return new Uint8Array(0);
	if (typeof body === "string") return new TextEncoder().encode(body);
	return new Uint8Array(body.slice(0));
}

function header(req: HttpRequest, name: string): string | undefined {
	for (const [k, v] of Object.entries(req.headers ?? {})) if (k.toLowerCase() === name) return v;
	return undefined;
}

export class FakeGraph implements HttpTransport {
	readonly requests: HttpRequest[] = [];
	readonly authLeaks: string[] = [];
	readonly nodes = new Map<string, Node>();
	readonly sessions = new Map<string, Session>();
	readonly opts: Required<FakeGraphOptions>;
	/** Called before routing; return a response to override (fault injection). */
	intercept: ((req: HttpRequest) => HttpResponse | null) | null = null;
	private seq = 0;

	constructor(opts: FakeGraphOptions = {}) {
		this.opts = {
			deltaForms: opts.deltaForms ?? ["approot-colon", "items-id"],
			putHonorsIfMatch: opts.putHonorsIfMatch ?? true,
			quotaReadable: opts.quotaReadable ?? false,
			nameMax: opts.nameMax ?? 255,
			pageSize: opts.pageSize ?? 3,
			deltaHashes: opts.deltaHashes ?? true,
			downloadHost: opts.downloadHost ?? DOWNLOAD_HOST,
			rejectFileSize: opts.rejectFileSize ?? false,
			uploadHost: opts.uploadHost ?? UPLOAD_HOST,
		};
		this.nodes.set("ROOT", this.node("ROOT", "root", null, true));
		this.nodes.set("APPS", this.node("APPS", "Apps", "ROOT", true));
		this.nodes.set("APPROOT", this.node("APPROOT", "MDVaultSync", "APPS", true));
	}

	private node(id: string, name: string, parentId: string | null, isFolder: boolean, content: Uint8Array = new Uint8Array(0)): Node {
		return { id, name, parentId, isFolder, content, version: 1, contentVersion: 1 };
	}

	eTag(n: Node): string {
		return `"{${n.id}},${n.version}"`;
	}

	/** Adds a file directly (test setup). */
	addFile(parentId: string, name: string, content: Uint8Array): Node {
		const n = this.node(`ID${++this.seq}!x`, name, parentId, false, content);
		this.nodes.set(n.id, n);
		this.touch(parentId);
		return n;
	}

	addFolder(parentId: string, name: string): Node {
		const n = this.node(`ID${++this.seq}!x`, name, parentId, true);
		this.nodes.set(n.id, n);
		this.touch(parentId);
		return n;
	}

	private touch(id: string | null): void {
		while (id) {
			const n = this.nodes.get(id);
			if (!n) return;
			n.version++;
			id = n.parentId;
		}
	}

	private children(id: string): Node[] {
		return [...this.nodes.values()].filter((n) => n.parentId === id);
	}

	private childByName(parentId: string, name: string): Node | undefined {
		const key = name.toLowerCase();
		return this.children(parentId).find((n) => n.name.toLowerCase() === key);
	}

	private descendants(id: string): Node[] {
		const out: Node[] = [];
		const queue = [id];
		while (queue.length) {
			const cur = queue.shift() as string;
			for (const c of this.children(cur)) {
				out.push(c);
				queue.push(c.id);
			}
		}
		return out;
	}

	itemJson(n: Node, opts: { downloadUrl?: boolean; hashes?: boolean } = {}): Record<string, unknown> {
		const parent = n.parentId ? this.nodes.get(n.parentId) : undefined;
		const o: Record<string, unknown> = {
			id: n.id,
			name: n.name,
			eTag: this.eTag(n),
			size: n.isFolder ? 0 : n.content.byteLength,
			lastModifiedDateTime: "2026-10-12T00:00:00Z",
			parentReference: parent
				? { id: parent.id, driveId: "d1", ...(n.id === "APPROOT" ? { path: "/drive/root:/Apps" } : {}) }
				: undefined,
			unknownField: { nested: true },
		};
		if (n.isFolder) o["folder"] = { childCount: this.children(n.id).length };
		else {
			o["cTag"] = `"c:{${n.id}},${n.contentVersion}"`;
			o["file"] = { mimeType: "application/octet-stream", ...(opts.hashes === false ? {} : { hashes: { quickXorHash: sha1Base64(n.content) } }) };
			if (opts.downloadUrl) o["@microsoft.graph.downloadUrl"] = `${this.opts.downloadHost}/dl/${n.id}?tempauth=${URL_SECRET}`;
		}
		return o;
	}

	async send(req: HttpRequest): Promise<HttpResponse> {
		await Promise.resolve();
		this.requests.push(req);
		const u = new URL(req.url);
		const auth = header(req, "authorization");
		if (u.origin !== "https://graph.microsoft.com") {
			if (auth !== undefined) this.authLeaks.push(u.origin);
		} else if (auth === undefined) {
			return err(401, "InvalidAuthenticationToken");
		}
		const forced = this.intercept?.(req) ?? null;
		if (forced) return forced;
		if (u.origin === UPLOAD_HOST || u.origin === this.opts.uploadHost) return this.uploadRoute(req, u);
		if (u.origin === this.opts.downloadHost || u.origin === DOWNLOAD_HOST) return this.downloadRoute(req, u);
		if (u.origin !== "https://graph.microsoft.com") return err(404, "itemNotFound");
		return this.graphRoute(req, u);
	}

	private downloadRoute(req: HttpRequest, u: URL): HttpResponse {
		const id = decodeURIComponent(u.pathname.replace(/^\/dl\//, ""));
		const n = this.nodes.get(id);
		if (req.method !== "GET" || !n || u.searchParams.get("tempauth") !== URL_SECRET) return err(404, "itemNotFound");
		return { status: 200, headers: {}, body: n.content.slice().buffer };
	}

	private graphRoute(req: HttpRequest, u: URL): HttpResponse {
		const p = u.pathname.slice("/v1.0".length);
		const m = req.method;
		if (m === "GET" && p === "/me/drive/special/approot") return json(200, this.itemJson(this.nodes.get("APPROOT") as Node));
		if (m === "GET" && p === "/me/drive") {
			if (!this.opts.quotaReadable) return err(403, "accessDenied");
			return json(200, { id: "d1", quota: { total: 5_000, used: 1_000, remaining: 4_000, deleted: 0, state: "normal" } });
		}
		if (m === "GET" && p === "/me/drive/special/approot:/:/delta") {
			if (!this.opts.deltaForms.includes("approot-colon")) return err(400, "invalidRequest");
			return this.deltaPage(u, p);
		}
		let r = /^\/me\/drive\/items\/([^/:]+)\/delta$/.exec(p);
		if (m === "GET" && r) {
			if (!this.opts.deltaForms.includes("items-id")) return err(400, "invalidRequest");
			return this.deltaPage(u, p);
		}
		r = /^\/me\/drive\/items\/([^/:]+)\/children$/.exec(p);
		if (r) {
			const parent = this.nodes.get(decodeURIComponent(r[1] as string));
			if (!parent) return err(404, "itemNotFound");
			if (m === "GET") {
				const all = this.children(parent.id);
				const page = Number(u.searchParams.get("page") ?? "0");
				const size = this.opts.pageSize;
				const slice = all.slice(page * size, page * size + size);
				const more = (page + 1) * size < all.length;
				return json(200, {
					value: slice.map((n) => this.itemJson(n)),
					...(more ? { "@odata.nextLink": `${GRAPH}${p}?page=${page + 1}` } : {}),
				});
			}
			if (m === "POST") {
				const body = JSON.parse(new TextDecoder().decode(toBytes(req.body))) as Record<string, unknown>;
				const name = body["name"] as string;
				if (body["@microsoft.graph.conflictBehavior"] !== "fail") return err(400, "invalidRequest");
				if (this.childByName(parent.id, name)) return err(409, "nameAlreadyExists");
				return json(201, this.itemJson(this.addFolder(parent.id, name)));
			}
		}
		r = /^\/me\/drive\/items\/([^/:]+):\/([^/:]+):\/content$/.exec(p);
		if (m === "PUT" && r) {
			const parent = this.nodes.get(decodeURIComponent(r[1] as string));
			const name = decodeURIComponent(r[2] as string);
			if (!parent) return err(404, "itemNotFound");
			if (u.searchParams.get("@microsoft.graph.conflictBehavior") !== "fail") return err(400, "invalidRequest");
			if (name.length > this.opts.nameMax) return err(400, "invalidRequest", "invalidPath");
			if (this.childByName(parent.id, name)) return err(409, "nameAlreadyExists");
			return json(201, this.itemJson(this.addFile(parent.id, name, toBytes(req.body))));
		}
		r = /^\/me\/drive\/items\/([^/:]+):\/([^/:]+):\/createUploadSession$/.exec(p);
		if (m === "POST" && r) {
			const parent = this.nodes.get(decodeURIComponent(r[1] as string));
			if (!parent) return err(404, "itemNotFound");
			return this.newSession({ parentId: parent.id, name: decodeURIComponent(r[2] as string) }, req);
		}
		r = /^\/me\/drive\/items\/([^/:]+)\/createUploadSession$/.exec(p);
		if (m === "POST" && r) {
			const n = this.nodes.get(decodeURIComponent(r[1] as string));
			if (!n) return err(404, "itemNotFound");
			const im = header(req, "if-match");
			if (im !== undefined && im !== this.eTag(n)) return err(412, "resourceModified", "entityTagDoesNotMatch");
			return this.newSession({ id: n.id }, req);
		}
		r = /^\/me\/drive\/items\/([^/:]+):\/([^/:]+)$/.exec(p);
		if (m === "GET" && r) {
			const parent = this.nodes.get(decodeURIComponent(r[1] as string));
			const c = parent ? this.childByName(parent.id, decodeURIComponent(r[2] as string)) : undefined;
			return c ? json(200, this.itemJson(c, { downloadUrl: true })) : err(404, "itemNotFound");
		}
		r = /^\/me\/drive\/items\/([^/:]+)\/content$/.exec(p);
		if (m === "PUT" && r) {
			const n = this.nodes.get(decodeURIComponent(r[1] as string));
			if (!n) return err(404, "itemNotFound");
			const im = header(req, "if-match");
			if (this.opts.putHonorsIfMatch && im !== undefined && im !== this.eTag(n)) return err(412, "resourceModified");
			n.content = toBytes(req.body);
			n.contentVersion++;
			n.version++;
			this.touch(n.parentId);
			return json(200, this.itemJson(n));
		}
		r = /^\/me\/drive\/items\/([^/:]+)$/.exec(p);
		if (r) {
			const n = this.nodes.get(decodeURIComponent(r[1] as string));
			if (!n) return err(404, "itemNotFound");
			if (m === "GET") return json(200, this.itemJson(n, { downloadUrl: true }));
			const im = header(req, "if-match");
			if (im !== undefined && im !== this.eTag(n)) return err(412, "resourceModified", "entityTagDoesNotMatch");
			if (m === "PATCH") {
				const body = JSON.parse(new TextDecoder().decode(toBytes(req.body))) as { name: string; parentReference: { id: string } };
				const clash = this.childByName(body.parentReference.id, body.name);
				if (clash && clash.id !== n.id) return err(409, "nameAlreadyExists");
				this.touch(n.parentId);
				n.name = body.name;
				n.parentId = body.parentReference.id;
				n.version++;
				this.touch(n.parentId);
				return json(200, this.itemJson(n));
			}
			if (m === "DELETE") {
				for (const d of this.descendants(n.id)) this.nodes.delete(d.id);
				this.nodes.delete(n.id);
				this.touch(n.parentId);
				return { status: 204, headers: {}, body: new ArrayBuffer(0) };
			}
		}
		return err(400, "invalidRequest");
	}

	private deltaPage(u: URL, p: string): HttpResponse {
		const all = [this.nodes.get("APPROOT") as Node, ...this.descendants("APPROOT")];
		const page = Number(u.searchParams.get("page") ?? "0");
		const size = this.opts.pageSize;
		const slice = all.slice(page * size, page * size + size);
		const more = (page + 1) * size < all.length;
		return json(200, {
			value: slice.map((n) => this.itemJson(n, { hashes: this.opts.deltaHashes })),
			...(more ? { "@odata.nextLink": `${GRAPH}${p}?page=${page + 1}` } : { "@odata.deltaLink": `${GRAPH}${p}?token=T1` }),
		});
	}

	private newSession(target: Session["target"], req: HttpRequest): HttpResponse {
		const raw = new TextDecoder().decode(toBytes(req.body));
		const body = (raw === "" ? {} : JSON.parse(raw)) as { item?: Record<string, unknown> };
		const fileSize = body.item?.["fileSize"];
		if (fileSize !== undefined && this.opts.rejectFileSize) return err(400, "invalidRequest", "invalidArgument");
		const total = typeof fileSize === "number" ? fileSize : null;
		const sid = `S${++this.seq}`;
		this.sessions.set(sid, { target, total, received: new Uint8Array(total ?? 0), next: 0 });
		return json(200, { uploadUrl: `${this.opts.uploadHost}/up/${sid}?tempauth=${URL_SECRET}`, expirationDateTime: "2026-10-13T00:00:00Z" });
	}

	private uploadRoute(req: HttpRequest, u: URL): HttpResponse {
		const sid = u.pathname.replace(/^\/up\//, "");
		const s = this.sessions.get(sid);
		if (!s || u.searchParams.get("tempauth") !== URL_SECRET) return err(404, "itemNotFound", "uploadSessionNotFound");
		if (req.method === "DELETE") {
			this.sessions.delete(sid);
			return { status: 204, headers: {}, body: new ArrayBuffer(0) };
		}
		if (req.method === "GET") {
			return json(200, { expirationDateTime: "2026-10-13T00:00:00Z", nextExpectedRanges: [`${s.next}-`] });
		}
		const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header(req, "content-range") ?? "");
		if (req.method !== "PUT" || !range) return err(400, "invalidRequest");
		const start = Number(range[1]);
		const end = Number(range[2]);
		const bytes = toBytes(req.body);
		if (s.total === null) {
			s.total = Number(range[3]);
			s.received = new Uint8Array(s.total);
		}
		if (Number(range[3]) !== s.total || end - start + 1 !== bytes.byteLength) return err(400, "invalidRequest");
		if (start !== s.next) return err(416, "invalidRange", "fragmentOverlap");
		s.received.set(bytes, start);
		s.next = end + 1;
		if (s.next < s.total) return json(202, { expirationDateTime: "2026-10-13T00:00:00Z", nextExpectedRanges: [`${s.next}-`] });
		this.sessions.delete(sid);
		const t = s.target;
		if ("id" in t) {
			const n = this.nodes.get(t.id) as Node;
			n.content = s.received;
			n.contentVersion++;
			n.version++;
			return json(200, this.itemJson(n));
		}
		if (this.childByName(t.parentId, t.name)) return err(409, "nameAlreadyExists");
		return json(201, this.itemJson(this.addFile(t.parentId, t.name, s.received)));
	}
}
