# MDVaultSync build plan

Nine milestones, each sized for one Claude Code session. Do them in order. Each one builds on the interfaces defined in [design.md](design.md) and satisfies requirements in [SPEC.md](../SPEC.md).

## Session protocol (every implementation session)
1. **Read.** Read `CLAUDE.md`, `SPEC.md`, `docs/design.md`, and this file. Find the first milestone whose status isn't `done`. Read the research facts it cites.
2. **Set up.** Run `npm ci`. Skip this for M1, before `package.json` exists.
3. **Work inside the milestone.** Build only what it lists. If the design has to change, update `docs/design.md` in the same session and say why in the commit message. Probe results go into `docs/research.md` (change the row's status and add the observed result and date).
4. **Verify.** Run the milestone's verification commands. Paste the trimmed output into the milestone's **Verification output** block: the final summary lines of each command, not the full logs.
5. **Review.** Run the `security-reviewer` subagent (`.claude/agents/security-reviewer.md`, created in M1) on the diff. Fix every finding rated high or medium. Record the result in the milestone.
6. **Close out.** Set **Status** to `done` with the date, commit, and push to the session's branch. Tick the requirement IDs in the traceability table at the bottom.

Standard verification commands, which exist from M1 on:
```bash
npm run lint        # eslint . (eslint-plugin-obsidianmd recommended + project rules)
npm run typecheck   # tsc --noEmit
npm test            # node --test "test/**/*.test.ts"   (Node ≥ 22.18, type stripping)
npm run build       # typecheck + esbuild production → main.js
npm audit --audit-level=high
```

A **manual check** means a step only the owner can do on a real device. The session writes the exact steps into the milestone, the owner performs them, and the owner records the result there. A milestone with manual checks is `done` only when they pass. Until then it is `awaiting-owner`, and the next milestone may start only if it doesn't depend on those results.

---

## M1: Scaffold, CI, hooks, security reviewer
**Status:** done (2026-10-12). Session work verified, owner actions done and verified with `gh api`. The optional desktop load check passed on 2026-10-12 (Obsidian 1.14.4); see **Manual check (optional)**.

**Goal.** An empty plugin that loads in Obsidian, with the full quality gate (lint, typecheck, test, build, audit) in local hooks and CI, before any real code exists.

**Files**
- **From the official sample plugin** [O-SMP-1] (fetch https://github.com/obsidianmd/obsidian-sample-plugin and adapt it; no sample code may remain [O-SUB-3]):
  - `package.json`: `"type": "module"`, `engines.node >=22.18`, scripts `dev`, `build`, `lint`, `typecheck`, `test`, `version`. `build` must be the production build, because the Community scanner runs it [O-SUB-5].
  - `package-lock.json` (committed).
  - `.nvmrc` = `24`.
  - `.npmrc` (from the sample).
  - `tsconfig.json`: everything from the sample [O-SMP-3], plus `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `moduleResolution: "bundler"`, `exactOptionalPropertyTypes`, `noImplicitOverride` and `noFallthroughCasesInSwitch`. Include `src/**/*.ts` and `test/**/*.ts`. Relative imports use the `.ts` extension, so Node can run tests directly [C-NODE-1].
  - `esbuild.config.mjs` (from the sample; entry `src/main.ts`; output `main.js`, CJS, ES2021).
  - `eslint.config.mjs`: `obsidianmd.configs.recommended` [O-ESL-1], plus project rules:
    - `no-restricted-imports` banning `obsidian` in `src/core/**` and `src/remote/**`, and Node built-ins (`http`, `https`, `net`, `child_process`, `fs`) everywhere;
    - `no-restricted-globals` for `fetch`, `XMLHttpRequest` and `WebSocket` (R-NET-1);
    - `no-restricted-syntax` banning `ImportExpression` (dynamic `import()`), and calls to `.download(`, `.uploadNew(`, `.uploadReplace(`, `.createUploadSession(` and `.putFragment(` inside `src/**` but outside `src/core/remote-content.ts` and `src/remote/**` (R-ENG-4; tests and fakes are exempt);
    - `no-eval`, `no-implied-eval` and `no-new-func` (T-E3). If the plugin's config needs `.mts`, keep the sample's `eslint.config.mts` and `jiti`.
  - `manifest.json`: id `mdvaultsync`, name `MDVaultSync`, `minAppVersion` `1.11.4`, `isDesktopOnly` false, a description of at most 250 characters that starts with a verb, and no `fundingUrl` [O-SUB-1], [O-SUB-3].
  - `versions.json`, `version-bump.mjs`, `styles.css` (empty placeholder class).
- **Plugin code:**
  - `src/main.ts`: an empty `Plugin` subclass with `onload` and `onunload`.
  - `src/core/ports.ts`: the interfaces from design §2, verbatim.
  - `test/smoke.test.ts`: imports `ports.ts` and asserts the test runner works.
- **Repo files:**
  - `LICENSE` (MIT, `Copyright (c) 2026 caseke`; the owner may replace `caseke` with their legal name) and `SECURITY.md` (report via GitHub private vulnerability reporting, 7-day acknowledgement target, supported version = latest release, no public issues for vulnerabilities) (R-SEC-6).
  - `README.md` skeleton with the required disclosures: network use (Microsoft identity platform and Microsoft Graph/OneDrive, and why), account required, no access outside the vault except the OneDrive App Folder, no telemetry [O-POL-1], [O-POL-2], [O-POL-3].
  - `.gitignore` (`node_modules`, `main.js`, `*.map`, `data.json`).
- **CI and GitHub configuration:**
  - `.github/workflows/ci.yml`: on push and PR; `permissions: contents: read`; Node 22.x and 24.x matrix; steps `npm ci`, lint, typecheck, test, build, `npm audit --audit-level=high`, and the network-API grep `! grep -rnE '\bfetch\(|XMLHttpRequest|new WebSocket' src/`. Actions are pinned by full commit SHA with a version comment (T-E4, T-T7).
  - `.github/workflows/codeql.yml`: the `javascript-typescript` language, on push, PR and a weekly schedule.
  - `.github/dependabot.yml`: the `npm` and `github-actions` ecosystems, weekly, with dev dependencies grouped.
- **Claude Code configuration:**
  - `.claude/settings.json`: a PostToolUse hook on `Edit|Write|MultiEdit` running `.claude/hooks/check.sh`, and a SessionStart hook running `npm ci --no-audit --no-fund` when `node_modules` is missing.
  - `.claude/hooks/check.sh` gets the hook event as JSON on **stdin**. It reads `tool_input.file_path` with `node -e` (don't assume `jq` is installed), and falls back to `$1` when run by hand. When the file is `.ts` or `.mts`, it runs `npx eslint --max-warnings=0 <file>` and `npx tsc --noEmit`. On failure it prints the errors to stderr and exits 2, so Claude sees them and must fix them. On success it exits 0 silently.
  - `.claude/agents/security-reviewer.md`: a subagent with tools Read, Grep, Glob and Bash (read-only commands). It reviews `git diff origin/main...HEAD` against `docs/threat-model.md` (the rows mapped to the current milestone), SPEC §3, and the Obsidian developer policies. It checks:
    - every network call goes through `HttpTransport`;
    - `Authorization` goes only to graph.microsoft.com;
    - no tokens, paths or contents reach the logger or console;
    - remote input is validated;
    - path containment before writes;
    - no `innerHTML`, `eval` or dynamic import;
    - no new dependencies without a SPEC §8 row;
    - workflow permissions are minimal.
    - It diffs against `origin/main` when that exists, falling back to the previous milestone's commit and then to `git diff --root HEAD`.

    It reports findings as `severity | file:line | issue | fix`.

**Owner actions** (manual, any time during M1):
Done 2026-10-12 (☑ = done by the owner):
- ☑ Make `main` the default branch. Merging this branch is the owner's call.
- ☑ In the repo settings, enable private vulnerability reporting, Dependabot alerts, secret scanning and push protection [C-GH-2].
- ☑ Confirm 2FA is on for the GitHub account (T-T8). Confirmed by the owner.
- ☑ Turn off CodeQL default setup. Original instructions: switch CodeQL from **default setup** to the workflow (`.github/workflows/codeql.yml`): Settings → Code security → Code scanning → CodeQL analysis → ⋯ → **Disable CodeQL** (or "Switch to advanced"). Until then every CodeQL run fails with "CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled" (observed 2026-10-12, run 38186164070).
- ☑ Verify all of the above with the `gh api` commands in **Verify** (session runs them if `gh` is available, otherwise owner pastes output). The owner pasted the output; it is below.

**Manual check (optional in M1): the plugin loads in a desktop test vault**

`main.js` is not in the repository. It is the build output: `npm run build` bundles `src/main.ts` and everything it imports into `./main.js`, which is what Obsidian loads. `.gitignore` excludes it; release copies are built only by CI (M9).

On the Ubuntu desktop, with Node ≥ 22.18:
```bash
cd ~/src/MDVaultSync
git fetch origin && git checkout claude/sleepy-allen-tegt17   # or main, after merging
npm ci
npm run build                     # creates ./main.js
mkdir -p ~/mdvs-test-vault/.obsidian/plugins/mdvaultsync
cp main.js manifest.json styles.css ~/mdvs-test-vault/.obsidian/plugins/mdvaultsync/
```
1. In Obsidian, open `~/mdvs-test-vault` as a vault (vault switcher → **Open folder as vault**). Use a throwaway vault, never your real one.
2. Open **Settings → Community plugins**, select **Turn on community plugins**, then turn on **MDVaultSync**.
3. Press **Ctrl+Shift+I** to open the developer console. **Pass:** the plugin turns on, nothing visible happens (no ribbon icon, command or setting yet), and the console shows no red errors mentioning `mdvaultsync`.
4. Record the result and the Obsidian version (Settings → About) on the line below.

Name the plugin folder `mdvaultsync` to match the manifest `id`; that is how Obsidian and BRAT install plugins. `.obsidian` is the default config folder. If you renamed it, use your folder name instead.

Result: pass (owner, Ubuntu desktop, Obsidian 1.14.4, 2026-10-12). The plugin was listed and turned on, the console showed no MDVaultSync errors, and `app.plugins.enabledPlugins.has("mdvaultsync") && !!app.plugins.plugins.mdvaultsync` returned `true`.

**Acceptance criteria**
- All standard commands pass locally and in CI on both Node versions.
- `main.js` builds. The plugin loads in a desktop Obsidian test vault and shows nothing (manual check, optional in M1). Passed 2026-10-12.
- Editing a `.ts` file with a lint error makes the hook print the error. Shown by deliberately adding an unused variable, then reverting.
- The security-reviewer agent runs against the M1 diff and reports.
- No sample-plugin code or names remain [O-SUB-3].

**Verify**
```bash
npm ci && npm run lint && npm run typecheck && npm test && npm run build && npm audit --audit-level=high
ls -l main.js
cp src/main.ts /tmp/main.ts.bak && echo 'const unused = 1;' >> src/main.ts && .claude/hooks/check.sh src/main.ts; echo "exit=$? (expect 2)"; cp /tmp/main.ts.bak src/main.ts
echo '{"tool_input":{"file_path":"src/main.ts"}}' | .claude/hooks/check.sh; echo "exit=$? (expect 0)"
scripts/check-network-apis.sh   # replaces the original grep one-liner; see "Deviations" below
gh api repos/caseke/MDVaultSync --jq '.security_and_analysis'            # secret_scanning + push_protection: enabled
gh api repos/caseke/MDVaultSync/private-vulnerability-reporting          # {"enabled":true}
gh api -i repos/caseke/MDVaultSync/vulnerability-alerts | head -1        # HTTP/2 204 = Dependabot alerts on
```

**Verification output** (session container, Node v22.22.0, 2026-10-12)
```
$ npm ci --ignore-scripts --no-fund
added 319 packages, and audited 320 packages in 4s
3 moderate severity vulnerabilities            # see "Optional for the owner" below
$ npm run lint          → exit 0 (eslint . ; also 0 with --max-warnings=0)
$ npm run typecheck     → exit 0
$ npm test
# tests 23
# pass 23
# fail 0
$ npm run build         → exit 0
$ npm audit --audit-level=high → exit 0
$ ls -l main.js
-rw-r--r-- 1 root root 652 Oct 12 00:05 main.js
$ (append 'const unused = 1;' to src/main.ts) .claude/hooks/check.sh src/main.ts
  12:7  warning  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars
ESLint found too many warnings (maximum: 0).
exit=2 (expect 2)        # the same case through stdin JSON also exits 2
$ (revert) echo '{"tool_input":{"file_path":"src/main.ts"}}' | .claude/hooks/check.sh
exit=0 (expect 0)
$ scripts/check-network-apis.sh
no forbidden network APIs
$ grep -rniE 'sample|MyPlugin' src manifest.json package.json
(no output, exit 1)      # no sample-plugin names remain [O-SUB-3]
```
`gh api` checks, run by the owner on their Ubuntu machine on 2026-10-12, since `gh` isn't authenticated in the session container:
```
$ gh api repos/caseke/MDVaultSync --jq '.security_and_analysis'
{
  "dependabot_security_updates": { "status": "enabled" },
  "secret_scanning": { "status": "enabled" },
  "secret_scanning_non_provider_patterns": { "status": "disabled" },
  "secret_scanning_push_protection": { "status": "enabled" },
  "secret_scanning_validity_checks": { "status": "disabled" }
}
$ gh api repos/caseke/MDVaultSync/private-vulnerability-reporting
{ "enabled": true }
$ gh api -i repos/caseke/MDVaultSync/vulnerability-alerts | head -1
HTTP/2.0 204 No Content
```
CI on GitHub: the `CI` workflow passed on Node 22.x and 24.x (run 38186164011 at e5c0f13 and run 38186746269 at 5f4663d). `CodeQL` failed on those commits with a configuration error because CodeQL default setup was enabled. The owner turned it off on 2026-10-12; the first run after that passed (CodeQL run 38188191755 at 78463fe; CI run 38188191640 passed on the same commit).

**Tests added:** `test/smoke.test.ts` (runner, ports.ts is erasable-only), `test/lint-rules.test.ts` (every project lint rule, plus disable comments rejected under the full config), `test/manifest.test.ts` (submission rules, versions agree, zero runtime deps, no sample names), `test/hook.test.ts` (hook fast paths), `test/network-check.test.ts` (CI backstop).

**Deviations from this milestone's text** (all recorded in commit messages):
- The Node built-in ban and the dynamic-`import()` ban apply to `src/**` only. Tests and build scripts use Node modules, and only `src/` ships. To back this up, esbuild no longer marks Node built-ins external, so a built-in reaching the bundle by any route fails the build.
- The CI grep one-liner matched the `RemoteContent.fetch(...)` method signature in `src/core/ports.ts` (design §2). It is replaced by `scripts/check-network-apis.sh`, which exempts that exact signature only and also catches `activeWindow.fetch`, `EventSource` and `sendBeacon`.
- `eslint.config.mjs` instead of `.mts`, so `jiti` is not installed (allowed by this milestone). Project rules live in `eslint/project-rules.ts` so they can be unit tested.
- ESLint started on 9.x because ESLint 10 leaves eslint-plugin-obsidianmd 0.4.2's bundled sub-plugins (import, react) on a nested ESLint 9. **Superseded 2026-10-12** by Dependabot PR #2 (eslint 10.12.0, @eslint/js 10.0.1, obsidian 1.13.1, @types/node 26). It was checked before merge: the obsidianmd, Microsoft SDL and `no-console` rules still fire under ESLint 10 (probe file), and lint, typecheck, build and all 23 tests pass. The plugin keeps its nested ESLint 9 internally, which is harmless. `@types/node` 26 is newer than the Node 22.18 floor; the Node 22 CI job catches any Node 26–only API in tests or scripts, and `src/` can't use Node APIs.
- Actions use current majors (checkout v7.0.1, setup-node v7.1.0, codeql-action v4.38.3), pinned by commit SHA resolved with `git ls-remote`. npm caching in setup-node is off, and `npm ci` runs with `--ignore-scripts` in CI and in the SessionStart hook (T-T7).

**Security review** (`security-reviewer` instructions, run through a general-purpose agent because the agent file only registers at the next session start; base `origin/main`, 31 files):
- Fixed, medium: `activeWindow.fetch` bypassed R-NET-1. Added `window`/`globalThis`/`self`/`activeWindow` × `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`require` to `no-restricted-properties`, and widened the CI script.
- Fixed, medium: project rules could be switched off with `// eslint-disable-next-line <rule> -- reason`. `src/**` now restates obsidianmd's `eslint-comments/no-restricted-disable` list (read from the plugin at load time) plus `no-restricted-imports`/`-globals`/`-properties`/`-syntax`, `no-eval`, `no-implied-eval` and `no-new-func`. Tested.
- Fixed, low: `EventSource`, `navigator.sendBeacon` and bare `require` are now banned. Node built-ins are no longer esbuild externals. The README and SECURITY.md now say the plugin stores its settings and state in its own plugin folder under the config folder (O-POL-2 accuracy). Dependabot `cooldown` is 7 days. `npm ci --ignore-scripts` is used.
- Fixed, info: the hook only lints `src/`, `test/` and `eslint/` and passes `--no-warn-ignored`, so an edit to an unlinted `.ts` file can't block.
- Open, info: the README token-storage residual risk is M9 scope. The action SHAs were resolved from the upstream tags in this session.

**Optional for the owner** (not fixed, no security or requirement impact):
- **For M6:** after "Sign-in required", the user can sign in with a *different* account (`prompt=select_account`) over the kept sync state. The `already-signed-in` guard doesn't cover that case. Harmless while `StateStore` is a stub. M6 should store the drive or account identity in `SyncState` and clear state (or refuse) when a redemption brings a different one.
- If the token clear on `invalid_grant` fails (SecretStorage writes broken), "sign-in required" is in memory only. After a restart the dead token reads as signed in until the next refresh fails again. Within one session the dead grant is never re-sent. Persisting a flag in `data.json` would close this. It needs SecretStorage writes to fail, so it is left open.
- `npm audit` reports 3 **moderate** advisories: `moment` (GHSA-4p3w-j4w9-5jqw), pulled in by the `obsidian` type package (ours is 1.13.1; eslint-plugin-obsidianmd pins its own 1.12.3). `obsidian` is external to the bundle and `moment` never ships. It clears when both move to `obsidian` ≥ 1.14. Dependabot will propose it.
- `test/hook.test.ts` covers only the hook's fast paths. The lint-failure path is covered by the Verify block, because it runs a full `tsc`.

---

## M2: Authentication
**Status:** done (2026-10-12). Session work verified; owner manual checks passed on 0.2.2 on Ubuntu (Flatpak) and the iPad. Check 3 withdrawn with R-AUTH-3. **Owner prerequisite:** complete [entra-setup.md](entra-setup.md) and have the client ID ready.

**Goal.** Sign in, stay signed in across restarts, refresh, and sign out on both devices (design §4).

**Files and interfaces**
- `src/remote/pkce.ts`: verifier, challenge and state generation (WebCrypto only).
- `src/remote/auth.ts`: `AuthClient` with `buildAuthorizeUrl()`, `handleCallback(params)` and `redeemCode()`. It implements `AccessTokenProvider` (single-flight refresh, rotation).
- `src/remote/http.ts`: an `HttpTransport` decorator that adds `Authorization` only for `https://graph.microsoft.com/` (T-I4).
- `src/platform/request-url-transport.ts`: `HttpTransport` over `requestUrl` with `throw: false`. Converts the body to ArrayBuffer and lower-cases header names.
- `src/platform/token-store.ts`: `TokenStore` over SecretStorage, with the `data.json` fallback and the `backend` field (D-5; design §4).
- `src/main.ts`: protocol handler `mdvaultsync-auth` (also accepting a trailing slash); commands `sign-in` and `sign-out`. Sign-out calls a `StateStore` stub here; M6 swaps in the real store.
- `src/ui/sign-in-modal.ts` (added in 0.2.1): shows the authorize URL as a link the user taps, because iOS blocks `window.open` after an await.
- `src/ui/settings-tab.ts`: the Account section only (status, Client ID, Sign in, Sign out, and the token-storage line: a warning for `plugin-data`, a neutral note for `secret-storage`).
- Tests: `test/pkce.test.ts`, `test/auth.test.ts`, `test/http.test.ts`, `test/fakes/fake-http.ts`.

**Acceptance criteria**
- **PKCE** matches the RFC 7636 Appendix B vector: verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` gives challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`. The verifier is 43–128 characters from the allowed alphabet.
- **Callback checks:** the callback is rejected when there's no pending sign-in, when the state is wrong, when it's expired (over 10 minutes), or when the state is reused. An `error` parameter is surfaced without echoing `error_description` into logs.
- **Scope** is exactly `Files.ReadWrite.AppFolder offline_access` (unit test) (T-E2).
- **Refresh:** concurrent `getAccessToken()` calls make one refresh request. The rotated refresh token replaces the stored one before the access token is returned. `invalid_grant` clears the token and sets "sign-in required".
- **Authorization header** never goes to a non-Graph host (unit test).
- ~~**Paste fallback**~~ withdrawn 2026-10-12 (owner decision, SPEC R-AUTH-3).
- **Manual checks** (owner, recorded below):
  1. Ubuntu: Sign in → browser → consent → Obsidian comes forward → "Signed in". Record whether the callback had a trailing slash [I-RU-3].
  2. iPad: same flow through Safari's "Open in Obsidian?" prompt.
  3. ~~"Sign in another way"~~ withdrawn with R-AUTH-3.
  4. Token redemption succeeds, which proves `requestUrl` sends no breaking `Origin` header [I-AC-7]. Record it.
  5. Quit and relaunch Obsidian on both devices: still signed in. Record `TokenStore.backend` [O-API-6].
  5a. Ubuntu: run `xdg-mime query default x-scheme-handler/obsidian` and record the output [O-DEB-1]. Then, with GNOME Keyring locked or absent (for example a fresh user session with no keyring daemon), sign in. Record whether `setSecret` threw, and whether Obsidian showed a "secret storage provider" warning. Update research.md O-API-6 with the observed behavior.
  6. Sign out: settings show signed out, and a SecretStorage read returns empty.
  7. The link https://account.microsoft.com/privacy/app-access shows MDVaultSync [C-MSA-1].
  8. Tick the verification box in entra-setup.md after correcting any portal wording.
  9. Sign-in in check 1 ran with **Enable Live SDK support = No**. Record the result in research.md I-REG-7.

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
```

**How to run the manual checks** (owner; use a throwaway test vault, never the real one)

Build and install on Ubuntu, as in M1: `git checkout claude/focused-shannon-aybk5p && npm ci && npm run build`, then copy `main.js`, `manifest.json` and `styles.css` into `<test vault>/.obsidian/plugins/mdvaultsync/`. On the iPad, install through BRAT. BRAT installs only from published GitHub release assets [O-BRAT-1]; it can't install a branch. Make a pre-release first (one time per build you want on the iPad):
```bash
git fetch origin && git checkout claude/focused-shannon-aybk5p && git pull
git tag 0.2.0 && git push origin 0.2.0        # triggers .github/workflows/release.yml
```
- Wait for the **Release** workflow run (Actions tab) to pass.
- Open **Releases**, then the draft `0.2.0`. Check that it has `main.js`, `manifest.json` and `styles.css` and is marked **Pre-release**, then select **Publish release**.
- Optional: `gh release download 0.2.0 -R caseke/MDVaultSync -p main.js && gh attestation verify main.js -R caseke/MDVaultSync`.
- **On the iPad,** in the test vault: BRAT → **Add a beta plugin for testing** → `caseke/MDVaultSync` → version `0.2.0` (or latest) → **Add plugin**, then enable MDVaultSync under Community plugins.

For a later build, bump the version in a session (`npm version 0.2.3 --no-git-tag-version`), then tag and publish it the same way. In BRAT on the iPad choose **Check for updates to all beta plugins** (or re-add with the new version). **0.2.1** fixed iPad sign-in through a small window; **0.2.2** makes **Sign in** in settings open the browser on the first tap. A tag that doesn't equal `manifest.json`'s version fails the workflow.

In **Settings → MDVaultSync**, paste the client ID from entra-setup.md.

1. **Ubuntu sign-in.** In **Settings → MDVaultSync**, select **Sign in** (0.2.2: no intermediate window; the **Sign in to OneDrive** command still shows one). Your default browser opens Microsoft's page; **pass requires** the default browser, not an Obsidian tab (Obsidian's Web viewer core plugin can open external links in-app; turn its "open external links" option off if it does) (T-S3). Sign in and consent, then allow the browser to open the `obsidian://` link. Pass: Obsidian comes forward, the notice says "Signed in to OneDrive.", and **Status** reads "Signed in to OneDrive.". For the trailing slash: before allowing the link, copy it from the browser prompt or history, and record whether it starts with `obsidian://mdvaultsync-auth/?` or `obsidian://mdvaultsync-auth?`.
2. **iPad sign-in** (0.2.2). Tap **Sign in** in settings. Safari shows Microsoft's page on that first tap. After consent it asks "Open in Obsidian?"; tap **Open**. **Pass requires** the Microsoft page to open in Safari (or a Safari tab sheet with Safari's address bar and Done button), not inside an Obsidian pane or tab (T-S3, RFC 8252). Record which. If it opens inside Obsidian, or never returns to Obsidian, it fails: record what you saw.
3. ~~Paste fallback~~ withdrawn (R-AUTH-3). Also remove the `nativeclient` redirect URI from your app registration if you added it (entra-setup.md step 3).
4. **Origin header.** Checks 1 and 2 succeeding means token redemption worked, so `requestUrl` sent no breaking `Origin` [I-AC-7]. If redemption fails, the notice ends with a code; `invalid_request` with AADSTS9002326 means `Origin` was sent. Record which.
5. **Restart.** Quit and relaunch Obsidian on both devices. Pass: **Status** still says signed in. Record **Token storage**: the neutral note means `secret-storage`, and the red warning means `plugin-data`.
   5a. On Ubuntu, run `xdg-mime query default x-scheme-handler/obsidian` and record the output. Then sign out. Lock the keyring (Seahorse → right-click **Login** → **Lock**), or log in to a fresh user session that has no keyring daemon. Sign in again. Record which **Token storage** line appears, and whether Obsidian showed a "secret storage provider" warning. Update research.md O-API-6.
6. **Sign out.** Select **Sign out**. Pass: **Status** reads "Signed out.", and the notice shows the app-access link. In the developer console (Ctrl+Shift+I on Ubuntu), run `app.secretStorage.getSecret("mdvaultsync-refresh-token")`. It must return `""` or `null`. Also check that `data.json` in the plugin folder has no `fallbackRefreshToken`.
7. Open https://account.microsoft.com/privacy/app-access. Pass: MDVaultSync (your app registration's name) is listed. Update research.md C-MSA-1.
8. **entra-setup.md accuracy.** Did every portal label in the guide match what you saw? Differences get fixed in the guide, then its verification box is ticked.
9. Confirm that check 1 ran with **Enable Live SDK support = No**, and record the result in research.md I-REG-7.

Manual check results (owner):
```
1 Ubuntu sign-in:        pass on 0.2.2 (one tap → default browser; also passed on 0.2.0 and 0.2.1). Trailing slash not visible; both handlers registered
2 iPad sign-in:          pass on 0.2.2 (one tap → default browser). History: FAIL on 0.2.0 (window.open after await blocked), pass on 0.2.1 (link in a modal)
3 Paste fallback:        withdrawn by owner (nativeclient page showed a phishing warning); R-AUTH-3 withdrawn; nativeclient redirect removed from the registration
4 Origin header:         pass on both: token redemption succeeded on Ubuntu (Electron) and iPad (0.2.1)
5 Restart, backend:      Ubuntu = still signed in, secret-storage.  iPad = still signed in, secret-storage
5a xdg-mime / keyring:   md.obsidian.Obsidian.desktop (Flatpak). Pass: (a) keyring locked, unlocked, Obsidian reopened: still signed in; (b) Obsidian opened with the keyring locked: the OS prompted for the keyring password, then still signed in, no errors or warnings. The plugin-data fallback was not triggered on a device (unit-tested)
6 Sign-out:              pass (Ubuntu): getSecret → null, no fallbackRefreshToken in data.json
7 App-access page:       pass: app listed
8 entra-setup verified:  pass: the owner corrected the portal wording in an earlier chat (commits c3e9655, 1cc3f8b, fe1379c, e486789); box ticked
9 Live SDK = No:         pass
(all results from the owner, 2026-10-12)
```

**Verification output** (session container, Node v22.22.0, 2026-10-12, final M2 commit)
```
$ npm ci --ignore-scripts --no-fund      → 3 moderate (unchanged from M1, see M1 "Optional")
$ npm run lint                           → exit 0, 0 errors, 3 warnings (see Deviations)
$ npm run typecheck                      → exit 0
$ npm test
# tests 121
# suites 7
# pass 121
# fail 0
$ npm run build                          → exit 0 (main.js 15750 bytes)
$ npm audit --audit-level=high           → exit 0
$ scripts/check-network-apis.sh
no forbidden network APIs
```
Tests were written first and run red (6 files failing to load) before the implementation. Mutation spot checks, each reverted, make the suite fail: clearing the pending sign-in on a wrong state, removing single-flight, a hostname-prefix origin check, not stripping caller `Authorization`, no expiry, and removing both epoch guards.

**Tests added:**
- `test/pkce.test.ts`: the RFC 7636 vector, the verifier alphabet and length, and the state format.
- `test/auth.test.ts`: authorize URL and exact scope; every callback rejection; error_description absent from errors and console; token POST shape (no Origin, no Authorization, no secret); hostile token JSON; single-flight refresh; rotation order; invalid_grant and interaction_required; sign-out and redemption races.
- `test/http.test.ts`: Authorization only for `https://graph.microsoft.com`; stripped for 10 look-alike and transfer hosts.
- `test/token-store.test.ts`: SecretStorage, the fallback, migration back, and clear verification.
- `test/request-url-transport.test.ts`, `test/settings.test.ts`, `test/auth-messages.test.ts`.
- `test/fakes/fake-http.ts` (FakeHttp, FakeClock).

**Deviations from this milestone's text** (recorded in design.md §4 and in commit messages):
- `buildAuthorizeUrl` is async, because the S256 digest is. Because of that, `window.open` after it was blocked on iOS (check 2). Since 0.2.1 the URL is shown as a link in `src/ui/sign-in-modal.ts`, the pattern Remotely Save uses. Until the fallback was withdrawn, `handleCallback` also took the arrival channel; it now takes only the params.
- A wrong `state` does not clear the pending sign-in, so a forged link can't cancel a real one. Expiry and a matching state do clear it.
- **Paste fallback withdrawn** (owner, 2026-10-12, after check 3 showed a phishing warning): SPEC R-AUTH-3 withdrawn, D-4 and R-UI-1 updated, threat-model T-S4 n/a, design §4 and entra-setup.md updated; `REDIRECT_NATIVE`, `parsePastedUrl`, the paste UI and their tests removed.
  - **0.2.2, owner request:** the settings **Sign in** is now itself the link, built before the tap (`AuthClient.prepareSignIn`). The tap starts the sign-in synchronously (`activateSignIn`) and opens the default browser with no intermediate window, using the link mechanism proven on both devices in 0.2.1. The command keeps the modal.
  - Review of the 0.2.2 change (`security-reviewer`): no high or medium findings; T-S1 holds (an untapped link accepts no callback). Fixed, low:
    - overlapping prepares could leave the link and the client disagreeing (now only the latest prepare wins, `superseded`);
    - a failed tap now rebuilds the link instead of leaving it dead;
    - stale prepares can't raise a false "signed out" notice (`renderId` is bumped on every render and on hide);
    - `already-signed-in` is re-checked after the await and on activation;
    - a double tap on an expired sign-in reports `expired`;
    - closing settings discards an untapped link (`discardPrepared`);
    - the double-tap test now asserts the result, and 6 edge-case tests were added;
    - T-S1/T-S3, design §4 and SPEC R-AUTH-3 updated.
  - Review of the 0.2.1 change (`security-reviewer`): no high findings.
    - Fixed, medium: T-S3 rested on an unverified "system browser" claim. Checks 1 and 2 now pass only if the page opens in the system browser (or a Safari tab sheet), not an Obsidian pane.
    - Fixed, medium: SPEC R-AUTH-3 and design §4 overstated that the primary flow worked on both devices. They now say iPad is pending, and R-AUTH-3 reopens if the iPad can't work.
    - Fixed, low: a forged or stale `obsidian://` link (`no-pending`, `state-mismatch`) no longer closes the real sign-in modal.
    - Fixed, low: `onunload` closes the modal.
    - Fixed, low: stale doc lines in design.md, plan.md (M2 file list), cost-estimate.md and research.md I-RU-4.
- `requestUrl` and SecretStorage are injected, so `request-url-transport.ts` and `token-store.ts` are unit tested. Extra supporting files: `src/settings.ts` (data.json shape and GUID check) and `src/ui/auth-messages.ts` (the error-code → message table, tested for completeness).
- The token store also falls back when SecretStorage accepts a write but reads back a different value (SPEC D-5 updated).
- Lint has 3 warnings in `settings-tab.ts`: `display()` is deprecated since 1.13 in favor of declarative settings. Declarative settings need 1.13.0 [O-API-18], and `minAppVersion` is 1.11.4 (R-ENV-3), so they can't be used yet. M7 must decide whether to raise `minAppVersion` or accept these warnings. The M7 criterion "no warnings from obsidianmd rules" conflicts with R-ENV-3 until then.
- **Release workflow pulled forward from M9** (owner decision, 2026-10-12). BRAT can't install without a release, so manual check 2 needed one. `.github/workflows/release.yml` builds, attests and drafts a release on an `x.y.z` tag. 0.x versions are marked pre-release, and publishing stays manual. Version bumped to 0.2.0. `test/workflows.test.ts` checks SHA pins, permissions, the tag-only trigger and that no `${{ }}` appears inside `run:`.
  - Review (`security-reviewer`, staged diff): no high findings.
    - Fixed, medium: the workflow test passed even with the tag check deleted. It now asserts the step itself.
    - Fixed, low: the permissions, trigger and job-set checks are now exact; `persist-credentials: false` is required; the injection check covers every workflow.
    - Fixed, low: split into a read-only `build` job and a `release` job that runs no npm or repo code, so dev dependencies never see `id-token: write`.
    - Fixed, low: the release job fails if the tag moved off the built commit during the run.
    - Fixed, info: the M9 tag pattern now matches the workflow; `manifest.json` and `versions.json` keep their trailing newline (`version-bump.mjs` fixed); added a CHANGELOG `[0.2.0]` section.
    - Open for the owner (optional now, an M9 action anyway): add a tag ruleset for `[0-9]*.[0-9]*.[0-9]*` so only you can create or move release tags (T-T8).
    - To confirm on the first run: the attest step succeeds and `gh attestation verify` passes (O-REL-1, C-GH-3).
- The neutral storage note says "your device's keyring", not "your OS keyring", because the obsidianmd sentence-case rule rejects "OS".

**Security review** (`security-reviewer` agent; base: the M1 merge commit 6fcb471, since `origin/main` isn't fetched in the container):
- No high findings.
- Fixed, medium: `TokenStore.clear()` ignored a failed overwrite, so sign-out could report success while the token stayed readable. It now verifies and throws `TokenClearError`, and sign-out shows "Sign-out is incomplete".
- Fixed, medium: the `sign-in` command worked while already signed in. That could relink the vault to another account without clearing state, and an older in-flight refresh could overwrite the new grant. Sign-in is now refused with `already-signed-in`, and redemption bumps the epoch.
- Fixed, low: sign-out now catches and reports failures (code-only logging) and always refreshes the tab.
- Fixed, low: short-lived tokens rotated the refresh token on every call. The margin is now capped at half the lifetime.
- Fixed, low: `isGraphUrl` threw a `TypeError` that carries the URL. It now throws a URL-free `InvalidUrl`.
- Fixed, low (documented): the read-back fallback is recorded in SPEC D-5.
- Re-review of fix commit b0cee50: all of the above confirmed resolved, no new high or medium findings.
  - Fixed, low: if a sign-out landed while a sign-in was writing its token and the undo then failed, the failure went unreported. It is now surfaced with a notice and an honest status. Tested.
  - Fixed, info: a sync-state clear failure no longer shows the token-failure text.
  - Open, low (M6): see the first item under Optional.
  - Open, low: see the second item under Optional.

**Optional for the owner** (not fixed, no security or requirement impact):
- **For M6:** after "Sign-in required", the user can sign in with a *different* account (`prompt=select_account`) over the kept sync state. The `already-signed-in` guard doesn't cover that case. Harmless while `StateStore` is a stub. M6 should store the drive or account identity in `SyncState` and clear state (or refuse) when a redemption brings a different one.
- If the token clear on `invalid_grant` fails (SecretStorage writes broken), "sign-in required" is in memory only. After a restart the dead token reads as signed in until the next refresh fails again. Within one session the dead grant is never re-sent. Persisting a flag in `data.json` would close this. It needs SecretStorage writes to fail, so it is left open.
- `AuthClient.redeemCode` is public, as this milestone's interface lists it. It could be made private and reached only through `handleCallback`. Other plugins share the JS realm, so this isn't a security boundary (T-I1).
- A web page can open `obsidian://mdvaultsync-auth?…` repeatedly. Each forged link shows a "Sign-in link ignored" notice: harmless spam. These notices could be suppressed for `no-pending` and `state-mismatch`.
- M3 must check that `requestUrl` doesn't carry `Authorization` across a Graph redirect to a CDN host (O-API-2), or never follow Graph redirects with auth.
- The README's token-storage residual-risk note is M9 scope. Tokens are stored for real from this milestone on.

---

## M3: Graph client, retry, validation, capability probe
**Status:** awaiting-owner (session work done 2026-10-12). The probe has to run on the owner's Ubuntu and iPad; see **Manual checks**. M4 can start now: only its QuickXorHash vectors need the probe JSON. M6 needs the applied capabilities (`CAPABILITIES_PROBED = true`).

**Goal.** A complete `RemotePort` over Graph. Settle every documentation gap from research.md §6 that can be tested against the live API.

**Files and interfaces**
- `src/remote/graph.ts`: `GraphClient implements RemotePort` (design §2). Delta follows `nextLink` and stops at `deltaLink` [G-DL-2]. Downloads go through a fresh `@microsoft.graph.downloadUrl` without auth [G-DLD-1]. `uploadNew` uses `conflictBehavior=fail` in the query [G-UP-2]. Move, delete and replace send `If-Match` [G-MV-1], [G-DEL-1].
- `src/remote/upload-session.ts`: create, send fragments, status and cancel [G-UP-5] … [G-UP-9]. Resume orchestration lands in M6; the primitives land here.
- `src/remote/retry.ts`: `RetryPolicy` (design §6.1): Retry-After in seconds or as an HTTP date, a global pause, full-jitter backoff, and a per-run budget [G-THR-1], [G-THR-2].
- `src/remote/validate.ts` and `src/remote/graph-types.ts`: type guards, size caps, the URL host allowlist (design §8) (T-T2, T-T5).
- `src/remote/errors.ts`: `GraphError {status, code, innerCodes}`. Any 410 or `resync*` code becomes `ResyncRequired` [G-DL-4], [G-ERR-1].
- `src/remote/capabilities.ts`: `PUT_HONORS_IF_MATCH`, `DELTA_FORM` (`"approot-colon" | "items-id" | "children-walk"`), and `NAME_MAX`, set from the probe results.
- `src/core/logger.ts`: the redacting typed logger (design §9) (T-I3).
- `src/platform/diagnostics.ts`: a `run-diagnostics` command. It runs the probes below inside the hidden remote folder `.mdvaultsync-probe/`, which normal sync excludes, then deletes it. It outputs a JSON result that contains no vault file names.
- Tests: `test/retry.test.ts` (FakeClock), `test/validate.test.ts` (hostile payloads: `..` names, huge sizes, bad hosts, wrong types), `test/graph.test.ts` (FakeHttp: paging, 410, 412 mapping, no auth on upload and download URLs, the encoding in `encodeURIComponent` per segment, including `#`, `%`, emoji and NFD input) [G-ADR-1].

**Probes** (each result updates research.md and `capabilities.ts`):
1. `GET /me/drive/special/approot`: record the `parentReference.path` and the name [G-AF-1].
2. Delta forms: `/me/drive/special/approot:/:/delta`, then `/me/drive/items/{approotId}/delta`. Record which works, whether the approot itself appears, and whether `file.hashes.quickXorHash` is present [G-DL-1], [G-DL-8].
3. PUT with a stale `If-Match`: 412 means `PUT_HONORS_IF_MATCH = true` [G-UP-3], (D-11).
4. Create `probe.md`, then `PROBE.md` with `conflictBehavior=fail`: a 409 confirms case-insensitivity [G-NM-5].
5. A 255-character and a 256-character name: record the per-name limit [G-NM-6].
6. PATCH rename and DELETE with If-Match: confirm the AppFolder scope allows both [G-AF-5].
7. `GET /me/drive`: record whether AppFolder can read quota [G-QT-1].
8. A 12 MiB file round trip through an upload session (two fragments: 10 MiB plus 2 MiB) and back through the download URL, run **on the iPad**. Record the duration and confirm the hashes match [O-API-2], (T-D6). Record the observed hosts of upload and download URLs to refine the allowlist.

**Acceptance criteria**
- All unit tests pass. Coverage of `retry.ts`, `validate.ts` and `graph.ts` is at least 90 % of lines (`node --test --experimental-test-coverage`).
- The probe runs on Ubuntu and on the iPad. Its JSON output is pasted below. `capabilities.ts` and the research.md rows are updated. If `DELTA_FORM` is `children-walk`, the design §5.2 fallback applies and the M5 planner must not assume delta semantics.

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
node --test --experimental-test-coverage "test/**/*.test.ts" 2>&1 | grep -E "retry|validate|graph"
```

**Verification output** (session container, Node v22.22.0, 2026-10-12, final M3 commit)
```
$ npm ci --ignore-scripts --no-fund      → exit 0; 3 moderate (unchanged, see M1 "Optional")
$ npm run lint                           → exit 0, 0 errors, 2 warnings (settings-tab.ts, the M2 declarative-settings warnings)
$ npm run typecheck                      → exit 0
$ npm test
# tests 289
# suites 8
# pass 289
# fail 0
$ npm run build                          → exit 0 (main.js 39317 bytes)
$ npm audit --audit-level=high           → exit 0
$ scripts/check-network-apis.sh
no forbidden network APIs
$ node --test --experimental-test-coverage "test/**/*.test.ts"   (line % | branch % | funcs %)
  retry.ts            100.00 | 96.67 | 100.00
  validate.ts          99.31 | 98.13 | 100.00
  graph.ts            100.00 | 95.07 | 100.00
  upload-session.ts   100.00 | 97.62 | 100.00
  errors.ts, logger.ts, http.ts  100.00 lines
  probe.ts             96.72 lines
```
The plan's grep line (`grep -E "retry|validate|graph"`) also matches test names, so the table rows above are taken from the coverage report itself.

Tests were written first and run red (7 test files failing to load, 3 new tests failing) before the implementation. Each of these mutation spot checks, when applied (and then reverted), makes the suite fail:
- no If-Match on the PUT replace;
- Authorization sent to non-Graph hosts;
- the global pause dropped;
- a look-alike transfer host accepted;
- `conflictBehavior=replace` on a new-file session;
- after the review: the Graph host allowed as a transfer URL, every error retried, the download sent through the authorizing transport, and dot-only ids allowed.

Probe JSON (owner, from **Run OneDrive capability probe** → Copy result):

**Probe v1 (0.3.0), Ubuntu, 2026-10-12** (owner; whitespace compacted):
```
{
  "probeVersion": 1, "platform": "linux", "pluginVersion": "0.3.0",
  "startedAt": "2026-10-12T04:51:36.567Z", "durationMs": 24912,
  "approot": { "ok": true, "parentPath": "/drive/root:/Apps", "name": "MDVaultSync", "pathPrefixLength": 16 },
  "leftoverRemoved": false,
  "delta": {
    "approot-colon": { "ok": false, "code": "InvalidResponse" },
    "items-id": { "ok": false, "code": "InvalidResponse" }
  },
  "putIfMatch": { "honored": true, "staleStatus": 412, "staleCode": "notAllowed" },
  "caseInsensitive": { "confirmed": true, "status": 409, "code": "nameAlreadyExists" },
  "nameLength": { "len255": { "status": 201 }, "len256": { "status": 201 }, "nameMax": null },
  "patchIfMatch": { "currentStatus": 200, "staleStatus": 412 },
  "deleteIfMatch": { "staleStatus": 412, "currentStatus": 204 },
  "quota": { "readable": true },
  "largeFile": { "ok": false, "size": 12582912, "fragments": 2, "status": 400, "code": "invalidRequest" },
  "hashVectors": [
    { "file": "probe.md", "size": 18, "generator": "utf8:\"MDVaultSync probe\\n\"", "quickXorHash": "DCznRcJQBzbQYQp5YsMYQAAHObw=" },
    { "file": "empty.bin", "size": 0, "generator": "empty", "quickXorHash": "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    { "file": "seq.bin", "size": 1000, "generator": "probeBytes(1000, seed)", "seed": 7, "quickXorHash": "RW+Rh6PcZW2m++mFuOGq5DBJwQk=" }
  ],
  "cleanup": { "ok": true }, "errors": 1
}
```

What v1 settled (server behavior, the same from any device; recorded in research.md):
- PUT honors a stale If-Match: 412 [G-UP-3]. The error code is `notAllowed`, so M6 must branch on status 412, not on the code.
- Names are case-insensitive: 409 `nameAlreadyExists` [G-NM-5].
- The name limit is above 255: 256 was accepted [G-NM-6].
- PATCH and DELETE honor If-Match under the AppFolder scope [G-AF-5].
- Quota is readable [G-QT-1].
- The App Folder is `/Apps/MDVaultSync` [G-AF-1].
- Hash vectors for M4 were recorded. The empty file hashes to `AAAAAAAAAAAAAAAAAAAAAAAAAAA=`, as expected.

Two v1 failures were bugs in this milestone's code, fixed in 0.3.1:
- **Both delta forms → `InvalidResponse`.** Probe step 5 had just created a 256-character name, which OneDrive accepted. `parseDriveItem` capped received names at 255, so the whole delta page was rejected. Outside the probe this would have stopped sync for good the moment any remote file got a name over 255 characters (for example, a rename in OneDrive web). The fake had masked it: FakeGraph refused names over 255.
  - Fix: received names are accepted up to the 400-character path limit, and the planner decides whether to sync them (design §8).
  - Probe v2 runs delta before creating the long names.
  - Regression tests added.
- **12 MiB round trip → 400 `invalidRequest` at createUploadSession.** `uploadHost` is missing from the result, so the create call failed, not a fragment. Its body carried `fileSize`, which I added beyond design §6.3.
  - Fix: `fileSize` is no longer sent.
  - Probe v2 tries three bodies (with fileSize, without it, none) and records each answer with its inner codes (`largeFile.createAttempts`). It also records which `stage` failed.

**Probe v2 (0.3.1)**, still needed from both devices: delta forms, the large-file round trip (iPad: O-API-2, T-D6), observed transfer hosts, and the name limit at 300.
```
Ubuntu: (paste here)
iPad:   (paste here)
```

**Manual checks** (owner; use a throwaway test vault, never the real one)
1. **Install 0.3.1.** `git switch claude/eloquent-clarke-21deia && git pull`, then `git tag 0.3.1 && git push origin 0.3.1`. (0.3.0 was installed on both devices on 2026-10-12 and ran probe v1 on Ubuntu; see above.)
   - Wait for the **Release** workflow to pass.
   - Open the draft `0.3.1` release, check that it has the three assets and is marked pre-release, then publish it.
   - Ubuntu: `npm ci && npm run build`, then copy `main.js`, `manifest.json` and `styles.css` into the test vault's plugin folder (as in M2), or install through BRAT.
   - iPad: BRAT → **Check for updates to all beta plugins**, or add version `0.3.1`.
2. **Run the probe on Ubuntu.** Sign in if needed. Open the command palette (Ctrl+P; on the iPad, swipe down on a note or use **Open command palette**) and run **MDVaultSync: Run OneDrive capability probe**. There is no settings button until M7.
   - Expect a window that says it is running. After up to a minute it shows JSON. Select **Copy result** and paste it into the block above.
   - Pass: `probeVersion` is 2, `cleanup.ok` is `true`, `largeFile.bytesMatch` is `true`, and OneDrive web shows no `.mdvaultsync-probe` folder in `Apps/<your app name>` afterwards. The probe's items are in the OneDrive recycle bin; you can empty it.
3. **Run the probe on the iPad**, the same way. Probe 8, the 12 MiB round trip, is the one the plan requires on the iPad (O-API-2, T-D6). Record whether Obsidian stayed responsive while it ran.
4. **A follow-up session applies the results:**
   - `src/remote/capabilities.ts`: `PUT_HONORS_IF_MATCH` from `putIfMatch.honored`; `DELTA_FORM` = the first form with `ok: true`, or `children-walk` if neither works (then the design §5.2 fallback applies and the M5 planner must not assume delta semantics); `NAME_MAX` from `nameLength.nameMax`; then `CAPABILITIES_PROBED = true`.
   - research.md rows: G-AF-1 (`approot`), G-DL-1 and G-DL-8 (`delta`), G-UP-3 (`putIfMatch`), G-NM-5 (`caseInsensitive`), G-NM-6 (`nameLength`), G-AF-5 (`patchIfMatch`, `deleteIfMatch` and `delta`), G-QT-1 (`quota`), and O-API-2 (`largeFile`).
   - Narrow `TRANSFER_HOST_SUFFIXES` to the observed `uploadHost` and `downloadHost` suffixes.
   - Record the `hashVectors` for M4.

**Tests added:**
- `test/retry.test.ts`: Retry-After as seconds and as an HTTP date, the clamp, the global pause (with a manual clock), backoff, jitter, the 60 s cap, the 6-attempt cap, network errors, non-network errors not retried, every non-retryable status, the budget, and `resetBudget`.
- `test/validate.test.ts`: hostile names, ids (dot-only included), sizes, tags (control characters included) and hashes; deleted-item leniency; the transfer-URL allowlist (Graph host, look-alikes, userinfo, port); delta, children, session, status and quota shapes; the 32 MiB cap; `checkName`.
- `test/graph.test.ts`:
  - `getAppRoot` and its `pathPrefix` checks;
  - the three delta forms, paging, the page cap, duplicates, untrusted links, and 410 and `resync*` → `ResyncRequired`;
  - `listChildren`, `getItem` and `getChildByName`;
  - per-segment encoding of `#`, `%`, `?`, space, emoji, NFD and `'()`;
  - `uploadNew`, `uploadReplace`, `move`, `delete` and `createFolder`: If-Match, `conflictBehavior=fail`, 409 and 412;
  - `download`: no auth, length check, untrusted host, never GET Graph `/content`;
  - quota, throttling and redaction in the log, and `sendRaw`;
  - the transport split, and the If-Match header-injection guard.
- `test/upload-session.test.ts`: fragment ranges (12 MiB = 10 + 2), `Content-Range`, 320 KiB alignment, new and replace sessions, If-Match, 202/201/404/416, cancel, and untrusted upload URLs.
- `test/errors.test.ts`, `test/logger.test.ts`, `test/probe.test.ts`: full probe against the fake; no names, URLs or tokens in the JSON; unsupported forms; leftovers; a failing step still cleans up; approot failure; cleanup failure; a non-folder at the probe name.
- `test/http.test.ts` and `test/auth.test.ts` additions: 401 → invalidate and resend once; `invalidateAccessToken`.
- `test/fakes/fake-graph.ts` (HTTP-level OneDrive fake) and `test/graph-setup.ts`.

**Deviations from this milestone's text** (recorded in design.md §2 layout, §5.2, §6.1, §6.3, §8, §9 and §10, and in commit messages):
- **Probe location.** The probe logic is `src/remote/probe.ts`. `src/platform/diagnostics.ts` only registers the command, and `src/ui/diagnostics-modal.ts` shows the JSON. The R-ENG-4 lint rule allows `.uploadNew(`, `.putFragment(` and `.download(` calls only in `src/remote/**` and `remote-content.ts`, and this way the probe is unit tested.
- **No `graph-types.ts`.** The guards in `validate.ts` read raw JSON as `unknown` directly, so a separate raw-types file would have been unused.
- **401 handling.** "One refresh then retry once" lives in `AuthorizingTransport`, through a new `AuthClient.invalidateAccessToken(token)`. `ports.ts` is unchanged.
- **Helpers outside RemotePort.** `GraphClient.deltaAll` (paging helper for M6) and the `CHILDREN_WALK_LINK` sentinel for the fallback. `GraphClient.sendRaw` sends Graph-only requests for the probe.
- **Stricter validation than design §8.** Names `.` and `..` and dot-only ids are rejected. eTag, cTag and If-Match must be printable ASCII. The approot path is validated per segment.
- **Probe 8** compares downloaded bytes with uploaded bytes, because QuickXorHash lands in M4. It records OneDrive's hashes of deterministic probe files (`hashVectors`) as M4 test vectors.
- **Transport split.** Transfers use a bare `transferTransport` (security review).
- **Version 0.3.0**, so the owner can tag a BRAT pre-release for the iPad probe (the M2 pattern).

**Security review** (`security-reviewer` agent; base: the M2 close commit 643cc29, since `origin/main` isn't fetched in the container):
- No high findings.
- Fixed, medium:
  - Transfer URLs on `graph.microsoft.com` passed the `.microsoft.com` allowlist and went through the authorizing transport, so a tampered `uploadUrl` or `downloadUrl` could make authorized, unconditional Graph calls. Now the Graph host is refused, and transfers use a transport with no auth decorator.
  - RetryPolicy retried any exception, including `AuthError` from the refresh, and logged it as `network`. Now only `NetworkError` is retried.
- Fixed, low:
  - Dot-only ids could climb out of `/items/` in a URL.
  - The decoded approot path was only partly checked.
  - If-Match blocked only CR and LF.
  - The retry budget was never reset (now reset per probe; M6 resets it per run).
- Fixed, info: the probe no longer deletes a non-folder at `.mdvaultsync-probe`, and the probe header comment now says the JSON includes the App Folder name and parent path.
- Re-review of fix commit 97b9dec: every finding above is confirmed resolved, with no high or medium findings.
  - Fixed, low: eTag and cTag from Graph are now required to be printable ASCII at parse time, so no path (the probe, or state M6 reads back) can forward a CR/LF eTag into a header.

- Review of the 0.3.1 fix (87d5e67, `security-reviewer`): no high or medium findings. Its two low findings are requirements for later milestones, because nothing builds a local path from a remote name yet:
  - **M4 must** run every remote-derived name (now up to 400 characters) through `validateSegment`. That means control characters, trailing dot or space, reserved names, and the 255 limit (design §7 step 3). The hostile-name tests must include 256–400-character names (R-PATH-3, R-PATH-4, T-T1).
  - **M5 must** test that a skipped remote item (a name over 255, or any other skip) never produces a local or remote delete, and that it counts as a child for the folder-delete rule R-DEL-3 (T-D1).
  - Info, fixed: the test title that still mentioned `fileSize`. Info, accepted: the probe's "none" session body relies on Graph's documented default `fail`. If probe v2 shows only "none" works, check that default before M6 depends on it.

**Optional for the owner** (not fixed, no security or requirement impact):
- **For M6:** the `.microsoft.com` transfer suffix is still broad. No token can leak (Graph is refused, and transfers carry no auth), but bytes could go to another `*.microsoft.com` host. Narrow the list from the probe's `uploadHost` and `downloadHost` (step 4 above).
- **For M6:** downloads are length-checked only after `requestUrl` has buffered the whole body. The executor must skip items over the size cap before calling `download` (D-12, T-D6).
- **For M6:** `GraphClientOptions.transferTransport` falls back to `transport` when omitted, which only tests do. It is safe either way, because the Graph host is refused and `AuthorizingTransport` strips Authorization from non-Graph hosts. It could be made required.
- The probe leaves its test files in the OneDrive recycle bin (about 12 MiB, which counts toward quota [G-DEL-2]) until the user empties it.
- The command's display name is "Run OneDrive capability probe", not design §10's "Run Graph capability probe", because the obsidianmd sentence-case rule flags "Graph".

---

## M4: Pure helpers (hash, paths, exclude, transform)
**Status:** not started

**Goal.** Deterministic building blocks with exhaustive tests.

**Files and interfaces**
- `src/core/quickxor.ts`: `quickXorHash(data: ArrayBuffer): string` (base64), ported from Microsoft's reference [G-HASH-2]. It works on `Uint8Array` in chunks, with no `BigInt` requirement unless needed for the length XOR.
- `src/core/paths.ts`: `toVaultPath`, `validateSegment`, `validatePath(path, pathPrefixLen)`, `caseKey`, `findCollisions` and `remoteToVaultPath` (containment), per design §7 and §8 (T-T1, T-E1).
- `src/core/exclude.ts`: `isExcluded(path, configDir, patterns)`, a gitignore-style glob (`*`, `**`, `?`, a trailing `/`), around 60 lines, no dependency.
- `src/core/transform.ts`: the `ContentTransform` interface and `IdentityTransform` (D-10).
- `src/core/conflict-name.ts`: `conflictCopyPath(path, deviceName, date, exists)`, which produces `stem (conflict Device YYYY-MM-DD HHmmss).ext` and adds ` 2`, ` 3` on collision (R-CONF-1).
- Tests for each.

**Acceptance criteria**
- **QuickXorHash** matches the hashes OneDrive returned for the M3 probe files. The empty input gives `AAAAAAAAAAAAAAAAAAAAAAAAAAA=`. It also matches published vectors from a second independent implementation; the source is cited in the test file (for example rclone's `quickxorhash` tests). Hashing 100 MiB on desktop takes under 3 s (logged, not asserted).
- **Path tests** cover every rule in design §7: each invalid character, each reserved name with and without an extension, a trailing space or period, a leading `~`, `_vti_`, 400 versus 401 characters including the prefix, NFC/NFD pairs, and case collisions. Containment tests cover `..`, `a/../../x`, `/abs`, `C:\x`, backslashes, NUL, `.obsidian/plugins/x/main.js`, a renamed configDir, and hidden segments.
- **Exclude tests** cover configDir, hidden paths and user globs.

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
```

**Verification output**
```
(paste here)
```

---

## M5: Sync planner and state (pure)
**Status:** not started

**Goal.** `plan(state, local, remoteIndex, settings) → Plan` implements design §5.4 exactly, proven with fakes.

**Files and interfaces**
- `src/core/state.ts`: `SyncState` schema validation and `emptyState(deviceId)`. A malformed state file is treated as "no state", which forces union mode (T-T6).
- `src/core/remote-tree.ts`: rebuilds paths from `parentId` chains and drops orphans [G-DL-6], [G-DL-7].
- `src/core/planner.ts`: the three-way table, rename and move detection, folder ops, union mode, skips, the mass-delete count, and `Plan`.
- `src/core/report.ts`: builds a `SyncReport` from a plan and results.
- `test/fakes/fake-vault.ts` and `test/fakes/fake-remote.ts`. FakeRemote follows OneDrive rules: case-insensitive names, eTag changes on any change, cTag only on content changes, recycle on delete, 412 on stale If-Match, and delta pages with duplicates.
- `test/planner.test.ts`: one named test per row of the design §5.4 table, plus:
  - renames: local, remote, both to different targets, both to the *same* target, case-only renames (no `local-move` loop), and the folder rename collapse;
  - union mode **with** bases (a resync: one-sided edits sync normally, no conflicts, no deletes);
  - union mode **without** bases (a stale device: conflicts counted in `differsNoHistory`);
  - the approot-ID change;
  - a remote folder delete blocked by a skipped (too-large) child;
  - the guard threshold boundary, and `declinedDeletes` suppressing re-proposals;
  - null remote hash handling;
  - every skip reason.
- `test/planner.property.test.ts`: a seeded PRNG (written in the test, no dependency) generates 5,000 random three-way states. It asserts:
  - no plan both deletes and fails to preserve bytes that only one side had;
  - union mode never emits deletes;
  - conflicts emit only when both sides changed with different hashes.

**Acceptance criteria**
- The tests above pass.
- `src/core/**` has no `obsidian` import (the lint rule passes).
- Planner line coverage is at least 95 %.

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
node --test --experimental-test-coverage "test/**/*.test.ts" 2>&1 | grep -E "planner|state|remote-tree"
```

**Verification output**
```
(paste here)
```

---

## M6: Executor, engine, persistence, resume
**Status:** not started

**Goal.** Running a plan safely and resumably (design §5.5, §6).

**Files and interfaces**
- `src/core/executor.ts`:
  - op handlers (download with hash check, upload-new, upload-replace per `capabilities.ts`, moves, deletes, trash, conflict procedure);
  - the order: pull side first, then push side [R-ORDER];
  - concurrency 4;
  - batched state saves;
  - 412 handling for metadata-only changes versus conflicts.
- `src/core/engine.ts`: `SyncEngine.requestSync(trigger)` with the single-flight lock and rerun flag, the phases from design §5, union-mode selection, and hooks for preview and delete confirmation (callbacks injected; the UI comes in M7).
- `src/core/upload-resume.ts`: resuming persisted `UploadSessionRecord`s [G-UP-9].
- `src/platform/obsidian-vault.ts`: `VaultPort` over the Obsidian APIs.
  - `writeAtomic` writes the hidden temp sibling `.mdvaultsync-tmp-<random>` through the adapter, then renames it into place.
  - `trash` calls `FileManager.trashFile`; `move` calls `Vault.rename` [O-API-7], [O-API-8], [O-API-10].
  - The containment check runs again right before the write (T-T1).
- `src/platform/plugin-state-store.ts`: `StateStore` over `sync-state.json`, written atomically. Wire it into sign-out, replacing the M2 stub.
- `src/core/remote-content.ts`: `RemoteContent` (design §2), the only caller of RemotePort content methods.
- Tests: `test/executor.test.ts` and `test/engine.test.ts` (FakeVault + FakeRemote).
  - Every op runs end to end.
  - Crash injection: throw after op *n* for each *n*, re-run, and assert convergence with no duplicate conflict copies.
  - Upload resume after an interruption mid-fragment; a session 404 restarts the upload.
  - A hash mismatch is discarded and reported.
  - Overlapping `requestSync` calls run sequentially, with at most one rerun.
  - **Edit during sync:** FakeVault changes a file between Scan and its download or trash. Assert no overwrite or trash, a conflict or deferral, and that the next run uploads the edit (R-CONF-4).
  - **Upload-session race:** FakeRemote changes the item's eTag while a replace session is mid-upload. Assert the session is cancelled before the final fragment and the conflict procedure runs (design §6.3).
  - **Conflict crash:** crash after the copy is written but before the download. Assert the re-run reuses the same `copyPath` (no second copy).
  - **Union crash:** crash during a union run after the delta save. Assert the next run is still union (`unionPending`) and emits no deletes.
  - **Transform seam:** run a full sync with an XOR-each-byte test transform. Assert FakeRemote stores only transformed bytes, both vaults end with the original plaintext, and no planner or executor code changed (R-ENG-4).
  - **Sign-out:** sign-out now calls the real `StateStore.clear()`. Assert the state file is gone and local files are untouched (R-AUTH-7).

**Manual checks**
- In a diagnostics sub-command, `adapter.rename` onto an existing file on Ubuntu and on the iPad. Record whether it overwrites. If not, `writeAtomic` uses remove-then-rename and research.md is updated [O-API-10].

**Acceptance criteria**
- The tests above pass.
- A fake end-to-end run of 1,000 files through two FakeVaults (device A and device B) sharing one FakeRemote converges in at most 2 runs per device, with zero data loss assertions passing.

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
```

**Verification output**
```
(paste here, plus manual rename results)
```

---

## M7: Obsidian integration and UI
**Status:** not started

**Goal.** A usable plugin: triggers, events, settings, status and notices (design §3, §10).

**Files and interfaces**
- `src/main.ts`: wiring. Registers vault events in `onLayoutReady` with the echo filter. Startup sync 5 s after layout ready. `registerInterval` timer. Commands `sync-now` and `sync-preview` (IDs without the plugin ID [O-SUB-3]). Ribbon icon. Status bar on desktop only [O-API-13]. No default hotkeys [O-GL-4].
- `src/ui/settings-tab.ts`: every R-UI-1 field, with headings through `setHeading()`, sentence case and no "settings" in headings [O-GL-2].
- `src/ui/plan-preview-modal.ts`, `src/ui/confirm-deletes-modal.ts` and `src/ui/report-view.ts` (built with `createEl` only [O-GL-3]).
- `src/ui/notices.ts`: notices for conflicts (persistent until dismissed), errors and sign-in required.
- `styles.css`: classes for the modals and report.

**Acceptance criteria**
- Lint passes with no warnings from `obsidianmd` rules.
- **Manual checks**, both devices, using a *test vault*, not the real one:
  1. The first sync shows the preview; Cancel does nothing.
  2. Edit a note: the timer sync uploads it, and the other device downloads it.
  3. Rename and move a note: the other device sees a move, and OneDrive version history is intact (check in OneDrive web).
  4. Delete a note: the other device puts it in trash per the Obsidian setting, and OneDrive has it in the recycle bin.
  5. Edit the same note on both devices offline, then sync both: one conflict copy named after the device, a notice listing it, and both versions present on both devices.
  6. Delete 30 % of the test vault: the confirm modal appears, and "Skip deletes" leaves the remote intact.
  7. The status bar on Ubuntu and the ribbon tooltip on iPad show the state and last sync time.
  8. "Sync now" pressed repeatedly during a sync doesn't start parallel runs (the log shows sequential runs).

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
```

**Verification output**
```
(paste here, plus manual check results 1–8)
```

---

## M8: Hardening and end-to-end test matrix
**Status:** not started

**Goal.** Close the remaining threat-model rows and prove v1 on real devices.

**Files and interfaces**
- `test/logging.sentinel.test.ts` (new)
- `src/ui/notices.ts`: the error-code → message table
- `src/ui/settings-tab.ts`: quota display
- `src/remote/graph.ts`: 507 / `quotaLimitReached` mapped to `GraphError` code `quota`
- `docs/threat-model.md`: a status column filled in

**Work**
- `test/logging.sentinel.test.ts`: a full fake sync with sentinel strings in file names, contents and tokens. The serialized log ring buffer and every `console.*` call contain none of them (R-SEC-3, T-I3).
- Error handling for 507 and `quotaLimitReached`, with a clear notice. Quota shown in settings when the scope allows it (T-D7) [G-QT-1].
- An error-code-to-notice mapping table in `src/ui/notices.ts`, with a unit test that every `GraphError` code maps to a message.
- Performance: a fake 5,000-file vault plans in under 2 s on desktop (logged).
- Review every row of docs/threat-model.md and mark each one implemented, or record why not.

**Manual end-to-end matrix** (owner; both devices; test vault):
| # | Scenario | Expected |
|---|---|---|
| 1 | Fresh device joins an existing remote vault | Preview, union download, no deletes |
| 2 | Airplane mode mid-sync, then reconnect | The next run resumes and the report is `partial` then `ok` |
| 3 | Force-quit Obsidian on iPad during a 50 MiB upload | Upload resumes from `nextExpectedRanges` |
| 4 | File at 101 MiB with a 100 MiB cap | Skipped, listed as `too-large` |
| 5 | Ubuntu: `Note.md` and `note.md` in the same folder | One syncs, one is reported `case-collision` |
| 6 | Ubuntu: a file named `a:b.md` | Reported `invalid-name` |
| 7 | Delete `Apps/MDVaultSync` in OneDrive web | Next sync treats it as first sync and re-uploads; no local deletes |
| 8 | Rename a file in OneDrive web | The local file is renamed; no conflict (metadata-only 412 path) |
| 9 | Sign out, then sign in | State cleared; first-sync union; no deletes |
| 10 | Revoke the app at account.microsoft.com | Next sync shows "Sign-in required" |
| 11 | Stale device rejoins: sign out on Ubuntu, edit 3 notes on iPad and sync, edit 1 *other* note on Ubuntu, sign in on Ubuntu | Preview shows "Differs on both sides, no sync history (4)"; after Run there are 4 conflict copies and nothing is lost |
| 12 | Type in a note continuously while a sync downloads a remote change to it | No keystrokes lost; conflict copy or deferred op (R-CONF-4) |

**Acceptance criteria**
- Every matrix row passes on both devices, with results recorded below.
- The sentinel test passes.
- The notice-mapping test passes.
- Every threat-model row is marked implemented, or has a recorded reason.
- `npm audit --audit-level=high` is clean.

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build && npm audit --audit-level=high
```

**Verification output**
```
(paste here, plus matrix results)
```

---

## M9: BRAT release 1.0.0 and README with the Entra guide
**Status:** not started

**Goal.** A first release, attested and built in CI, installable through BRAT on both devices.

**Files**
- `.github/workflows/release.yml` (**exists since M2**, pulled forward for BRAT pre-releases; M9 reviews it, adds the 1.0.0 release and the tag ruleset):
  - Triggers on a tag push matching exactly `[0-9]+.[0-9]+.[0-9]+` (no suffix; `manifest.json` versions are `x.y.z` [O-SUB-1]).
  - A `build` job (read-only token, no OIDC) runs `npm ci`, the standard checks and `npm run build`, and uploads the 3 files. A `release` job (no checkout, no npm) downloads them, re-checks that the tag still points at the built commit, then runs `actions/attest` over `main.js`, `manifest.json` and `styles.css` [O-REL-1], [C-GH-3]. This split came from the M2 review: dev-dependency code never runs next to `id-token: write`.
  - Creates a **draft** release with those assets.
  - Job permissions: `build` has `contents: read`; `release` has `contents: write`, `id-token: write`, `attestations: write`. Actions pinned by SHA. `test/workflows.test.ts` enforces all of this.
  - Verifies that the tag equals `manifest.json` version, and fails otherwise [O-SUB-2], [O-BRAT-1].
- `README.md`, complete:
  - what it does;
  - the required disclosures [O-POL-1], [O-POL-2];
  - **the full Entra setup guide** (copy of docs/entra-setup.md, verified in M2);
  - installing via BRAT (`caseke/MDVaultSync`);
  - settings reference;
  - conflict naming;
  - what's excluded;
  - the residual risks from threat-model §4;
  - how to verify a release: `gh attestation verify main.js -R caseke/MDVaultSync`;
  - uninstall and sign-out.
- `docs/community-checklist.md`: every item from [O-SUB-1] … [O-SUB-5] with pass or fail, plus the result of the community.obsidian.md "Review branch" preview if available.

**Owner actions**
- Add a tag protection (ruleset) for release tags.
- Publish the draft release after checking the assets.
- Install through BRAT on the iPad and on Ubuntu.
- Re-test sign-in 30 or more days after the Azure sign-up (cost-estimate "to re-check").

**Acceptance criteria**
- Tag `1.0.0` produces a draft release with 3 assets and an attestation.
- `gh attestation verify` succeeds on the downloaded `main.js`.
- BRAT installs 1.0.0 on both devices, and a sync round trip works.
- Every SPEC requirement is ticked in the table below.

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
npm version 1.0.0          # runs version-bump.mjs → manifest.json + versions.json; .npmrc tag-version-prefix="" makes tag 1.0.0
git push --follow-tags     # owner, on main after merge; pushes commit + tag 1.0.0, triggering release.yml
gh release download 1.0.0 -R caseke/MDVaultSync -p main.js && gh attestation verify main.js -R caseke/MDVaultSync
```

**Verification output**
```
(paste here)
```

---

## Requirement traceability
| Requirement | Milestone | Done |
|---|---|---|
| R-ENV-1…4 | M1, M2 | ☐ (M2 part done 2026-10-12: personal accounts only via /consumers, iPad and Ubuntu sign-in verified, minAppVersion 1.11.4) |
| R-AUTH-1…8 | M2 | ☑ (M2, 2026-10-12; R-AUTH-3 withdrawn. R-AUTH-7 token clear verified on Ubuntu; clearing real sync state is verified with the M6 StateStore) |
| R-SCOPE-1…4 | M4, M5, M7 | ☐ |
| R-TRIG-1…4 | M6 (lock), M7 | ☐ |
| R-CD-1 | M3, M5 | ☐ (M3 part done 2026-10-12: delta in three forms with paging to deltaLink; the form is chosen after the owner's probe) |
| R-CD-2 | M5, M7 | ☐ |
| R-CD-3, R-CD-4 | M4, M5 | ☐ |
| R-ORDER | M6 | ☐ |
| R-CC-1, R-CC-2 | M3, M6 | ☐ (M3 part done 2026-10-12: If-Match on replace, move, delete and replace sessions; conflictBehavior=fail on new files and folders; 412 → GraphError) |
| R-CONF-1…4 | M4, M5, M6, M7 | ☐ |
| R-DEL-1…3 | M5, M6 | ☐ |
| R-MOVE-1 | M5, M6 | ☐ |
| R-FIRST-1, R-FIRST-2 | M5, M7 | ☐ |
| R-GUARD-1 | M5, M7 | ☐ |
| R-PATH-1…4 | M4, M6 | ☐ |
| R-IO-1, R-IO-2 | M6 | ☐ |
| R-NET-1 | M2, M3 | ☑ (M2 and M3, 2026-10-12: auth and Graph go only through the requestUrl transport; lint and the CI script enforce it) |
| R-RES-1 | M3 | ☑ (M3, 2026-10-12: Retry-After with a global pause, full-jitter backoff, run budget; unit tested) |
| R-RES-2, R-RES-3 | M3, M6 | ☐ (M3 part done 2026-10-12: 10 MiB upload-session primitives, status and 404 handling; persistence and resume are M6) |
| R-UI-1…3 | M2, M7 | ☐ (M2 part done 2026-10-12: Account section) |
| R-SEC-1, R-SEC-2 | M2 | ☑ R-SEC-1 (unit tested); ☑ R-SEC-2 M2 part (SecretStorage observed on both devices, including a locked GNOME keyring) — README residual-risk text is owed in M9 |
| R-SEC-3 | M3, M8 | ☐ (M3 part done 2026-10-12: typed redacting logger, unit tested; the sentinel test is M8) |
| R-SEC-4 | M3, M4 | ☐ (M3 part done 2026-10-12: Graph JSON, ids, names, sizes, tags, hashes, links and transfer URLs validated; paths are M4) |
| R-SEC-5 | M1, M9 | ☐ (M1 part done: lockfile, Dependabot, CodeQL, audit, SHA pins, and secret scanning and push protection verified 2026-10-12; release attestation is M9) |
| R-SEC-6 | M1 | ☑ (M1, 2026-10-12) |
| R-ENG-1…5 | M1 onward | ☐ |
