# MDVaultSync

Sync one Obsidian vault across your devices through a private app folder in your personal OneDrive.

Each device uploads its changes to your OneDrive and downloads the others'. The plugin can see only its own folder there (`Apps/<your app name>`), never the rest of your OneDrive.

Tested on iOS (iPad) and Linux (Ubuntu). Windows, macOS and Android should work but aren't tested. Requires Obsidian 1.11.4 or later.

It doesn't sync Obsidian's settings, plugins or themes, support work or school accounts, encrypt files in OneDrive, merge conflicting edits, or sync while Obsidian is closed. See [SPEC.md](SPEC.md) for the full specification.

## Disclosures
Required by the [Obsidian developer policies](https://docs.obsidian.md/Developer+policies).

- **Network use.** The plugin contacts only Microsoft:
  - `login.microsoftonline.com`, to sign you in and keep you signed in;
  - `graph.microsoft.com` and the OneDrive upload and download hosts it hands out, to read and write your synced files.

  All requests go through Obsidian's network API.
- **Account required.** A personal Microsoft account with OneDrive (not work or school), plus your own free Microsoft Entra app registration for a client ID. See [Microsoft Entra setup](#microsoft-entra-setup).
- **Files outside the vault.** The plugin writes only:
  - synced files inside your vault, never in the Obsidian config folder or hidden folders. A download is first written to a hidden temporary file beside its target, then moved into place;
  - its own settings and sync state, in its plugin folder inside the config folder, on this device;
  - in its own App Folder in your OneDrive. The permission it asks for, `Files.ReadWrite.AppFolder`, can't see anything else in your OneDrive.
- **No telemetry.** No analytics, usage data or crash reports. The log stays on your device and never contains file names, contents or tokens.

## Install
MDVaultSync isn't in the community plugin directory yet. Install it with **BRAT**:

1. **Settings → Community plugins**: install and enable **BRAT**.
2. Run the command **BRAT: Add a beta plugin for testing** and enter `caseke/MDVaultSync`.
3. Enable **MDVaultSync** in **Settings → Community plugins**.
4. Do [Microsoft Entra setup](#microsoft-entra-setup) once, then [connect each device](#step-5-connect-each-device).

To update, run **BRAT: Check for updates to all beta plugins** on each device. Keep every device on the same version, and don't go back to a 0.x test build: those could save your sign-in unencrypted.

**Use only one sync service per vault.** Don't use MDVaultSync on a vault that iCloud Drive, Obsidian Sync, Dropbox, Syncthing or another tool also syncs. On iOS, create the vault with *Store in iCloud* off. A second service fights over the same files and copies MDVaultSync's sync state between devices, where it could make a sync act on another device's history.

**Try it on a test vault first,** or back up your vault. The first sync on a device never deletes anything and shows its plan before it runs (see [First sync](#first-sync)).

## Microsoft Entra setup
MDVaultSync signs in through an app registration you own. Setting one up takes about 15 minutes and costs $0, but step 1 needs a credit or debit card for identity verification ([docs/cost-estimate.md](docs/cost-estimate.md)). You do steps 1–4 once and step 5 on each device. Sources for each step are in [docs/research.md](docs/research.md).

Microsoft requires every app registration to live in a directory (tenant), and a personal account doesn't come with one; an Azure free account creates it. **If you already have a tenant you control** (not your employer's), skip step 1 and select that directory in step 2.

### Step 1: Create a tenant with an Azure free account
1. Open https://azure.microsoft.com/free, choose **Start free**, and sign in with the **personal Microsoft account whose OneDrive will hold the vault**.
2. Complete phone verification (a real mobile number) and card verification (credit or debit, not prepaid; a temporary hold of about $1 is released).
3. Accept the agreement. Azure creates a directory, usually called **Default Directory**.
4. To stay at $0: create no Azure resources, leave the spending limit on, and decline every upgrade prompt. After 30 days the subscription is disabled; the directory and the app registration remain.

If Azure says you're not eligible and offers **pay-as-you-go**, that plan has no spending limit. It still costs $0 if you create nothing beyond this guide, because app registrations aren't billed.

### Step 2: Register the application
1. Open https://entra.microsoft.com and sign in with the same account. If you have more than one directory, switch to the one from step 1 (gear icon → **Directories + subscriptions**).
2. Go to **Entra ID → App registrations → New registration** and fill in:
   - **Name:** `MDVaultSync`. This becomes the OneDrive folder `Apps/MDVaultSync`; renaming the app later doesn't rename the folder.
   - **Supported account types:** **Personal accounts only**.
   - **Redirect URI:** platform **Public client/native (mobile & desktop)**, value `obsidian://mdvaultsync-auth`, exactly as written: lowercase, no trailing slash.
3. Choose **Register**, and copy the **Application (client) ID** from the **Overview** page.

### Step 3: Authentication settings
Open **Authentication**:
1. Under **Mobile and desktop applications**, `obsidian://mdvaultsync-auth` must be the only redirect URI. Leave every suggested URI unticked.
2. **Allow public client flows:** **No**.
3. **Enable Live SDK support:** **No**.
4. No **Web** or **Single-page application** platform; either one breaks sign-in.
5. **App instance property lock → Configure:** turn on **Enable property lock**, tick **All properties**. This stops anyone from adding credentials to the app later.
6. Choose **Save**.

### Step 4: API permissions
Open **API permissions**:
1. Remove **User.Read** if it's listed.
2. **Add a permission → Microsoft Graph → Delegated permissions**, and select `Files.ReadWrite.AppFolder` and `offline_access`.
3. Choose **Add permissions**. Don't grant admin consent; you consent yourself at first sign-in.

### Step 5: Connect each device
1. In Obsidian, open **Settings → MDVaultSync** and paste the client ID into **Application (client) ID**.
2. Choose **Sign in**. Your browser opens Microsoft's sign-in page. The consent screen calls the app **unverified**, which is expected for an app you registered, and should ask only for "Have full access to the application's folder".
3. Approve, and let the browser open Obsidian. Settings shows you signed in, and the first sync starts with a preview.

### Final check
| Where | Expected |
|---|---|
| Manifest | `"signInAudience": "PersonalMicrosoftAccount"`, `"requestedAccessTokenVersion": 2` |
| Authentication → platforms | Only **Mobile and desktop applications** |
| Redirect URIs | Only `obsidian://mdvaultsync-auth` |
| Allow public client flows | No |
| Enable Live SDK support | No |
| App instance property lock | Enabled, all properties |
| API permissions | Microsoft Graph, delegated: `Files.ReadWrite.AppFolder`, `offline_access`, nothing else |
| Certificates & secrets | Empty |

## First sync
The first sync on a device, and the first after signing in again, is a **merge**: it adds what's missing on each side and deletes nothing. A preview lists every planned change and waits for **Run**. **Cancel**, closing it, or leaving it for 10 minutes runs nothing.

A device with no sync history can't tell which side changed a file. A file that exists on both sides with different content therefore gets a conflict copy. The preview lists these as **Differs on both sides, no sync history**. To avoid them, join a new device with an empty vault.

The same merge runs if the OneDrive app folder is deleted or recreated.

## Settings reference
Values that aren't valid aren't saved, and the setting says why.

### Account
- **Status**: signed out, signed in, or sign-in required.
- **Application (client) ID**: from [Microsoft Entra setup](#microsoft-entra-setup). Locked while signed in.
- **OneDrive storage**: used, total and free space (signed in only). Warns when 10 % or less is free. The OneDrive recycle bin counts toward it.
- **Sign in** and **Sign out**: see [Sign out and uninstall](#sign-out-and-uninstall).
- **Token storage**: your sign-in is kept in Obsidian's secret storage. If secret storage doesn't work on a device, the sign-in is kept in memory only, never on disk, and you sign in again each time Obsidian starts; this row then shows a warning.

### Sync
- **Device name**: used in conflict copy names. Empty means the platform: "iOS", "Linux", "Mac", "Windows", "Android", or "Device". Give two devices of the same kind different names.
- **Sync interval**: minutes between automatic syncs, 1 to 1440 (default 5). 0 turns it off; a sync still runs at startup.
- **Maximum file size**: in MB (1024 × 1024 bytes), 1 to 1024 (default 100). Larger files are skipped.
- **Exclude patterns**: one per line, `.gitignore` style. `*` matches within a name, `?` one character, `**` any number of folders. A pattern without `/` matches at any depth; with `/` it starts at the vault root. A trailing `/` matches folders only. `#` starts a comment. `!` and backslash escapes aren't supported. Case-sensitive. At most 200 lines. If the saved patterns can't be read, sync pauses until you fix them and select **Save and resume sync**.
- **Preview changes before every sync**: show the plan and wait for **Run** every time.
- **Confirm large deletes**: if a sync would delete more than this share of synced files (1 to 100 %, default 25), it asks first. **Skip deletes this time** syncs everything else and doesn't ask about those deletes again until a file changes or you run **Sync now**.

### Last sync report
- **Last sync**: the result, changes, conflict copies, skipped files with the reason, and errors, with a **Sync now** button.

### Diagnostics
- **Log**: **Show log** opens the recent log, with a **Copy** button for bug reports. Operation names, counts, durations and status codes only. It is kept in memory and cleared when Obsidian restarts.
- **Verbose logging**: also writes each log line to the developer console. Leave it off unless you're troubleshooting.

## Commands
No default hotkeys; assign them in **Settings → Hotkeys**.

- **Sync now**: sync at once, the same as the ribbon button. Also re-offers deletes you skipped.
- **Preview sync**: show the plan; run it only if you select **Run**.
- **Show sync status**: the current state, the last sync time and the last report. On desktop, clicking the status bar does the same.
- **Sign in to OneDrive** and **Sign out of OneDrive**.

The ribbon icon shows the state on every device: arrows (synced), a loader (syncing), an hourglass (waiting for you), a warning (error) or a sign-in arrow (sign-in needed). Successful syncs are silent; errors and conflicts raise a notice.

## How sync works
Syncs run at startup, on the interval and on **Sync now**, one at a time. Each sync applies OneDrive's changes first, then uploads this device's. Unchanged files aren't transferred, except that a file OneDrive lists without a fingerprint may be downloaded once to compare it.

### Conflicts
When a file changed on both sides with different content:
- The OneDrive version keeps the name.
- This device's version is saved beside it as `<name> (conflict <device name> <YYYY-MM-DD HHmmss>).<extension>`, for example `Note (conflict iOS 2026-10-12 140203).md`, and uploaded. If that name is taken, ` 2`, ` 3`… is added after the `)`.
- One notice lists every conflict copy until you dismiss it.
- Files that are identical on both sides never become conflicts; they're compared byte for byte.
- A note you edit during a sync is never overwritten by that sync.

Merge the two versions yourself, then delete the copy.

### Deletes and renames
- Deletes go both ways: to this device's trash (per Obsidian's **Deleted files** setting) and to the OneDrive recycle bin, which keeps files for a limited time.
- An edit wins over a delete.
- Renames and moves, including folders, are applied as renames, keeping OneDrive's version history.
- A OneDrive folder is deleted only when it's empty.

### Skipped files
Skipped files are listed in the sync report with a reason. They're never renamed, and a skip never deletes the other side's copy.
- Names OneDrive refuses: characters such as `:`, `*`, `?`, `"`, `<`, `>`, `|` or `\`, leading or trailing spaces, a leading `~`, names over 255 characters (`invalid-name`); reserved names such as `CON` or `desktop.ini` (`reserved-name`); paths over 400 characters (`path-too-long`).
- Names that differ only in letter case, such as `Note.md` and `note.md` on Linux: the synced one keeps syncing and the other is skipped. If neither is synced yet, both are skipped (`case-collision`).
- Names that look identical but use different Unicode forms: both are skipped (`unicode-collision`).
- Files over **Maximum file size** (`too-large`).

### Slow or lost connections
- A request with no answer gives up after 2 minutes, plus time for its size (about 5 minutes for a 10 MB piece of an upload). The sync ends `partial` and the next one carries on. The last piece of a large upload always waits, so a late answer can't overwrite a newer edit.
- While 2 or more requests are still hanging, automatic syncs pause, with one notice. **Sync now** still works. The pause ends when OneDrive answers or Obsidian restarts.
- Throttling from OneDrive is honored, and temporary errors are retried with increasing pauses.
- Interrupted uploads and syncs resume where they stopped, after a restart too.

### How transfers are protected
- HTTPS only, through Obsidian's network API.
- Your sign-in goes only to Microsoft's sign-in service and `graph.microsoft.com`, never to upload or download hosts.
- Upload and download addresses must be on a short list of Microsoft OneDrive hosts. A redirect from one of them is followed without the sign-in.
- Downloads are checked against their size and, when OneDrive lists one, their fingerprint (QuickXorHash), written to a hidden temporary file, then moved into place.
- Nothing from OneDrive is written outside the vault, into the config folder or into a hidden folder; each path is checked again right before the write.

## What never syncs
- The Obsidian config folder (usually `.obsidian`), including this plugin's data.
- Files and folders whose name starts with `.`.
- Anything matching **Exclude patterns**.
- Files over **Maximum file size** (100 MB by default).

OneDrive files that would land in one of these places aren't downloaded; they're listed in the sync report.

## Security and residual risks
MDVaultSync asks for the narrowest OneDrive permission, `Files.ReadWrite.AppFolder`. Its access token lives in memory only, and its sign-in is kept in Obsidian's secret storage, never in the plugin's own files. The plugin never opens, renders or runs the contents of your files; it only moves bytes.

The risks that remain:
1. Any other Obsidian plugin you install can read MDVaultSync's refresh token and your vault. This is true of every Obsidian plugin. The token reaches only the MDVaultSync folder in your OneDrive.
2. On Linux without a working keyring, and possibly on iOS, the token may be stored unencrypted on disk. Use full-disk encryption or a device passcode.
3. Files are stored unencrypted in your OneDrive in v1.
4. QuickXorHash detects corruption, not deliberate tampering by someone who controls your OneDrive account.
5. To cut off a lost device, remove the app at https://account.microsoft.com/privacy/app-access or change your Microsoft account password.

So:
- **Install only plugins you trust.**
- Your files are unencrypted in your OneDrive, readable by Microsoft and by anyone who can sign in to your account. Use a strong password and two-step verification.
- If a device is lost or you suspect a leak, remove the app at https://account.microsoft.com/privacy/app-access. That signs out every device.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Verify a release
Release files are built from the tagged commit by the [release workflow](.github/workflows/release.yml) and carry a GitHub artifact attestation. With the [GitHub CLI](https://cli.github.com):

```bash
gh release download 1.0.0 -R caseke/MDVaultSync -p main.js
gh attestation verify main.js -R caseke/MDVaultSync
# stricter: require that the release workflow signed it
gh attestation verify main.js -R caseke/MDVaultSync --signer-workflow caseke/MDVaultSync/.github/workflows/release.yml
```

The same works for `manifest.json` and `styles.css`. Verify the downloaded files: BRAT may not store `manifest.json` byte for byte.

To check each version before it runs, turn off BRAT's automatic updates at startup, update by hand, and verify first.

## Sign out and uninstall
- **Sign out** removes the sign-in and the sync state from this device. Your notes and the OneDrive copy stay. The next sign-in starts with a merge.
- Signing out affects only this device. To cut off every device, remove the app at https://account.microsoft.com/privacy/app-access.
- **To uninstall:** sign out, then uninstall the plugin in **Settings → Community plugins** and remove it from BRAT. Uninstalling doesn't clear Obsidian's secret storage: a sign-in left there is removed when MDVaultSync is next installed. If you uninstalled without signing out, remove the app at https://account.microsoft.com/privacy/app-access too.
- Your OneDrive files in `Apps/<your app name>` stay. To delete the app registration, open it in the Entra admin center and choose **Delete**.

## Troubleshooting
**Sign-in**
| Symptom | Fix |
|---|---|
| The browser never offers to open Obsidian | The device has no handler for `obsidian://` links, and there's no other sign-in method. On Linux, check `xdg-mime query default x-scheme-handler/obsidian`. |
| The sign-in page opens inside Obsidian | The **Web viewer** core plugin is opening links. Turn off its option to open external links, then sign in again, so you sign in in your real browser. |
| `AADSTS50011` redirect URI mismatch | The redirect URI has a typo, capitals, a trailing slash or the wrong platform (step 2). |
| `AADSTS7000218` client secret required | A **Web** platform was added; remove it (step 3). |
| `AADSTS9002326` or `9002327` cross-origin | A **Single-page application** platform was added; remove it (step 3). |
| `AADSTS700016` application not found | Wrong client ID, or the app is in another directory. |
| `unauthorized_client` or an account-type error | **Supported account types** isn't **Personal accounts only** (step 2). If it is, try **Enable Live SDK support: Yes** (step 3). If that doesn't fix it, set it back to **No**; if it does, please open an issue. |
| Consent asks for more than the app folder | Check the API permissions (step 4). |
| "Sign-in required" | The sign-in expired (about 90 days unused) or access was removed. Sign in again. |
| Asked to sign in at every start | Obsidian's secret storage isn't working on this device (see **Token storage**). On Linux, check that a keyring such as GNOME Keyring is running and unlocked. |

**Sync**
| Symptom | Fix |
|---|---|
| A sync stopped with a notice | **Show sync status** shows what failed. A `partial` sync carries on next time. |
| A file didn't sync | The sync report lists skipped files with the reason ([Skipped files](#skipped-files)). |
| Automatic syncs paused | Requests are hanging; see [Slow or lost connections](#slow-or-lost-connections). |
| OneDrive is full | Free up space, including the OneDrive recycle bin. |

**Reporting a bug.** Turn on **Verbose logging**, reproduce the problem, then **Show log → Copy** and attach it to an issue at https://github.com/caseke/MDVaultSync/issues. If **Copy** can't reach the clipboard, the log is selected so you can copy it yourself.

## License
[MIT](LICENSE).
