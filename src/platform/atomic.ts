// Atomic replace through Obsidian's DataAdapter: the new bytes are already in a hidden temp sibling, and this
// moves them into place (R-IO-1, design §12). Whether `adapter.rename` replaces an existing target isn't
// documented [O-API-10]; the M6 manual check records it per platform. If rename refuses (throws, or leaves the
// target as it was), the target is removed and the rename retried. That fallback has a short window in which the
// target is missing and the bytes sit in the temp file.

export interface RenameAdapter {
	exists(path: string): Promise<boolean>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export async function replaceInto(adapter: RenameAdapter, tmp: string, target: string): Promise<void> {
	try {
		await adapter.rename(tmp, target);
		// A rename that "succeeds" but leaves the temp file in place didn't replace the target.
		if (!(await adapter.exists(tmp))) return;
	} catch (e) {
		if (!(await adapter.exists(target))) throw e;
	}
	await adapter.remove(target);
	await adapter.rename(tmp, target);
}
