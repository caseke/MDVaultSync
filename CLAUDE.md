# MDVaultSync

Obsidian plugin that syncs one vault to a personal OneDrive App Folder over Microsoft Graph, on iPad and Ubuntu.

## Read first
- `SPEC.md`: requirements (R-*) and decisions (D-*). Don't contradict it; change it explicitly if you must.
- `docs/design.md`: architecture, interfaces (`src/core/ports.ts`), and the sync algorithm.
- `docs/plan.md`: milestones. Do the first one that isn't `done`. Follow its session protocol.
- `docs/research.md`: facts with source URLs. Cite IDs like `[G-UP-3]` in code comments where behavior depends on them.
- `docs/threat-model.md`: run the `security-reviewer` agent before you close a milestone.

## Commands (Node ≥ 22.18; `.nvmrc` says 24)
```bash
npm ci                         # install from the lockfile; never `npm install` without a reason
npm run lint                   # eslint (eslint-plugin-obsidianmd recommended + project rules)
npm run typecheck              # tsc --noEmit
npm test                       # node --test "test/**/*.test.ts" (native type stripping)
npm run build                  # typecheck + esbuild production → main.js
npm audit --audit-level=high
```
A milestone is done only when lint, typecheck, test, and build all pass. Paste their output into docs/plan.md.

## Layout and boundaries
- `src/core/`: pure sync engine (planner, executor, paths, hash, transform, logger). It **must not import `obsidian`**.
- `src/remote/`: auth and Graph clients over the `HttpTransport` interface. It **must not import `obsidian`**.
- `src/platform/`: the only code that touches Obsidian APIs (`requestUrl`, Vault, SecretStorage).
- `src/ui/`: settings tab, modals, notices. `test/fakes/`: FakeVault, FakeRemote, FakeHttp, FakeClock.

## Conventions
- **Erasable TypeScript only.** No enums, namespaces, parameter properties or decorators. Relative imports end in `.ts`. Use `import type` for types.
- **Runtime dependencies.** Zero. A new dev dependency needs a row in SPEC §8 and owner approval.
- **HTTP.** Only through `HttpTransport` → `requestUrl`. Never `fetch`, XHR, or Node `http`. `Authorization` goes to `graph.microsoft.com` only.
- **Remote data is untrusted.** Validate it in `src/remote/validate.ts` before use. Check path containment again right before every local write.
- **Logging.** Use `logger.event(op, {count, durationMs, status, code})` only. Never log paths, names, contents, or tokens. Use `console.error` for errors only.
- **Vault access.**
  - Use the Vault API. Use the adapter only for hidden temp files and `sync-state.json`.
  - Delete with `FileManager.trashFile`. Rename from remote with `Vault.rename`.
  - Use `normalizePath` and `app.vault.configDir`. Never hardcode `.obsidian`.
- **UI.** Use `createEl`/`createDiv`. Never `innerHTML`. Settings headings use `setHeading()` and sentence case. No default hotkeys. Command IDs exclude the plugin ID.
- **Graph.**
  - Every update, move, or delete of an existing item sends `If-Match`. New files use `conflictBehavior=fail`.
  - Only QuickXorHash.
  - Upload fragments are 10 MiB (a multiple of 320 KiB). Never send auth to upload or download URLs.
- **Data safety beats convenience.** Edits win over deletes. Union mode never deletes. Never auto-rename user files.
- **Releases.** Tag equals the `manifest.json` version, no `v` prefix. Release files are built only by `.github/workflows/release.yml`.
- **Commits.** Keep commits per milestone small and descriptive. Never commit `main.js`, `data.json`, or secrets.
