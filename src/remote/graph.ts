// RemotePort over Microsoft Graph (design §2, §5, §6). Every request goes through the RetryPolicy and the
// HttpTransport (requestUrl, R-NET-1); every response is validated before use (design §8, R-SEC-4). Graph
// `/content` GETs are never used: they 302 to the CDN, and a redirect must never carry Authorization (O-API-2).
import type {
	AppRoot,
	Clock,
	DeltaPage,
	HttpRequest,
	HttpResponse,
	HttpTransport,
	RemoteItem,
	RemotePort,
	UploadSessionInfo,
	UploadStatus,
	UploadTarget,
	UploadTargetReplace,
} from "../core/ports.ts";
import { NULL_LOGGER, type Logger } from "../core/logger.ts";
import { DELTA_FORM, type DeltaForm } from "./capabilities.ts";
import { GraphError, UntrustedUrl, toGraphError } from "./errors.ts";
import type { RetryPolicy } from "./retry.ts";
import * as session from "./upload-session.ts";
import {
	InvalidResponse,
	MAX_JSON_BODY,
	NAME_LIMIT,
	checkName,
	checkTransferUrl,
	isGraphApiUrl,
	isValidId,
	isValidName,
	parseChildrenPage,
	parseDeltaPage,
	parseDriveItem,
	parseItemExtras,
	parseJsonObject,
	parseQuota,
} from "./validate.ts";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Simple PUT is used up to 10 MiB; larger files use upload sessions [G-UP-4] (design §5.5). */
export const SIMPLE_UPLOAD_MAX = session.FRAGMENT;
/** deltaLink of the children-walk fallback: "walk the whole tree again" (design §5.2). */
export const CHILDREN_WALK_LINK = "mdvaultsync:children-walk";
export const MAX_PAGES = 10_000;
const MAX_WALK_FOLDERS = 100_000;
const MAX_TAG = 512;
/**
 * `$select` for metadata reads. It leaves out the download URL: OneDrive personal omits
 * `@microsoft.graph.downloadUrl` from any `$select` response, despite the docs (0.3.4 probe, Ubuntu) [G-DLD-1].
 * download() reads the item with no `$select` instead, where the URL is present.
 */
const ITEM_SELECT = "id,name,eTag,cTag,size,file,folder,parentReference,lastModifiedDateTime,deleted";
const DRIVE_ROOT_PREFIX = "/drive/root:";
/** Longest App Folder path accepted; the whole drive path is limited to 400 characters [G-NM-4]. */
const MAX_PREFIX = 400;

export interface GraphClientOptions {
	/** For Graph API calls: the AuthorizingTransport. */
	transport: HttpTransport;
	/**
	 * For upload and download URLs: a transport with no auth decorator, so a tampered transfer URL can never carry
	 * the token [G-UP-7], [G-DLD-1] (T-I4). Defaults to `transport` (tests); main.ts passes the bare requestUrl one.
	 */
	transferTransport?: HttpTransport;
	retry: RetryPolicy;
	clock: Clock;
	logger?: Logger;
	deltaForm?: DeltaForm;
	maxPages?: number;
	/** Longest name this client sends. Raised only by the probe's name-length test [G-NM-6]. */
	maxNameLength?: number;
}

/** NFC (design §7), then UTF-8 percent-encoding of one path segment [G-ADR-1]. */
export function encodeSegment(name: string): string {
	return encodeURIComponent(name.normalize("NFC"));
}

function idSegment(id: string): string {
	if (!isValidId(id)) throw new RangeError("invalid-id");
	return encodeURIComponent(id);
}

/** If-Match goes out verbatim (eTags are opaque quoted strings [G-TAG-2]); printable ASCII only, so it can't split headers. */
function checkIfMatch(v: string): string {
	if (!/^[\x20-\x7e]+$/.test(v) || v.length > MAX_TAG) throw new RangeError("invalid-if-match");
	return v;
}

function json(res: HttpResponse): unknown {
	return parseJsonObject(res.body, MAX_JSON_BODY);
}

export class GraphClient implements RemotePort {
	private readonly transport: HttpTransport;
	private readonly transferTransport: HttpTransport;
	private readonly retry: RetryPolicy;
	private readonly clock: Clock;
	private readonly logger: Logger;
	private readonly deltaForm: DeltaForm;
	private readonly maxPages: number;
	private readonly maxName: number;
	private approotId: string | null = null;
	private readonly call: session.Call;
	private readonly transferCall: session.Call;

	constructor(opts: GraphClientOptions) {
		this.transport = opts.transport;
		this.transferTransport = opts.transferTransport ?? opts.transport;
		this.retry = opts.retry;
		this.clock = opts.clock;
		this.logger = opts.logger ?? NULL_LOGGER;
		this.deltaForm = opts.deltaForm ?? DELTA_FORM;
		this.maxPages = opts.maxPages ?? MAX_PAGES;
		this.maxName = opts.maxNameLength ?? NAME_LIMIT;
		this.call = (req) => this.send(req);
		this.transferCall = (req) => this.send(req, this.transferTransport);
	}

	/** One request through retry and logging. Logs status and duration only (design §9). */
	private async send(req: HttpRequest, transport: HttpTransport = this.transport): Promise<HttpResponse> {
		const t0 = this.clock.now();
		try {
			const res = await this.retry.execute(() => transport.send(req));
			this.logger.event("graph.request", { status: res.status, durationMs: this.clock.now() - t0 });
			return res;
		} catch (e) {
			this.logger.event("graph.request", { code: e instanceof Error ? e.name : "unknown", durationMs: this.clock.now() - t0 });
			throw e;
		}
	}

	/** A request to a Graph v1.0 URL that the typed methods don't cover (the diagnostics probe). */
	sendRaw(req: HttpRequest): Promise<HttpResponse> {
		if (!isGraphApiUrl(req.url)) return Promise.reject(new UntrustedUrl());
		return this.send(req);
	}

	private async getJson(url: string): Promise<unknown> {
		const res = await this.send({ url, method: "GET" });
		if (res.status !== 200) throw toGraphError(res);
		return json(res);
	}

	private async sendJson(method: string, url: string, body: unknown, ifMatch: string | null, ok: number[]): Promise<HttpResponse> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (ifMatch !== null) headers["If-Match"] = checkIfMatch(ifMatch);
		const res = await this.send({ url, method, headers, body: JSON.stringify(body) });
		if (!ok.includes(res.status)) throw toGraphError(res);
		return res;
	}

	/** `GET /me/drive/special/approot`; creates the folder on first use [G-AF-1]. pathPrefix per design §5.1. */
	async getAppRoot(): Promise<AppRoot> {
		const raw = await this.getJson(`${GRAPH_BASE}/me/drive/special/approot`);
		const item = parseDriveItem(raw);
		const { parentPath } = parseItemExtras(raw);
		if (!item.isFolder || item.deleted || parentPath === null || !parentPath.startsWith(DRIVE_ROOT_PREFIX)) throw new InvalidResponse();
		let parent: string;
		try {
			parent = decodeURIComponent(parentPath.slice(DRIVE_ROOT_PREFIX.length));
		} catch {
			throw new InvalidResponse();
		}
		const pathPrefix = `${parent}/${item.name}`;
		// Every decoded segment must be a valid name with no control characters (R-SEC-4, M3 review).
		const segments = pathPrefix.split("/").slice(1);
		const hasControl = (s: string) => Array.from(s).some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
		const segmentOk = (s: string) => isValidName(s) && !hasControl(s);
		if (!pathPrefix.startsWith("/") || pathPrefix.length > MAX_PREFIX || !segments.every(segmentOk)) throw new InvalidResponse();
		this.approotId = item.id;
		return { item, pathPrefix };
	}

	private async approot(): Promise<string> {
		return this.approotId ?? (await this.getAppRoot()).item.id;
	}

	/**
	 * One delta page. `null` starts a full enumeration in the configured form [G-DL-1]; any other link must be a
	 * Graph v1.0 URL (a persisted link is untrusted, T-T6). 410 and resync* codes throw ResyncRequired [G-DL-4].
	 */
	async delta(link: string | null): Promise<DeltaPage> {
		if (this.deltaForm === "children-walk" && (link === null || link === CHILDREN_WALK_LINK)) return this.walk();
		let url: string;
		if (link !== null) {
			if (!isGraphApiUrl(link)) throw new UntrustedUrl();
			url = link;
		} else if (this.deltaForm === "items-id") {
			url = `${GRAPH_BASE}/me/drive/items/${idSegment(await this.approot())}/delta`;
		} else {
			url = `${GRAPH_BASE}/me/drive/special/approot:/:/delta`;
		}
		const res = await this.send({ url, method: "GET" });
		if (res.status !== 200) throw toGraphError(res);
		return parseDeltaPage(res.body);
	}

	/**
	 * Follows nextLink until a deltaLink arrives [G-DL-2]. Items keep server order, duplicates included; the engine
	 * keeps the last occurrence per id [G-DL-6]. Nothing is applied until every page is in.
	 */
	async deltaAll(link: string | null): Promise<{ items: RemoteItem[]; deltaLink: string; pages: number }> {
		const items: RemoteItem[] = [];
		let next: string | null = link;
		for (let pages = 1; pages <= this.maxPages; pages++) {
			const page = await this.delta(next);
			items.push(...page.items);
			if (page.deltaLink !== undefined) return { items, deltaLink: page.deltaLink, pages };
			next = page.nextLink ?? null;
		}
		throw new InvalidResponse();
	}

	/** Design §5.2 fallback: breadth-first listing of the whole App Folder as one synthetic page. */
	private async walk(): Promise<DeltaPage> {
		const root = (await this.getAppRoot()).item;
		const items: RemoteItem[] = [root];
		const queue = [root.id];
		for (let visited = 0; queue.length > 0; visited++) {
			if (visited >= MAX_WALK_FOLDERS) throw new InvalidResponse();
			const id = queue.shift() as string;
			for (const child of await this.listChildren(id)) {
				items.push(child);
				if (child.isFolder) queue.push(child.id);
			}
		}
		return { items, deltaLink: CHILDREN_WALK_LINK };
	}

	async listChildren(folderId: string): Promise<RemoteItem[]> {
		const items: RemoteItem[] = [];
		let url: string | undefined = `${GRAPH_BASE}/me/drive/items/${idSegment(folderId)}/children?$top=200`;
		for (let pages = 0; url !== undefined; pages++) {
			if (pages >= this.maxPages) throw new InvalidResponse();
			const res = await this.send({ url, method: "GET" });
			if (res.status !== 200) throw toGraphError(res);
			const page = parseChildrenPage(res.body);
			items.push(...page.items);
			url = page.nextLink;
		}
		return items;
	}

	/**
	 * The item and its raw JSON (which carries a fresh download URL [G-DLD-2]), or null on 404. The download URL is
	 * parsed only by download(), so a URL problem can't break ordinary item reads.
	 */
	private async getItemWithUrl(url: string): Promise<{ item: RemoteItem; raw: unknown } | null> {
		const res = await this.send({ url, method: "GET" });
		if (res.status === 404) return null;
		if (res.status !== 200) throw toGraphError(res);
		const raw = json(res);
		return { item: parseDriveItem(raw), raw };
	}

	async getItem(id: string): Promise<RemoteItem | null> {
		const r = await this.getItemWithUrl(`${GRAPH_BASE}/me/drive/items/${idSegment(id)}?$select=${ITEM_SELECT}`);
		return r?.item ?? null;
	}

	/** Lookup after a 409 nameAlreadyExists (design §5.5); names are matched case-insensitively by OneDrive. */
	async getChildByName(parentId: string, name: string): Promise<RemoteItem | null> {
		const seg = encodeSegment(checkName(name.normalize("NFC"), this.maxName));
		const r = await this.getItemWithUrl(`${GRAPH_BASE}/me/drive/items/${idSegment(parentId)}:/${seg}?$select=${ITEM_SELECT}`);
		return r?.item ?? null;
	}

	createUploadSession(target: UploadTarget | UploadTargetReplace, ifMatch: string | null, size: number): Promise<UploadSessionInfo> {
		if (!Number.isSafeInteger(size) || size < 0) return Promise.reject(new RangeError("invalid-size"));
		// Body exactly as design §6.3. `fileSize` is documented for OneDrive personal [G-UP-5], but the 0.3.0 probe
		// got 400 invalidRequest on Ubuntu with it in the body, so it is not sent (probe v2 records which bodies work).
		if (target.kind === "new") {
			const seg = encodeSegment(checkName(target.name.normalize("NFC"), this.maxName));
			const url = `${GRAPH_BASE}/me/drive/items/${idSegment(target.parentId)}:/${seg}:/createUploadSession`;
			return session.createSession(this.call, url, null, { item: { "@microsoft.graph.conflictBehavior": "fail" } });
		}
		// R-CC-1: a replace must be conditional on the last-synced eTag.
		if (ifMatch === null) return Promise.reject(new RangeError("if-match-required"));
		const url = `${GRAPH_BASE}/me/drive/items/${idSegment(target.id)}/createUploadSession`;
		return session.createSession(this.call, url, checkIfMatch(ifMatch), {
			item: { "@microsoft.graph.conflictBehavior": "replace" },
		});
	}

	putFragment(uploadUrl: string, start: number, total: number, bytes: ArrayBuffer): Promise<RemoteItem | null> {
		return session.putFragment(this.transferCall, uploadUrl, start, total, bytes);
	}

	getUploadStatus(uploadUrl: string): Promise<UploadStatus> {
		return session.getUploadStatus(this.transferCall, uploadUrl);
	}

	cancelUpload(uploadUrl: string): Promise<void> {
		return session.cancelUpload(this.transferCall, uploadUrl);
	}

	/**
	 * Fetches a fresh downloadUrl, then GETs it with no Authorization [G-DLD-1]. The byte length must equal the
	 * item's size (design §8). Hash verification is RemoteContent's job (M6).
	 */
	async download(id: string, expectedSize?: number): Promise<ArrayBuffer> {
		// No $select: that is the only read that returns the download URL on OneDrive personal [G-DLD-1].
		const r = await this.getItemWithUrl(`${GRAPH_BASE}/me/drive/items/${idSegment(id)}`);
		if (!r) throw new GraphError(404, "itemNotFound");
		if (r.item.isFolder || r.item.deleted) throw new InvalidResponse("not-a-file");
		const downloadUrl = parseItemExtras(r.raw).downloadUrl;
		if (downloadUrl === null) throw new InvalidResponse("download-url-missing");
		// The caller checked this size against the cap; an item that changed since must not be buffered (T-D6).
		if (expectedSize !== undefined && r.item.size !== expectedSize) throw new InvalidResponse("download-length-mismatch");
		const res = await this.send({ url: checkTransferUrl(downloadUrl), method: "GET" }, this.transferTransport);
		if (res.status !== 200) throw toGraphError(res);
		if (res.body.byteLength !== r.item.size) throw new InvalidResponse("download-length-mismatch");
		return res.body;
	}

	async createFolder(parentId: string, name: string): Promise<RemoteItem> {
		const nfc = checkName(name.normalize("NFC"), this.maxName);
		const res = await this.sendJson(
			"POST",
			`${GRAPH_BASE}/me/drive/items/${idSegment(parentId)}/children`,
			{ name: nfc, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
			null,
			[200, 201],
		);
		return parseDriveItem(json(res));
	}

	/** Simple PUT of a new file; conflictBehavior goes in the query for PUT [G-UP-1], [G-UP-2]. */
	async uploadNew(parentId: string, name: string, data: ArrayBuffer): Promise<RemoteItem> {
		if (data.byteLength > SIMPLE_UPLOAD_MAX) throw new RangeError("too-large-for-put");
		const seg = encodeSegment(checkName(name.normalize("NFC"), this.maxName));
		const url = `${GRAPH_BASE}/me/drive/items/${idSegment(parentId)}:/${seg}:/content?@microsoft.graph.conflictBehavior=fail`;
		return this.putContent(url, null, data);
	}

	/** Simple PUT replace with If-Match. Only used when PUT_HONORS_IF_MATCH (D-11) [G-UP-3]. */
	async uploadReplace(id: string, ifMatch: string, data: ArrayBuffer): Promise<RemoteItem> {
		if (data.byteLength > SIMPLE_UPLOAD_MAX) throw new RangeError("too-large-for-put");
		return this.putContent(`${GRAPH_BASE}/me/drive/items/${idSegment(id)}/content`, checkIfMatch(ifMatch), data);
	}

	private async putContent(url: string, ifMatch: string | null, data: ArrayBuffer): Promise<RemoteItem> {
		const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
		if (ifMatch !== null) headers["If-Match"] = ifMatch;
		const res = await this.send({ url, method: "PUT", headers, body: data });
		if (res.status !== 200 && res.status !== 201) throw toGraphError(res);
		return parseDriveItem(json(res));
	}

	/** PATCH by id with If-Match; keeps OneDrive version history (R-MOVE-1) [G-MV-1]. */
	async move(id: string, ifMatch: string, newParentId: string, newName: string): Promise<RemoteItem> {
		checkIfMatch(ifMatch);
		const name = checkName(newName.normalize("NFC"), this.maxName);
		if (!isValidId(newParentId)) throw new RangeError("invalid-id");
		const res = await this.sendJson("PATCH", `${GRAPH_BASE}/me/drive/items/${idSegment(id)}`, { parentReference: { id: newParentId }, name }, ifMatch, [200]);
		return parseDriveItem(json(res));
	}

	/** DELETE with If-Match: goes to the recycle bin; permanentDelete is never used (R-DEL-1) [G-DEL-1]. */
	async delete(id: string, ifMatch: string): Promise<void> {
		checkIfMatch(ifMatch);
		const res = await this.send({ url: `${GRAPH_BASE}/me/drive/items/${idSegment(id)}`, method: "DELETE", headers: { "If-Match": ifMatch } });
		if (res.status !== 204 && res.status !== 200) throw toGraphError(res);
	}

	/** Drive quota, or null when the AppFolder scope may not read it (403) [G-QT-1]. */
	async quota(): Promise<{ total: number; used: number; remaining: number } | null> {
		const res = await this.send({ url: `${GRAPH_BASE}/me/drive?$select=quota`, method: "GET" });
		if (res.status === 403) return null;
		if (res.status !== 200) throw toGraphError(res);
		return parseQuota(res.body);
	}
}
