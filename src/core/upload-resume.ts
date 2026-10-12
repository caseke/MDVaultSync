// Resuming persisted upload sessions (design §6.3, R-RES-2) [G-UP-9]. Runs in preflight, before the pull.
// A session is continued only if it still describes the same upload: the local bytes are unchanged, and for a
// replace the item's eTag is still the one the session was created against (R-CC-1). Anything else cancels it
// and drops the record; the next plan then decides from scratch (a raced replace becomes a conflict there,
// because both sides now differ from the base). Pure core: no Obsidian import.
import { runOutcome, type ErrorClassifier } from "./failure.ts";
import type { Logger } from "./logger.ts";
import type { RemoteContent, RemotePort, SyncState, VaultPath, VaultPort } from "./ports.ts";
import { quickXorHash } from "./quickxor.ts";
import { putFile, upsertItem } from "./records.ts";
import type { Saver } from "./saver.ts";

export interface ResumeContext {
	state: SyncState;
	vault: VaultPort;
	remote: RemotePort;
	content: RemoteContent;
	classify: ErrorClassifier;
	saver: Saver;
	transformId: string;
	logger?: Logger;
}

/** Finishes or drops every persisted session. Rethrows run-ending failures (auth, network…) with the record kept. */
export async function resumeUploads(ctx: ResumeContext): Promise<void> {
	const { state, vault, remote } = ctx;
	for (const [key, rec] of Object.entries(state.uploadSessions)) {
		const path = key as VaultPath;
		const drop = async (cancel: boolean) => {
			delete state.uploadSessions[path];
			if (!cancel) return;
			try {
				await remote.cancelUpload(rec.uploadUrl);
			} catch {
				// Best effort: an abandoned session expires on its own.
			}
		};
		try {
			const st = await vault.stat(path);
			if (!st || st.isFolder) {
				await drop(true);
				continue;
			}
			const plain = await vault.read(path);
			const localHash = quickXorHash(plain);
			// Edited since the session started: start over with the new bytes (design §6.3).
			if (localHash !== rec.localHash) {
				await drop(true);
				continue;
			}
			if (rec.target.kind === "replace") {
				const now = await remote.getItem(rec.target.id);
				if (!now || now.eTag !== rec.ifMatch) {
					await drop(true);
					continue;
				}
			}
			ctx.logger?.event("upload.resume", { count: 1 });
			const res = await ctx.content.resume(rec, plain);
			if (!res) {
				// The session is gone (404 or expired): the planned upload starts over [G-UP-9].
				await drop(false);
				continue;
			}
			const after = await vault.stat(path);
			putFile(state, {
				path,
				remoteId: res.item.id,
				eTag: res.item.eTag,
				cTag: res.item.cTag,
				size: plain.byteLength,
				mtime: after && after.size === st.size && after.mtime === st.mtime ? st.mtime : 0,
				localHash,
				remoteHash: res.remoteHash,
				transformId: ctx.transformId,
			});
			upsertItem(state, res.item);
			delete state.uploadSessions[path];
		} catch (e) {
			const f = ctx.classify(e);
			ctx.logger?.event("upload.resume", { code: f.code });
			if (runOutcome(f.kind) !== null) throw e;
			await drop(true);
		}
		ctx.saver.dirty();
	}
	await ctx.saver.flush();
}
