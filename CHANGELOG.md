# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Milestone 6 (0.4.0): the part that carries out a sync plan, safely and so it can pick up where it stopped. Sync still isn't switched on in the app (that is milestone 7), so the only visible changes are a new diagnostics command and sign-out clearing the saved sync state.

### Added

- Carrying out the sync plan: OneDrive changes are applied here first, then this device's changes are sent up; renames and moves come before everything else, and up to four files transfer at a time.
- Every download is checked against OneDrive's fingerprint before it replaces a file, and is written to a hidden temporary file first, then moved into place. Every upload's result is checked the same way.
- Nothing is ever written into Obsidian's settings folder, a hidden folder, or outside the vault: the path is checked again right before each write.
- A note you edit while a sync is running is never overwritten or deleted by that sync. The change becomes a conflict copy, or waits for the next sync.
- Conflicts keep both versions: your version is saved as a conflict copy before the OneDrive version replaces the note, and the copy is uploaded so every device has it. If the app is closed in the middle, the next sync reuses the same copy instead of making another.
- Large files (over 10 MB) upload in pieces. An interrupted upload continues where it stopped after a restart, or starts over if OneDrive dropped it.
- Progress is saved at most a second after each step and right before anything is overwritten or deleted, so a sync stopped by iPadOS or a lost connection resumes without redoing or losing work.
- Sync triggers that overlap never run two syncs at once; at most one more sync is queued.
- A "Test file replace on this device" command, for checking how this device replaces files (results go in the build plan).

### Changed

- Signing out now also deletes the saved sync state file. Your notes are untouched, and the next sign-in starts with a safe merge that deletes nothing.

Milestone 5: the sync planner, which decides what each sync will do. Sync isn't wired up yet, so nothing changes in the app.

### Added

- The sync plan: for every file it compares the last synced version with this device and OneDrive, then decides to upload, download, move, delete, keep both as a conflict copy, or skip with a reason.
- Edits always win over deletes, and the first sync on a device (or after the OneDrive folder is recreated) only adds files, never deletes.
- Renames and moves on either side are applied as moves, including whole folders, so OneDrive's version history is kept.
- Files skipped for any reason (name rules, size, exclusions, clashing names) never cause a delete on the other side, and an OneDrive folder is deleted only when it is truly empty.
- The deletes count toward the "confirm large deletes" check, and deletes you declined aren't proposed again until the file changes or you press "Sync now".
- The saved sync state is checked when it is loaded; a damaged or edited file makes the next sync a safe merge that deletes nothing.
- A per-sync report of every file touched, conflicts, skips and errors.

Milestone 4: the sync engine's building blocks.

### Added

- File fingerprints (QuickXorHash), the same ones OneDrive computes, so a later version can skip files that haven't changed. Checked against OneDrive's own values and an independent implementation.
- File name rules: names OneDrive rejects, paths over 400 characters, names that clash by letter case or Unicode form, and remote paths that would land outside the vault, in Obsidian's settings folder, or in a hidden folder are all detected for skipping. Files are never renamed.
- Exclude patterns in gitignore style (`*`, `**`, `?`, a trailing `/`) for keeping folders or file types out of sync.
- Conflict copy names such as `Note (conflict iPad 2026-10-12 140203).md`.

## [0.3.6] - 2026-10-12

Milestone 3 complete: the OneDrive connection is built and checked on both devices.

### Changed

- The plugin trusts fewer servers for file transfers: only OneDrive personal's content servers (`*.microsoftpersonalcontent.com`, `*.1drv.com`, `*.onedrive.com`, `*.livefilestore.com`). It no longer trusts all of `*.sharepoint.com`, `*.microsoft.com` or `*.live.com`.
- The settings learned from the probe are now final for both devices.

## [0.3.5] - 2026-10-12

### Fixed

- Downloads couldn't start: personal OneDrive leaves the download link out of responses that request only specific fields, and the plugin requested exactly that. The plugin now reads the file's full details before a download, where the link is present. The capability probe found this.

## [0.3.4] - 2026-10-12

### Changed

- The probe output is now version 4. It explains why a download couldn't start: whether OneDrive's download link was missing, too long, or on an untrusted server. It records the link's length and server name, never the link itself.

### Fixed

- Reading a file's details no longer fails when its download link is unusual (too long, or malformed). Only the download itself is refused, with a specific reason.

## [0.3.3] - 2026-10-12

### Fixed

- Large uploads (over 10 MiB) were refused because OneDrive personal sends them to `my.microsoftpersonalcontent.com`, a Microsoft server that wasn't on the plugin's trusted list. The probe found it, and a domain-ownership check confirmed it belongs to Microsoft, so it is now trusted. Uploads to it never carry your sign-in token.

## [0.3.2] - 2026-10-12

### Changed

- Settings learned from the capability probe are now built in: conditional plain uploads for small files, and the delta form that works on personal OneDrive.
- The probe output is now version 3. When OneDrive hands back an upload or download address on a server the plugin doesn't trust yet, the probe reports that server's name (never the full address) and sends nothing to it.

### Fixed

- Reading a file's details no longer fails when OneDrive's download server isn't on the trusted list. Only the download itself is refused.

## [0.3.1] - 2026-10-12

### Fixed

- The capability probe's delta check failed on any app folder holding a file name longer than 255 characters. OneDrive allows such names. The same check would have stopped sync entirely once sync exists. Long names from OneDrive are now accepted; whether to sync one is decided per file later.
- The probe's 12 MiB upload failed with "invalid request" when starting the upload session. The plugin no longer sends the optional file-size field. The probe now tries several request forms and reports which one OneDrive accepts.

### Changed

- The probe output is now version 2. It runs the delta check first, adds a 300-character name test, and records error sub-codes and which step of the large-file test failed.

## [0.3.0] - 2026-10-12

Pre-release for the M3 capability probe on the iPad and Ubuntu. Nothing syncs yet.

### Added

- **Run OneDrive capability probe** command. It checks how your OneDrive's app folder behaves: delta queries, conditional updates, case-insensitive names, the name length limit, rename and delete, quota access, and a 12 MiB upload and download. It works in a hidden `.mdvaultsync-probe` folder inside the app folder, and deletes that folder afterwards (items go to the OneDrive recycle bin). The result is JSON you can copy. It contains statuses, counts, timings and server host names, and no file names from your vault, links or sign-in data.
- Internal: the Microsoft Graph client (retries that honor `Retry-After`, upload sessions, conditional requests), validation of everything Graph returns, and a log that records only operation types, counts, durations, statuses and error codes.

## [0.2.2] - 2026-10-12

### Changed

- **Sign in** in settings opens Microsoft's sign-in page in your default browser on the first tap, with no intermediate window. The link is prepared before you tap, because iOS only lets a tap (not code after it) open a browser. The **Sign in to OneDrive** command still shows a small window with the link.

## [0.2.1] - 2026-10-12

### Fixed

- iPad: **Sign in** did nothing. The browser is now opened by tapping **Open Microsoft sign-in** in a small window (a real link), because iOS blocks `window.open` that doesn't run directly in a tap.

### Removed

- The "Sign in another way" paste fallback through Microsoft's `nativeclient` page (owner decision: the page showed a phishing warning, and the primary flow works). Remove the `nativeclient` redirect URI from your app registration if you added it.

## [0.2.0] - 2026-10-12

First pre-release, for testing through BRAT. Includes M1 and M2.

### Added

- M2 sign-in to a personal Microsoft account: OAuth authorization code with PKCE (S256) against `/consumers`, scope exactly `Files.ReadWrite.AppFolder offline_access`, returning through `obsidian://mdvaultsync-auth` (trailing slash accepted), with a "Sign in another way" paste fallback through Microsoft's `nativeclient` page.
- Callback protection: a 10-minute pending sign-in, a constant-time single-use `state`, binding to the channel the sign-in started on, and a forged link can't cancel a real sign-in.
- Refresh token storage in Obsidian secret storage, with a `data.json` fallback and a standing warning when secret storage fails. Access tokens stay in memory only. Refresh is single-flight, and the rotated refresh token is stored before use. `invalid_grant` leads to "Sign-in required".
- `HttpTransport` over `requestUrl` (`throw: false`) and an authorizing decorator that sends `Authorization` only to `https://graph.microsoft.com`.
- Commands **Sign in to OneDrive** and **Sign out of OneDrive**. Sign-out clears the token and sync state (a stub until M6), leaves local files untouched, and links to Microsoft's app-access page.
- Settings: the Account section (status, application ID, sign in, sign in another way, sign out, token storage).

- M1 scaffold: an empty plugin (`src/main.ts`) that loads in Obsidian, and the module contracts in `src/core/ports.ts` (design §2).
- Quality gate: ESLint with `eslint-plugin-obsidianmd` plus project rules, strict `tsc`, Node's built-in test runner, and an esbuild production build.
- Project lint rules (`eslint/project-rules.ts`): no `obsidian` import in `src/core` or `src/remote`, no `fetch`/XHR/WebSocket or Node networking and file modules in `src`, no `eval` or dynamic `import()`, and RemotePort content methods only from `src/core/remote-content.ts`.
- CI on Node 22 and 24 (lint, typecheck, test, build, `npm audit`, network-API check), CodeQL, and Dependabot. All actions are pinned by commit SHA.
- Claude Code project config: a post-edit lint and typecheck hook, a dependency-install session hook, and a `security-reviewer` subagent.
- `LICENSE` (MIT), `SECURITY.md` (private vulnerability reporting), and a README with the required disclosures.

- Release workflow (`.github/workflows/release.yml`), pulled forward from M9 so BRAT can install pre-releases on the iPad. On an `x.y.z` tag that equals `manifest.json`'s version, it runs every check, attests `main.js`, `manifest.json` and `styles.css`, and drafts a release (pre-release for 0.x). Version 0.2.0.

### Security

- M2 security review fixes: sign-out verifies the token was removed and reports an incomplete sign-out otherwise. Signing in while signed in is refused. An older in-flight refresh can't overwrite a new sign-in. Short-lived tokens no longer rotate the refresh token on every call. URL parse errors carry no URL.
- Security review hardening: network APIs are banned through `activeWindow`, `window`, `self` and `globalThis`, plus `EventSource`, `sendBeacon` and `require`. Inline `eslint-disable` comments can't switch off the project rules in `src`. Node built-ins fail the build instead of being left external. `npm ci` runs with `--ignore-scripts`. Dependabot waits 7 days before proposing new releases.
