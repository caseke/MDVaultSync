// The M6 manual check (plan M6, research O-API-10): does `adapter.rename` replace an existing file on this
// device? Two small files in the plugin folder are created, one is renamed onto the other, the result is
// recorded, and then the fallback in atomic.ts is exercised. Both files are removed afterwards. The result holds
// no paths or content.
import { replaceInto } from "./atomic.ts";

export interface RenameProbeAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export interface RenameProbeResult {
	/** replaced: rename overwrote the target; threw: it refused with an error; kept-target: it returned but left the target. */
	renameOverExisting: "replaced" | "threw" | "kept-target" | "other";
	/** The writeAtomic path (rename, else remove then rename) ended with the new content and no temp file. */
	fallbackWorks: boolean;
	cleanedUp: boolean;
}

export async function probeRename(adapter: RenameProbeAdapter, dir: string): Promise<RenameProbeResult> {
	const a = `${dir}/rename-probe-a.tmp`;
	const b = `${dir}/rename-probe-b.tmp`;
	let renameOverExisting: RenameProbeResult["renameOverExisting"] = "other";
	let fallbackWorks = false;
	try {
		await adapter.write(a, "new");
		await adapter.write(b, "old");
		let threw = false;
		try {
			await adapter.rename(a, b);
		} catch {
			threw = true;
		}
		const now = (await adapter.exists(b)) ? await adapter.read(b) : null;
		if (threw) renameOverExisting = "threw";
		else if (now === "new") renameOverExisting = "replaced";
		else if (now === "old") renameOverExisting = "kept-target";

		await adapter.write(a, "newer");
		if (!(await adapter.exists(b))) await adapter.write(b, "old");
		await replaceInto(adapter, a, b);
		fallbackWorks = (await adapter.read(b)) === "newer" && !(await adapter.exists(a));
	} catch {
		// Recorded as fallbackWorks: false.
	}
	let cleanedUp = true;
	for (const p of [a, b]) {
		try {
			if (await adapter.exists(p)) await adapter.remove(p);
		} catch {
			cleanedUp = false;
		}
	}
	return { renameOverExisting, fallbackWorks, cleanedUp };
}
