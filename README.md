# MDVaultSync

Sync one Obsidian vault across your devices through a private app folder in your personal OneDrive.

MDVaultSync keeps the same notes and attachments on each of your devices. Your personal OneDrive is the hub: each device uploads its changes there and downloads the others'. The plugin can see only its own folder in your OneDrive (`Apps/<your app name>`), never the rest of it.

It is built and tested for an iPad (Obsidian for iOS) and an Ubuntu desktop. Windows, macOS and Android are expected to work, since nothing in it is platform-specific, but they aren't tested. It needs Obsidian 1.11.4 or later. The full specification is in [SPEC.md](SPEC.md).

What it doesn't do: sync Obsidian's settings, plugins or themes; work with work or school accounts or SharePoint; encrypt your files in OneDrive; merge the text of two conflicting edits; sync in the background while Obsidian is closed or suspended. The full list is in [SPEC.md §7](SPEC.md#7-out-of-scope-for-v1).

## Disclosures
These are required by the [Obsidian developer policies](https://docs.obsidian.md/Developer+policies).

- **Network use.** The plugin connects to two Microsoft services, and only these:
  - the **Microsoft identity platform** (`login.microsoftonline.com`), to sign you in and refresh your sign-in;
  - **Microsoft Graph** (`graph.microsoft.com`) and the OneDrive upload and download hosts it hands out, to read and write your synced files.

  All requests go through Obsidian's own network API. Nothing else is contacted.
- **Account required.** You need a personal Microsoft account with OneDrive. Work and school accounts aren't supported. You also register your own free Microsoft Entra app to get a client ID; [Microsoft Entra setup](#microsoft-entra-setup) below shows how.
- **Files outside the vault.** The plugin reads and writes only:
  - files inside your vault. It never syncs the Obsidian config folder or hidden files. It keeps its own settings and sync state in this device's plugin folder, inside the config folder;
  - its own App Folder in your OneDrive (`Apps/<your app name>`). The permission it asks for, `Files.ReadWrite.AppFolder`, can't see the rest of your OneDrive.

  This is how your devices share the vault.
- **No telemetry.** The plugin sends no analytics, usage data or crash reports. Its logs stay on your device and never contain file names, file contents or tokens.

## Install
MDVaultSync isn't in Obsidian's community plugin directory yet. Install it with **BRAT**, which installs plugins from a GitHub repository's releases:

1. In Obsidian, open **Settings → Community plugins**, then browse for and install **BRAT** (Obsidian42 - BRAT), and enable it.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Enter `caseke/MDVaultSync` and confirm. BRAT installs the latest release.
4. In **Settings → Community plugins**, enable **MDVaultSync**.

To update later, run **BRAT: Check for updates to all beta plugins**. Do this on each device; every device should run the same version.

Then follow [Microsoft Entra setup](#microsoft-entra-setup) once, and connect each device with step 5.

**Use only one sync service per vault.** Don't use MDVaultSync on a vault that iCloud Drive, Obsidian Sync, Dropbox, Syncthing or any other tool also syncs. On the iPad, keep the vault out of iCloud Drive (create it with *Store in iCloud* off). Another service would copy MDVaultSync's own data between devices: its sync state, which is only valid on the device that wrote it and could make a sync act on another device's history, and possibly its sign-in token (see **Token storage**). Both sync services would also fight over the same files.

**Try it on a test vault first**, or back up your vault before the first sync. The first sync on a device only adds files and never deletes, and it shows you its plan before it runs (see [First sync](#first-sync)).

## Microsoft Entra setup
MDVaultSync signs in to your **personal** Microsoft account through an app registration that you own. This guide creates one. It takes about 15 minutes and costs $0, but Microsoft requires a credit or debit card for identity verification in step 1 (see [docs/cost-estimate.md](docs/cost-estimate.md)).

At the end you'll have an **Application (client) ID**, a GUID you paste into the MDVaultSync settings. You do steps 1–4 once; step 5 on each device.

The guide was checked against the live portal on 2026-10-12. Microsoft redesigns the portal often, so a label may differ slightly from what you see. IDs in brackets, like [I-REG-1], point to the sources in [docs/research.md](docs/research.md).

### Why each step exists
- Since June 2024, every app registration must live in a Microsoft Entra directory (tenant) [I-REG-1].
- A personal Microsoft account (outlook.com, hotmail.com, live.com) doesn't come with one. The documented way to get one is an Azure free account [I-REG-2]. The Microsoft 365 Developer Program no longer accepts personal accounts [I-REG-3].
- The app is registered as a **public client** under the "Mobile and desktop applications" platform. That means no secret, and refresh tokens last about 90 days. The "Single-page application" platform would cap them at 24 hours [I-TL-2], [I-AC-6].

### Before you start
- **Already have an Entra tenant you control** (not your employer's)? Skip step 1 and use it. In step 2, switch to that directory instead of "Default Directory".
- **Install MDVaultSync first** (see [Install](#install)) so you can finish step 5.

### Step 1: Create the tenant with an Azure free account
1. Open https://azure.microsoft.com/free and choose **Start free** (or **Try Azure for free**).
2. Sign in with the **same personal Microsoft account** whose OneDrive will hold the vault.
3. Complete the sign-up:
   - phone verification (a real mobile number; VoIP numbers are rejected);
   - card verification (credit or debit, not prepaid). You may see a temporary hold of about $1, which is released [C-AZ-1].
4. Accept the agreement. Azure creates a subscription and a directory, usually called **Default Directory**. The name may differ, for example `<yourname>outlook.onmicrosoft.com`; any name works. Note what it is called.
   - **If Azure says you're not eligible** for a free account (you had one before, or you already have a subscription), it will offer **pay-as-you-go**. Pay-as-you-go has *no* spending limit. It still costs $0 as long as you create no resources, because app registrations aren't billed. But a mistake later could cost money. If you accept it, create nothing in Azure except what this guide says. If you already have a subscription, its directory works and you don't need a new one.
5. To stay at $0:
   - Don't create any Azure resources.
   - Leave the spending limit on.
   - Decline every "upgrade to pay-as-you-go" prompt.
   - After 30 days the subscription is disabled. This is expected; the directory and the app registration remain [C-AZ-2], [C-AZ-4].

### Step 2: Register the application
1. Open the Microsoft Entra admin center at https://entra.microsoft.com and sign in with the same account.
2. If the top-right corner shows more than one directory, switch to the directory from step 1 (gear icon → *Directories + subscriptions*).
   - You may see a banner saying ADAL and Azure AD Graph "no longer receive new feature updates". It is shown to every tenant and is about legacy libraries and APIs that MDVaultSync doesn't use. MDVaultSync calls the Microsoft identity platform v2.0 endpoints and Microsoft Graph (`graph.microsoft.com`) directly. App registration is still the current method, so continue. ([Azure AD Graph retirement](https://learn.microsoft.com/graph/migrate-azure-ad-graph-overview))
3. Go to **Entra ID → App registrations** (older layouts: *Identity → Applications → App registrations*) and choose **New registration**.
4. Fill in the form:
   - **Name:** `MDVaultSync`. This name becomes the OneDrive folder `Apps/MDVaultSync`. Renaming the app later does *not* rename the folder [G-AF-1].
   - **Supported account types:** **Personal accounts only** (older portal label: "Personal Microsoft accounts only"). Not "Any Entra ID Tenant + Personal Microsoft accounts", which would also admit work and school accounts [I-REG-4].
   - **Redirect URI:** platform **Public client/native (mobile & desktop)**, value `obsidian://mdvaultsync-auth`. Type it exactly, all lowercase, with no trailing slash and no `?` [I-RU-2].
5. Choose **Register**.
6. On the **Overview** page, copy the **Application (client) ID** and keep it for step 5.

### Step 3: Check the authentication settings
1. Open **Authentication** (it may be labelled *Authentication (Preview)*).
2. Under **Mobile and desktop applications**, `obsidian://mdvaultsync-auth` must be the **only** redirect URI. The portal offers suggested URIs as checkboxes; leave them all **unticked**, including `https://login.microsoftonline.com/common/oauth2/nativeclient`. Early test versions of MDVaultSync had a paste fallback that used it; it was removed on 2026-10-12, so if you ticked it earlier, untick it and save [I-RU-4]. `https://login.live.com/oauth20_desktop.srf` (LiveSDK) belongs to Microsoft's older Live SDK, and `msal<client-id>://auth` is the MSAL library's default scheme. MDVaultSync uses neither, and every extra redirect URI is one more place Microsoft will deliver an authorization code.
3. Confirm **Allow public client flows** is **No**. MDVaultSync doesn't use device code sign-in [I-DC-1].
4. Under **Settings**, set **Enable Live SDK support** to **No**. It provides compatibility with Microsoft's legacy Live Connect SDK (`login.live.com`), which MDVaultSync doesn't use. *Unverified:* Microsoft Learn doesn't document this toggle [I-REG-7]. If the first sign-in fails with an account-type or consent error, set it back to Yes and retry before troubleshooting further.
5. Make sure no **Web** or **Single-page application** platform is configured. Either one would break sign-in [I-AC-5], [I-AC-6].
6. Under **App instance property lock**, choose **Configure**. Turn on **Enable property lock**, tick **All properties**, and save. New apps have the lock enabled by default since June 2026, so confirm **All properties** is ticked. MDVaultSync uses no signing or verification credentials and no token encryption key, so locking them costs nothing and blocks anyone from adding credentials to the app later [I-REG-8].
7. Choose **Save**.

### Step 4: Set API permissions
1. Open **API permissions**.
2. Remove **User.Read** if it's listed (⋯ → *Remove permission*). MDVaultSync doesn't need it, and least privilege applies.
3. Choose **Add a permission → Microsoft Graph → Delegated permissions**. Pick **Microsoft Graph**, not the legacy *Azure Active Directory Graph*, which was retired Aug 31 2025. Then select:
   - `Files.ReadWrite.AppFolder` ("Have full access to the application's folder (preview)") [I-REG-5]
   - `offline_access` (under *OpenId permissions*), which allows refresh tokens.
4. Choose **Add permissions**. Don't use "Grant admin consent". It isn't needed for personal accounts: you consent yourself at first sign-in.

Check the manifest (optional). Under **Manifest**, `signInAudience` should be `PersonalMicrosoftAccount` and `api.requestedAccessTokenVersion` should be `2`. The portal sets both when you pick "Personal accounts only" [I-REG-4].

### Step 5: Connect MDVaultSync
Do this on each device, with the same client ID.

1. In Obsidian, open **Settings → MDVaultSync**. Paste the client ID into **Application (client) ID**.
2. Choose **Sign in**.
   - Your default browser opens Microsoft's sign-in page. On desktop, if it opens inside Obsidian instead (the **Web viewer** core plugin can open external links), turn off Web viewer's option to open external links and sign in again: sign in only in your real browser, where you can see the address.
   - The consent screen says the app is **unverified**. That's expected for an app you registered yourself [I-REG-6].
   - The consent screen should show "Have full access to the application's folder". If it asks for anything more, stop and check step 4.
3. After you approve, the browser asks to open Obsidian. Allow it. Settings should show you as signed in, and the first sync starts with a preview (see [First sync](#first-sync)).
4. If the browser never offers to open Obsidian, the device has no handler for `obsidian://` links. MDVaultSync has no other sign-in method. On Ubuntu, check `xdg-mime query default x-scheme-handler/obsidian`; the Flatpak and .deb installs register one.

### Final check
On the app registration, confirm each of these:
| Where | Expected |
|---|---|
| Overview → Supported account types | Personal Microsoft accounts only (the Overview page may word it differently; the manifest `signInAudience` = `PersonalMicrosoftAccount` is the authoritative check) |
| Authentication → platforms | Only **Mobile and desktop applications**; no Web, no Single-page application |
| Mobile and desktop redirect URIs | Only `obsidian://mdvaultsync-auth` |
| Authentication → Allow public client flows | No |
| Authentication → Enable Live SDK support | No |
| Authentication → App instance property lock | Enabled, All properties |
| API permissions | Microsoft Graph, Delegated: `Files.ReadWrite.AppFolder`, `offline_access`, and nothing else |
| Manifest | `"signInAudience": "PersonalMicrosoftAccount"`, `"requestedAccessTokenVersion": 2` |
| Certificates & secrets | Empty: no client secrets, no certificates |
| Copied | The Application (client) ID |

### Removing access
To disconnect every device at once, remove MDVaultSync at https://account.microsoft.com/privacy/app-access [C-MSA-1]. Changing your Microsoft account password also revokes its tokens [I-TL-4]. To delete the registration itself: Entra admin center → App registrations → MDVaultSync → **Delete**. Your OneDrive files in `Apps/MDVaultSync` are not deleted.

### Troubleshooting
| Symptom | Likely cause |
|---|---|
| `AADSTS50011` redirect URI mismatch | The redirect URI in step 2 or 3 has a typo, uppercase letters, a trailing slash, or the wrong platform |
| `AADSTS7000218` client secret required | A **Web** platform was added; remove it (step 3) |
| `AADSTS9002326` or `9002327` cross-origin errors | A **Single-page application** platform was added; remove it |
| `AADSTS700016` application not found | Wrong client ID, or the app is in a different directory |
| `unauthorized_client` / account type error | Supported account types isn't "Personal accounts only" |

## First sync
The first sync on a device, and the first one after you sign in again, is a **merge**: it adds what's missing on each side and deletes nothing. Before it runs, a preview lists every planned upload, download, move, conflict and skip, and waits for **Run**. **Cancel**, closing the preview, or leaving it for 10 minutes runs nothing.

A device that has never synced a file can't tell which side changed it. So a file that exists on both sides with different content gets one conflict copy (see [Conflicts](#conflicts)). The preview lists these in their own group, **Differs on both sides, no sync history**, so they're no surprise. To avoid them, join a new device with an empty vault, or one whose files match OneDrive.

The same merge happens if the OneDrive app folder is deleted or recreated.

## Settings reference
**Settings → MDVaultSync**. Values that aren't valid aren't saved, and the setting says why.

### Account
- **Status**: signed out, signed in, or "Sign-in required" when access expired or was removed.
- **Application (client) ID**: the ID from [Microsoft Entra setup](#microsoft-entra-setup). It has no default. It can't be changed while signed in.
- **OneDrive storage** (signed in only): used, total and free space in your OneDrive. It warns when 10 % or less is free, and when the drive is full. Files in the OneDrive recycle bin count toward it, including the ones MDVaultSync deleted.
- **Sign in**: opens Microsoft's sign-in page in your browser, then returns to Obsidian.
- **Sign out**: removes the stored sign-in and the sync state from this device. Your local files are untouched, and the OneDrive copy stays. See [Sign out and uninstall](#sign-out-and-uninstall).
- **Token storage**: where the sign-in token is kept. Normally Obsidian's secret storage; encryption then depends on your device's keyring. If secret storage fails on a device, the token is kept unencrypted in the plugin's data file (`data.json` in the plugin folder), and this row shows a standing warning. That file never syncs through MDVaultSync, but it does through any other tool that syncs the vault folder or backs up the device.

### Sync
- **Device name**: used in conflict copy names. Leave it empty for the default: "iPad" on iOS (any iPhone or iPad), "Ubuntu" on Linux, "Mac", "Windows" or "Android", and "Device" on anything else. If you sync two devices of the same kind, give each its own name so you can tell their conflict copies apart.
- **Sync interval**: minutes between automatic syncs, 1 to 1440 (default 5). 0 turns automatic sync off; a sync still runs about 5 seconds after Obsidian starts.
- **Maximum file size**: in megabytes, 1 to 1024 (default 100). Here and below, 1 MB means 1024 × 1024 bytes. Larger files are skipped and listed in the sync report as `too-large`.
- **Exclude patterns**: one pattern per line, like a `.gitignore` file. `*` matches any characters except `/`, `?` one character, and `**` as a whole segment any number of folders. A pattern without a `/` matches a name at any depth; one with a `/` is anchored to the vault root. A trailing `/` matches folders only, and excluding a folder excludes everything in it. `#` starts a comment. `!` lines and backslash escapes aren't supported; such patterns never match. Matching is case-sensitive. At most 200 lines. If the saved patterns can't be read, sync pauses until you check them and select **Save and resume sync**, rather than syncing with no exclusions.
- **Preview changes before every sync**: shows every planned change and waits for **Run**. The first sync on a device always shows it.
- **Confirm large deletes**: if a sync would delete more than this share of the synced files (1 to 100 %, default 25), it asks first and lists the deletes. **Skip deletes this time** (or leaving the prompt for 10 minutes) syncs everything else and doesn't ask about those deletes again until a file changes or you run **Sync now**.

### Last sync report
- **Last sync**: the last report: the result, what changed, conflict copies, skipped files with the reason, and problems. The **Sync now** button runs a sync.

### Diagnostics
- **OneDrive capability probe**: checks what OneDrive supports for this account, using a hidden test folder in the app folder.
- **Log**: **Copy log** copies the recent log for a bug report. It holds operation names, counts, durations and status codes, never file names, contents or tokens.
- **Verbose logging**: also writes each log line to the developer console, for troubleshooting. Same content as the log, codes only. In the desktop developer console (Ctrl+Shift+I), tick the **Verbose** level to see the lines. Leave it off otherwise.

## Commands
None has a default hotkey; you can assign one in **Settings → Hotkeys**.

- **Sync now**: syncs at once. The ribbon button does the same. It also re-proposes deletes you skipped earlier.
- **Preview sync**: shows what a sync would do, and runs it only if you select **Run**.
- **Show sync status**: the current state, the time of the last sync and the last report. On desktop, clicking the status bar opens it too.
- **Sign in to OneDrive** and **Sign out of OneDrive**: the same as the settings buttons.
- **Run OneDrive capability probe**: the diagnostics probe.
- **Test file replace on this device**: a diagnostic that checks how this device replaces one file with another. It uses two small test files in the plugin's own folder and removes them afterwards.

**Sync state at a glance.** On desktop, the status bar shows the state and the time of the last sync. On every device, the ribbon button's icon shows the state: arrows when synced, a loader while syncing, an hourglass when the sync waits for you, a warning after an error, and a sign-in arrow when you need to sign in. A successful sync with no conflicts is silent; errors and conflicts raise a notice.

## How sync works
Syncs run about 5 seconds after Obsidian starts, on the interval, and on **Sync now**. Only one runs at a time; a trigger during a sync queues at most one more. Each sync applies OneDrive's changes on this device first, then uploads this device's changes. Unchanged files are never transferred, except that a file OneDrive lists without a fingerprint may be downloaded once to compare it byte for byte.

### Conflicts
A conflict is a file changed on both sides, with different content. Nothing is lost:

- The OneDrive version keeps the original name on every device.
- This device's version is saved next to it as `<name> (conflict <device name> <YYYY-MM-DD HHmmss>).<extension>`, for example `Note (conflict iPad 2026-10-12 140203).md`, and uploaded so every device has it. If that name is taken, ` 2`, ` 3`… is added after the `)`.
- One notice lists every conflict copy and stays until you dismiss it. The sync report lists them too.
- Files that are identical on both sides are never turned into conflicts, even when OneDrive lists no fingerprint for them: they're compared byte for byte first.
- A note you edit while a sync is running is never overwritten or deleted by that sync. Your edit becomes a conflict copy, or waits for the next sync.

Merging the two versions is up to you; delete the conflict copy when you're done.

### Deletes and renames
- Deletes go both ways. A file deleted on OneDrive goes to this device's trash, as Obsidian's **Deleted files** setting says; it can be restored unless that setting is *Permanently delete*. A file deleted here goes to the OneDrive recycle bin, which keeps it for a limited time (Microsoft empties it after a while) and counts toward your storage.
- An edit wins over a delete: if one side deleted a file and the other edited it, the edited file comes back.
- Renames and moves are applied as renames on the other side, including whole folders, so OneDrive's version history is kept.
- A OneDrive folder is deleted only when it is truly empty, including files this device skips.

### Skipped files
Skipped files are listed in the sync report with the reason. They are never renamed, and skipping a file never deletes it on the other side.

- Names OneDrive refuses are skipped: a name over 255 characters or with `:`, `*`, `?`, `"`, `<`, `>`, `|` or `\`, a leading or trailing space, a leading `~`, or a folder name ending in `.` (`invalid-name`); reserved names such as `CON`, `desktop.ini` or anything containing `_vti_` (`reserved-name`); and paths over 400 characters, counting the OneDrive app folder (`path-too-long`).
- Two files whose names differ only in letter case (`Note.md` and `note.md`, possible on Linux) can't both exist in OneDrive. If one of them is already synced, it keeps syncing and the other is skipped. If neither is synced yet, both are skipped (`case-collision`).
- Two names that look identical but use different Unicode forms are both skipped (`unicode-collision`).
- Files larger than **Maximum file size** (`too-large`).

### Slow or lost connections
- A request that OneDrive doesn't answer gives up after 2 minutes, plus more time for large transfers (about 5 minutes for a 10 MB piece of an upload). The sync then ends `partial`, and the next one carries on where it stopped. The final piece of a large upload is the exception: it always waits for OneDrive's answer, so a late answer can never overwrite a newer edit.
- While 2 or more requests are still hanging after giving up, automatic syncs (startup and interval) pause, and a notice says so once. **Sync now** still runs. The pause ends once OneDrive answers the hanging requests, or when you restart Obsidian.
- When OneDrive asks the plugin to slow down, it waits as long as OneDrive asks, and retries other temporary errors with increasing pauses.
- Files over 10 MB upload in pieces. An interrupted upload continues where it stopped, after a restart too.
- Progress is saved as the sync goes, so a sync cut off by iPadOS, a lost connection or a crash resumes without losing work.
- If OneDrive is full, the sync stops with a notice to free up space; remember that the recycle bin counts.

### How transfers are protected
- Every request uses HTTPS through Obsidian's network API.
- Your sign-in token is sent only to `graph.microsoft.com` (and to Microsoft's sign-in service when it is refreshed), never to the upload and download hosts.
- Upload and download addresses must be HTTPS and on a short list of Microsoft OneDrive hosts. If one of those hosts redirects a transfer, Obsidian follows the redirect without the plugin seeing it; no token goes along, and downloads are still checked.
- Every download is checked against its size and, when OneDrive provides one, its fingerprint (QuickXorHash), written to a hidden temporary file, and only then moved into place. Every upload's result is checked the same way. OneDrive lists no fingerprint for some files, such as empty ones; those are checked by size only.
- Nothing from OneDrive is ever written outside the vault, into Obsidian's config folder, or into a hidden folder: each path is checked again right before the write.

## What never syncs
- The Obsidian config folder (usually `.obsidian`): settings, plugins, themes, and this plugin's own data. Each device keeps its own.
- Every file or folder whose name starts with `.`, and everything inside such a folder.
- Files and folders matching your **Exclude patterns**.
- Files larger than **Maximum file size** (100 MB by default).

Files in OneDrive that would land in one of these places on this device aren't downloaded; they're listed in the sync report.

## Security and residual risks
MDVaultSync asks for the smallest permission OneDrive offers, `Files.ReadWrite.AppFolder`: it reaches only its own app folder. Its access token lives in memory only. Its refresh token is stored in Obsidian's secret storage, or, if that fails on a device, unencrypted in the plugin's data file, with a standing warning in settings. The plugin never opens, renders or runs the contents of your files; it only moves bytes. Rendering a note is Obsidian's job, with the same risk as any file you add to a vault.

The risks that remain, stated plainly:
1. Any other Obsidian plugin you install can read MDVaultSync's refresh token and your vault. This is true of every Obsidian plugin. The token reaches only the MDVaultSync folder in your OneDrive.
2. On Linux without a working keyring, and possibly on iOS, the token may be stored unencrypted on disk. Use full-disk encryption or a device passcode.
3. Files are stored unencrypted in your OneDrive in v1.
4. QuickXorHash detects corruption, not deliberate tampering by someone who controls your OneDrive account.
5. To cut off a lost device, remove the app at https://account.microsoft.com/privacy/app-access or change your Microsoft account password.

What that means for you:
- **Install only plugins you trust.** Obsidian plugins all run in the same app, and no plugin can hide its data from another.
- Your files are unencrypted in your OneDrive: Microsoft, and anyone who can sign in to your Microsoft account, can read them. Protect the account with a strong password and two-step verification.
- If a device is lost or you suspect the token leaked, remove the app at https://account.microsoft.com/privacy/app-access. That signs out every device; sign in again on the ones you keep.

To report a vulnerability privately, see [SECURITY.md](SECURITY.md).

## Verify a release
Every release file is built by this repository's [release workflow](.github/workflows/release.yml) from the tagged commit, and signed with a GitHub artifact attestation. To check that the `main.js` you have came from that build, install the [GitHub CLI](https://cli.github.com) and run:

```bash
gh release download 1.0.0 -R caseke/MDVaultSync -p main.js   # or use the main.js in your vault's plugin folder
gh attestation verify main.js -R caseke/MDVaultSync
```

For a stricter check, require that the release workflow signed it:

```bash
gh attestation verify main.js -R caseke/MDVaultSync --signer-workflow caseke/MDVaultSync/.github/workflows/release.yml
```

The same works for `manifest.json` and `styles.css`. Verify the files from `gh release download`: the installed copy is in `<vault>/<config folder>/plugins/mdvaultsync/`, and its `main.js` should match, but BRAT may not store `manifest.json` byte for byte.

**Updating safely.** A release is only as trustworthy as the account that publishes it. If you'd rather check each version before it runs, turn off BRAT's automatic update check at startup, update by hand with **BRAT: Check for updates to all beta plugins**, and verify the new release first.

## Sign out and uninstall
- **Sign out** (settings or the command) removes the stored sign-in and the sync state from this device. Your notes stay, and so does the copy in OneDrive. Signing in again starts with a first-sync merge (see [First sync](#first-sync)).
- Signing out on one device doesn't affect the others. To remove the app's access for every device, remove MDVaultSync at https://account.microsoft.com/privacy/app-access.
- **To uninstall:** sign out first, then disable and uninstall the plugin in **Settings → Community plugins** (and remove it from BRAT's list). Obsidian gives plugins no uninstall step, and uninstalling doesn't clear Obsidian's secret storage, so a sign-in left there is removed the next time MDVaultSync is installed, with a notice. Signing out first removes it at once. If you uninstalled without signing out, remove the app's access at https://account.microsoft.com/privacy/app-access as well: until the next install, the sign-in stays in secret storage, where other plugins can read it, and stays valid at Microsoft.
- Your files in OneDrive (`Apps/<your app name>`) are not deleted. Delete that folder in OneDrive if you no longer want them; to delete the app registration too, see [Removing access](#removing-access).

## Troubleshooting
- **Sync stopped with a notice.** Open **Show sync status**: the last report says what failed. A sync that ends `partial` carries on next time.
- **"Sign-in required".** Your sign-in expired (about 90 days without use) or its access was removed. Select **Sign in** again.
- **A bug.** Turn on **Verbose logging** if asked, reproduce it, then use **Copy log** and attach the log to an issue at https://github.com/caseke/MDVaultSync/issues. The log never contains file names, contents or tokens.

## License
[MIT](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
