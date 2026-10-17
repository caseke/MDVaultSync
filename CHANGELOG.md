# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

0.6.2: the settings freeze after access was removed (in progress).

### Fixed

- After this app's access was removed at your Microsoft account, opening the MDVaultSync settings could freeze Obsidian. The settings tab no longer redraws itself while it's closed, which is the one thing that set this case apart. It isn't confirmed yet that this was the cause; the next device check confirms it.

### Added

- With **Verbose logging** on, the settings tab writes short markers to the developer console (no names or tokens), to find where a freeze stops.

0.6.1: fixes from the owner's first pass of the Milestone 8 device checks.

### Fixed

- After a large upload was cut off at the very end (for example by airplane mode), the next sync could make a conflict copy of a file that was identical on both sides. A sync now compares the two versions before it makes a copy, and only keeps both when they really differ.
- A file named like `a:b.md` was reported as "would land outside the vault". It's now reported as an invalid name (OneDrive doesn't allow `:`). It was never uploaded either way. Renaming a synced note to such a name now keeps its OneDrive copy, as other invalid names already did, instead of deleting it there.

### Added

- **Verbose logging** in Settings → Diagnostics writes each log line to the developer console too (the same content as **Copy log**: no file names, contents or tokens).
- The log now marks first-sync merges and records each step of a sign-in renewal, to help find the cause of a freeze seen after the app's access was removed.

0.6.0: Milestone 8, hardening. The owner's end-to-end checks on both devices are still to come.

### Added

- Settings → Account shows **OneDrive storage**: used, total and free space. It warns when 10 % or less is free, and when the drive is full. The recycle bin counts toward it.
- A full OneDrive now gives a clear notice: sync stops, and the notice says to free up space, including the recycle bin.
- Every error a sync can meet now has a readable notice text.

### Changed

- A request that OneDrive doesn't answer now gives up after a while: 2 minutes, plus more for large files (a 10 MB piece of an upload gets about 5 minutes). Before, a stalled request could hold up syncing for as long as it hung (about 24 minutes once on the iPad). The sync ends as "partial" and the next one carries on. The last piece of a large upload is the exception: it always waits for OneDrive's answer, so a late answer can never overwrite a newer edit.
- While two or more requests are still hanging after giving up, automatic syncs (startup and interval) wait, and a notice says so once. **Sync now** still runs, and restarting Obsidian clears it.

### Security

- A new test runs whole syncs with marker text in file names, contents, sign-in tokens and server messages, and checks that none of it reaches the plugin's log or the developer console.

0.5.1: the sync state on the iPad.

Milestone 7 is complete: the owner's checks passed on the iPad and Ubuntu.

### Fixed

- The iPad had no way to see the sync state at a glance: it has no status bar, and the ribbon button's tooltip needs a mouse to hover. The ribbon button's icon now shows the state on every device (arrows when synced, a loader while syncing, an hourglass when the sync waits for you, a warning after an error, a sign-in arrow when you need to sign in).

### Added

- A **Show sync status** command shows the current state, the time of the last sync and the last sync report. Clicking the status bar on desktop opens the same window.

Milestone 7 (0.5.0): sync is switched on. The plugin now syncs by itself and can be used day to day; the owner's device checks are still to come.

### Added

- Sync runs about 5 seconds after Obsidian opens, then every 5 minutes (change it, or turn it off, in settings). **Sync now** (command or the ribbon button) syncs at once, and **Preview sync** shows what would change and does nothing unless you select Run.
- The first sync on a device always shows the preview first, and you can turn on a preview before every sync. Files that differ on both sides with no sync history are listed in their own group, so the conflict copies they get are no surprise.
- If a sync would delete more than 25 % of your synced files (adjustable), it asks first. "Skip deletes this time" syncs everything else and doesn't ask about those deletes again until a file changes or you select Sync now.
- After a sync with conflicts, one notice lists every conflict copy and stays until you dismiss it. Errors raise a short notice; a sync with nothing wrong stays quiet, and a problem that repeats on its own doesn't notice again every few minutes.
- The status bar (desktop) and the ribbon button's tooltip (iPad) show the sync state and the time of the last successful sync. Clicking the status bar opens the last sync report.
- New settings: device name (used in conflict copy names), sync interval, maximum file size, exclude patterns, preview before every sync, and the delete threshold. Values that aren't valid aren't saved, and the setting says why. On Obsidian 1.13 and later they appear in the settings search.
- The settings page shows the last sync report (what changed, conflicts, skipped files with the reason, problems), a **Sync now** button, the OneDrive capability probe and **Copy log**.
- File names in the preview, report and notices show hidden or direction-changing characters as codes, so a name can't disguise itself.

### Changed

- If the saved exclude patterns can't be read (for example after a hand edit, or a damaged plugin data file), sync pauses with a notice until you check them in settings and select **Save and resume sync**, instead of syncing with no exclusions.
- Signing out also closes any open sync preview or delete prompt, and disabling or updating the plugin during a sync stops it from starting anything new.

Milestone 6 (0.4.0, 0.4.1): the part that carries out a sync plan, safely and so it can pick up where it stopped. Sync still isn't switched on in the app (that is milestone 7), so the only visible changes are a new diagnostics command and sign-out clearing the saved sync state.

### Added

- Carrying out the sync plan: OneDrive changes are applied here first, then this device's changes are sent up; renames and moves come before everything else, and up to four files transfer at a time.
- Every download is checked against OneDrive's fingerprint before it replaces a file, and is written to a hidden temporary file first, then moved into place. Every upload's result is checked the same way.
- Nothing is ever written into Obsidian's settings folder, a hidden folder, or outside the vault: the path is checked again right before each write.
- A note you edit while a sync is running is never overwritten or deleted by that sync. The change becomes a conflict copy, or waits for the next sync.
- Conflicts keep both versions: your version is saved as a conflict copy before the OneDrive version replaces the note, and the copy is uploaded so every device has it. If the app is closed in the middle, the next sync reuses the same copy instead of making another.
- Large files (over 10 MB) upload in pieces. An interrupted upload continues where it stopped after a restart, or starts over if OneDrive dropped it.
- Progress is saved at most a second after each step and right before anything is overwritten or deleted, so a sync stopped by iPadOS or a lost connection resumes without redoing or losing work.
- Sync triggers that overlap never run two syncs at once; at most one more sync is queued.
- A "Test file replace on this device" command, for checking how this device replaces files (results go in the build plan). On both Ubuntu and the iPad, Obsidian can't rename one file over another, so the plugin removes the old file and then moves the new one into place.

### Changed

- A OneDrive sign-in left behind by an uninstalled copy of the plugin is now removed when the plugin is installed again, with a notice linking to the page where you can also remove the app's access from your Microsoft account. Obsidian gives plugins no way to clean up at uninstall, and the sign-in is kept in Obsidian's secret storage, which uninstalling doesn't clear.
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
