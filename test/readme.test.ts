// The README is part of the release (plan M9, SPEC §6.4): disclosures [O-POL-1], [O-POL-2], the Entra guide,
// the settings reference and the residual risks (R-SEC-2, threat-model §4). Plain text checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { conflictCopyPath } from "../src/core/conflict-name.ts";
import type { VaultPath } from "../src/core/ports.ts";
import { AUTHORITY } from "../src/remote/auth.ts";
import { GRAPH_BASE } from "../src/remote/graph.ts";
import { API_TIMEOUT_MS } from "../src/remote/timeout.ts";
import { FRAGMENT } from "../src/remote/upload-session.ts";
import { TRANSFER_HOST_SUFFIXES } from "../src/remote/validate.ts";
import { DEFAULT_DATA, MAX_PATTERN_LINES } from "../src/settings.ts";
import { LOW_SPACE_FRACTION } from "../src/ui/quota.ts";
import { STUCK_LIMIT } from "../src/ui/triggers.ts";

const root = join(import.meta.dirname, "..");
const read = (name: string) => readFileSync(join(root, name), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const readme = read("README.md");
const flatReadme = flat(readme);

/** The text of the `## heading` section, up to the next `## `. */
function section(heading: string): string {
	const lines = readme.split("\n");
	const start = lines.indexOf(`## ${heading}`);
	assert.ok(start >= 0, `README has no "## ${heading}" section`);
	const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const has = (text: string, needle: string, what = needle) => assert.ok(flat(text).includes(needle), `missing: ${what}`);

test("README has the developer-policy disclosures [O-POL-1], [O-POL-2]", () => {
	const d = section("Disclosures");
	for (const label of ["**Network use.**", "**Account required.**", "**Files outside the vault.**", "**No telemetry.**"]) has(d, label);
	for (const origin of [AUTHORITY, GRAPH_BASE]) has(d, `\`${new URL(origin).host}\``, `host of ${origin}`);
	assert.deepEqual(TRANSFER_HOST_SUFFIXES, [".microsoftpersonalcontent.com", ".1drv.com", ".onedrive.com", ".livefilestore.com"], "transfer hosts changed: update the Network use disclosure");
	has(d, "OneDrive upload and download hosts");
	has(d, "Files.ReadWrite.AppFolder");
});

test("README holds the full Entra setup guide (SPEC §6.4); docs/entra-setup.md points to it", () => {
	const g = section("Microsoft Entra setup");
	for (const h of ["Step 1:", "Step 2:", "Step 3:", "Step 4:", "Step 5:", "Final check", "Troubleshooting"]) {
		assert.match(g, new RegExp(`^### ${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), `guide heading ${h}`);
	}
	has(g, "`obsidian://mdvaultsync-auth`");
	has(g, "`Files.ReadWrite.AppFolder`");
	has(g, "`offline_access`");
	has(g, "**Personal accounts only**");
	has(g, "PersonalMicrosoftAccount");
	has(g, "Allow public client flows");
	has(g, "property lock");
	assert.match(read("docs/entra-setup.md"), /\(\.\.\/README\.md#microsoft-entra-setup\)/);
});

test("README explains installing through BRAT from caseke/MDVaultSync", () => {
	const s = section("Install");
	has(s, "BRAT");
	has(s, "`caseke/MDVaultSync`");
});

test("README settings reference names every settings row and every command", () => {
	const ref = section("Settings reference") + section("Commands");
	const rows = [...read("src/ui/settings-tab.ts").matchAll(/^\s+name: "([^"]+)",$/gm)].map((m) => m[1] ?? "");
	assert.ok(rows.length >= 15, `found ${rows.length} settings rows`);
	for (const r of rows) has(ref, `**${r}**`, `settings row ${r}`);
	const commands = [...read("src/main.ts").matchAll(/^\s+name: "([^"]+)",$/gm)].map((m) => m[1] ?? "");
	assert.ok(commands.length >= 7, `found ${commands.length} commands`);
	for (const c of commands) has(section("Commands"), `**${c}**`, `command ${c}`);
	has(ref, "Verbose logging");
	has(ref, `${LOW_SPACE_FRACTION * 100} % or less is free`);
	has(ref, "recycle bin");
	has(ref, `1 to 1440 (default ${DEFAULT_DATA.intervalMinutes})`);
	has(ref, `1 to 1024 (default ${DEFAULT_DATA.maxFileSizeMiB})`);
	has(ref, `1 to 100 %, default ${DEFAULT_DATA.massDeleteThresholdPct}`);
	has(ref, `At most ${MAX_PATTERN_LINES} lines`);
});

test("README conflict naming matches src/core/conflict-name.ts", () => {
	const at = new Date(2026, 9, 12, 14, 2, 3);
	const first = conflictCopyPath("Note.md" as VaultPath, "iPad", at, () => false, 16);
	const second = conflictCopyPath("Note.md" as VaultPath, "iPad", at, (p) => p === first.toLowerCase() || p === first, 16);
	const s = section("How sync works");
	has(s, `\`${first}\``, `example ${first}`);
	assert.ok(second.startsWith(first.replace(/\.md$/, " 2")), `second copy ${second}`);
	has(s, "` 2`, ` 3`… is added after the `)`");
	has(s, "`<name> (conflict <device name> <YYYY-MM-DD HHmmss>).<extension>`");
	has(s, "identical");
});

test("README states the M8 behavior notes", () => {
	const s = section("How sync works");
	has(s, `${API_TIMEOUT_MS / 60_000} minutes`);
	has(s, "`partial`");
	has(s, `${STUCK_LIMIT} or more requests`);
	has(s, `${FRAGMENT / (1024 * 1024)} MB piece`);
	has(s, "**Sync now** still");
	has(s, "`:`");
	has(s, "letter case");
	has(s, "both are skipped");
});

test("README lists what never syncs", () => {
	const s = section("What never syncs");
	has(s, "config folder");
	has(s, "starts with `.`");
	has(s, `${DEFAULT_DATA.maxFileSizeMiB} MB`);
});

test("README copies every residual risk from threat-model §4 and the M9 security notes", () => {
	const tm = read("docs/threat-model.md");
	const start = tm.indexOf("## 4. Residual risks");
	assert.ok(start >= 0);
	const risks = tm.slice(start).split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, "").replace(/ \[[A-Z]+-[A-Z0-9-]+\](, \[[A-Z]+-[A-Z0-9-]+\])*/g, ""));
	assert.equal(risks.length, 5);
	const s = section("Security and residual risks");
	for (const r of risks) has(s, flat(r), `risk: ${r}`);
	has(s, "unencrypted in your OneDrive"); // T-I5
	has(s, "never opens, renders or runs"); // T-T3
	has(s, "Install only plugins you trust"); // T-I1
	has(s, "https://account.microsoft.com/privacy/app-access"); // T-I1, T-I2
});

test("README shows how to verify a release (T-T7)", () => {
	const s = section("Verify a release");
	has(s, "gh attestation verify main.js -R caseke/MDVaultSync");
	has(s, "--signer-workflow caseke/MDVaultSync/.github/workflows/release.yml");
});

test("README covers sign-out and uninstall (R-AUTH-7, R-AUTH-9)", () => {
	const s = section("Sign out and uninstall");
	has(s, "**Sign out**");
	has(s, "secret storage");
	has(s, "https://account.microsoft.com/privacy/app-access");
	has(s, "If you uninstalled without signing out");
});

test("README warns against a second sync service on the same vault", () => {
	const s = section("Install");
	has(s, "**Use only one sync service per vault.**");
	has(s, "iCloud Drive");
	has(s, "Obsidian Sync");
});

test("README has no pre-release status text, and every relative link resolves", () => {
	for (const stale of ["early development", "doesn't sync anything yet", "by version 1.0.0", "Until release 1.0.0"]) {
		assert.ok(!flatReadme.includes(stale), `stale text: ${stale}`);
	}
	for (const m of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
		const target = (m[1] ?? "").split("#")[0] ?? "";
		if (target === "" || /^[a-z]+:/i.test(target)) continue;
		assert.ok(existsSync(join(root, target)), `broken link: ${target}`);
	}
	for (const m of read("docs/entra-setup.md").matchAll(/\]\(([^)\s#]+)/g)) {
		const target = m[1] ?? "";
		if (/^[a-z]+:/i.test(target)) continue;
		assert.ok(existsSync(join(root, dirname("docs/entra-setup.md"), target)), `broken link in entra-setup.md: ${target}`);
	}
});
