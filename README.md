# MDVaultSync

Sync one Obsidian vault across your devices through a private app folder in your personal OneDrive.

> **Status: early development.** The plugin doesn't sync anything yet. See [docs/plan.md](docs/plan.md) for progress. Don't use it on a vault you care about until version 1.0.0.

MDVaultSync is built for an iPad (Obsidian for iOS) and an Ubuntu desktop. Other platforms are expected to work but aren't tested. The full specification is in [SPEC.md](SPEC.md).

## Disclosures
These are required by the [Obsidian developer policies](https://docs.obsidian.md/Developer+policies).

- **Network use.** The plugin connects to two Microsoft services, and only these:
  - the **Microsoft identity platform** (`login.microsoftonline.com`), to sign you in and refresh your sign-in;
  - **Microsoft Graph** (`graph.microsoft.com`) and the OneDrive upload and download hosts it hands out, to read and write your synced files.

  All requests go through Obsidian's own network API. Nothing else is contacted.
- **Account required.** You need a personal Microsoft account with OneDrive. Work and school accounts aren't supported. You also register your own free Microsoft Entra app to get a client ID; the setup guide will be in this README by version 1.0.0 (draft: [docs/entra-setup.md](docs/entra-setup.md)).
- **Files outside the vault.** The plugin reads and writes only:
  - files inside your vault. It never syncs the Obsidian config folder or hidden files. It keeps its own settings and sync state in its plugin folder inside the config folder, on this device only;
  - its own App Folder in your OneDrive (`Apps/<your app name>`). The permission it asks for, `Files.ReadWrite.AppFolder`, can't see the rest of your OneDrive.

  This is how your devices share the vault.
- **No telemetry.** The plugin sends no analytics, usage data or crash reports. Its logs stay on your device and never contain file names, file contents or tokens.

## License
[MIT](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
