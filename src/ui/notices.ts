// Which notices a finished sync raises (R-UI-3, R-CONF-2, design §5.6): conflicts and errors only; a successful
// sync with no conflicts stays quiet. Pure (returns what to show), so it is unit tested; main.ts shows them.
// M8 extends ERROR_TEXT to every Graph error code.
import { LOG_CODE_RE } from "../core/logger.ts";
import type { SyncReport, Trigger } from "../core/ports.ts";
import { displayPath } from "./display.ts";

export interface NoticeSpec {
	message: string;
	/** Names listed under the message, display-escaped. */
	lines: string[];
	/** true: stays until dismissed (`new Notice(msg, 0)`, design §5.5). */
	persistent: boolean;
}

/** User-facing text per error code (plan M6 carry-in "Statuses"). Codes come from the executor and classifier. */
export const ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
	"type-clash": "A folder on one side has the same name as a file on the other. Rename one of them.",
	"changed-during-sync": "A file changed while it was syncing. It syncs on the next run.",
	"hash-mismatch": "A download didn't match OneDrive's fingerprint and was discarded. It's retried on the next run.",
	"too-large": "A file grew past the size limit during the sync and was skipped.",
	"conflict-name": "A conflict copy couldn't be named. Both versions were left as they are.",
	"path-too-long": "A path is too long for OneDrive, including for a conflict copy. Both versions were left as they are.",
	network: "Couldn't reach OneDrive. The sync continues on the next run.",
	"retry-budget-exceeded": "OneDrive kept asking to slow down. The sync continues on the next run.",
	quota: "Your OneDrive is full. Free up space, including the recycle bin.",
	forbidden: "OneDrive refused access to the app folder.",
	"unsafe-path": "A file from OneDrive has a path that isn't safe to write here. It was skipped.",
	"replace-raced": "Another device changed a file during the upload. It's handled as a conflict on the next run.",
	"untrusted-url": "OneDrive returned a transfer address the plugin doesn't trust. Nothing was sent there.",
	"invalid-response": "OneDrive returned data the plugin couldn't read. The sync continues on the next run.",
	precondition: "A file changed in OneDrive during the sync. It syncs on the next run.",
	"not-found": "A file was gone from OneDrive during the sync. It syncs on the next run.",
	"delta-no-link": "OneDrive's change list was incomplete. The sync continues on the next run.",
	"delta-too-many-pages": "OneDrive's change list was too long to read in one run.",
});

/** Failure codes that mean "not signed in". The auth layer already raised its own persistent notice. */
const AUTH_CODES = new Set(["signed-out", "sign-in-required", "unauthorized", "no-client-id", "expired"]);
const SIGN_IN_TEXT = "Sign in to OneDrive in the MDVaultSync settings to sync.";
const UNATTENDED = new Set<Trigger>(["startup", "interval", "rerun"]);
const MAX_LINES = 10;

export function errorText(code: string): string {
	if (Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)) return ERROR_TEXT[code] ?? code;
	return `Sync error (${LOG_CODE_RE.test(code) ? code : "other"}).`;
}

function firstError(r: SyncReport | null): string | null {
	if (!r || (r.result !== "partial" && r.result !== "failed")) return null;
	return r.errors[0]?.code ?? null;
}

/** `previous` is the report before this one: an unattended run repeating its error doesn't notice again. */
export function noticesFor(report: SyncReport, previous: SyncReport | null): NoticeSpec[] {
	if (report.result === "cancelled") return [];
	const out: NoticeSpec[] = [];
	const n = report.conflicts.length;
	if (n > 0) {
		out.push({
			message: `Sync found ${n} conflict${n === 1 ? "" : "s"}. Both versions are kept: OneDrive's version keeps the name, and this device's version is in:`,
			lines: report.conflicts.map((c) => displayPath(c.copyPath)),
			persistent: true,
		});
	}
	const first = firstError(report);
	if (first === null) return out;
	const unattended = UNATTENDED.has(report.trigger);
	if (AUTH_CODES.has(first)) {
		if (!unattended) out.push({ message: SIGN_IN_TEXT, lines: [], persistent: false });
		return out;
	}
	if (unattended && firstError(previous) === first) return out;
	const more = report.errors.length - 1;
	const message = more > 0 ? `${errorText(first)} ${more} more problem${more === 1 ? " is" : "s are"} listed in the sync report in settings.` : errorText(first);
	const lines = report.errors
		.filter((e) => e.path !== null)
		.slice(0, MAX_LINES)
		.map((e) => `${displayPath(e.path ?? "")}: ${errorText(e.code)}`);
	out.push({ message, lines, persistent: false });
	return out;
}
