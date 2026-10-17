# Community directory checklist

MDVaultSync 1.0.0 ships through BRAT. This file records, item by item, whether it already meets the Obsidian community directory rules, so a later submission (SPEC: "built to the official Obsidian Community directory standards from the start") starts from a known state. Checked in plan M9 on 2026-10-17 against the rules in [research.md](research.md) [O-SUB-1]…[O-SUB-5], [O-POL-1]…[O-POL-4].

**Source check.** `docs.obsidian.md` is blocked by this session's network policy, so the live pages couldn't be fetched. A web search on 2026-10-17 returned the same rules as the research rows (funding link, `minAppVersion`, `isDesktopOnly`, command IDs, sample code, the description rules, and README/LICENSE/manifest at the repository root). It also showed that the submission-requirements page now lives under `docs.obsidian.md/community-directory/` (recorded in research.md). Re-read the live pages before submitting.

| # | Rule | Source | Result | Evidence |
|---|---|---|---|---|
| 1 | Plugin `id` is unique and doesn't contain "obsidian" | O-SUB-1 | Pass (unique: to confirm at submission) | `manifest.json` `id: "mdvaultsync"`; `test/manifest.test.ts`. Uniqueness can only be checked by the directory itself |
| 2 | Versions are `x.y.z` | O-SUB-1 | Pass | `1.0.0`; `test/manifest.test.ts`; `release.yml` triggers only on `[0-9]+.[0-9]+.[0-9]+` (`test/workflows.test.ts`) |
| 3 | `README.md`, `LICENSE` and `manifest.json` at the repository root | O-SUB-1, O-POL-4 | Pass | All three present; LICENSE is MIT |
| 4 | The directory reads `manifest.json` from the default branch | O-SUB-1 | Pass once merged | 1.0.0 reaches `main` by pull request before the tag is pushed (plan M9 owner steps) |
| 5 | Release tag equals the manifest `version`, no `v` prefix | O-SUB-2 | Pass | `.npmrc` `tag-version-prefix=""`; `release.yml` fails the build when the tag differs from `manifest.json` (`test/workflows.test.ts`) |
| 6 | Release assets: `main.js`, `manifest.json`, `styles.css` | O-SUB-2 | Pass | `release.yml` uploads exactly these three (`if-no-files-found: error`) |
| 7 | Description ≤ 250 characters, starts with an action verb, ends with a period, no emoji | O-SUB-3 | Pass | "Sync this vault across your devices through a private app folder in your personal OneDrive." (91 characters; starts with "Sync"); `test/manifest.test.ts` checks length, period and no "Obsidian" |
| 8 | `minAppVersion` is the real minimum | O-SUB-3 | Pass | `1.11.4`, the first version with `app.secretStorage` (R-ENV-3, [O-API-4]); `test/manifest.test.ts` |
| 9 | `fundingUrl` only for donations | O-SUB-3 | Pass | No `fundingUrl` (`test/manifest.test.ts`) |
| 10 | Command IDs don't contain the plugin ID | O-SUB-3 | Pass | `sync-now`, `show-status`, `sync-preview`, `sign-in`, `sign-out` (`src/main.ts`) |
| 11 | All sample code removed | O-SUB-3 | Pass | `test/manifest.test.ts` "no sample-plugin names remain" |
| 12 | `isDesktopOnly: true` if Node or Electron APIs are used | O-SUB-4 | Pass (`false`, none used) | No Node or Electron import in `src/`; the esbuild config doesn't mark Node built-ins external, so importing one fails the build; works on iPadOS (M8 matrix) |
| 13 | Submission through community.obsidian.md with a linked GitHub account | O-SUB-5 | Not done | Out of scope for v1 (BRAT release). Owner action when submitting |
| 14 | Automated review: Manifest, Releases, Source code checks | O-SUB-5 | Not run | Needs the owner's community.obsidian.md login (see "Review branch" below) |
| 15 | Build verification: the release build matches the committed source; the scanner runs the `build` script | O-SUB-5 | Pass (local) | `npm run build` = `tsc --noEmit && node esbuild.config.mjs production`. Two builds in a row on 2026-10-17 gave the same `main.js` (sha256 `6ba661c5…799d65` both times, after the owner-notes follow-up). The banner carries no date. Release files are built only by `release.yml`, from the tagged commit |
| 16 | Plugin ID can't change after publication | O-SUB-5 | Noted | Keep `mdvaultsync` |
| 17 | README discloses network use, the account requirement and files accessed outside the vault | O-POL-1, O-POL-2 | Pass | README **Disclosures**; `test/readme.test.ts` |
| 18 | No obfuscation, no telemetry, no self-update or remote code | O-POL-3 | Pass | Plain esbuild minification of the committed source; no analytics (README **Disclosures**); ESLint `no-eval`, `no-implied-eval`, `no-new-func` (`test/lint-rules.test.ts`); BRAT, not the plugin, installs updates |
| 19 | "Obsidian" not used to imply a first-party product | O-POL-4 | Pass | Name "MDVaultSync"; the description doesn't say Obsidian (`test/manifest.test.ts`) |

## "Review branch" preview
**Not run.** It needs the owner's community.obsidian.md account linked to GitHub [O-SUB-5]. To run it (optional for a BRAT release):
1. Sign in at https://community.obsidian.md with the GitHub account that owns `caseke/MDVaultSync`.
2. Start **Add a plugin**, choose the repository, and use **Review branch** with the tag `1.0.0` (or `main`). Stop before submitting.
3. Record each check's result (Manifest, Releases, Source code, Build verification), with any errors or warnings, in the table below.

| Check | Result |
|---|---|
| Manifest | (owner) |
| Releases | (owner) |
| Source code | (owner) |
| Build verification | (owner) |
