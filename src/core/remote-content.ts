// RemoteContent (design §1, §2, §6.3; R-ENG-4, D-10): the only path file bytes take between the executor and
// RemotePort. Every byte goes through the ContentTransform, every download is checked against the stored-bytes
// QuickXorHash before it is decoded (T-T4, R-IO-2), and every upload's returned hash is checked too. This is the
// only file outside src/remote allowed to call RemotePort content methods (lint rule mdvaultsync/content-owners).
//
// Resume re-encodes the plaintext and sends the rest of it, so it relies on `encode` being deterministic for the
// same plaintext and path. The identity transform is. A future E2EE transform with a random IV must restart a
// session instead (design §13).
import { HashMismatch, ReplaceRaced, type ErrorClassifier } from "./failure.ts";
import { quickXorHash } from "./quickxor.ts";
import type {
	ContentTransform,
	RemoteContent,
	RemoteItem,
	RemotePort,
	UploadSessionInfo,
	UploadSessionRecord,
	UploadTarget,
	UploadTargetReplace,
	VaultPath,
} from "./ports.ts";

/** Fragments must be multiples of 320 KiB [G-UP-6]. */
export const FRAGMENT_UNIT = 327_680;
/** 10 MiB = 32 × 320 KiB (R-RES-2). Equal to src/remote/upload-session.ts FRAGMENT (core can't import it; a test checks). */
export const FRAGMENT = 10 * 1024 * 1024;
/** Most fragments one upload may take, a guard against a server that never advances. */
const MAX_FRAGMENT_CALLS = 10_000;

export interface RemoteContentOptions {
	/** capabilities.ts PUT_HONORS_IF_MATCH (D-11): small replaces may use PUT with If-Match. */
	putHonorsIfMatch: boolean;
	classify: ErrorClassifier;
	/** Largest body sent by simple PUT. Default FRAGMENT (10 MiB) [G-UP-1]. */
	simpleMax?: number;
	/** Fragment size; a multiple of 320 KiB. Default FRAGMENT. Smaller only in tests. */
	fragmentSize?: number;
}

type Target = UploadTarget | UploadTargetReplace;

export class TransformedRemoteContent implements RemoteContent {
	private readonly remote: RemotePort;
	private readonly transform: ContentTransform;
	private readonly putHonorsIfMatch: boolean;
	private readonly classify: ErrorClassifier;
	private readonly simpleMax: number;
	private readonly fragment: number;

	constructor(remote: RemotePort, transform: ContentTransform, opts: RemoteContentOptions) {
		this.remote = remote;
		this.transform = transform;
		this.putHonorsIfMatch = opts.putHonorsIfMatch;
		this.classify = opts.classify;
		this.simpleMax = opts.simpleMax ?? FRAGMENT;
		this.fragment = opts.fragmentSize ?? FRAGMENT;
		if (this.fragment <= 0 || this.fragment % FRAGMENT_UNIT !== 0 || this.fragment > FRAGMENT) throw new RangeError("fragment-size");
	}

	get transformId(): string {
		return this.transform.id;
	}

	async fetch(item: RemoteItem, path: VaultPath): Promise<{ plain: ArrayBuffer; remoteHash: string }> {
		// The item's size was checked against the cap; the remote refuses before the GET if it changed (T-D6).
		const stored = await this.remote.download(item.id, item.size);
		if (stored.byteLength !== item.size) throw new HashMismatch();
		const remoteHash = quickXorHash(stored);
		// A null hash (zero-byte files, or missing from delta [G-DL-8]) can only be checked by size (design §5.4).
		if (item.quickXorHash !== null && remoteHash !== item.quickXorHash) throw new HashMismatch();
		return { plain: await this.transform.decode(stored, { path }), remoteHash };
	}

	async storedHashOf(plain: ArrayBuffer, path: VaultPath): Promise<string> {
		return quickXorHash(await this.transform.encode(plain, { path }));
	}

	async store(
		target: Target,
		ifMatch: string | null,
		plain: ArrayBuffer,
		path: VaultPath,
		onSession?: (s: UploadSessionInfo) => Promise<void>,
	): Promise<{ item: RemoteItem; remoteHash: string }> {
		// R-CC-1: a replace is always conditional on the last-synced eTag.
		if (target.kind === "replace" && ifMatch === null) throw new RangeError("if-match-required");
		const stored = await this.transform.encode(plain, { path });
		const hash = quickXorHash(stored);
		const small = stored.byteLength <= this.simpleMax || stored.byteLength === 0;
		let item: RemoteItem;
		if (target.kind === "new" && small) {
			item = await this.remote.uploadNew(target.parentId, target.name, stored);
		} else if (target.kind === "replace" && small && (this.putHonorsIfMatch || stored.byteLength === 0)) {
			item = await this.remote.uploadReplace(target.id, ifMatch as string, stored);
		} else {
			// Graph checks If-Match only here, at creation [G-UP-5]; the commit is re-checked below (§6.3).
			const info = await this.remote.createUploadSession(target, target.kind === "replace" ? ifMatch : null, stored.byteLength);
			if (onSession) await onSession(info);
			item = await this.sendFrom(info.uploadUrl, target, ifMatch, stored, 0);
		}
		return { item, remoteHash: this.checkReturned(item, hash) };
	}

	async resume(rec: UploadSessionRecord, plain: ArrayBuffer): Promise<{ item: RemoteItem; remoteHash: string } | null> {
		const status = await this.remote.getUploadStatus(rec.uploadUrl);
		if (status.nextExpectedStart === null) return null;
		const stored = await this.transform.encode(plain, { path: rec.path });
		if (status.nextExpectedStart > stored.byteLength) return null;
		const item = await this.sendFrom(rec.uploadUrl, rec.target, rec.ifMatch, stored, status.nextExpectedStart);
		return { item, remoteHash: this.checkReturned(item, quickXorHash(stored)) };
	}

	/** The upload's own result must carry the hash of the bytes we sent (T-T4). */
	private checkReturned(item: RemoteItem, hash: string): string {
		if (item.quickXorHash !== null && item.quickXorHash !== hash) throw new HashMismatch();
		return item.quickXorHash ?? hash;
	}

	/** Sends `stored` from byte `start` in fragments; the item comes back with the final one [G-UP-8]. */
	private async sendFrom(uploadUrl: string, target: Target, ifMatch: string | null, stored: ArrayBuffer, start: number): Promise<RemoteItem> {
		const total = stored.byteLength;
		let offset = start;
		for (let calls = 0; calls < MAX_FRAGMENT_CALLS; calls++) {
			const end = Math.min(total, offset + this.fragment);
			if (end === total && target.kind === "replace") await this.checkCommit(uploadUrl, target.id, ifMatch);
			let item: RemoteItem | null;
			try {
				item = await this.remote.putFragment(uploadUrl, offset, total, stored.slice(offset, end));
			} catch (e) {
				// 416: that range was already received (a lost answer); continue from what the server has [G-UP-9].
				if (this.classify(e).kind !== "range") throw e;
				const st = await this.remote.getUploadStatus(uploadUrl);
				if (st.nextExpectedStart === null || st.nextExpectedStart > total) throw e;
				offset = st.nextExpectedStart;
				continue;
			}
			if (item) return item;
			if (end === total) throw new HashMismatch(); // the server wants more than we have
			offset = end;
		}
		throw new RangeError("upload-stalled");
	}

	/**
	 * Commit-time precondition for replace sessions (design §6.3, R-CC-1): the fragments and the commit carry no
	 * If-Match, so the item's eTag is compared right before the final fragment. A mismatch cancels the session.
	 */
	private async checkCommit(uploadUrl: string, id: string, ifMatch: string | null): Promise<void> {
		const now = await this.remote.getItem(id);
		if (now !== null && now.eTag === ifMatch) return;
		try {
			await this.remote.cancelUpload(uploadUrl);
		} catch {
			// Best effort: an unfinished session expires on its own; the commit was not sent.
		}
		throw new ReplaceRaced();
	}
}
