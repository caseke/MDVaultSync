# MDVaultSync: specification

MDVaultSync is an Obsidian community plugin. It keeps one vault in sync across the owner's devices, an iPad (Obsidian for iOS) and an Ubuntu desktop (Obsidian .deb), using the owner's personal OneDrive as the hub. The plugin reads and writes only inside its OneDrive App Folder.

- Version 1 ships through BRAT from the public GitHub repo `caseke/MDVaultSync` under the MIT license.
- It is built to the official Obsidian Community directory standards from the start, so it can be submitted later.

Related documents:
- [docs/design.md](docs/design.md): how it is built.
- [docs/plan.md](docs/plan.md): the build order and milestone status.
- [docs/research.md](docs/research.md): the facts behind every decision. IDs like `[G-UP-3]` refer to it.
- [docs/threat-model.md](docs/threat-model.md): STRIDE threat model.
- [docs/cost-estimate.md](docs/cost-estimate.md): cost of every component.

Requirement keywords: **MUST** is required for v1. **SHOULD** is expected unless a documented reason prevents it.

---

## 1. Users and environment
- **R-ENV-1.** The plugin MUST support personal Microsoft accounts only. Work and school accounts are not supported.
- **R-ENV-2.** The plugin MUST work on Obsidian for iOS (iPadOS) and Obsidian desktop on Linux. Windows, macOS and Android SHOULD work, since nothing is platform-specific, but they are not tested in v1. `manifest.json` sets `isDesktopOnly: false` [O-SUB-4].
- **R-ENV-3.** `minAppVersion` MUST be `1.11.4`, the first version with `app.secretStorage` [O-API-4].
- **R-ENV-4.** The owner edits from one device at a time. Concurrent edits on two devices are rare, but they MUST be handled without data loss.

## 2. Functional requirements

### Account and auth
- **R-AUTH-1.** Sign-in MUST use OAuth 2.0 authorization code with PKCE (S256) as a public client with no client secret, against the `/consumers` endpoints [I-AC-1], [I-AC-2], [I-AC-3].
- **R-AUTH-2.** Sign-in MUST open in the system browser and return through the `obsidian://mdvaultsync-auth` protocol handler [I-BR-1], [O-API-3].
- **R-AUTH-3.** A fallback MUST let the user paste the final URL from Microsoft's `nativeclient` redirect page into settings, with the same PKCE and `state` validation [I-RU-4].
- **R-AUTH-4.** The requested scopes MUST be exactly `Files.ReadWrite.AppFolder offline_access` [I-REG-5].
- **R-AUTH-5.** The refresh token MUST be stored in `app.secretStorage`. If that API throws, the plugin MUST store it in plugin data and show a standing warning in settings (D-5). Access tokens MUST be kept in memory only.
- **R-AUTH-6.** Each refresh MUST replace the stored refresh token with the new one [I-TL-3]. Refreshes MUST be single-flight: concurrent callers share one refresh request.
- **R-AUTH-7.** Sign-out MUST clear the stored tokens and all sync state, leave local files untouched, and show the user where to remove the app's access in their Microsoft account [I-TL-4], [C-MSA-1].
- **R-AUTH-8.** The Entra application (client) ID MUST be a user setting, with no default value (D-14).

### Scope of synced content
- **R-SCOPE-1.** The plugin MUST sync notes and attachments, which means every file the Vault API can see.
- **R-SCOPE-2.** It MUST exclude `app.vault.configDir` (usually `.obsidian`), every path with a segment that starts with `.`, and user-configured exclude patterns (gitignore-style globs).
- **R-SCOPE-3.** Files larger than the size cap (default 100 MiB, configurable 1–1024 MiB) MUST be skipped and listed in the sync report with reason `too-large`.
- **R-SCOPE-4.** Remote items that would map to an excluded or hidden local path MUST NOT be downloaded. They MUST be reported.

### Triggers
- **R-TRIG-1.** A sync MUST start about 5 seconds after Obsidian finishes loading the workspace (`onLayoutReady`).
- **R-TRIG-2.** A sync MUST run on a user-configurable interval: default 5 minutes, 0 to disable, 1–1440 minutes otherwise.
- **R-TRIG-3.** There MUST be a "Sync now" command and a ribbon button that runs the same action.
- **R-TRIG-4.** Triggers MUST share a single-flight lock. A trigger that arrives during a run queues at most one follow-up run; runs never happen in parallel.

### Change detection and state
- **R-CD-1.** Remote changes MUST be detected with Graph delta queries scoped to the App Folder. The full `deltaLink` MUST be persisted [G-DL-1], [G-DL-2]. If the M3 probe shows approot delta is unsupported, a recursive children listing compared on cTag MUST be used instead (design §5.2).
- **R-CD-2.** Local changes MUST be detected from vault events (create, modify, delete, rename) registered after layout-ready [O-API-12]. A full reconcile scan MUST also run at startup.
- **R-CD-3.** The plugin MUST keep a per-file record of remote item ID, last-synced eTag and cTag, size, modified time, and content hash (local plaintext hash and remote stored-bytes hash) (design §2 `FileRecord`).
- **R-CD-4.** Content hashing MUST use QuickXorHash, the only hash guaranteed on personal OneDrive [G-HASH-1], [G-HASH-2]. Unchanged content MUST never be transferred.

### Ordering, concurrency and conflicts
- **R-ORDER.** Each run MUST pull remote changes and apply them locally before pushing local changes.
- **R-CC-1.** Every update, move and delete of an existing remote item MUST send `If-Match` with the last-synced eTag.
  - New files MUST be created with `conflictBehavior=fail`.
  - Small updates MUST use simple PUT only if the M3 probe confirms that PUT honors If-Match; otherwise they use a single-fragment upload session (D-11) [G-UP-3], [G-UP-5].
- **R-CC-2.** A 412 response MUST be resolved under the conflict policy:
  - First re-fetch the item. If only metadata changed (same cTag and hash), retry with the new eTag.
  - Otherwise it is a content conflict.
- **R-CONF-1.** Conflicts MUST lose no data. The remote version keeps the original path. This device's version is written to `<stem> (conflict <device name> <YYYY-MM-DD HHmmss>)<.ext>` in the same folder and then uploaded (D-9).
- **R-CONF-2.** After a run with conflicts, one notice MUST list every conflict copy. It stays visible until dismissed. The conflicts also appear in the sync report.
- **R-CONF-3.** A conflict copy MUST only be created when both sides changed with different content. Identical content on both sides MUST be recorded as synced with no copy.

### Deletes, renames and safety
- **R-DEL-1.** Deletes MUST propagate in both directions.
  - Remote deletes use `DELETE /items/{id}` with If-Match, which puts items in the OneDrive recycle bin [G-DEL-1]. `permanentDelete` MUST NOT be used.
  - Local deletes use `FileManager.trashFile`, which follows Obsidian's "Deleted files" setting [O-API-7].
- **R-DEL-2.** A delete MUST lose to an edit. If one side deleted a file and the other side edited it, the edited version is restored (design §5.4 table).
- **R-MOVE-1.** Renames and moves MUST be detected and applied as moves by item ID: PATCH remotely, `Vault.rename` locally. This keeps OneDrive version history [G-MV-1], [O-API-8].
- **R-FIRST-1.** The first sync on a device MUST merge by union and delete nothing. The same rule applies whenever the App Folder's identity changes or Graph demands a resync.
- **R-FIRST-2.** A dry-run preview MUST list planned uploads, downloads, moves, deletes, conflicts and skips.
  - It MUST be shown before the first sync.
  - It MUST be available on demand through a "Preview sync" command.
  - It MUST be shown before every sync when the "Preview changes before every sync" setting is on.
- **R-GUARD-1.** If a run would delete more than the configured share of tracked files (default 25 %), it MUST pause and list the deletes for confirmation. Declining runs the sync without the deletes.

### Paths
- **R-PATH-1.** Names MUST be normalized to Unicode NFC. Two local names that are equal after NFC MUST be skipped and reported.
- **R-PATH-2.** Case-only collisions between local paths (possible on Linux) MUST be detected. The already-tracked path keeps syncing, and the other is skipped and reported.
- **R-PATH-3.** OneDrive naming rules MUST be enforced: invalid characters, reserved names, leading and trailing spaces, folder names ending in a period, a leading `~`, `_vti_`, and the 400-character full-path limit including the App Folder prefix [G-NM-1]–[G-NM-4]. Files that break a rule MUST be skipped with the reason, never renamed silently.
- **R-PATH-4.** Every remote-derived path MUST be validated to resolve inside the vault before any write: no `..`, no absolute paths, no hidden or config segments (design §8).

### Local writes and network
- **R-IO-1.** Downloads MUST be written to a hidden temporary file in the same folder, then renamed into place.
- **R-IO-2.** Downloaded bytes MUST match the remote QuickXorHash before they replace a local file.
- **R-NET-1.** Every HTTP call MUST go through Obsidian's `requestUrl` [O-API-1]. `fetch`, XHR and Node `http` are forbidden.

### Resilience
- **R-RES-1.** The plugin MUST honor `Retry-After` on 429 and 503 and pause all requests while it lasts. It MUST use exponential backoff with jitter on other 5xx errors and network errors [G-THR-1], [G-THR-2].
- **R-RES-2.** Files over 10 MiB MUST use upload sessions with 10 MiB fragments (32 × 320 KiB) [G-UP-4], [G-UP-6].
  - The session MUST be persisted.
  - Interrupted uploads MUST resume from `nextExpectedRanges`.
  - A 404 on the session MUST restart the upload [G-UP-9].
- **R-RES-3.** Progress MUST be persisted after each completed operation, so an interrupted sync resumes where it stopped (design §6.2).

### UI
- **R-UI-1.** The settings tab MUST show:
  - account status;
  - Sign in, Sign in another way, Sign out;
  - Client ID;
  - device name;
  - sync interval;
  - maximum file size;
  - exclude patterns;
  - the dry-run toggle;
  - the mass-delete threshold;
  - the last sync report;
  - diagnostics (capability probe, copy log).
- **R-UI-2.** The status bar MUST show the last sync time and current state. Obsidian has no status bar on mobile [O-API-13], so on iPad the ribbon tooltip shows the same state.
- **R-UI-3.** Errors and conflicts MUST raise notices. A successful sync with no conflicts MUST NOT.

## 3. Security requirements
- **R-SEC-1.** OAuth MUST be public client plus PKCE (R-AUTH-1). `state` MUST be checked in constant time and used only once. A pending sign-in MUST expire after 10 minutes.
- **R-SEC-2.** Token storage MUST be the most secure option available (R-AUTH-5). The residual risk MUST be documented in docs/threat-model.md and in the README.
- **R-SEC-3.** Logs MUST record only operation types, counts, durations, HTTP statuses and error codes. Tokens, file contents and file names MUST NOT appear in logs, and the logger API must make passing them impossible (design §9). A test MUST check this.
- **R-SEC-4.** All remote data is untrusted. JSON shape, field types, sizes, IDs, names, paths and transfer URLs MUST be validated before use (design §8).
- **R-SEC-5.** Supply chain:
  - zero runtime dependencies, and every dev dependency justified (§8);
  - committed `package-lock.json`;
  - Dependabot for npm and GitHub Actions;
  - CodeQL;
  - secret scanning with push protection;
  - `npm audit` in CI;
  - Actions pinned by commit SHA;
  - release files built in GitHub Actions with artifact attestations [O-REL-1], [C-GH-3].
- **R-SEC-6.** `SECURITY.md` MUST describe private vulnerability reporting through GitHub Security Advisories.

## 4. Engineering requirements
- **R-ENG-1.** TypeScript strict mode, starting from the structure of `obsidianmd/obsidian-sample-plugin` [O-SMP-1]–[O-SMP-3].
- **R-ENG-2.** Lint with `eslint-plugin-obsidianmd` `configs.recommended` [O-ESL-1]. Follow the plugin guidelines and developer policies, including the README disclosures [O-POL-1], [O-POL-2].
- **R-ENG-3.** The sync engine (`src/core`) and remote clients (`src/remote`) MUST NOT import `obsidian`. They talk to the vault and Graph only through the `VaultPort`, `RemotePort` and `HttpTransport` interfaces, and are unit tested with fakes.
- **R-ENG-4.** All file content MUST pass through a single `ContentTransform` layer between the vault and the Graph client. v1 uses the identity transform; end-to-end encryption can be added later without changing the engine.
- **R-ENG-5.** Every milestone MUST end with `npm run lint`, `npm run typecheck` and `npm test` passing, with the command output pasted into docs/plan.md.

## 5. Decisions and reasons
| ID | Decision | Reason |
|---|---|---|
| D-1 | Personal Microsoft accounts only | Owner decision. The AppFolder scope is designed for personal accounts [G-AF-4]. |
| D-2 | The Entra tenant comes from an Azure free account (card used for verification only) | Since June 2024 apps must be registered in a directory [I-REG-1]. The M365 Developer Program excludes personal accounts [I-REG-3]. Azure free is the documented route [I-REG-2], [C-AZ-1]. Owner accepted the card step. |
| D-3 | Scopes `Files.ReadWrite.AppFolder` + `offline_access` | Least privilege: the plugin can't see any other OneDrive file [I-REG-5]. |
| D-4 | Auth code + PKCE, "Mobile and desktop applications" platform, `obsidian://mdvaultsync-auth` primary, `nativeclient` paste fallback, no device code | The Mobile and desktop platform gives about 90-day refresh tokens and no Origin requirement; SPA would give 24-hour tokens [I-TL-2], [I-AC-5]. The .deb install registers `obsidian://`, so one code path covers both devices with no Node code. Device code needs "Allow public client flows" and is flagged by Microsoft as phishing-prone [I-DC-1]. Owner chose the paste fallback. |
| D-5 | Refresh token in SecretStorage; fall back to `data.json` with a warning only if the API throws | It is the most secure store Obsidian offers [O-API-4]. The owner prefers working sync with a visible warning over being locked out. `configDir` is never synced, so `data.json` stays on the device. |
| D-6 | Exclude configDir, hidden paths and user patterns | Owner decision. Settings and plugin state are per device, and `data.json` may hold a token. |
| D-7 | Triggers: startup, interval, command, ribbon, behind one lock | Owner decision. |
| D-8 | Remote delete goes to the recycle bin; local delete uses the trash per Obsidian setting | Owner decision. Both are recoverable [G-DEL-1], [O-API-7]. |
| D-9 | On conflict the remote version keeps the name; the local version becomes the conflict copy | Owner decision. Every device converges on the same main file, and the conflict copy is uploaded so it is visible everywhere. |
| D-10 | Single `ContentTransform` seam; `FileRecord` stores plaintext and stored-bytes hashes separately | Lets E2EE be added later without changing the engine (design §13). |
| D-11 | New files use PUT with `conflictBehavior=fail`. Updates use PUT with If-Match only if M3 proves Graph honors it; otherwise a single-fragment upload session | If-Match is undocumented for PUT but documented for upload sessions [G-UP-3], [G-UP-5]. Owner chose probe-then-decide. |
| D-12 | Default size cap 100 MiB | Owner decision. The adapter API reads whole files into memory, which matters on iPad. |
| D-13 | QuickXorHash only | sha256 is "don't use" and sha1 is "if available" [G-HASH-1]. |
| D-14 | Client ID is a setting with no default | Each user registers their own app. Shipping one shared app to the public would need publisher verification to avoid the "unverified" consent warning [I-REG-6]. The App Folder is named after each user's app registration [G-AF-1]. |
| D-15 | Zero runtime dependencies. Tests use Node's built-in runner with type stripping | Minimal supply chain. Node ≥22.18 runs `.ts` tests without a transpiler [C-NODE-1], [C-NODE-2]. |
| D-16 | Remote-applied renames use `Vault.rename`, not `FileManager.renameFile` | The device that made the rename already rewrote links, and those edits arrive as content changes. Rewriting again would create spurious edits. |
| D-17 | Invalid names are skipped and reported, never auto-renamed | Renaming the user's files without asking is worse than a clear report. |
| D-18 | A changed App Folder ID (deleted or recreated by the user) is treated as a first sync | Prevents mass deletes when the user removes the remote folder by mistake [G-AF-2]. |

## 6. Acceptance for v1 (all must hold)
1. Every R-* requirement is implemented, and docs/plan.md shows which milestone verified it.
2. The manual test matrix in docs/plan.md (M8) passes on the owner's iPad and Ubuntu desktop.
3. A tagged release built by GitHub Actions has a verifiable attestation (`gh attestation verify main.js -R caseke/MDVaultSync`) and installs through BRAT on both devices.
4. The README contains the Entra setup guide and the required disclosures.

## 7. Out of scope for v1
- End-to-end encryption (only the seam exists, D-10). Encrypting file names.
- Work and school accounts, SharePoint, shared folders, and any OneDrive location outside the App Folder.
- Syncing `.obsidian` settings, plugins, themes or hidden files.
- More than one vault per App Folder, and multiple accounts.
- Selective sync per folder (beyond exclude patterns), and on-demand or placeholder files.
- Real-time sync through webhooks or push notifications (Graph webhooks need a public HTTPS endpoint).
- Device code sign-in.
- A shared, publisher-verified app registration with a built-in client ID.
- Version history UI; OneDrive's own version history covers this.
- Three-way text merge of conflicts.
- Preserving file modification times across devices.
- Bandwidth limits, metered-network detection, and background sync while Obsidian is closed or suspended on iOS.
- Android, Windows and macOS testing (expected to work, but untested).
- Localization (English only).

## 8. Dependencies (dev only; zero runtime)
| Package | Why |
|---|---|
| `obsidian` | API type definitions (the build marks it external, so it isn't bundled) |
| `typescript` | Strict type checking |
| `esbuild` | Bundler used by the official sample plugin |
| `eslint`, `@eslint/js`, `typescript-eslint` | Peer dependencies required by the Obsidian ESLint plugin [O-ESL-1] |
| `eslint-plugin-obsidianmd` | Official Obsidian lint rules (R-ENG-2) |
| `globals` | Browser and Node globals for the ESLint config, as in the sample |
| `jiti` | Lets ESLint load `eslint.config.mts`, as in the sample. Drop it if the config is written as `.mjs` |
| `@types/node` | Types for build scripts and `node:test` |

`@eslint/json` is a peer dependency of the ESLint plugin, so npm installs it automatically. Adding any other package requires a row in this table and the owner's approval.
