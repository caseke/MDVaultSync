// Persisted plugin data (`data.json` via loadData/saveData [O-API-15]). M7 adds the sync settings here.

export interface PluginData {
	/** Entra application (client) ID. A user setting with no default (R-AUTH-8, D-14). */
	clientId: string;
	/** Refresh token, present only when SecretStorage threw (D-5). */
	fallbackRefreshToken?: string;
}

export const DEFAULT_DATA: Readonly<PluginData> = Object.freeze({ clientId: "" });

/** data.json can be edited by hand or by another plugin (T-T6): keep only well-typed fields. */
export function parseData(raw: unknown): PluginData {
	const out: PluginData = { ...DEFAULT_DATA };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	const o = raw as Record<string, unknown>;
	if (typeof o["clientId"] === "string") out.clientId = o["clientId"];
	const rt = o["fallbackRefreshToken"];
	if (typeof rt === "string" && rt.length > 0) out.fallbackRefreshToken = rt;
	return out;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidClientId(id: string): boolean {
	return GUID_RE.test(id);
}
