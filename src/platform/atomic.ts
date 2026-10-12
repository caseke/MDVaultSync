// Atomic replace through Obsidian's DataAdapter: the new bytes are already in a hidden temp sibling, and this
// moves them into place (R-IO-1, design §12). Whether `adapter.rename` replaces an existing target isn't
// documented [O-API-10]; the M6 manual check records it per platform. If rename refuses (throws while both files
// still exist, or returns with the temp file still there), the target is removed and the rename retried. That
// fallback has a short window in which the target is missing and the bytes sit only in the temp file, so once the
// target is gone the temp file must never be deleted (TargetRemoved tells the caller).

export interface RenameAdapter {
	exists(path: string): Promise<boolean>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
}

/** The target was removed but the temp file couldn't take its place: the temp holds the only copy. Keep it. */
export class TargetRemoved extends Error {
	constructor() {
		super("target-removed");
		this.name = "TargetRemoved";
	}
}

export async function replaceInto(adapter: RenameAdapter, tmp: string, target: string): Promise<void> {
	try {
		await adapter.rename(tmp, target);
		// A rename that "succeeds" but leaves the temp file in place didn't replace the target.
		if (!(await adapter.exists(tmp))) return;
	} catch (e) {
		// Only a refusal over an existing target falls back; any other failure is the caller's.
		if (!(await adapter.exists(target)) || !(await adapter.exists(tmp))) throw e;
	}
	await adapter.remove(target);
	try {
		await adapter.rename(tmp, target);
	} catch {
		throw new TargetRemoved();
	}
}
