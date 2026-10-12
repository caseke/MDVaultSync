// R-AUTH-9: is this load the first after an uninstall? Obsidian has no uninstall hook [O-API-19]; uninstalling
// removes the plugin folder, so a refresh token found while the folder holds neither data.json nor
// sync-state.json was left by a removed copy. The decision is made from the file system, not from loadData():
// a data.json that exists but is corrupt or unreadable must never cost the user a live sign-in (security review).

export interface ExistsAdapter {
	exists(path: string): Promise<boolean>;
}

/** True only when both files are confirmed absent. Any doubt (an error) keeps the sign-in. */
export async function isLeftoverInstall(adapter: ExistsAdapter, pluginDir: string): Promise<boolean> {
	try {
		return !(await adapter.exists(`${pluginDir}/data.json`)) && !(await adapter.exists(`${pluginDir}/sync-state.json`));
	} catch {
		return false;
	}
}
