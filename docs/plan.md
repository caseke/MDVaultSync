# MDVaultSync build plan

Nine milestones, each sized for one Claude Code session. Do them in order. Each one builds on the interfaces defined in [design.md](design.md) and satisfies requirements in [SPEC.md](../SPEC.md).

## Session protocol (every implementation session)
1. **Read.** Read `CLAUDE.md`, `SPEC.md`, `docs/design.md`, and this file. Find the first milestone whose status isn't `done`. Read the research facts it cites. Read that milestone's **Carry-ins** list too: each item is a requirement for the milestone, handed over by an earlier milestone's build or security review, and it overrides nothing in SPEC.md.
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
**Status:** done (2026-10-12). The probe passed with `errors: 0` on Ubuntu and on the iPad (0.3.5). The results are applied in `capabilities.ts` (`CAPABILITIES_PROBED = true`), research.md and design.md, and the transfer-host allowlist is narrowed (0.3.6).

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

**Verification output** (session container, Node v22.22.0, 2026-10-12, M3 close commit, 0.3.6)
```
$ npm ci --ignore-scripts --no-fund      → exit 0; added 339 packages; 3 moderate (unchanged, see M1 "Optional")
$ npm run lint                           → exit 0, 0 errors, 2 warnings (settings-tab.ts, the M2 declarative-settings warnings)
$ npm run typecheck                      → exit 0
$ npm test
# tests 306
# suites 8
# pass 306
# fail 0
$ npm run build                          → exit 0 (main.js 41073 bytes)
$ npm audit --audit-level=high           → exit 0
$ scripts/check-network-apis.sh
no forbidden network APIs
$ node --test --experimental-test-coverage "test/**/*.test.ts"   (line % | branch % | funcs %)
  retry.ts            100.00 | 96.67 | 100.00
  validate.ts          99.38 | 98.20 | 100.00
  graph.ts            100.00 | 95.00 | 100.00
  upload-session.ts   100.00 | 97.62 | 100.00
  errors.ts, logger.ts, http.ts, capabilities.ts  100.00 lines
  probe.ts             96.37 lines
```
The first session-close run (289 tests, before the probe rounds) is in the commit history. 0.3.1–0.3.6 each ran the same gate before their commits.
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

**Probe v2 (0.3.1), Ubuntu, 2026-10-12** (owner; whitespace compacted):
```
{
  "probeVersion": 2, "platform": "linux", "pluginVersion": "0.3.1",
  "startedAt": "2026-10-12T05:10:26.258Z", "durationMs": 31160,
  "approot": { "ok": true, "parentPath": "/drive/root:/Apps", "name": "MDVaultSync", "pathPrefixLength": 16 },
  "leftoverRemoved": false,
  "delta": {
    "approot-colon": { "ok": false, "code": "InvalidResponse" },
    "items-id": { "ok": true, "pages": 1, "items": 5, "approotListed": true, "filesWithHash": 3, "filesWithoutHash": 0 }
  },
  "putIfMatch": { "honored": true, "staleStatus": 412, "staleCode": "notAllowed" },
  "caseInsensitive": { "confirmed": true, "status": 409, "code": "nameAlreadyExists" },
  "nameLength": {
    "len255": { "status": 201 }, "len256": { "status": 201 },
    "len300": { "status": 400, "code": "invalidRequest", "innerCodes": ["badArgument"] }, "nameMax": null
  },
  "patchIfMatch": { "currentStatus": 200, "staleStatus": 412 },
  "deleteIfMatch": { "staleStatus": 412, "currentStatus": 204 },
  "quota": { "readable": true },
  "largeFile": {
    "ok": false, "size": 12582912, "fragments": 2,
    "createAttempts": [ { "variant": "conflictBehavior+fileSize", "status": 400, "code": "invalidRequest" } ],
    "stage": "create", "code": "UntrustedUrl"
  },
  "hashVectors": [ same three vectors as v1 ],
  "cleanup": { "ok": true }, "errors": 1
}
```

What v2 settled, applied in 0.3.2 (`capabilities.ts`, pinned by `test/capabilities.test.ts`):
- **Delta:** `items-id` works, with one page, the approot listed and hashes on every file, so `DELTA_FORM = "items-id"`. `approot-colon` fails our validation and isn't used [G-DL-1], [G-DL-8].
- **PUT honors If-Match** (second observation), so `PUT_HONORS_IF_MATCH = true` [G-UP-3].
- **Name limit:** 256 is accepted and 300 is rejected (`badArgument`, with the path under 400). `NAME_MAX` stays 255 [G-NM-6].
- **createUploadSession:** the body with `fileSize` → 400 again. The body without it was accepted: the session was created, but its `uploadUrl` failed our host allowlist (`UntrustedUrl` at parse, which is why that attempt wasn't listed). The 0.3.1 fix (no `fileSize`) is confirmed. **The upload host is missing from design §8's list**, and v2 couldn't say which host, because it only reported hostnames that pass.
- 0.3.2 also stops `getItem` from failing on an unlisted download host. The host is now checked only in `download()`.
- `CAPABILITIES_PROBED` stays `false` until the upload host is allowlisted and the round trip passes on the iPad.

**Probe v3 (0.3.2), Ubuntu, 2026-10-12** (owner; only `largeFile` differs from v2):
```
"largeFile": {
  "ok": false, "size": 12582912, "fragments": 2,
  "createAttempts": [
    { "variant": "conflictBehavior+fileSize", "status": 400, "code": "invalidRequest" },
    { "variant": "conflictBehavior", "status": 200, "rejectedHost": "my.microsoftpersonalcontent.com" }
  ],
  "rejectedUploadHost": "my.microsoftpersonalcontent.com",
  "stage": "create", "code": "UntrustedUrl"
}
(durationMs 19885; every other field equals v2)
```
The upload host is `my.microsoftpersonalcontent.com`. WHOIS (2026-10-12) shows the domain belongs to Microsoft Corporation (registrar MarkMonitor, created 2020-06-18). 0.3.3 adds `.microsoftpersonalcontent.com` to `TRANSFER_HOST_SUFFIXES` [G-UP-11]. The download host is still unobserved, because v3 stopped at `create`.

**Probe v3 on 0.3.3, Ubuntu, 2026-10-12** (owner; only `largeFile` and the new vector differ from v2):
```
"largeFile": {
  "ok": false, "size": 12582912, "fragments": 2,
  "createAttempts": [
    { "variant": "conflictBehavior+fileSize", "status": 400, "code": "invalidRequest" },
    { "variant": "conflictBehavior", "status": 200 }
  ],
  "uploadHost": "my.microsoftpersonalcontent.com", "uploadMs": 13625,
  "stage": "download", "code": "InvalidResponse"
}
"hashVectors" adds: { "file": "large.bin", "size": 12582912, "generator": "probeBytes(12582912, seed)",
                      "seed": 1296324179, "quickXorHash": "ZxozysDdwfh/G5yk00nGRvIqEAI=" }
(durationMs 42290)
```
- **The upload works.** 12 MiB went up in two fragments (10 + 2 MiB) to `my.microsoftpersonalcontent.com` in 13.6 s on Ubuntu Electron (O-API-2). OneDrive's hash of `large.bin` is a fourth M4 vector.
- **The download step failed before any download request.** `downloadHost` would have been recorded first, and it wasn't. So either the download URL was longer than the 8192-character cap or wasn't a string, or it was missing from the response. v3 couldn't tell which: `InvalidResponse` carried no reason.
- 0.3.4 (probe v4):
  - `InvalidResponse` now carries a fixed reason code (`download-url-missing`, `download-url-too-long`, `download-url-invalid`, `not-a-file`, `download-length-mismatch`).
  - The probe reads the large file with and without `$select` and records URL presence, type, length and host (`largeFile.downloadDiag`).
  - `getItem` no longer parses the download URL at all, so URL problems affect only downloads.

**Probe v4 on 0.3.4, Ubuntu, 2026-10-12** (owner; only `largeFile` is new):
```
"largeFile": {
  "ok": false, "size": 12582912, "fragments": 2,
  "createAttempts": [
    { "variant": "conflictBehavior+fileSize", "status": 400, "code": "invalidRequest" },
    { "variant": "conflictBehavior", "status": 200 }
  ],
  "uploadHost": "my.microsoftpersonalcontent.com", "uploadMs": 7141,
  "downloadDiag": {
    "select": { "status": 200, "urlPresent": false },
    "plain":  { "status": 200, "urlPresent": true, "urlType": "string", "urlLength": 1087,
                "host": "my.microsoftpersonalcontent.com" }
  },
  "downloadHost": "my.microsoftpersonalcontent.com", "downloadHostTrusted": true,
  "stage": "download", "code": "InvalidResponse", "reason": "download-url-missing"
}
(durationMs 33793; every other field equals v3)
```
- **Cause found.** OneDrive personal omits `@microsoft.graph.downloadUrl` from any `$select` response, even though the get-content doc says to select it. The default response carries it (1087 characters, on `my.microsoftpersonalcontent.com`, already trusted) [G-DLD-1].
- 0.3.5: `download()` reads the item with no `$select`, and `ITEM_SELECT` no longer asks for the URL. FakeGraph now behaves this way by default, so every download test uses the real server shape.
- Upload took 7.1 s this run, 13.6 s in the previous one (Ubuntu).

**Probe v4 on 0.3.5, Ubuntu, 2026-10-12: PASS** (owner; local build; every field except `largeFile`, `durationMs` and `errors` equals v4):
```
"largeFile": {
  "ok": true, "size": 12582912, "fragments": 2,
  "createAttempts": [
    { "variant": "conflictBehavior+fileSize", "status": 400, "code": "invalidRequest" },
    { "variant": "conflictBehavior", "status": 200 }
  ],
  "uploadHost": "my.microsoftpersonalcontent.com", "uploadMs": 5815,
  "downloadDiag": {
    "select": { "status": 200, "urlPresent": false },
    "plain":  { "status": 200, "urlPresent": true, "urlType": "string", "urlLength": 1087,
                "host": "my.microsoftpersonalcontent.com" }
  },
  "downloadHost": "my.microsoftpersonalcontent.com", "downloadHostTrusted": true,
  "downloadMs": 4278, "bytesMatch": true
}
"cleanup": { "ok": true }, "errors": 0   (durationMs 34235)
```
Every probe question is answered on Ubuntu. The 12 MiB round trip works through `my.microsoftpersonalcontent.com` (up 5.8 s, down 4.3 s), with identical bytes. The download URL comes from the unselected item read (the 0.3.5 fix). The four `hashVectors` (the v4 run carries all four) are final for M4.

**iPad (0.3.5)**, the last M3 check (O-API-2, T-D6). Steps:
1. Publish **only 0.3.5**: Releases → draft `0.3.5` → Publish release. It contains every fix. The 0.3.3 and 0.3.4 drafts aren't needed; BRAT never sees drafts [O-BRAT-1], so leave them or delete them.
2. On the iPad: BRAT → **Check for updates to all beta plugins**. Confirm that Settings → Community plugins shows MDVaultSync 0.3.5.
3. Command palette (swipe down on a note, or **Open command palette**) → **MDVaultSync: Run OneDrive capability probe**. Keep Obsidian in the foreground until the result appears.
4. Pass: `largeFile.ok` and `bytesMatch` are `true`, and `errors` is 0. Record whether Obsidian stayed responsive (you could scroll or open a note while it ran), then paste the JSON below.
**Probe v4 on 0.3.5, iPad, 2026-10-12: PASS** (owner; installed through BRAT from the published 0.3.5; every field except `platform`, `largeFile`, `durationMs` and `errors` equals the Ubuntu run):
```
"platform": "ios", "durationMs": 30063,
"largeFile": {
  "ok": true, "size": 12582912, "fragments": 2,
  "createAttempts": [
    { "variant": "conflictBehavior+fileSize", "status": 400, "code": "invalidRequest" },
    { "variant": "conflictBehavior", "status": 200 }
  ],
  "uploadHost": "my.microsoftpersonalcontent.com", "uploadMs": 4450,
  "downloadDiag": {
    "select": { "status": 200, "urlPresent": false },
    "plain":  { "status": 200, "urlPresent": true, "urlType": "string", "urlLength": 1087,
                "host": "my.microsoftpersonalcontent.com" }
  },
  "downloadHost": "my.microsoftpersonalcontent.com", "downloadHostTrusted": true,
  "downloadMs": 5345, "bytesMatch": true
}
"cleanup": { "ok": true }, "errors": 0
Responsive during the run: not reported
```
- **iPad (O-API-2, T-D6):** `requestUrl` on iOS uploaded 12 MiB in two fragments (4.5 s) and downloaded it whole (5.3 s), with identical bytes. Every server-side answer matches Ubuntu.
- Responsiveness wasn't reported. That is a usability observation, not a pass/fail criterion; the round trip completed without a crash.

**Results applied at M3 close (0.3.6):**
- `capabilities.ts`: `CAPABILITIES_PROBED = true`, `PUT_HONORS_IF_MATCH = true`, `DELTA_FORM = "items-id"`, `NAME_MAX = 255`.
- **Transfer-host allowlist narrowed** to `.microsoftpersonalcontent.com` (the only host observed, for uploads and downloads on both devices) plus `.1drv.com`, `.onedrive.com` and `.livefilestore.com`.
  - Those three are OneDrive personal content endpoints in Microsoft's required-URL list. They're kept so a server-side host change fails over rather than stopping transfers.
  - Dropped: `.sharepoint.com`, because any company can own a tenant subdomain, so a tampered URL could send bytes there.
  - Dropped: `.microsoft.com` and `.live.com`: huge zones with no observed transfer use.
  - An exact-host list was considered and rejected: the first Microsoft host change would stop every upload and download.

**Manual checks** (owner; use a throwaway test vault, never the real one)
1. **Install the newest 0.3.x** (now 0.3.5). `git switch claude/eloquent-clarke-21deia && git pull`, then `git tag 0.3.5 && git push origin 0.3.5`. (0.3.0–0.3.4 ran probes v1–v4 on Ubuntu; see above.)
   - Wait for the **Release** workflow to pass.
   - Open the draft release, check that it has the three assets and is marked pre-release, then publish it.
   - Ubuntu: `npm ci && npm run build`, then copy `main.js`, `manifest.json` and `styles.css` into the test vault's plugin folder (as in M2), or install through BRAT.
   - iPad: BRAT → **Check for updates to all beta plugins**.
2. **Run the probe on Ubuntu.** Sign in if needed. Open the command palette (Ctrl+P; on the iPad, swipe down on a note or use **Open command palette**) and run **MDVaultSync: Run OneDrive capability probe**. There is no settings button until M7.
   - Expect a window that says it is running. After up to a minute it shows JSON. Select **Copy result** and paste it into the block above.
   - Pass: `probeVersion` is 3 or later, `cleanup.ok` is `true`, `largeFile.bytesMatch` is `true`, and OneDrive web shows no `.mdvaultsync-probe` folder in `Apps/<your app name>` afterwards. The probe's items are in the OneDrive recycle bin; you can empty it.
3. **Run the probe on the iPad**, the same way. Probe 8, the 12 MiB round trip, is the one the plan requires on the iPad (O-API-2, T-D6). Record whether Obsidian stayed responsive while it ran.
4. **A follow-up session applies the results:**
   - `src/remote/capabilities.ts`: `PUT_HONORS_IF_MATCH` from `putIfMatch.honored`; `DELTA_FORM` = the first form with `ok: true`, or `children-walk` if neither works (then the design §5.2 fallback applies and the M5 planner must not assume delta semantics); `NAME_MAX` from `nameLength.nameMax`; then `CAPABILITIES_PROBED = true`.
   - research.md rows: G-AF-1 (`approot`), G-DL-1 and G-DL-8 (`delta`), G-UP-3 (`putIfMatch`), G-NM-5 (`caseInsensitive`), G-NM-6 (`nameLength`), G-AF-5 (`patchIfMatch`, `deleteIfMatch` and `delta`), G-QT-1 (`quota`), and O-API-2 (`largeFile`).
   - Narrow `TRANSFER_HOST_SUFFIXES` to the observed `uploadHost` and `downloadHost` suffixes. (Done in 0.3.6 with a deliberate deviation: three unobserved OneDrive content suffixes stay as failover; see **Results applied at M3 close**.)
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
- ~~**For M6:** the `.microsoft.com` transfer suffix is still broad.~~ Resolved in 0.3.6: the list was narrowed at M3 close (see **Results applied at M3 close**).
- **For M6:** downloads are length-checked only after `requestUrl` has buffered the whole body. The executor must skip items over the size cap before calling `download` (D-12, T-D6).
- **For M6:** `GraphClientOptions.transferTransport` falls back to `transport` when omitted, which only tests do. It is safe either way, because the Graph host is refused and `AuthorizingTransport` strips Authorization from non-Graph hosts. It could be made required.
- Review of 0.3.2 (ec47424, `security-reviewer`): no high or medium findings. Fixed, low: hostnames in the probe output are capped at 253 characters, and `NAME_LIMIT` now derives from `NAME_MAX`. Open, low (optional, for M6): `getItemWithUrl` returns the unchecked `downloadUrl` as a plain string. It is private and its only fetching caller (`download`) checks it first; a branded `UncheckedUrl` type would make that structural. Info for M6: when the executor starts using `PUT_HONORS_IF_MATCH`, keep the upload-session path as the fallback, and make sure a stale replace still surfaces as 412.
- Review of 0.3.3 (4103019, `security-reviewer`): no high or medium findings. The new suffix matches only real subdomains of a Microsoft-registered zone, and the upload host never gets the token. Fixed, low: a stale design §8 sentence and a test title. Closed by decision at M3 close: the exact-host list was rejected, and three OneDrive content suffixes were kept as failover. See **Results applied at M3 close** for the reasons.
- Review of 0.3.4 (b32dccb, `security-reviewer`): no high or medium findings. It confirmed that no request goes to an unchecked download URL, that the probe output holds only presence, type, length and hostname, and that `getItem` returns only validated fields. Fixed, low: `InvalidResponse.reason` is a closed union type, so the compiler rejects data as a reason. Fixed, info: a test for `download-url-invalid`.
- Review of 0.3.5 (d0484ff, `security-reviewer`): no high or medium findings. It confirmed the unselected item read still goes through the 32 MiB cap, `parseDriveItem` and the download-URL checks before any request, and that no Authorization reaches the download host. Info: the full response also carries `createdBy`/`lastModifiedBy`; these stay in memory, are never logged, and are dropped after `download()`. Fixed, info: the new test also asserts no Authorization on the download request.
- **Final review at M3 close** (a17d4cd, `security-reviewer`, M3 `src/` diff 643cc29..a17d4cd plus the close commit): no high or medium findings. It confirmed that every transfer request passes `checkTransferUrl`, that the narrowed list accepts every observed host (and the test fakes' hosts), and that no token reaches a transfer host. Fixed, low: four stale doc lines (this line, the two open allowlist items below, manual-check step 4, and research.md O-API-2). Info, carried forward:
  - **M8:** `requestUrl` follows redirects from an allowlisted transfer host without re-checking the target (O-API-2). No token can go along, because the transport is bare. Download bytes are length-checked now and hash-checked in M6 (T-T4). Note it in the M8 hardening review.
  - **M6:** skip items over the size cap before `download()`; the length check runs after buffering (T-D6).
  - ~~**Optional for the owner:** the 0.3.6 allowlist was unit-tested but not run live.~~ **Confirmed live** (Ubuntu, 0.3.6, `startedAt` 2026-10-12T06:48:42Z):
    - `errors: 0`, `largeFile.ok: true`, `bytesMatch: true`, `downloadHostTrusted: true`;
    - upload 8.3 s and download 6.1 s via `my.microsoftpersonalcontent.com`;
    - every other answer matches the 0.3.5 runs.
    - `leftoverRemoved: true`: an earlier interrupted run had left `.mdvaultsync-probe` behind, and the probe removed it as designed. That exercised the leftover path live.
    - **iPad, 0.3.6** (`startedAt` 2026-10-12T06:51:28Z): also `errors: 0`, `largeFile.ok: true`, `bytesMatch: true`, `downloadHostTrusted: true`, with upload 8.0 s and download 3.5 s via `my.microsoftpersonalcontent.com`; every other answer matches. The narrowed allowlist is confirmed on both devices.
  - The iPad record shows only the fields that differ from Ubuntu, and responsiveness wasn't reported. Both are stated openly above.
- When the upload URL is off the allowlist, the probe leaves that server-side upload session uncancelled (cancelling would mean contacting the unlisted host). OneDrive expires it [G-UP-9].
- The probe leaves its test files in the OneDrive recycle bin (about 12 MiB, which counts toward quota [G-DEL-2]) until the user empties it.
- The command's display name is "Run OneDrive capability probe", not design §10's "Run Graph capability probe", because the obsidianmd sentence-case rule flags "Graph".

---

## M4: Pure helpers (hash, paths, exclude, transform)
**Status:** done (2026-10-12). Implementation 00d9dc0, plus the security-review fixes and close-out in the next commit. No manual checks.

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

**Verification output** (2026-10-12, after the security-review fixes; Node 24, container)
```
$ npm run lint
✖ 4 problems (0 errors, 4 warnings)
  (2 pre-existing in src/ui/settings-tab.ts; 2 are the `.obsidian` test fixture constants in test/paths.test.ts and test/exclude.test.ts,
   obsidianmd/hardcoded-config-path, deliberate: the acceptance criteria require testing the default configDir)
$ npm run typecheck
> tsc --noEmit                        (exit 0)
$ npm test
# quickXorHash 100 MiB: 145 ms        (logged, not asserted; criterion is < 3 s)
# tests 501
# suites 8
# pass 501
# fail 0
$ npm run build
> tsc --noEmit && node esbuild.config.mjs production   (exit 0)
$ npm audit --audit-level=high
3 moderate severity vulnerabilities   (exit 0; none high; lockfile unchanged since M3)
```

**What was built** (`src/core/`, no `obsidian` import, no runtime dependency):
- `quickxor.ts`: `QuickXorHasher` (incremental, chunk-independent) and `quickXorHash(data)`. It folds byte n into slot n mod 160 and applies the 160 shifts once in `digest()`; the length XOR uses 32-bit halves (no `BigInt`).
- `paths.ts`: `NAME_MAX`, `PATH_MAX`, `caseKey`, `isConfigDirName`, `toVaultPath`, `validateSegment`, `validatePath`, `containmentProblem` (the M6 pre-write re-check), `remoteToVaultPath` and `findCollisions`.
- `exclude.ts`: `exclusionReason` and `isExcluded`, implementing the gitignore subset written down in design §7.
- `transform.ts`: `IdentityTransform`; re-exports the `ContentTransform` types from `ports.ts`, which stays the single definition.
- `conflict-name.ts`: `conflictCopyPath(path, deviceName, date, exists, pathPrefixLen)` and `sanitizeDeviceName`.

**Tests added:** `test/quickxor.test.ts` (the four OneDrive probe vectors, all 70 rclone vectors [G-HASH-3], chunk sizes 1–512 and across the 160-byte period, views, 100 MiB timing), `test/paths.test.ts`, `test/exclude.test.ts`, `test/transform.test.ts`, `test/conflict-name.test.ts`. Each acceptance criterion maps to named tests: every design §7 rule (each invalid character, U+0000–U+001F, each reserved name with and without an extension, trailing space or period, leading `~`, `_vti_`, 255/256–400-character names, 400 vs 401 with the `Apps/MDVaultSync` prefix, NFC/NFD, case collisions), every listed containment case, and configDir, hidden and user-glob exclusion.

**Deviations from this milestone's text** (recorded in design.md §7 and §8):
- `conflictCopyPath` takes a required `pathPrefixLen` (the 400-character budget needs it) and shortens the *copy's* stem when the name or path would be too long. The user's file is never renamed (D-17).
- `findCollisions(rawPaths, tracked)` also compares folders, including implied ones. A losing folder takes its descendants with it, since OneDrive would merge the two folders.
- `remoteToVaultPath(segments, configDir, pathPrefixLen, isFolder)` runs containment and then `validatePath`, so one call covers the M3 carry-in. `containmentProblem` was added for M6's pre-write check.
- `exclusionReason` returns `"hidden" | "excluded" | null` (the skip reason); `isExcluded` is the boolean wrapper. Both take an optional `isFolder`.
- configDir is compared case-insensitively under two folds (`isConfigDirName`).
- Names containing U+00A0 or U+202F are `invalid-name` (security review, below).

**Security review** (`security-reviewer` agent; base 0fa7f31):
- No high findings. It found no input that makes `remoteToVaultPath` return a path outside the vault, inside configDir, or with a hidden segment.
- Fixed, medium: Obsidian's `normalizePath` is believed to map U+00A0 and U+202F to a space; this is undocumented in `obsidian.d.ts`. Two remote names differing only there would then share one local file. `validateSegment` now rejects such names on both sides, so they are skipped and reported instead.
- Fixed, low:
  - The configDir check also uses an upper-then-lower fold, so `ſettings` (U+017F) can't land in a configDir named `settings`.
  - `exclusionReason` NFC-normalizes the path.
  - `sanitizeDeviceName` replaces `_vti_`, so the conflict copy stays uploadable.
  - `pathPrefixLen` is required.
- Re-review of the fix diff (`security-reviewer`): every finding above is confirmed resolved, with no new high, medium or low issues. Info, fixed: U+1E9E "ẞ" (fully case-folds to "ss") passed both folds; `isConfigDirName` now also compares lower-upper-lower, and a test covers it. Info, carried forward: see the M6 note on `validatePath` below, and local files with NBSP in their name are now skipped, which falls under the existing M5 "a skip never deletes" requirement (T-D1).

**Notes for M5 and later** (carry-ins from the review and the build):
- **M5 must** call `remoteToVaultPath` for every remote item's rebuilt name chain and skip on `ok: false`. It must call `exclusionReason` with the real configDir, and `findCollisions` on the raw local paths with `tracked` = the NFC paths in `files`.
- **M5 must** group remote-derived VaultPaths by path and by `caseKey`, and skip every member of a group as `unicode-collision` or `case-collision`. Remote names that differ only in normalization map to one VaultPath, and `findCollisions` sees only local paths (review, low). Test it.
- **M5:** match remote and local by `caseKey` (design §5.4). `caseKey` deliberately stays `toLocaleLowerCase("en-US")`; the wider fold is used only for configDir.
- **M6:** the `exists` callback for `conflictCopyPath` must be case-insensitive. A `RangeError` from it means "conflict not resolved, keep both sides untouched", never an overwrite (review, info). Call `containmentProblem` right before every local write, and `validatePath` on the same final path: `containmentProblem` checks containment only, so the name rules (the NBSP rule included) need `validatePath` (re-review, info).
- **M7:** the exclude-setting help must say that `!` lines and backslash escapes are unsupported and that matching is case-sensitive, so on the iPad a remote `PRIVATE/` isn't excluded by `Private/` (review, info). Consider escaping or rejecting C1 controls, DEL and bidi overrides when names are shown in reports (review, info: they can't escape the vault, but they can spoof names).

---

## M5: Sync planner and state (pure)
**Status:** done (2026-10-12). Implementation in the "M5: sync planner…" commit, security-review fixes and close-out in the next one. No manual checks.

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

**Carry-ins** (requirements handed over by earlier milestones; each names its source)
- **Skips never delete** (M3 review of 0.3.1, see M3 **Security review**): a skipped remote item (a name over 255, or any other skip reason) must never produce a local or remote delete, and it counts as a child for the folder-delete rule R-DEL-3 (T-D1). Test both. Since M4 this also covers local files whose names contain U+00A0 or U+202F, which `validateSegment` now skips (M4 re-review).
- **Use the M4 path helpers** (M4 **Notes for M5 and later**): call `remoteToVaultPath(segments, configDir, pathPrefixLen, isFolder)` for every remote item's rebuilt name chain (approot excluded) and skip on `ok: false` with its reason. Call `exclusionReason(path, configDir, patterns, isFolder)` with the real configDir. Call `findCollisions(rawLocalPaths, tracked)` with `tracked` = the NFC paths in `files`.
- **Remote-side collisions** (M4 review, low): remote names that differ only in Unicode form or case map to one VaultPath, and `findCollisions` sees only local paths. Group remote-derived VaultPaths by exact path and by `caseKey`, and skip every member of a group as `unicode-collision` or `case-collision`. Test it.
- **Matching key** (M4): match remote and local by `caseKey` (design §5.4). Don't use `isConfigDirName`'s wider fold for matching; it exists only for the configDir check.

**Acceptance criteria**
- The tests above pass.
- `src/core/**` has no `obsidian` import (the lint rule passes).
- Planner line coverage is at least 95 %.

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
node --test --experimental-test-coverage "test/**/*.test.ts" 2>&1 | grep -E "planner|state|remote-tree"
```

**Verification output** (2026-10-12, after the security-review fixes; Node 22.22, container)
```
$ npm run lint
✖ 4 problems (0 errors, 4 warnings)
  (unchanged since M4: 2 in src/ui/settings-tab.ts, 2 `.obsidian` fixture constants in test/paths.test.ts and
   test/exclude.test.ts. The M5 fixtures use a renamed configDir, "obs-config", so they add none.)
$ npm run typecheck
> tsc --noEmit                        (exit 0)
$ npm test
# tests 636
# suites 8
# pass 636
# fail 0
$ npm run build
> tsc --noEmit && node esbuild.config.mjs production   (exit 0)
$ node --test --experimental-test-coverage "test/**/*.test.ts" 2>&1 | grep -E "planner|state|remote-tree"
#   planner.ts                    |  98.60 |    97.46 |   94.23 | 222-225 469-472
#   remote-tree.ts                | 100.00 |    96.97 |  100.00 |
#   state.ts                      |  98.90 |    94.59 |   97.62 | 245-246 325-326
#   (report.ts 100.00 | 100.00 | 100.00; planner line coverage 98.60 % ≥ 95 %)
$ npm audit --audit-level=high
3 moderate severity vulnerabilities   (exit 0; none high; lockfile unchanged)
```

**What was built** (`src/core/`, no `obsidian` or `src/remote` import, no dependency):
- `planner.ts`: `plan(state, local, remoteIndex, settings)` and `exceedsDeleteGuard(plan, pct)`. Planner-local input types `ScannedEntry` (raw path, size, mtime, `localHash`, `storedHash`) and `PlanSettings`. Filters, blocked keys, folder-rename collapse, file renames by id / event / unique hash, the §5.4 table, folders, declined deletes, deterministic order (skips, moves, then the rest).
- `remote-tree.ts`: `buildRemoteTree(index, appRootId, configDir, pathPrefixLen)`: paths from parentId chains, every chain through `remoteToVaultPath`, sibling unicode/case collisions skipped with descendants, `childCount` including skipped children, `unresolvedIds` for live items it can't place.
- `state.ts`: `emptyState`, `parseSyncState` (every field guarded; keys equal records; containment on every path; a replace session without If-Match rejected; a bad `lastReport` dropped), `loadState` (malformed → fresh union state, valid deviceId kept), `applyAppRoot` (D-18).
- `report.ts`: `buildReport` and `opPath` (T-R1; codes filtered with `LOG_CODE_RE`).

**Tests added:** `test/planner.test.ts` (65: one per §5.4 row, every rename case, folder collapse both ways, folders, union with and without bases, approot change, R-DEL-3 with a too-large child, guard boundary, declined deletes, null hash, every SkipReason, the carry-ins and the review regressions), `test/planner.property.test.ts` (5,000 seeded cases with remote moves; invariants (a)–(e); determinism), `test/state.test.ts`, `test/remote-tree.test.ts`, `test/report.test.ts`, `test/fake-remote.test.ts`. Fakes: `test/fakes/fake-remote.ts` (OneDrive rules), `fake-vault.ts`, `plan-fixtures.ts`. Three mutations (union upload removed, move order reverted, the local-move of a remote rename dropped) were confirmed to fail the property test.

**Deviations and clarifications** (recorded in design.md §5.4 "M5 implementation"):
- Case-only remote renames keep the *local* spelling in the record and emit nothing (the design said the record takes the remote spelling; on ext4 that path doesn't exist locally). Local case-only renames still go out as `remote-move`. No loop.
- `deleteCount` counts file deletes only (R-GUARD-1 is a share of tracked files). Folder deletes are still only planned when empty.
- Both sides renamed to the same target → `adopt` (record update). No new PlanOp kind; `ports.ts` is unchanged.
- New folders are emitted even when not empty, so M6 can create folders explicitly.
- A tracked file renamed to a name or size we skip blocks its record (no remote delete); moving into a hidden or excluded folder (Obsidian's `.trash`) is still a delete.
- `applyAppRoot` also clears `pendingConflicts` and `declinedDeletes`.

**Security review** (`security-reviewer` agent; base 38e03fd plus the uncommitted M5 files):
- Fixed, high: a move was sorted by its destination, so a write at its source could run first. A remote "archive" rename (`daily.md` → `daily-old.md` plus a new `daily.md`) would have downloaded the new file over an unsynced local edit before the move. All moves now come before all other ops; a test covers the scenario, and the property test now generates remote moves and new items at vacated paths and checks the order.
- Fixed, medium: a pending conflict's `copyPath` was reused unchecked; a stale or forged one could point the copy write at another note or at the original. It is now reused only for the same pair and only where nothing else lives; the parser rejects a copy path equal to its original.
- Fixed, medium: a live remote item whose parent chain doesn't reach the approot was treated as deleted (`local-trash`). It is now `unresolved` and its base is blocked.
- Fixed, low: a state with records but no `appRootId` saw an empty remote. It now plans in union mode, and `applyAppRoot` from null with records sets `unionPending`.
- Fixed, low: the property test didn't cover moves. It now generates remote moves and new items at vacated paths, checks move order (invariant (e)), and checks that no download or trash at a moved path loses local bytes found nowhere else (local edits include unique bytes, so the check can fire; final re-review).
- Found by the extended property test while fixing the above: once a tracked case-collision keeper moved away, a new remote file at that key was downloaded onto the skipped loser. Keys that hold a skipped local file now get no transfers.
- Carried to M6 (below): hashing name-skipped files in the scan, `__proto__`-safe state maps, eTag chaining after a move. Info for M7: list folder deletes in the guard modal; render report paths with `createEl` only.
- Re-review of the fix diff (`security-reviewer`, two passes): the high, both mediums, the low and the property-test find are confirmed resolved. It found one regression from the unresolved-items fix, **fixed, medium**: a live child of a *tombstoned* folder was treated as unresolved (blocked forever) instead of deleted. `buildRemoteTree` now follows the parent chain: under a deleted ancestor the item is gone; only a chain ending at a missing id or a cycle is unresolved. Tests cover trash (normal) and restore (union). Also fixed, low: design §5.5 now states the move-first order for M6, and §5.2 requires the delta merge to drop a deleted folder's descendants. Fixed, info: a reused copy path is also checked against names chosen earlier in the run. Final pass (`security-reviewer`): every round-2 item confirmed resolved, nothing new high or medium; its low (the moved-path byte check was vacuous) and info (own-key parent lookup in `buildRemoteTree`) are fixed. Open, info (owner's call): unresolved bases are reported as `outside-vault`; a distinct `SkipReason` would need a `ports.ts` change.

**Notes for M6 and later** (carry-ins from the build and the review):
- **Order** (design §5.5): within a side, run moves first, one at a time and each to completion, in plan order; create a missing parent folder on demand for a move or upload (a planned folder `upload-new` then adopts). Running a move concurrently with a write at its source brings back the M5 high finding.
- **Delta merge** (design §5.2): when a folder arrives deleted, remove its descendants from `remoteIndex` too (or keep the tombstone). A live item whose parent is missing is treated as unresolved and its record is frozen, so a descendant left behind would never sync. Test it.
- **eTag chaining:** an `upload-replace` (or any If-Match op) on an id that a `remote-move` in the same run just moved must use the eTag the move returned; the planned `ifMatch` is the base eTag.
- **Folder moves:** a folder `remote-move` or `local-move` rewrites the paths of every record (`files`, `folders`) under it.
- **Folder ops:** `local-trash` on a folder means `removeEmptyFolder`; `upload-new` / `download` on a folder path means create.
- **Scan:** hash every file skipped for a *name* reason (invalid, reserved, path too long, collision), so a tracked file renamed to such a name without a vault event still matches its record (review, low). Pass `storedHash` from `RemoteContent.storedHashOf`. Confirm the Obsidian vault reports NFC paths, or map them: the planner's VaultPaths are NFC.
- **State maps:** when M6 writes `state.files[path]` or `state.remoteIndex[id]`, a note named `__proto__` (a valid name) must stay data: write with `Object.defineProperty` or build the objects with `Object.fromEntries`, and add a round-trip test (review, low).
- **Pending conflicts:** a resumed conflict's copy file is also seen by the scan as a new local file; don't upload it twice.
- **M7:** list folder deletes in the confirm modal even though they don't count toward the threshold; render report paths only with `createEl`/`setText` (state is untrusted).

---

## M6: Executor, engine, persistence, resume
**Status:** done (2026-10-12). The `adapter.rename` manual check passed on Ubuntu and the iPad. The R-AUTH-9 reinstall check (an M6 follow-up, 0.4.1) is tracked in the traceability table and doesn't block M7. M7 may start: it doesn't depend on the result unless the fallback has to change.

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
  - **Owner steps (0.4.0):**
    1. Push tag `0.4.0` from this branch (or after merging), so `release.yml` builds the draft release; publish it. Install 0.4.0 with BRAT on Ubuntu and on the iPad. A test vault is fine; the check touches only the plugin's own folder.
    2. On each device, open the command palette and run **MDVaultSync: Test file replace on this device**.
    3. Copy the JSON (Copy result) and paste it below, one block per device.
  - **What the fields mean:** `renameOverExisting` is `replaced` (rename overwrites: writeAtomic is atomic on that device), `threw` or `kept-target` (rename refuses: writeAtomic uses the remove-then-rename fallback, which has a short crash window; see design §12). `fallbackWorks` must be `true` and `cleanedUp` must be `true` on both devices.
  - **Result, Ubuntu (2026-10-12, owner, Flatpak):** `{"renameOverExisting": "threw", "fallbackWorks": true, "cleanedUp": true, "platform": "linux", "pluginVersion": "0.4.0"}`. `adapter.rename` refuses to overwrite on Ubuntu, so writeAtomic uses the remove-then-rename fallback there; the fallback works. Matches the design (design §12, atomic.ts); no code change.
  - **Result, iPad (2026-10-12, owner):** `{"renameOverExisting": "threw", "fallbackWorks": true, "cleanedUp": true, "platform": "ios", "pluginVersion": "0.4.0"}`. Same as Ubuntu: `adapter.rename` refuses to overwrite, and writeAtomic's remove-then-rename fallback works with no temp file left. Both devices therefore always use the fallback, with its short crash window (design §12); the security review judged that window recoverable for notes (the next run downloads the file again, R-DEL-2), and sync-state.json recovers from its temp file. No code change.
- **Leftover sign-in after uninstall (R-AUTH-9, added 2026-10-12 from the owner's report).** On 0.4.1, on each device: sign in, uninstall the plugin, reinstall it (BRAT), and open settings. Expected: a notice says a leftover sign-in was removed, with the account-page link, and the account section shows signed out. A normal restart or a BRAT update must keep the sign-in. Also: while signed in, replace data.json's content with `{not json` and restart: the sign-in must be kept (the file isn't overwritten by the check).
  - **Result, Ubuntu (2026-10-12, owner, 0.4.1):** reinstall passed: the leftover-sign-in notice appeared and the account section showed signed out. Corrupt-data.json sub-check passed (2026-10-12, Obsidian quit before the edit): Obsidian logged `failed to read JSON …data.json SyntaxError…` and loaded the plugin anyway; the file stayed on disk unchanged (`{not json}`); the secret was still present (`!!getSecret(...)` → `true`); the plugin stayed signed in with a blank Client ID. An earlier run that looked like a sign-out was most likely the blank Client ID read as "signed out" (owner's assessment).
  - **Result, iPad (2026-10-12, owner, 0.4.1):** reinstall passed, the same as Ubuntu. The corrupt-data.json sub-check: pending.
  - **UX decision (2026-10-12):** keep clearing the token. Uninstall removes the Client ID with data.json, and a refresh needs it, so a kept token would be unusable until the user re-enters the ID anyway; signing in again is one more tap. Keeping it would mean mirroring the Client ID into SecretStorage, which contradicts "uninstall clears creds" and leaves a usable grant behind after every uninstall (T-I1). The remaining gap (an uninstall with no reinstall keeps the token until revoked) has no plugin API fix; the M9 README advice covers it.

**Carry-ins** (requirements handed over by earlier milestones; each names its source)
- **Size cap before download** (M3 review, T-D6): skip items over the size cap before calling `download()`. The length check in `download()` runs only after `requestUrl` has buffered the whole body.
- **If-Match on replace** (M3 review of 0.3.2): when the executor starts using `PUT_HONORS_IF_MATCH`, keep the upload-session path as the fallback, and make sure a stale replace still surfaces as 412.
- **Pre-write check** (M4, T-T1; M4 re-review): right before every local write, call `containmentProblem(path, configDir)` **and** `validatePath(path, pathPrefixLen, isFolder)` on the final path. `containmentProblem` checks containment only; the name rules, including the U+00A0/U+202F rule, need `validatePath`.
- **Conflict copy names** (M4 review): the `exists` callback passed to `conflictCopyPath` must compare case-insensitively (`caseKey`). Pass the real `pathPrefixLen` (`AppRoot.pathPrefix` without its leading `/`). A `RangeError` from it means "conflict not resolved": keep both sides untouched and report an error, never overwrite.
- **Session body** (M3 review of 0.3.1, info): one probe body sent no `conflictBehavior` and relied on Graph's documented default, `fail`. Before M6 depends on new-file upload sessions, confirm from the M3 probe records (M3 **Ubuntu probe** results) that the body M6 sends, with `"@microsoft.graph.conflictBehavior":"fail"`, is accepted. If only the empty body works, verify that the default really is `fail` (a name clash must give 409, never a silent overwrite) and record it in research.md.
- Optional (M3 review, owner's call): make `GraphClientOptions.transferTransport` required instead of falling back to `transport`; give `getItemWithUrl`'s `downloadUrl` a branded `UncheckedUrl` type.

**Acceptance criteria**
- The tests above pass.
- A fake end-to-end run of 1,000 files through two FakeVaults (device A and device B) sharing one FakeRemote converges in at most 2 runs per device, with zero data loss assertions passing.

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
```

**Verification output** (2026-10-12, after the security-review fixes; Node 22.22, container)
```
$ npm run lint
✖ 4 problems (0 errors, 4 warnings)
  (unchanged since M4/M5: 2 in src/ui/settings-tab.ts, 2 `.obsidian` fixture constants in test/paths.test.ts and
   test/exclude.test.ts. The M6 tests use the configDir "obs-config", so they add none.)
$ npm run typecheck
> tsc --noEmit                        (exit 0)
$ npm test
# tests 733
# suites 8
# pass 733
# fail 0
$ npm run build
> tsc --noEmit && node esbuild.config.mjs production   (exit 0)
$ npm audit --audit-level=high
3 moderate severity vulnerabilities   (exit 0; none high; only the version changed in the lockfile)
$ scripts/check-network-apis.sh
no forbidden network APIs
$ node --test --experimental-test-coverage "test/**/*.test.ts"   (new modules, line % | branch % | funcs %)
#   engine.ts 96.6 | 87.9 | 96.4   executor.ts 95.8 | 86.3 | 94.0   remote-content.ts 96.8 | 91.3 | 90.0
#   upload-resume.ts 97.7 | 93.8 | 100   saver.ts 95.7 | 88.9 | 77.8   records.ts 94.9 | 95.7 | 95.0
#   obsidian-vault.ts 94.7 | 84.1 | 94.4   plugin-state-store.ts 95.9 | 92.9 | 85.7   atomic.ts 100 | 100 | 100
#   (coverage measured before the review fixes; the fixes added tests for every changed branch)
```
Manual rename results: Ubuntu and iPad both `threw` / fallback works / cleaned up (see **Manual checks**).

**What was built**
- `src/core/remote-content.ts`: `TransformedRemoteContent`, the only caller of RemotePort content methods. `fetch` checks length and QuickXorHash before decoding (null hash: size only); `store` uses PUT for new files and for replaces (`PUT_HONORS_IF_MATCH`) up to 10 MiB and sessions above, persists the session through `onSession`, re-checks a replace session's eTag before the final fragment (`ReplaceRaced`), handles 416, and checks the returned hash; `resume` continues a persisted session. `RemoteContent.resume` was added to `ports.ts` and design §2.
- `src/core/executor.ts`: `executePlan`: pull side then push side, moves first and one at a time, folders shallowest first, file ops 4 at a time, deletes (folders deepest first); pre-write containment, name and scan re-checks; 412 metadata-only retry vs conflict; 409 adopt vs conflict; remote-delete 404/412; the conflict procedure with pending-conflict reuse and a single copy upload; eTag chaining; one record per remote id; on-demand parent folders.
- `src/core/engine.ts`: `Engine` with the single-flight lock and one rerun, preflight with `applyAppRoot`, upload resume, the delta pull and merge (deleted folders drop their descendants; resync re-enumerates in union mode), the incremental scan, the plan, preview and guard prompts with a 10-minute timeout, declined deletes, the report, union completion, `reset()` for sign-out, `expectedWrites` and `noteLocalChange` for M7.
- `src/core/upload-resume.ts`, `src/core/saver.ts` (≤ 1 s batched saves, flush before destructive ops), `src/core/records.ts`, `src/core/failure.ts`; `src/remote/classify.ts` maps Graph and auth errors to core failure kinds.
- `src/platform/obsidian-vault.ts` (`ObsidianVault` over structural Vault, adapter and FileManager types), `src/platform/atomic.ts` (rename, else remove-then-rename; the temp file is kept if the target was removed), `src/platform/plugin-state-store.ts` (`sync-state.json`, temp then rename, temp fallback on load, serialized save and clear), `src/platform/sign-out.ts` (`clearSession`, wired into `main.ts` sign-out), `src/platform/rename-probe.ts` and the `test-file-replace` command.
- `RemotePort.download(id, expectedSize?)`: GraphClient refuses before the GET when the item's size changed since the cap check (T-D6).
- Version 0.4.0 (manifest, versions.json, package.json) for the manual check.

**Tests added:** `test/remote-content.test.ts` (18), `test/executor.test.ts` (33: every op, order, 412/409, deletes, edits during sync, the session race, containment, hash mismatch, size cap, saves, `__proto__`, review regressions), `test/engine.test.ts` (15: union and preview, single-flight, guard and declined deletes, resync, delta merge, sign-in required, crash injection after every mutating call, conflict crash, union crash, XOR transform seam, 1,000 files over two devices, exclusions), `test/upload-resume.test.ts` (4), `test/obsidian-vault.test.ts` (13), `test/plugin-state-store.test.ts` (6), `test/sign-out.test.ts` (4), a graph test for the expected download size, and network-check tests for the new exemption. Fakes: `test/fakes/sync-fakes.ts` (ManualClock, MemoryStateStore that rejects any state the real parser wouldn't load, XorTransform, withOverrides), `device.ts` (Device harness and CrashSwitch), `fake-obsidian.ts`.

**Acceptance**
- Every listed test exists and passes. Crash injection kills the run after each of the scenario's mutating calls in turn (every op kind, a conflict and a 3-fragment replace session), restarts a fresh Engine on the saved state, and asserts the same final vault and remote as an uninterrupted run, with exactly one conflict copy.
- 1,000 files through two FakeVaults and one FakeRemote, with edits on both sides, five same-file conflicts, deletes, renames and new files: each device needs at most 2 runs, the vaults and the remote end identical, and every written version survives (deleted files are in the recycle bin).

**Carry-ins closed**
- Size cap before download: `getItem` then the cap, before any bytes; and the expected size is enforced by GraphClient before the GET.
- If-Match on replace: PUT with If-Match per `PUT_HONORS_IF_MATCH`, sessions above 10 MiB, a stale replace still surfaces as 412 (tested both ways).
- Pre-write check: `containmentProblem` and `validatePath` before every local write, move, trash and mkdir (executor and ObsidianVault).
- Conflict copy names: `exists` compares by `caseKey`, the real `pathPrefixLen` is passed, a `RangeError` fails the op with `path-too-long` and both sides stay untouched.
- Session body: closed by the M3 records. The body M6 sends, `{"item":{"@microsoft.graph.conflictBehavior":"fail"}}` without `fileSize`, returned 200 on Ubuntu (probe v2–v4) and on the iPad (0.3.5); no code change.
- M5 notes: move order, the delta merge of deleted folders, eTag chaining, folder moves re-pathing records, folder ops, scan hashing of name-skipped files, `storedHash` from `RemoteContent.storedHashOf`, NFC mapping in ObsidianVault, `__proto__`-safe maps, no double upload of a resumed conflict copy.
- Optional (M3, owner's call), not done: making `transferTransport` required; a branded `UncheckedUrl`.

**Deviations and clarifications** (recorded in design.md §5.5, §5.6, §6.3, §12, §13)
- `RemoteContent.resume` added to the port; `RemotePort.download` takes an optional expected size.
- Union mode ends only after an `ok` or `partial` run in which every planned op got its turn; a run cut short by the network or the retry budget stays union.
- `pendingLocal` is cleared (the part the run saw) only after an `ok` run.
- A folder locally where the remote has a file (or the reverse) fails as `type-clash` every run, until the user renames one; the planner doesn't skip it yet (optional below).
- Upload-session resume needs a deterministic `encode` (design §13).

**Security review** (`security-reviewer` agent; base 9926865 plus the uncommitted M6 files):
- No high findings.
- Fixed, medium: a folder at a path where the remote has a file looped between download and the conflict procedure (endless Graph calls). The conflict procedure now fails it as `type-clash`; a test hangs if the fix is reverted.
- Fixed, medium: two conflicts in one run could pick the same copy name (long stems shorten alike), and the second copy write would replace the first, losing an edit. Names are reserved before any await, and the copy write is create-only; a test fails if the reservation is reverted.
- Fixed, medium: the rename fallback ran on any rename error and then deleted the temp file even after the target was removed. It now runs only when both files still exist, keeps the temp file once the target is gone (`TargetRemoved`), and the state store loads from the temp file if the main file is missing. Crash-window assessment (reviewer): for notes the window is recoverable (the next run sees "deleted here, changed there" and downloads again, R-DEL-2).
- Medium (process): this section and the verification output, now filled in; the manual check is pending.
- Fixed, low: the size check before download was time-of-check/time-of-use (`download(id, expectedSize)`); the network-check exemptions now match whole lines; a stale pending copy path is reused only under the planner's checks; a 404 on replace is confirmed with `getItem` before it counts as a delete; a folder move's 412 retries only if the folder hasn't moved elsewhere; after sign-out the executor starts no new op and the state store serializes save and clear.
- Fixed, info: `trash` and `removeEmptyFolder` re-check containment in ObsidianVault; a local move updates the eTag chain.
- **R-AUTH-9 follow-up review** (`security-reviewer`, base 238937f): fixed, medium: the first version decided "uninstalled" from `loadData()` returning null, so a corrupt or unreadable data.json could have cleared a live sign-in and overwritten the file. It now checks on disk that the plugin folder holds neither data.json nor sync-state.json (`platform/leftover-install.ts`, tested with corrupt, empty, `null` and `{}` files; an `exists` error keeps the sign-in). Fixed, low: duplicate research ID (now O-API-19) and its overclaimed status; the failure notice now carries the account-page link; the Client ID is saved before it is assigned, so a sign-in can't exist without data.json; the M6 status line. The sync-state finding is moot: a folder with sync-state.json isn't a leftover. Carried to M9: the README uninstall advice.
- Re-review of the fix diff (`security-reviewer`, base 4059c3f): all three code mediums and every fixed low and info confirmed resolved, no new high or medium, no regressions (network, auth header, logging, data-safety rules, interface sync). It found one new low, **fixed**: a reused pending copy path wasn't reserved before the next await, so a tampered state with two pending conflicts sharing a copy path could make one copy replace the other. The reuse branch now reserves the name at once (and checks the path first), and `parseSyncState` rejects pending conflicts that share a copy path or use another's original; both parser tests fail without the rule. Open, info (owner's call or later milestones): leftover hidden temp files after a `TargetRemoved` are never cleaned up (harmless, hidden files are never synced; M8 could sweep them); the planner still plans file and folder ops onto a folder/file clash key (reported as `type-clash` each run; optional skip above).

**Notes for M7 and later** (carry-ins)
- **Wire the engine** in `main.ts`: `Engine` with `ObsidianVault`, `TransformedRemoteContent(graph, new IdentityTransform(), { putHonorsIfMatch: PUT_HONORS_IF_MATCH, classify: classifyError })`, `PluginStateStore`, `ensureSignedIn: () => auth.getAccessToken()`, `resetBudget: () => retry.resetBudget()`, and pass the engine to `clearSession` (it is `null` in M6).
- **Vault events:** call `engine.noteLocalChange` and consult `engine.expectedWrites` (path → hash) for the echo filter; clear entries as the scan consumes them. `expectedWrites` grows until M7 clears it.
- **Hooks:** `confirmPlan` and `confirmDeletes` resolve false on Cancel; the engine applies the 10-minute timeout itself. Folder deletes are in the `confirmDeletes` list (M5 note).
- **Statuses:** `syncing` phases are `preflight`, `resume`, `pull`, `scan`, `exec`; a `partial` run (including `changed-during-sync` deferrals) sets `error` with the first code. Map `type-clash`, `changed-during-sync`, `hash-mismatch`, `too-large`, `conflict-name` and `path-too-long` to notice text (M8 table).
- **Manual check (M7/M8):** a replace over 10 MiB from a real device must not end in a false conflict. Creating a replace session must not change the item's eTag on OneDrive personal; that was never observed (design §6.3). On the iPad, check that a downloaded file shows up in the vault without a restart (writes go through the adapter).
- **M9 README (R-AUTH-9 review, info):** say to sign out before uninstalling, or to remove the app's access at the account page: until a reinstall, the refresh token stays in SecretStorage, where other plugins can read it (T-I1).
- **M9 README:** persisted upload-session URLs in `sync-state.json` grant upload access until they expire; the config folder must not be synced by another tool (review, info).
- Optional (owner): have the planner skip a key that is a folder on one side and a file on the other, so it is reported as a skip instead of a recurring `type-clash` error.

---

## M7: Obsidian integration and UI
**Status:** done (2026-10-12). The owner's manual checks passed on both devices: 1–6, 8, 9 and 11 on 0.5.0, 10 on the iPad, and 7 after the 0.5.1 fix (re-check 7b). Lint with no warnings, typecheck, 804 tests and the build pass (see **Verification output**). The security-review passes are done and their findings fixed or recorded. M8 may start.

**Goal.** A usable plugin: triggers, events, settings, status and notices (design §3, §10).

**Files and interfaces**
- `src/main.ts`: wiring. Registers vault events in `onLayoutReady` with the echo filter. Startup sync 5 s after layout ready. `registerInterval` timer. Commands `sync-now` and `sync-preview` (IDs without the plugin ID [O-SUB-3]). Ribbon icon. Status bar on desktop only [O-API-13]. No default hotkeys [O-GL-4].
- `src/ui/settings-tab.ts`: every R-UI-1 field, with headings through `setHeading()`, sentence case and no "settings" in headings [O-GL-2].
- `src/ui/plan-preview-modal.ts`, `src/ui/confirm-deletes-modal.ts` and `src/ui/report-view.ts` (built with `createEl` only [O-GL-3]).
- `src/ui/notices.ts`: notices for conflicts (persistent until dismissed), errors and sign-in required.
- `styles.css`: classes for the modals and report.

**Carry-ins** (requirements handed over by earlier milestones; each names its source)
- **Exclude-setting help** (M4 review, info): the help text must say that `!` lines and backslash escapes are unsupported (such patterns never match), and that matching is case-sensitive, so on the iPad a remote `PRIVATE/` isn't excluded by a local `Private/` rule. The supported syntax is in design §7.
- **Showing names** (M4 review, info): C1 controls, DEL, bidi overrides (for example U+202E) and U+2028/U+2029 pass `validateSegment`. They can't escape the vault, but they can disguise names in the report, preview and conflict notice. Consider escaping them when names are displayed.

**Acceptance criteria**
- Lint passes with no warnings from `obsidianmd` rules.
- **Manual checks**, both devices, using a *test vault*, not the real one:
  1. The first sync shows the preview; Cancel does nothing.
  2. Edit a note: the timer sync uploads it, and the other device downloads it.
  3. Rename and move a note: the other device sees a move, and OneDrive version history is intact (check in OneDrive web).
  4. Delete a note: the other device puts it in trash per the Obsidian setting, and OneDrive has it in the recycle bin.
  5. Edit the same note on both devices offline, then sync both: one conflict copy named after the device, a notice listing it, and both versions present on both devices.
  6. Delete 30 % of the test vault: the confirm modal appears, and "Skip deletes" leaves the remote intact.
  7. The status bar on Ubuntu and the ribbon tooltip on iPad show the state and last sync time. *(Amended 2026-10-12 with SPEC R-UI-2: a tooltip can't show on a touchscreen [O-API-20]. On the iPad, the ribbon icon shows the state and **Show sync status** shows the state and last sync time; see check 7b.)*
  8. "Sync now" pressed repeatedly during a sync doesn't start parallel runs (the log shows sequential runs).

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build
```

**Manual checks: owner steps and results**

**Owner steps (0.5.0).** Use a *test vault* on both devices, not the real one, and the same Client ID on both.
1. Push tag `0.5.0` from this branch (or after merging) so `release.yml` drafts the release; publish it. Install 0.5.0 with BRAT on Ubuntu and on the iPad (BRAT → **Check for updates to all beta plugins**). Sign in on both devices if needed.
2. Run checks 1–8 below, then the extra checks 9–11. Record pass/fail per device under **Results**; for check 8, copy the log (Settings → MDVaultSync → Diagnostics → **Copy log**) and paste the `sync.run` lines.

| # | Steps | Pass when |
|---|---|---|
| 1 | Fresh test vault with a few notes. Wait about 5 seconds after Obsidian opens (or run **MDVaultSync: Sync now**). In the preview, select **Cancel**. Then run **MDVaultSync: Preview sync** and select **Run**. | The first sync shows **Preview sync** with the planned uploads. Cancel changes nothing (OneDrive's app folder stays empty). Run uploads them. |
| 2 | Set **Sync interval** to 1 minute on both devices. Edit a note on Ubuntu. Wait up to 2 minutes; on the iPad wait for its timer or tap the ribbon button. | Ubuntu uploads it without any action; the iPad shows the edit. |
| 3 | On Ubuntu, rename a note and move another into a folder. Sync both devices. In OneDrive on the web, open the moved file's version history. | The iPad shows the same rename and move (not a new file plus a delete). OneDrive shows the earlier versions. |
| 4 | Delete a note on Ubuntu. Sync both devices. | The iPad puts it where its Obsidian "Deleted files" setting says (system trash or `.trash`). OneDrive web shows it in the recycle bin. |
| 5 | Put both devices offline (airplane mode on the iPad, network off on Ubuntu). Edit the same note differently on each. Reconnect, sync Ubuntu, then the iPad, then Ubuntu again. | One conflict copy named `<note> (conflict iPad <date time>).md` (the iPad's version); a notice on the iPad lists it and stays until dismissed; both versions are on both devices. |
| 6 | With 10 or more notes synced, delete 30 % of them on Ubuntu. Sync. Choose **Skip deletes this time**. Then run **Sync now** and choose **Delete N files**. | The confirm window lists the deletes. Skipping leaves them in OneDrive (and the next interval run doesn't ask again); Sync now asks again and then deletes them. |
| 7 | Watch the status bar on Ubuntu and hover or long-press the ribbon icon on the iPad during and after a sync. | Ubuntu: "MDVaultSync: Syncing…", then "MDVaultSync: Synced HH:MM". iPad tooltip: "Sync now. Synced HH:MM". Clicking the status bar opens **Last sync**. (0.5.0 wording, as tested.) |
| 7b | **0.5.1 re-check.** On both devices, watch the ribbon icon during and after a sync; on the iPad, note where you see it (the sidebar ribbon or the ribbon menu). Run **MDVaultSync: Show sync status**. On Ubuntu, click the status bar. To see the error icon, turn the network off and select **Sync now**. | The icon changes to a loader while syncing and back to the sync arrows after; with the network off it shows a warning triangle. **Show sync status** (and, on Ubuntu, the status-bar click) opens **Sync status** with "Synced HH:MM" (or the error) and the last report. |
| 8 | Add a 20 MB file, start a sync, and while it runs run **Sync now** five times. Copy the log. | The log shows `sync.run` entries one after another (never two starting before one ends), and at most one extra run after the first. |
| 9 | (M6 carry-in) Sync a file over 10 MB, edit it (for example, replace it with another file over 10 MB under the same name), sync again. | It uploads; no conflict copy appears. |
| 10 | (M6 carry-in) On the iPad, with the note list visible, add a note on Ubuntu and sync both. | The note appears in the iPad's file list without restarting Obsidian. |
| 11 | Open Settings → MDVaultSync on both devices; record the Obsidian version (Settings → General). Change each Sync field, close and reopen settings. Type "exclude" in the settings search box. | Every R-UI-1 field is there (account, sign in/out, client ID, device name, interval, size, exclude patterns, preview toggle, delete threshold, last sync report, probe, copy log), values persist, invalid values show a red explanation and aren't saved, and the search finds **Exclude patterns** on Obsidian 1.13 or later. |

**Results** (owner, 2026-10-12, 0.5.0)
- **Ubuntu** (Obsidian 1.14.4): 1–9 and 11 pass; 10 n/a (iPad-only check).
- **iPad** (Obsidian 1.14.5 (387)): 1–6 and 8–11 pass. **7 failed:** there's no status bar on mobile (expected [O-API-13]), and hovering or long-pressing the ribbon icon showed nothing. Owner: "not a deal breaker; fix it if it's an easy fix."
  - **Cause:** a design error, not user error. `setTooltip` is a hover tooltip, and a touchscreen has no hover [O-API-20], so SPEC R-UI-2's "on iPad the ribbon tooltip shows the same state" couldn't work. **Fix (0.5.1):** the ribbon icon shows the state on every platform, and a new **Show sync status** command shows the state and last sync time; SPEC R-UI-2 changed to match (design §10). Re-check 7b on 0.5.1: **passed** (owner, 2026-10-12).
- **Check 8 log** (owner, 0.5.0; reviewed in session): every `sync.run` ends before the next run's first `graph.request`, so runs never overlapped; pressing Sync now again after a run finished starts a new run, as designed. The owner recorded check 8 as passed; the log alone can't show which runs were reruns, so the "at most one extra run" part rests on the owner's observation. One `op.upload-new` ended `changed-during-sync` while the 20 MB file was still being written; the next run uploaded it (201). One observation, carried to M8: a single `graph.request` took 1,424,364 ms (about 24 minutes), and its run held the single-flight lock for that long. Most likely the iPad suspended Obsidian mid-request (or the network stalled). It caused no error, but `requestUrl` has no timeout.

**Verification output** (2026-10-12, after all three review passes; Node 22.22, container)
```
$ npm run lint
> eslint .                              (exit 0, no problems: 0 errors, 0 warnings)
$ npm run typecheck
> tsc --noEmit                          (exit 0)
$ npm test
# tests 803
# suites 8
# pass 803
# fail 0
$ npm run build
> tsc --noEmit && node esbuild.config.mjs production   (exit 0)
$ npm audit --audit-level=high
3 moderate severity vulnerabilities   (exit 0; none high; unchanged since M6)
$ scripts/check-network-apis.sh
no forbidden network APIs
$ node --test --experimental-test-coverage "test/**/*.test.ts"   (line % | branch % | funcs %, before the second-round fixes)
#   engine.ts 97.7 | 89.0 | 100   upload-resume.ts 97.8 | 95.0 | 100   vault-events.ts 100 | 96.0 | 100
#   settings.ts 100 | 97.6 | 100   display.ts 100 | 75.0 | 100   notices.ts 100 | 91.7 | 100
#   plan-groups.ts 100 | 97.4 | 100   status.ts 100 | 100 | 100   triggers.ts 100 | 100 | 100
```
**Verification output, 0.5.1** (2026-10-12, after the review of the check 7 fix; Node 22.22, container)
```
$ npm run lint                  (exit 0; 0 errors, 0 warnings)
$ npm run typecheck             (exit 0)
$ npm test
# tests 804
# suites 8
# pass 804
# fail 0
$ npm run build                 (exit 0)
$ npm audit --audit-level=high  (exit 0; 3 moderate, unchanged)
$ scripts/check-network-apis.sh
no forbidden network APIs
```
**0.5.1 review** (`security-reviewer`, base 363faf6): no high or medium. Fixed, low: plan.md records (check 10 is iPad-only; the check 7 wording as tested on 0.5.0 kept, with the 0.5.1 re-check as 7b, including the Ubuntu status-bar click and the error icon; the stale status line; the acceptance and built-list lines); stale comments about the tooltip; a missing error icon could have fallen back to the "synced" arrows, so each state now tries its own list of icon names (Lucide renamed `alert-triangle` to `triangle-alert`) before the default. Info, settled: the iPad shows the updated icon (re-check 7b passed); the status window is a snapshot taken when it opens (design §10).

The Obsidian-facing files (main.ts, the modals, the settings tab) import `obsidian` at runtime and can't run under `node --test`; every decision they make is in a pure module above, and the manual checks cover the rendering.

**What was built**
- `src/main.ts`: the `Engine` wired with `ObsidianVault` (through `instanceof`-checked adapters for Vault and FileManager), `TransformedRemoteContent(graph, IdentityTransform, PUT_HONORS_IF_MATCH, classifyError)`, `PluginStateStore`, `ensureSignedIn`, `resetBudget` and the hooks. `onLayoutReady`: vault events, the startup sync 5 s later, the interval timer (restarted when the setting changes). Commands `sync-now`, `sync-preview` and (0.5.1) `show-status` (no hotkeys); the ribbon button, whose icon shows the state (0.5.1) and whose desktop tooltip adds the text; the status bar on desktop only (click opens **Sync status**, 0.5.1; **Last sync** in 0.5.0). Notices come from the engine's new `onReport` hook. Sign-out passes the engine to `clearSession` and closes open prompts; unload closes prompts, refuses new ones and resets the engine. `persist()` serializes every data.json write.
- `src/ui/`: `settings-tab.ts` (every R-UI-1 field; one row list for `getSettingDefinitions()` on 1.13+ and the `display()` fallback through `SettingGroup` on 1.11.4–1.12; invalid input isn't saved and says why; after a sync only the report re-renders), `plan-preview-modal.ts`, `confirm-deletes-modal.ts`, `prompt-modal.ts` (answers no on close, closes itself after 10 minutes), `report-view.ts`, `report-modal.ts`; pure: `display.ts`, `status.ts`, `notices.ts`, `plan-groups.ts`, `triggers.ts`.
- `src/platform/vault-events.ts`: events to hints; hidden, configDir and excluded paths ignored; renames into or out of them become a delete or a new file.
- `src/settings.ts`: the sync settings with range checks (T-T6), the device-name rules, the interval floor for the listing fallback, `toEngineSettings`, the fail-closed pattern check and `snapshotForSave`.
- `src/core/engine.ts`: the rerun keeps the strongest trigger and the Sync now re-offer; no rerun after `reset()` and a fresh run for a request after it; a cancelled preview drops timer reruns; `onReport`; `pathPrefixLen`; the scan consumes `expectedWrites`; bounded hints with the full re-hash past the cap. `upload-resume.ts` stops between sessions after a reset. Conflict ops carry `noHistory` (planner, ports).
- `styles.css`; `eslint.config.mjs` turns `obsidianmd/hardcoded-config-path` off for tests only (fixtures use `.obsidian` on purpose; inline disables of that rule are banned). Version 0.5.0.

**Tests added:** `test/settings.test.ts` (rewritten, 17), `display.test.ts` (5), `status.test.ts` (5), `notices.test.ts` (8), `plan-groups.test.ts` (6), `triggers.test.ts` (3), `vault-events.test.ts` (6), 15 engine tests (rerun trigger, Sync now re-offer, echo filter for writes, moves and trashes, edit after download, `pathPrefixLen`, `onReport`, reset with a queued rerun, cancel, preview plus Sync now, the hint cap and re-hash, rename hints over the cap, the hint boundary, a request after reset, the re-hash surviving a cancel and a reset), a planner assertion pair for `noHistory`, and an upload-resume test for `live`. Each review-fix test was checked to fail with its fix reverted.

**Acceptance**
- Lint passes with no warnings from `obsidianmd` rules (no warnings at all).
- Manual checks (owner, 2026-10-12, 0.5.0): 1–6, 8, 9 and 11 pass on both devices; 10 (iPad only) passes; 7 passes on Ubuntu, and on the iPad on 0.5.1 (re-check 7b passed, owner, 2026-10-12; 0.5.0 failed it, see Results).

**Carry-ins closed**
- Exclude-setting help: the help text says `!` lines and backslash escapes aren't supported and never match, and that matching is case-sensitive, with the iPad case. (The literal `PRIVATE/` example was reworded: the sentence-case lint rule flags it.)
- Showing names: every name in the preview, report and notices passes `displayPath`.
- M6 notes: the engine is wired as listed; vault events call `noteLocalChange`, and the scan consumes `expectedWrites`; `confirmPlan` and `confirmDeletes` resolve false on Cancel or close; statuses map to text, and the M6 codes to notice text; the two M6 manual checks are checks 9 and 10.

**Deviations and clarifications** (recorded in design.md §2, §3, §10, threat-model T-D8)
- Vault events are kept in memory and saved with the run, not per event (owner-approved with the plan).
- `SyncHooks.onReport` (optional) and `PlanOp` conflict `noHistory` (optional) added to `ports.ts`.
- `expectedWrites` isn't needed for the echo decision: echoes are resolved by comparing with the sync record. The map is kept and cleared by each scan.
- The device-name default is "iPad" on iOS and "Ubuntu" on Linux, as design §11 says (other platforms get their OS name).

**Security review** (`security-reviewer` agent; base 7b874b1 plus the M7 work):
- No high findings in any round.
- Fixed, medium: a queued rerun survived `engine.reset()`, so a sync could run after the plugin was unloaded (a BRAT update) or start alongside a reloaded copy. `reset()` clears it and the loop stops on an epoch change.
- Fixed, medium: unreadable `excludePatterns` in data.json silently became "no exclusions" (T-I6). Sync now pauses with a persistent notice until the patterns are saved again.
- Fixed, low: unbounded `pendingLocal` (now deduplicated and capped); Cancel re-prompting from a queued timer run; racing data.json writes that could put a removed fallback token back (one serialized queue); upload resume ignoring a reset; invisible characters missing from the display escaping; status lines without the last sync time. Fixed, info: prompts close on sign-out and never open after unload; the design §3 and T-D8 echo wording; `refresh()` only while the tab is on screen; Sync now's re-offer survives a preview outranking it.
- **Re-review of the fixes** (base c1a35ae): all of the above confirmed fixed. Two new mediums came from the fixes, both **fixed**: the dedupe could drop a hint the running sync would then clear, losing an edit made right after a download (the dedupe now only looks at hints newer than the run's snapshot); and the pause didn't survive another save plus a restart (every save writes the unreadable value back until the patterns are saved). Fixed lows: the pause cleared on the first keystroke (now only **Save and resume sync**); early hints bypassed the cap; dropping hints over the cap could lose an edit or a rename hint (now a full re-hash until an ok run, and rename hints are kept up to 50,000); more default-ignorable characters escaped (`\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}`). Fixed info: a request after `reset()` joined the dead loop.
- Declined, low (owner's call): checking `live()` between fragments inside `RemoteContent.resume`. After a reset, a session already resuming sends its remaining fragments (up to about ten 10 MiB fragments at the 100 MiB cap). They carry no token (T-I4), nothing is saved afterwards, and the executor also stops only between ops; the check would need a `RemoteContent` port change.
- **Third pass** on the second-round fixes (base c1a35ae, commit 0329a38): every second-round item confirmed fixed, no high or medium. Fixed, low: a data.json on disk that doesn't load as an object (corrupt or truncated) now pauses sync too, since its patterns are unknown (T-I6); a test pins that the full re-hash survives a cancelled and a reset run; a failed **Save and resume sync** says so; the pause notice is hidden on resume and names the button. Fixed, info: the field is pre-filled with the readable lines. Open, info (no action): the re-hash generation is in memory only (same exposure as the approved deviation); rename hints over 50,000 are dropped (the scan hashes name-skipped files, so the record still matches by hash); visible look-alikes (Zs spaces, combining marks) aren't escaped, by design: they're visible.

**Notes for M8 and later** (carry-ins)
- **Long requests (owner check 8 log):** one `graph.request` took about 24 minutes (most likely iOS suspending Obsidian mid-request), and the run held the single-flight lock throughout. `requestUrl` takes no timeout. M8 hardening should decide whether to race each request against a timer, and what happens to a response that arrives after its run gave up.
- **Notice table:** `src/ui/notices.ts` `ERROR_TEXT` holds the M6 codes and the run-level codes; M8 adds every `GraphError` code and the test that each maps to a message. `quota` text exists; 507 → `quota` mapping is already in `classify.ts`.
- **Sentinel test:** the new UI shows paths only in the report, preview and notices, never in logs; `Copy log` copies only the ring buffer. The sentinel test should cover a full fake sync through `Engine` with the M7 hooks attached.
- **Optional (owner):** the per-fragment `live()` check above; `recordDownload` trusts a same-size stat taken right after the write, so an edit landing in that window depends on its vault event (now always kept); re-hashing after the write would remove the dependency at the cost of one extra read per download.
- **Unverified offline:** whether Obsidian 1.13+ re-renders declarative settings on `update()` and detaches `containerEl` when settings close. Manual check 11 covers the rendering; if the account rows don't update after sign-in with settings open, `refresh()` needs another trigger.

---

## M8: Hardening and end-to-end test matrix
**Status:** done (2026-10-17, 0.6.4). Every matrix row passed on the devices it names (Ubuntu, Obsidian 1.14.4; iPad, Obsidian 1.14.5 (387)), the last one, row 10, on 0.6.4; see **Results**. Lint, typecheck, 852 tests, build and audit pass (**Verification output, 0.6.4**). The sentinel and notice-mapping tests pass, every threat-model row has a status, and the owner accepted the S5 redirect risk (2026-10-17). Every security-review pass is recorded, with its findings fixed or listed as open info.

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

**Manual end-to-end matrix** (owner; test vault, not the real one; same Client ID on both devices; 0.6.0, re-runs on 0.6.1)

**Before you start.**
1. Push tag `0.6.4` (from this branch or after merging; 0.6.0 for the first pass, 0.6.1–0.6.3 for the re-runs) so `release.yml` drafts the release, and publish it. Update both devices with BRAT (**Check for updates to all beta plugins**). Settings → MDVaultSync → Account should show **OneDrive storage** with used, total and free space (T-D7).
2. Run each row on the devices it names, and record pass or fail under **Results**. For rows 2, 3 and 10, copy the log (Settings → MDVaultSync → Diagnostics → **Copy log**) and paste the `sync.run` and `upload.resume` lines.

| # | Scenario | Devices | Steps | Pass when |
|---|---|---|---|---|
| 1 | Fresh device joins an existing remote vault | iPad joins Ubuntu's vault | With a synced test vault on Ubuntu, create a new empty vault on the iPad, install 0.6.0 there with BRAT, enter the Client ID, sign in, and let the first sync start (or run **Sync now**). | **Preview sync** appears and lists only downloads (a union download): no deletes, no uploads. After **Run**, every note is on the iPad, and nothing in OneDrive is deleted. |
| 2 | Airplane mode mid-sync, then reconnect | iPad (Ubuntu: turn the network off) | Add a file of about 30 MB and run **Sync now**. Turn on airplane mode while the status shows Syncing. Wait for the sync to end, turn airplane mode off, and run **Sync now**. | The first run's report (**Show sync status**) is `partial`, with a network or timeout error. The next run resumes it and ends `ok`. The file is in OneDrive once, with no conflict copy. |
| 3 | Force-quit Obsidian on iPad during a 50 MiB upload | iPad | Add a 50 MB file and run **Sync now**. While it uploads (Syncing), swipe Obsidian away in the app switcher. Reopen Obsidian and let the startup sync run. | The upload resumes from `nextExpectedRanges`: the log after reopening has an `upload.resume` line (it continued, not restarted from zero). The file is in OneDrive once, with the right size. |
| 4 | File at 101 MiB with a 100 MiB cap | Ubuntu (the file is easiest to make there) | Leave **Maximum file size** at 100 (the default, in megabytes). In the vault folder, run `head -c 105906176 /dev/urandom > big.bin` (101 MiB). Sync. | It isn't uploaded, and the last sync report lists it as skipped `too-large`. |
| 5a | Ubuntu: `Note.md` and `note.md` in the same folder, neither synced yet | Ubuntu | In a terminal, create `Note.md` and `note.md` with different text in the same vault folder. Sync. | Neither is uploaded: with no synced name to keep (R-PATH-2), both are reported `case-collision`. Nothing is overwritten. |
| 5b | Ubuntu: `note.md` appears beside an already synced `Note.md` | Ubuntu | Delete `note.md` from 5a and sync until `Note.md` uploads. Then create `note.md` again, with different text, and sync. | `Note.md` keeps syncing (edit it and sync: the edit reaches the iPad). `note.md` is reported `case-collision` and isn't uploaded. Nothing is overwritten. |
| 6 | Ubuntu: a file named `a:b.md` | Ubuntu | In a terminal, create a file named `a:b.md` in the vault folder. Sync. | It isn't uploaded, and the report lists it as `invalid-name`. |
| 7 | Delete `Apps/MDVaultSync` in OneDrive web | Ubuntu, then the iPad | In OneDrive on the web, delete the app folder (`Apps/MDVaultSync`). Run **Sync now** on Ubuntu and select **Run** in the preview. Then do the same on the iPad. Keep syncing each device until it shows **Synced** and **Sync now** brings no preview. | Each device's next sync is treated as a first sync: the preview appears (it says the OneDrive folder changed), and after Run every note is uploaded again. No local file is deleted or trashed on either device. The log (**Copy log**) shows `"op":"sync.plan"` with `"code":"union"` for those runs only. |
| 8 | Rename a file in OneDrive web | Ubuntu, then the iPad | **First:** both devices have finished row 7 (each shows **Synced**, and **Sync now** shows no preview). In OneDrive on the web, rename a synced note (for example `x.md` → `y.md`). Sync Ubuntu, then the iPad. | No preview appears on either device. The local file is renamed to `y.md`, with its content, on both. No conflict copy appears (the metadata-only 412 path), and no second file is downloaded or uploaded. |
| 9 | Sign out, then sign in | Both, one at a time | On one device, **Sign out**, then **Sign in** again with the same account, and let the sync run. Repeat on the other device. | Sign-out clears the sync state, so the next sync is a first-sync union: the preview appears. After Run, nothing is deleted on either side, and there are no conflict copies (the files are identical). |
| 10 | Revoke the app at account.microsoft.com | Both (the capture: Ubuntu) | **First:** Settings → MDVaultSync → Diagnostics → turn on **Verbose logging** on both devices. On Ubuntu, open the developer console (Ctrl+Shift+I) → **Console** tab → the levels dropdown (**Default levels**) → tick **Verbose** (DevTools hides `console.debug` lines otherwise). **10a:** with settings closed, run the command **MDVaultSync: Sign out of OneDrive**, then open Settings → MDVaultSync; note whether it opens; close settings and sign in again. **10b:** remove the app at https://account.microsoft.com/privacy/app-access. Restart Obsidian on each device and wait for the "sign-in required" notice. On Ubuntu, check the console now shows `MDVaultSync {"…op":"auth.refresh"…}` lines. In DevTools, click the **Sources** tab (in the row of tabs across the top of DevTools, next to **Console**; behind **»** if hidden), then open Settings → MDVaultSync. Afterwards, sign in again and turn Verbose logging off. | 10a: the tab opens and shows **Sign in**, with no **OneDrive storage** or **Sign out**. 10b: the tab opens and its Status says "Sign-in required"; Obsidian stays responsive; nothing is deleted; **Sign in** works and sync resumes. **If it freezes (Ubuntu):** click inside DevTools and press **F8** (or the **⏸** button at the top of the right-hand panel in Sources) until a yellow "Paused in debugger" bar appears, then in that panel open **Call Stack**, right-click → **Copy stack trace**, and send it with the last `MDVaultSync {…}` lines from the **Console** tab (codes only). If the tab opens but shows **OneDrive storage** or a **Sign out** button while Status says Sign-in required, say so. |
| 11 | Stale device rejoins: sign out on Ubuntu, edit 3 notes on iPad and sync, edit 1 *other* note on Ubuntu, sign in on Ubuntu | Both | Sign out on Ubuntu. On the iPad, edit notes A, B and C and sync. On Ubuntu (still signed out), edit note D. Sign in on Ubuntu, then sync the iPad. | The preview on Ubuntu shows **Differs on both sides, no sync history (4)**. After Run there are 4 conflict copies (A–D), on both devices once the iPad syncs, and nothing is lost. |
| 12 | Type in a note continuously while a sync downloads a remote change to it | Ubuntu types; the iPad makes the remote change | Open a synced note on Ubuntu. On the iPad, edit the *same* note (add a line at the top) and sync the iPad, so the change is in OneDrive but not yet on Ubuntu. On Ubuntu, without syncing, start typing at the end of the note, and keep typing while you run **Sync now** and for a few seconds after it finishes. Stop, then run **Sync now** once more. | No keystroke typed on Ubuntu is lost, and the iPad's line isn't lost either: after the second sync both are on both devices, in the note or split between the note and a conflict copy (R-CONF-4). The first sync's report may show `changed-during-sync` for the note. |

**Results, 0.6.0** (owner, 2026-10-16; session verdicts 2026-10-17)
| # | Result | Verdict |
|---|---|---|
| 1, 3, 4, 7, 9, 11 | Pass | Stand. |
| 2 | Fail: an extra conflict copy | **Bug, fixed in 0.6.1.** Re-run. Most likely the commit of the 30 MB upload landed but its answer was lost to airplane mode; the next run found the file with no sync record and no hash in OneDrive's listing, so the pair counted as "differs, no history", and the conflict procedure wrote the copy before comparing bytes. Reproduced in `test/engine.test.ts`. The procedure now compares first (design §5.5 step 0). |
| 5 | Fail: neither note synced, both `case-collision` | **As specified** (R-PATH-2: with neither name tracked, both are skipped; nothing is guessed or renamed). The row's wording was wrong. Recorded as **5a: pass**; **5b** (a tracked name) is new. |
| 6 | Fail: reported "would land outside the vault" | **Bug, fixed in 0.6.1.** The drive-letter check (`C:`) ran before the name rules, so the file was reported `outside-vault`; it was safely skipped either way. Now `invalid-name`. One side effect, safer (M8 review): a synced note renamed to such a name now keeps its OneDrive copy, as other invalid names already did, instead of counting as a local delete. Re-run. |
| 8 | Fail: iPad download + 2 uploads + a no-history conflict | **Most likely carried over from row 7.** That plan is exactly a first-sync merge (it never deletes, and it matches by path), which a device runs once after the app folder changes. If the iPad's first sync after row 7 happened in row 8, this is by design. 0.6.1 marks such runs in the log (`"code":"union"`). Re-run 7 → 8 with the new precondition. |
| 10 | Fail: both devices froze after the restart | **Not explained by the code.** The same revoked-grant path runs without hanging in the tests, so it involves something only the app has. 0.6.1 adds refresh breadcrumbs and the Verbose logging toggle; re-run with the console open. |
| 12 | Unclear: the iPad edit arrived before typing started | **Test setup**: the download didn't race the typing. New steps. Re-run. |

**Re-runs on 0.6.1** (owner, 2026-10-17): rows 2, 6, 7 → 8 and 12 **pass**. Row 5 gave the 5a outcome (neither synced, both `case-collision`), as expected, so it **passes**; 5b wasn't run separately. Row 10 **fails** again on both devices, now narrowed down by the owner: after the revoke and a restart the sign-in-required notice shows; syncing, notes and Obsidian's own settings all work; opening the **MDVaultSync** settings tab freezes Obsidian. Verbose logging was on and the console was open, and no line was visible. That proves little: the mirror writes `console.debug`, which DevTools hides unless the Verbose level is ticked (M8 review); the startup sync's `auth.refresh` lines should have been there. After a second restart (status signed out) the tab opens fine.

**Row 10 analysis (session, 2026-10-17).**
- **Ruled out (read-only):**
  - the tab's rows are identical in sign-in-required and signed-out, except the Status text;
  - the failed report a revoked run leaves in memory renders in 1 ms (run in node), and so do its notices and status text;
  - there is no synchronous loop in the settings, auth or report code;
  - no Graph or token call can run on that path without a console line.
- **What sets this state apart:**
  - A revoked grant flips the auth status during a background sync, and the listener calls the tab's `refresh()` → `update()` while the tab is closed. The guard was `containerEl.isConnected`, which M7 had already noted as unverified on Obsidian 1.13+.
  - This isn't the only closed-tab refresh: the **Sign in** and **Sign out** commands and any `obsidian://mdvaultsync-auth` callback also refresh with the tab closed (M8 review). Row 10a separates the two.
  - What is unique: the tab's definitions are built at load (`addSettingTab` → `update()`) while the plugin is still signed in, and the status changes afterwards. If Obsidian rendered those cached definitions, they would show the signed-in rows next to a "Sign-in required" Status.
- **0.6.2:**
  - `refresh()` now re-renders only while the tab is on screen: a row has rendered since the last `hide()`. The decision lives in `ui/settings-refresh.ts`, unit tested.
  - `ui.settings` breadcrumbs: `defs`, each row's start and end, `refresh` with a per-second count, `refresh-skipped-hidden` / `refresh-skipped-detached`, `hide`, and the sign-in prepare. They are logged only with Verbose logging on, so they never push the sync lines out of the 500-entry log.
- **This is a hypothesis.** The DevTools stack from the next re-run decides it.

**0.6.2 security review** (`security-reviewer` agent; base db4880c): no security regression.
- Fixed, medium (accuracy):
  - "no console line" wasn't evidence, because DevTools hides `console.debug`. Row 10 now has you tick the Verbose level and check for the `auth.refresh` lines first.
  - "the only closed-tab refresh" was wrong: the sign-in and sign-out commands and auth callbacks do it too. The analysis is corrected, and row 10a now separates the cases.
- Fixed, low:
  - The skip crumb now says why it skipped (`hidden` or `detached`).
  - The stale-definitions tell now names the right symptom: the signed-in rows next to a Sign-in required Status.
  - Crumbs are logged only with Verbose logging on.
  - The 0.6.0 row-10 verdict, which my edit had overwritten, is restored.
  - design.md's OpKind list now includes `ui.settings`.
- Open, low: if Obsidian runs row renders outside display (search results, indexing), `shown` could be true while the tab is closed, and a prepared sign-in has no TTL (R-SEC-1 defense in depth; the same exposure as 0.6.1). Skipping `update()` leaves Obsidian's search index at its load-time definitions. Both get re-checked once the stack shows how 1.13 renders.

**Re-run on 0.6.2** (owner, 2026-10-17, Ubuntu): 10a (sign out with the command, settings closed, then open settings) and 10b (revoke, restart, notice, open the tab) **both froze**. No call stack was captured, but the console breadcrumbs (Verbose on) were decisive:
- **`defs`/`defs-done` once, at load:** Obsidian built the definitions while the plugin was signed in.
- **`refresh` → `refresh-skipped-detached` at the revoke:** the closed tab is detached, so the 0.6.2 hypothesis (a closed-tab refresh) is **ruled out**; 0.6.1 skipped there too.
- **When the tab opened, no `defs` line:** Obsidian reused the definitions from load. It drew `account-0`…`account-4`, five rows, which is the **signed-in** layout (storage and Sign out), while the status was signed out or sign-in-required.
- **The last line before the freeze:** `graph.request` with `code: "AuthError"`, the stale storage row reading without a sign-in.

**Cause (confirmed as far as the logs go): stale settings definitions.** The Account rows were chosen when the definitions were built, and Obsidian 1.13+ never rebuilt them unless `update()` ran while the tab was connected. The exact statement that hangs after the failed read isn't proven; the fix removes the stale layout and the read.

**0.6.3:**
- Every Account row is always defined. `visible` predicates (`ui/account-rows.ts`, unit tested) and render-time `auth.status` reads decide what shows.
- `refresh()` calls `update()` on every auth change, even with the tab closed (it only stores the definitions then).
- The storage row reads nothing unless signed in.
- The Sign in row's cleanup discards its prepared sign-in (R-SEC-1).
- design §10 records Obsidian's actual behavior.

**Verification output, 0.6.3** (2026-10-17, after the 0.6.3 review fixes; Node 22.22, container)
```
$ npm run lint                  (exit 0; 0 errors, 0 warnings)
$ npm run typecheck             (exit 0)
$ npm test
# tests 851
# suites 8
# pass 851
# fail 0
$ npm run build                 (exit 0)
$ npm audit --audit-level=high  (exit 0; 3 moderate, dev-only, unchanged)
$ scripts/check-network-apis.sh
no forbidden network APIs
```

**0.6.3 security review** (`security-reviewer` agent; diff 8aea879..d057cb6): no high finding and no security regression. A prepared but untapped sign-in still accepts no callback (T-S1), so every lifecycle gap below could at worst leave a verifier in memory or a dead link.
- Fixed, medium:
  - The status line claimed verification and review results that weren't recorded yet. Both are now recorded here.
  - "update() on a closed tab renders nothing" was stated as observed, but it was seen only before the first display. It is now worded as inferred. A prepare that lands on a detached link now discards itself, and the re-run checks the breadcrumbs (below).
- Fixed, low:
  - The Sign in row's cleanup acts only while no newer render has claimed the row.
  - `hide()` clears the Sign in row, and a client ID change rebuilds the link only while it's attached.
  - `refresh()` catches a settings failure, so it can't break a sign-in or the sign-in-required flip.
  - design §10 says the evidence is from Ubuntu, and that the failed read was the last logged step, not a proven cause.
  - The CHANGELOG no longer says "fixed at its cause".
- Open, info:
  - The visibility test checks the predicate, not each row's key.
  - The Sync rows capture the data object when the definitions are built. That is safe while `data` is only ever changed in place.

**Re-run on 0.6.3** (owner, 2026-10-17): the tab **no longer freezes**. New problem: every time the tab opened while signed in, a notice said "You're already signed in. Sign out first to use a different account." Cause (inferred from the notice, the only path that runs when the tab opens; the 0.6.4 breadcrumb check confirms it): Obsidian 1.14 calls `render` for rows whose `visible` is false. The hidden **Sign in** row ran its prepare, which rejected `already-signed-in`, and the settings tab reported it. **0.6.4:** each state-dependent row checks its own predicate at the top of `render` and renders nothing when hidden; `already-signed-in` and `superseded` prepare rejections stay quiet (`isQuietPrepareError`, tested). design §10 updated.

**Re-run on 0.6.4** (owner):
- **Signed in:** open settings several times. No notice; **OneDrive storage** and **Sign out** show, **Sign in** doesn't. With Verbose logging on, no `signin-prepare` line appears.
- **Sign out with settings open:** while signed in, with the tab open, click **Sign out**. Without reopening settings, the **Sign in** row shows an active **Sign in** link, and storage and Sign out disappear.
- **Sign in with settings open:** while signed out, with the tab open, sign in through the link. When you return, **OneDrive storage** (with figures) and **Sign out** appear and **Sign in** disappears, without reopening.
- **10a and 10b:** as below.

**Verification output, 0.6.4** (2026-10-17; Node 22.22, container)
```
$ npm run lint                  (exit 0; 0 errors, 0 warnings)
$ npm run typecheck             (exit 0)
$ npm test
# tests 852
# suites 8
# pass 852
# fail 0
$ npm run build                 (exit 0)
$ npm audit --audit-level=high  (exit 0; 3 moderate, dev-only, unchanged)
$ scripts/check-network-apis.sh
no forbidden network APIs
```

**0.6.4 security review** (`security-reviewer` agent; diff a7edba3..8be176c): no high finding and no security regression. A hidden row now prepares nothing and claims nothing, and the cleanup contract holds whatever order Obsidian runs render and cleanup in. Quieting `already-signed-in` is correct: it is thrown only when the user is signed in, and the Sign in command and a link tap still report it.
- Fixed, medium: the status line claimed verification and review results before they were recorded. Both are now recorded here.
- Fixed, low:
  - "Cause (traced)" and "observed" are now worded as inferred.
  - The re-run now checks a sign-out and a sign-in with settings open, since a row that rendered hidden is empty and must re-render when it becomes visible.
- Open, low: no unit test covers the hidden-row early return itself (it lives in the Obsidian-facing file). The breadcrumb check (no `signin-prepare` while signed in) covers it on the device.


**Re-run on 0.6.3 steps** (kept for 0.6.4): 10a and 10b, Ubuntu then the iPad.
- **10a pass:** the tab opens and shows **Sign in**, with no **OneDrive storage** or **Sign out**.
- **10b pass:** the tab opens, Status says "Sign-in required", and **Sign in** works and sync resumes.
- **Breadcrumb check** (Verbose logging on, console level Verbose): after you close settings, a `ui.settings` `refresh` line must not be followed by `account-…` or `signin-prepare` lines until you open the tab again.
- If it still freezes, capture the stack (row 10 steps).

**Results, 0.6.4** (owner, 2026-10-17): **row 10 passes.** 10a and 10b pass; no freeze; no notice when the tab opens while signed in; a sign-out and a sign-in with settings open re-render the rows; no errors on either device.
- **Ubuntu** (Obsidian 1.14.4): pass.
- **iPad** (Obsidian 1.14.5 (387)): pass.

**Carry-ins** (requirements handed over by earlier milestones; each names its source)
- **Redirects** (M3 final review, O-API-2): `requestUrl` follows redirects from an allowlisted transfer host without re-checking the target. No token can go along, because the transfer transport is bare, and download bytes are length- and hash-checked. Cover this in the hardening review.

**Acceptance criteria** (all met, 2026-10-17)
- ☑ Every matrix row passes on the devices its **Devices** column names, with results recorded under **Results**. (Some rows need one device by their scenario, such as the iPad force-quit or the Ubuntu-only file names.) Rows 1, 3, 4, 9 and 11 passed on 0.6.0; rows 2, 5 (as 5a), 6, 7, 8 and 12 on 0.6.1; row 10 on 0.6.4.
- ☑ The sentinel test passes (`test/logging.sentinel.test.ts`).
- ☑ The notice-mapping test passes (`test/notices.test.ts`).
- ☑ Every threat-model row is marked implemented, or has a recorded reason (the Status column in docs/threat-model.md; S5 accepted by the owner).
- ☑ `npm audit --audit-level=high` is clean (**Verification output, 0.6.4**).

**Verify**
```bash
npm run lint && npm run typecheck && npm test && npm run build && npm audit --audit-level=high
```

**Verification output** (2026-10-13, after both review passes; Node 22.22, container)
```
$ npm run lint                  (exit 0; 0 errors, 0 warnings)
$ npm run typecheck             (exit 0)
$ npm test
# first sync (union): 664.9 ms, 7000 ops
# steady state: 693.5 ms, 0 ops
# busy day: 677.7 ms, 1252 ops (local-move 50, upload-replace 500, remote-delete 50, local-trash 50, download 501, upload-new 101)
# tests 833
# suites 8
# pass 833
# fail 0
$ npm run build                 (exit 0)
$ npm audit --audit-level=high  (exit 0; 3 moderate, dev-only, unchanged since M6)
$ scripts/check-network-apis.sh
no forbidden network APIs
```
The planning times are the slowest of 3 runs of `plan()` on a 5,000-file, 250-folder fake vault (`test/planner.perf.test.ts`); the limit is 2,000 ms. The engine's `sync.plan` log event now carries `durationMs`, so the time on a real vault shows in **Copy log**.

**Verification output, 0.6.1** (2026-10-17, after the 0.6.1 review fixes; Node 22.22, container)
```
$ npm run lint                  (exit 0; 0 errors, 0 warnings)
$ npm run typecheck             (exit 0)
$ npm test
# tests 843
# suites 8
# pass 843
# fail 0
$ npm run build                 (exit 0)
$ npm audit --audit-level=high  (exit 0; 3 moderate, dev-only, unchanged)
$ scripts/check-network-apis.sh
no forbidden network APIs
```
Planning times on this host were 0.97–1.29 s, against 0.66–0.80 s on 0.6.0. The 0.6.0 code (stashed) measured the same 0.98–1.13 s on this host, so the rise comes from the host, not from 0.6.1. The margin to the 2 s limit is now about 1.5×.

**0.6.1 changes** (after the owner's first pass; verdicts under **Results**):
- **Row 2** (`src/core/executor.ts`, design §5.5 step 0): the conflict procedure compares both versions before it writes a copy: the item's hash, or the downloaded bytes byte for byte when OneDrive lists no hash. Identical files are recorded as synced, with no copy. Tests:
  - the lost commit answer;
  - different bytes;
  - the same bytes;
  - an edit made during the download (it uploads on the next run);
  - an XOR transform;
  - a constructed QuickXorHash collision (two different 200-byte files with equal hashes), which must still give a copy.
- **Row 6** (`src/core/paths.ts`, planner): `containmentSkipReason` reports a drive-letter name as `invalid-name`. `containmentProblem` (the pre-write re-check) still refuses it.
- **Rows 7–8** (engine): `sync.plan` logs `code: "union"` for first-sync merges.
- **Row 10:**
  - `AuthClient` logs `auth.refresh` breadcrumbs (design §9).
  - Settings → Diagnostics has the **Verbose logging** toggle. Design §9 specified it from the start, but it was never built.
- Version 0.6.1.

**0.6.1 security review** (`security-reviewer` agent; base 49ab5c3, commit e784e25):
- No high or medium findings. The step-0 adopt can't lose or mask local bytes (an edit after the read leaves mtime 0, so the next scan re-hashes). The drive-letter refusal holds at every local write. The breadcrumbs and the console mirror carry codes only.
- Fixed, low:
  - With the remote bytes already downloaded, step 0 still decided by QuickXorHash, which a writer to the App Folder could collide. It now compares bytes, and the collision test proves it.
  - Edge cases are now tested: an edit during the download, a non-identity transform, and the collision.
  - The sentinel run now gives `AuthClient` the logger, so the breadcrumbs pass the sentinel check and the console capture.
  - A bad token answer or a failed token store left `start` as the last breadcrumb, which looks like a hang. These now log `failed-local`.
- Fixed, info: the clear step can no longer skip the sign-in-required notice if the logger throws. The row-6 verdict and the CHANGELOG now say that a rename to such a name keeps the OneDrive copy.
- Open, info: a copy an earlier, crashed attempt wrote stays on disk and uploads as an ordinary file (design §5.5 step 0).

**What was built**
- `src/remote/timeout.ts` (new): `TimeoutTransport` wraps the requestUrl transport once in `main.ts`, under both the authorizing and the transfer transport. 120 s, plus 1 s per started 64 KiB of body; `GraphClient.download` sets `HttpRequest.timeoutMs` (new optional field, `ports.ts`) from the item size. `RequestTimeout` (no URL) isn't retried; `classify.ts` maps it to `network`/`timeout`, so the run ends `partial`. An upload session's final fragment carries `NO_TIMEOUT` (see **Security review**). `stuck` counts timed-out requests still hanging; at 2, unattended triggers skip, with a one-time notice (`ui/triggers.ts`).
- `src/ui/quota.ts` (new): `quotaText` and `QuotaCache` (5 min success, 1 min failure, shared in flight, cleared on sign-out and after a `quota` failure). Settings → Account → **OneDrive storage** (signed in only). Quota reads use their own `GraphClient` with `RetryPolicy({ singleAttempt: true })` (new option).
- `src/ui/notices.ts`: `ERROR_TEXT` covers every classifier and core code (`timeout`, `name-exists`, `range`, `resync`, `range-error`, `no-approot`, `cancelled`, `other`), `graph-<status>` families (5xx, 429, other 4xx), and sign-in codes via `AUTH_ERROR_MESSAGES`; `isAuthCode`. The quota text points to **OneDrive storage**.
- The 507 / `quotaLimitReached` → `quota` mapping already existed in `src/remote/classify.ts` (M6); M8 proves it per write call and through the engine rather than moving it into `graph.ts` (clarification of the **Files** list).
- `docs/threat-model.md`: a **Status** column on every row. `docs/design.md` §2, §6.1, §9 and §10 updated. Version 0.6.0.

**Tests added:** `test/logging.sentinel.test.ts` (1; full stack; checked to catch a URL written to the console and a path logged as `code`), `timeout-transport.test.ts` (10), `quota.test.ts` (6), `planner.perf.test.ts` (1), and in existing files: notices (4: every classified and core code, HTTP families, sign-in codes, quota notice), graph (4: quota per write call, quota on a fragment, the download timeout, no timeout on the commit fragment), engine (1: a 507 mid-run), triggers (1), retry (1). The commit-fragment test was checked to fail with its fix reverted; the other new tests were written before their code and failed first. The quota-mapping tests passed at once: they pin behavior M6 built. `FakeGraph` gained `realHashes` for end-to-end runs through `RemoteContent`; `Device` gained `concurrency`.

**Acceptance**
- Matrix rows: pending (owner, 0.6.0).
- The sentinel test passes. The notice-mapping test passes. Every threat-model row is marked implemented, accepted with a reason, or owed in M9. `npm audit --audit-level=high` is clean.

**Carry-ins closed**
- **Long requests (M7):** timeouts as above; the owner chose "timeout, no retry" in the plan approval.
- **Notice table (M7):** done, with the mapping test.
- **Sentinel test (M7):** it runs a full fake sync through `Engine` with the M7 hooks (`onStatus` → `statusText`, `onReport` → `noticesFor`) attached.
- **Redirects (M3):** reviewed under threat-model S5/T5: accepted, because the transfer transport is bare (no token can go along), downloads are length- and hash-checked, and the redirect comes from Microsoft's own host. **Accepted by the owner, 2026-10-17.**
- Not done (optional, owner's call, unchanged from M7): the per-fragment `live()` check in `RemoteContent.resume`; re-hashing after a download write. Settings re-render on 1.13+ (`update()`) was covered by M7 check 11.

**Security review** (`security-reviewer` agent; base 4b14335, then 1b8482a):
- **First pass.** No high findings.
  - Fixed, medium: an upload session's final fragment commits the file with no If-Match [G-UP-5]. With timeouts, a timed-out commit could land after the next run had uploaded a newer version, and the run after that would download the old bytes over the edit. The final fragment now carries `NO_TIMEOUT` and keeps the single-flight lock, as before M8. The timeout.ts header, design §6.1 and threat-model D4 were corrected.
  - Fixed, low: requests hung past their timeout piled up (each holds a body of up to 10 MiB and a connection). Now they are counted, and unattended runs pause at 2.
  - Fixed, low: quota reads shared the sync's `RetryPolicy` (backoff, budget, pause), and failures weren't cached.
  - Fixed, info: the iOS timer wording in design §6.1; the I3 status wording; the `fetch` field in `QuotaCache` renamed `read`.
  - Open, info: the S5 redirect acceptance needed the owner's sign-off (given 2026-10-17).
- **Re-review of the fixes.** The medium is confirmed fixed, and `stuck` can't drift below zero. No high or medium findings.
  - Fixed, low: a request that never answers kept the pause on silently. The first skip now shows a persistent notice.
  - Fixed, low: `maxAttempts: 1` still waited on Retry-After. Quota reads now use `singleAttempt` (no wait, pause or budget).
  - Open, info (no action): an engine rerun already queued isn't re-checked against `stuck` (at most one more run). A commit fragment that never answers holds the lock until a restart (the pre-M8 behavior, now limited to the commit; the probe's last fragment too). The commit-fragment test checks the flag, not a simulated late commit. A plugin reload while a commit is on the wire can still race the new instance (pre-M8, unchanged).

**Notes for M9:** moved to the M9 section's **Carry-ins** list, which is where the session protocol tells the next session to read.

---

## M9: BRAT release 1.0.0 and README with the Entra guide
**Status:** awaiting-owner (2026-10-17, 1.0.0). The session part is done: README, community checklist, version 1.0.0 and CHANGELOG; lint, typecheck, 872 tests, build and audit pass (**Verification output**, after the owner-notes follow-up and its review). The release itself (tag, draft, publish, `gh attestation verify`), the tag ruleset, the BRAT installs and the round trip are owner steps 1–7 below; M9 is `done` when they pass.

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

**Carry-ins** (requirements handed over by earlier milestones; each names its source)
- **Start from `main`** (M8 close-out): M8 was built on branch `claude/wizardly-einstein-m82jdh` and is merged into `main` by pull request before M9 starts. The last pre-release version is 0.6.4. `CHANGELOG.md` **[Unreleased]** holds the 0.5.x–0.6.4 notes; turn them into the **[1.0.0]** section.
- **README items** (threat model; M8 review):
  - the residual risks (threat-model §4);
  - files are stored unencrypted in OneDrive (T-I5);
  - the plugin never runs or renders file contents (T-T3);
  - any installed plugin can read the token; install only plugins you trust, and how to remove the app's access at https://account.microsoft.com/privacy/app-access (T-I1, T-I2);
  - `gh attestation verify main.js -R caseke/MDVaultSync` (T-T7).
- **README settings reference** (M8):
  - **OneDrive storage** (used, total and free; warns at 10 % free; the recycle bin counts);
  - **Verbose logging** (mirrors the log to the developer console; codes only).
- **README behavior notes** (M8):
  - a request OneDrive doesn't answer gives up after 2 minutes plus time for its size, and the sync ends `partial`;
  - while 2 or more requests hang, automatic syncs pause with a notice (**Sync now** still works);
  - conflict naming, including that identical files are never turned into conflicts;
  - names OneDrive refuses, such as `:` in a name, are skipped and listed;
  - with two names that differ only in letter case and neither synced yet, both are skipped (R-PATH-2).
- **S5 redirect** (M3 carry-in, accepted by the owner 2026-10-17): it stays off the README's residual-risk list; the README may mention it under how transfers are protected. **Reopen S5** if the transfer-host allowlist (design §8) ever gains a domain where outsiders can create subdomains, such as `.sharepoint.com`: an outsider-owned allowed host could then redirect uploads.
- **Obsidian 1.14 settings-tab behavior** (M8 row 10; design §10; research [O-API-21], [O-API-22]). It differs from its d.ts in two ways:
  - it builds `getSettingDefinitions()` at load and on `update()`, and reuses that copy when the tab opens;
  - it calls `render` for rows whose `visible` is false.

  Any settings change must keep both rules: decide everything at render time, and guard each state-dependent row inside `render`. The 0.6.2–0.6.4 history is in M8.
- **Open items, not blocking 1.0.0** (from the M7 and M8 reviews; the owner may pick any):
  - checking `live()` between fragments inside `RemoteContent.resume` (M7, declined for now);
  - re-hashing after a download write in `recordDownload` (M7);
  - a prepared but untapped sign-in has no expiry; only a tapped one expires after 10 minutes (R-SEC-1 defense in depth, M8 0.6.2 review);
  - a conflict copy that an earlier crashed attempt wrote stays on disk and uploads as an ordinary file (M8 0.6.1 review);
  - unit tests check the settings visibility predicates, not their wiring in `settings-tab.ts`; the Sync rows capture the data object when the definitions are built, which is safe while `data` is only changed in place (M8 0.6.3 and 0.6.4 reviews).
- **Performance margin** (M8): planning a 5,000-file vault took 0.97–1.29 s on the slower container host, against a 2 s limit (`test/planner.perf.test.ts`). If CI ever runs on a slower host, that test is the first to watch.
- **Matrix row 5b** (M8): passed by design as 5a (neither name synced, so both are skipped). The tracked-name case (5b) was never run on a device; the planner tests cover it.

**Owner actions** (in this order; record each result under **Owner results**)
1. **Merge** this branch into `main` by pull request (the directory and BRAT read `manifest.json` from the default branch [O-SUB-1]).
2. **Tag ruleset** (T-T8) [C-GH-6]. On GitHub: repository **Settings → Rules → Rulesets → New ruleset → New tag ruleset**.
   - **Ruleset name:** `Release tags`. **Enforcement status:** Active.
   - **Bypass list:** **Add bypass** → **Repository admin** (that's you) → *Always allow*.
   - **Target tags:** **Add target → Include by pattern** → `*.*.*`.
   - **Rules:** tick **Restrict creations**, **Restrict updates** and **Restrict deletions**. Leave the rest unticked.
   - **Create.** Check it: `gh api repos/caseke/MDVaultSync/rulesets --jq '.[] | {name, target, enforcement}'` lists `Release tags`, `tag`, `active`.
   The portal labels come from GitHub's docs, not from a live look; if one differs, use the nearest match and note it here.
3. **Tag and push** the merge commit on `main` (the version is already 1.0.0 in the branch, so don't run `npm version`):
   ```bash
   git switch main && git pull
   node -p 'require("./manifest.json").version'      # must print 1.0.0
   git tag -a 1.0.0 -m 1.0.0 && git push origin 1.0.0
   ```
   The **Release** workflow runs (Actions tab). Pass when both jobs are green and **Releases** has a draft `1.0.0`, **not** marked pre-release, with exactly `main.js`, `manifest.json` and `styles.css`.
4. **Check the draft, then publish it.** Paste the CHANGELOG `[1.0.0]` section into the release notes (below the generated "Verify:" line), select **Set as the latest release**, and **Publish release**.
5. **Verify the attestation** (T-T7):
   ```bash
   cd "$(mktemp -d)"
   gh release download 1.0.0 -R caseke/MDVaultSync -p main.js
   gh attestation verify main.js -R caseke/MDVaultSync
   gh attestation verify main.js -R caseke/MDVaultSync --signer-workflow caseke/MDVaultSync/.github/workflows/release.yml
   ```
   Pass when both print `✓ Verification succeeded!` (paste the last lines below).
6. **BRAT on both devices.** On Ubuntu and on the iPad, run **BRAT: Check for updates to all beta plugins** (or add `caseke/MDVaultSync` on a fresh install). **Settings → Community plugins** shows MDVaultSync **1.0.0**.
7. **Round trip.** On Ubuntu, create a note `M9 check.md` with one line and run **Sync now**. On the iPad, run **Sync now**: the note appears. Add a line on the iPad, sync, then sync Ubuntu: the line arrives. Delete the note on Ubuntu and sync both: it's in the iPad's trash (as Obsidian's **Deleted files** setting says) and in the OneDrive recycle bin. Pass when each step shows the expected result and no conflict copy appears.
7a. **Owner-notes follow-up checks** (on 1.0.0; a failure here means a 1.0.1, not a re-tag):
   - **Show log** on Ubuntu and on the iPad: Settings → MDVaultSync → Diagnostics → **Show log** opens the log; **Copy**, then paste somewhere. Pass when the paste holds the log, or, if it can't reach the clipboard, the hint appears within about 2 seconds and the text is selected for a manual copy. Say which one happened on each device.
   - **Device name:** the **Device name** description reads `Leave empty for "iOS"` on the iPad and `Leave empty for "Linux"` on Ubuntu.
   - **Diagnostics:** the command palette has no "Run OneDrive capability probe" or "Test file replace" command, and settings has no probe row.
8. **Optional:** the community.obsidian.md **Review branch** preview, steps in [community-checklist.md](community-checklist.md).
9. **Later:** re-test sign-in 30 or more days after the Azure sign-up (cost-estimate "to re-check"), when the free subscription is disabled. Pass when **Sign in** still works on one device. This doesn't block 1.0.0.

**Acceptance criteria**
- Tag `1.0.0` produces a draft release with 3 assets and an attestation. *(owner step 3)*
- `gh attestation verify` succeeds on the downloaded `main.js`. *(owner step 5)*
- BRAT installs 1.0.0 on both devices, and a sync round trip works. *(owner steps 6–7)*
- Every SPEC requirement is ticked in the table below. *(all ticked except R-SEC-5, which waits on step 5)*

**Verify** (session part; the release part is owner steps 3–5)
```bash
npm run lint && npm run typecheck && npm test && npm run build
npm audit --audit-level=high
scripts/check-network-apis.sh
npm version 1.0.0 --no-git-tag-version   # done in the session: version-bump.mjs → manifest.json + versions.json
```
*Changed in M9:* the plan had `npm version 1.0.0` and `git push --follow-tags` on `main` after the merge. The version is bumped in the branch instead, as for 0.6.x, so the pull request carries the 1.0.0 manifest and CHANGELOG; `npm version 1.0.0` on `main` would then fail ("Version not changed"). The owner tags the merge commit (step 3).

**Verification output** (2026-10-17, Node 22.22, container; after the owner-notes follow-up and its review fixes)
```
$ npm run lint                  (exit 0; 0 errors, 0 warnings)
$ npm run typecheck             (exit 0)
$ npm test
# tests 872
# suites 8
# pass 872
# fail 0
$ npm run build                 (exit 0)
$ npm audit --audit-level=high  (exit 0; 3 moderate, dev-only, unchanged)
$ scripts/check-network-apis.sh
no forbidden network APIs
$ npm run build; sha256sum main.js   (twice)
1d473fb238fcb8b15df362b81db4708c167faae9e57ab92231d96a2a89b6d5b6  main.js
1d473fb238fcb8b15df362b81db4708c167faae9e57ab92231d96a2a89b6d5b6  main.js
```
Before the follow-up (after the first review fixes): 868 tests passing, `main.js` sha256 `d36b5900…77f6e` both times. The count fell by the removed probe tests and rose by the new token, migration, copy and README tests.
The two builds give the same `main.js`, which the community directory's build verification relies on [O-SUB-5].

**What was built**
- `README.md`, complete: what it does and doesn't; the disclosures [O-POL-1], [O-POL-2]; installing with BRAT; the full **Microsoft Entra setup**; first sync; a settings reference and a commands list; how sync works (conflict naming, identical files never become conflicts, deletes, renames, skipped names including `:` and case collisions, timeouts and the pause, how transfers are protected, including the S5 redirect); what never syncs; security and residual risks (threat-model §4 verbatim, plus T-I5, T-T3, T-I1, T-I2); verifying a release; sign-out and uninstall; troubleshooting.
- `docs/entra-setup.md` now points to the README section. The guide moved rather than being copied, so there is one copy to keep current (a deviation from the **Files** list, approved in the plan). The "Before you start" text no longer says "until 1.0.0".
- `docs/community-checklist.md` (new): 19 items from [O-SUB-1]…[O-SUB-5] and [O-POL-1]…[O-POL-4], all pass or owner-pending; the Review branch preview isn't run (needs the owner's login).
- `release.yml`: reviewed. A `1.0.0` tag gives a normal draft release (only `0.*` tags are pre-releases), which BRAT installs as the latest [O-BRAT-1]. New step (security review): the release job refuses a tag whose commit isn't on `main` (GitHub compare status `behind` or `identical`), before attesting. **So from now on, tag only after merging**: the 0.6.x habit of tagging a branch commit before the merge now fails the release job.
- `docs/research.md`: O-SUB-7 (the re-check; `docs.obsidian.md` and `cli.github.com` are blocked here, so web-search results were used), C-GH-5 (`gh attestation verify` flags), C-GH-6 (tag rulesets).
- Version 1.0.0; CHANGELOG `[1.0.0]` sums up 0.4.0–0.6.4 for users.

**Tests added:** `test/readme.test.ts` (12; the 12th, the one-sync-service warning, came with the review fix): the disclosures; the Entra guide's steps, redirect URI, scopes and account type, and the pointer in entra-setup.md; BRAT; every settings row and command name, parsed from `settings-tab.ts` and `main.ts`, appears in the README (a setting added later without docs fails it); conflict naming tied to `conflict-name.ts`; the M8 behavior notes; exclusions; every §4 risk verbatim from `threat-model.md`; both verify commands; sign-out and uninstall; no stale pre-release text and no broken relative link. `test/workflows.test.ts` (3): only `0.*` is a pre-release; `--verify-tag` (these two pin existing behavior and passed at once); the commit must be on `main` (written before the step, failed first). `test/manifest.test.ts` (1): CHANGELOG has a dated section for the manifest version. The README tests (but the disclosures one, which the M1 README already met) and the CHANGELOG test failed before the docs were written.

**Carry-ins closed**
- **Start from `main`:** the branch starts at the PR #10 merge (e0a4efa); `[Unreleased]` became `[1.0.0]`.
- **README items, settings reference, behavior notes:** all in the README, and tested.
- **S5 redirect:** under **How transfers are protected**, not under the risks. The reopen condition stays in threat-model S5.
- **Obsidian 1.14 settings-tab behavior, performance margin, matrix row 5b:** no settings or planner change in M9, so nothing to keep; they stay recorded in M8 for later work.
- **Open items, not blocking 1.0.0:** none picked; they stay open (listed under **Open after 1.0.0**).

**Owner-notes follow-up** (2026-10-17, after the owner read the README; plan approved in the session)
Triage of the 9 notes: 1, 2, 3, 4a, 5 and 7 before the tag; 4b, 6 and 8 after (below).
- **Token fallback (note 3; owner chose "memory only"):** when SecretStorage fails, the refresh token is kept in memory for the session and never written to disk. A non-secret `sessionOnlySignIn` flag in data.json drives the settings warning and a notice at the next launch. A 0.x plaintext `fallbackRefreshToken` is moved into SecretStorage, or memory, at load and data.json is saved without it (`legacyRefreshToken`, `adoptLegacy`). SPEC R-AUTH-5, D-5 and D-6, design §4 and §11, and threat-model I1 and I2 are updated. Tests: `test/token-store.test.ts` (rewritten for memory-only, restart, migration) and `test/settings.test.ts`.
- **Device names (note 4a; owner chose "iOS"):** "iOS", "Linux", "Mac", "Windows", "Android", else "Device". No distribution name: that needs Node file access, which mobile lacks.
- **Diagnostics (note 5):** the capability probe (`src/remote/probe.ts`, `src/platform/diagnostics.ts`), the file-replace test (`src/platform/rename-probe.ts`) and `src/ui/diagnostics-modal.ts` are removed, along with their commands, settings row and tests. `platformName` moved to `src/platform/platform-name.ts`. `probeBytes` moved into `test/quickxor.test.ts`, which keeps OneDrive's hash vectors. SPEC R-UI-1 is amended. The capability constants stay in `capabilities.ts`.
- **Copy log (note 7; owner: on Ubuntu nothing happened, no notice):** the old handler gave no answer when `navigator.clipboard.writeText` threw before returning a promise or never settled. **Show log** now opens `LogModal`, and `copyText` (`src/ui/copy-text.ts`) always settles: copied, or manual after a throw, a rejection, a missing API or a 2-second timeout, which selects the text. Tests: `test/copy-text.test.ts` (6). The real cause on Ubuntu isn't known; step 7a records what each device does.
- **README (notes 1, 2):** rewritten shorter. Old portal labels, old layouts, the paste-fallback history and research IDs are gone. One **Troubleshooting** section holds the sign-in errors and sync symptoms. `test/readme.test.ts` (+2) checks the single troubleshooting section, the memory-only text and that no removed diagnostic is mentioned.
- CHANGELOG `[1.0.0]` updated (Removed, Fixed, Security). The version stays 1.0.0 (not tagged yet).
- **Security review of the follow-up** (`security-reviewer` agent; commit f219554 against 5244dfd). No high or medium. Every save path keeps the token off disk.
  - Fixed, low:
    - A failed save during the migration left the plaintext token in data.json, and the flag stayed set in memory without being saved. Now `migrateLegacyToken` (`token-store.ts`, tested) saves even if adopting fails and reports a failed save; `main.ts` then shows a persistent notice with the app-access page. `setFlag` puts the flag back when its save fails.
    - The migration had no test; it has 5 now.
    - When SecretStorage keeps an older token it won't overwrite, `staleSecret` makes the settings warning say so (tested).
    - `copyText` settles even when `writeText` returns no promise (tested).
    - The log modal sets the selection range and, if the selection didn't take (iPadOS outside a tap), says to select it by hand.
    - README: the Live SDK advice now says to set it back to No; the files-outside-the-vault disclosure no longer contradicts itself and names the hidden temporary file; a warning against going back to a 0.x build, also in the CHANGELOG.
  - Fixed, info:
    - The launch notice says "closed or the plugin reloaded" and shows for 15 seconds, not until dismissed.
    - A failed flag save no longer makes sign-out report a removed token as still there.
    - Stale comments in `main.ts` and `capabilities.ts`, and design §1 and §10.
    - SPEC R-AUTH-5 covers a write SecretStorage doesn't keep.
    - Threat-model D3 notes the removed file-replace test.

**Open after 1.0.0** (owner's choice; the M7 and M8 review items, plus owner notes 4b, 6 and 8)
- **Duplicate device names (note 4b).** No data-safety effect: copies carry a timestamp to the second and get ` 2` on a clash. Detecting duplicates needs a shared registry file in the app folder (new remote data, validation and threat-model rows).
- **Sync history and log export (note 6).** Proposal: keep a local history of the last N reports with problems, file names included, viewable in Obsidian and separate from the log. The log stays codes-only (R-SEC-3). An optional export adds per-file tokens as an HMAC with a random key made per export and never saved, so names can be matched within one export but not guessed. Needs a SPEC and threat-model change.
- **Ribbon action by state (note 8).** Sync when synced; show the status while syncing, waiting or after an error; sign in when a sign-in is needed. The tooltip and aria-label must change with the action.
- checking `live()` between fragments inside `RemoteContent.resume`;
- re-hashing after a download write in `recordDownload`;
- a prepared but untapped sign-in has no expiry;
- a conflict copy written by a crashed attempt uploads as an ordinary file;
- wiring tests for the settings visibility predicates in `settings-tab.ts`.

**Security review** (`security-reviewer` agent; base e0a4efa, commits 942360a and 1511526):
- No high findings. release.yml for 1.0.0 checked item by item with no problem (permissions, trigger, tag check before `npm ci`, tag re-check, attestation of all 3 files, draft only, pre-release only for `0.*`, SHA pins). The README's host list, Authorization claims, log claims, naming rules, settings, commands, sign-out and uninstall text match the code. The Entra guide matches the M2-verified text.
- Fixed, medium: the disclosure said the plugin's settings and sync state stay "on this device only", which holds only when nothing else syncs the vault folder. iCloud, Obsidian Sync, Dropbox or Syncthing would carry `sync-state.json` (valid state, so no union fallback: a sync could act on another device's history, T-D1) and possibly a fallback token in `data.json`. The disclosure now says "this device's plugin folder", Install warns to use only one sync service per vault (and to keep an iPad vault out of iCloud Drive), and **Token storage** names the `data.json` exposure. Tested.
- Fixed, low:
  - "Both can be restored" now says local trash depends on **Deleted files** and the recycle bin keeps items for a limited time.
  - "Checked against size and fingerprint" now says the fingerprint is checked when OneDrive provides one (README and CHANGELOG).
  - The security section names the `data.json` fallback for the refresh token.
  - Step 5 says what to do if the sign-in opens in Obsidian's Web viewer (T-S3).
  - Uninstall without signing out: remove the app's access, since the token stays readable until a reinstall (T-I1, T-I2).
  - Updating safely: turn off BRAT's startup auto-update and verify each release before updating (T-T8).
  - release.yml: a tag on a commit not on `main` is refused (above). The release-environment reviewer gate is not added (optional below).
  - The conflict-naming test now calls `conflictCopyPath`; the behavior and settings tests build their numbers from the code's constants (`API_TIMEOUT_MS`, `STUCK_LIMIT`, `FRAGMENT`, `DEFAULT_DATA`, `MAX_PATTERN_LINES`, `LOW_SPACE_FRACTION`); the disclosure test takes the hosts from `AUTHORITY` and `GRAPH_BASE`, and fails if `TRANSFER_HOST_SUFFIXES` changes.
- Fixed, info: "Device" as the default on other platforms, and a unique name for two devices of one kind; MB means 1024 × 1024 bytes; the pause also ends when OneDrive answers; the byte compare may download a file without a fingerprint; verify the files from `gh release download`, not the installed `manifest.json`; names over 255 characters; the ruleset's admin bypass recorded in threat-model T8.
- **Re-review of the fixes** (commit a25a041): every finding fixed but the two optional ones below; no high or medium. Fixed, low: the main check named `main` as a short ref, which a tag called `main` could shadow; it now takes the branch's commit from the branches API. Info, no action: the compare semantics (a tag on an older commit of main passes, which the version check and the ruleset bound) and every failure path refusing the release.
- Open, optional (owner): run the release job in a `release` environment with a required reviewer (T-E4); add `--source-ref refs/tags/<version>` to the README's verify command once the owner confirms the installed gh supports it.

**Owner results**
| Step | Result |
|---|---|
| 1 Merge | (owner) |
| 2 Tag ruleset | (owner) |
| 3 Tag 1.0.0 → draft, 3 assets, not pre-release | (owner) |
| 4 Published | (owner) |
| 5 `gh attestation verify` (both forms) | (owner) |
| 6 BRAT 1.0.0 on Ubuntu / iPad | (owner) |
| 7 Round trip | (owner) |
| 7a Show log / device name / diagnostics gone | (owner) |
| 9 Sign-in after 30+ days | (owner, later) |

---

## Requirement traceability
| Requirement | Milestone | Done |
|---|---|---|
| R-ENV-1…4 | M1, M2 | ☑ (M2 part done 2026-10-12: personal accounts only via /consumers, iPad and Ubuntu sign-in verified, minAppVersion 1.11.4. M8 2026-10-17: the end-to-end matrix passed on the iPad and Ubuntu, including concurrent edits (rows 11, 12, R-ENV-4); `isDesktopOnly: false` and minAppVersion tested in `test/manifest.test.ts`) |
| R-AUTH-9 | M6 (follow-up) | ☑ (2026-10-12: a token in SecretStorage is cleared at load, with a notice, only when the plugin folder holds neither data.json nor sync-state.json (checked on disk); unit tested. Owner checks 2026-10-12: reinstall passed on Ubuntu and the iPad (0.4.1); a corrupt data.json keeps the sign-in and the file (Ubuntu)) |
| R-AUTH-1…8 | M2 | ☑ (M2, 2026-10-12; R-AUTH-3 withdrawn. R-AUTH-7 token clear verified on Ubuntu; clearing real sync state is verified with the M6 StateStore; M6 2026-10-12: sign-out clears sync-state.json through PluginStateStore and a running sync can't write it back; tested) |
| R-SCOPE-1…4 | M4, M5, M7 | ☑ (M7 part done 2026-10-12 (owner checks passed): maximum file size and exclude patterns settings, validated; unreadable patterns pause sync instead of excluding nothing. M4 part done 2026-10-12: configDir, hidden and user-glob exclusion (R-SCOPE-2); `remoteToVaultPath` returns the skip reason for hidden or excluded remote paths (R-SCOPE-4 rules). M5 part done 2026-10-12: size cap skips `too-large` (R-SCOPE-3), excluded or hidden remote items are skipped and reported, never downloaded (R-SCOPE-4)) |
| R-TRIG-1…4 | M6 (lock), M7 | ☑ (M6 part done 2026-10-12: single-flight lock with at most one rerun, R-TRIG-4, tested. M7 part done 2026-10-12 (owner checks passed 2026-10-12): startup sync 5 s after layout-ready, interval timer 0/1–1440, Sync now command and ribbon button through one path; the rerun keeps the strongest trigger, none after reset; tested) |
| R-CD-1 | M3, M5 | ☑ (M3 part done 2026-10-12: delta with paging to deltaLink, `items-id`; M5 part done 2026-10-12: remote paths rebuilt from parentId chains; children of a deleted folder are deletes, orphans and cycles never are. Merging delta pages into `remoteIndex` is M6; M6 part done 2026-10-12: delta pages merged into `remoteIndex`, last occurrence wins, a deleted folder drops its descendants, saved with the deltaLink; resync re-enumerates in union mode) |
| R-CD-2 | M5, M7 | ☑ (M7 part done 2026-10-12 (owner checks passed 2026-10-12): create, modify, delete and rename events registered in onLayoutReady and recorded as hints; startup full reconcile scan; tested) |
| R-CD-3, R-CD-4 | M4, M5 | ☑ (M4 2026-10-12: QuickXorHash; M5 2026-10-12: FileRecord validated, change detection by hash → cTag → size/eTag, unchanged content never planned for transfer) |
| R-ORDER | M6 | ☑ (M6, 2026-10-12: pull side before push side, moves first; tested) |
| R-CC-1, R-CC-2 | M3, M6 | ☑ (M3 part done 2026-10-12: If-Match on replace, move, delete and replace sessions; conflictBehavior=fail on new files and folders; 412 → GraphError; M6 part done 2026-10-12: PUT with If-Match per the probe, sessions above 10 MiB with the commit-time eTag re-check, 412 re-read: metadata-only retry, else conflict; tested) |
| R-CONF-1…4 | M4, M5, M6, M7 | ☑ (M4 part done 2026-10-12: conflict-copy naming for R-CONF-1; M5 part done 2026-10-12: conflicts only when both sides differ (R-CONF-3, property-tested), no-history pairs counted in `differsNoHistory`, report conflicts list; M6 part done 2026-10-12: conflict procedure with pendingConflicts and crash reuse, copy uploaded, pre-write re-check (R-CONF-4); the notice is M7. M7 part done 2026-10-12 (owner checks passed 2026-10-12): one persistent notice lists every conflict copy (R-CONF-2); the preview groups no-history conflicts (R-CONF-3); tested; M8 2026-10-17: identical bytes are adopted, not copied, even when OneDrive lists no hash (byte compare)) |
| R-DEL-1…3 | M5, M6 | ☑ (M5 part done 2026-10-12: deletes planned both ways with If-Match, edits beat deletes (R-DEL-2), folder deletes only with zero children incl. skipped (R-DEL-3); M6 part done 2026-10-12: remote delete with If-Match (404 forget, 412 download back), local delete via FileManager.trashFile, folders only when empty; tested with fakes) |
| R-MOVE-1 | M5, M6 | ☑ (M5 part done 2026-10-12: renames detected by id, event or unique hash; folder renames collapse to one move; M6 part done 2026-10-12: PATCH by id with If-Match and eTag chaining, Vault.rename locally, folder moves re-path records; tested with fakes) |
| R-FIRST-1, R-FIRST-2 | M5, M7 | ☑ (M5 part done 2026-10-12: union mode never deletes (property-tested); malformed state, approot change and a missing approot id all force it. M7 part done 2026-10-12 (owner checks passed 2026-10-12): preview modal before the first sync, on the Preview sync command and with the setting on; Cancel and timeout run nothing; tested) |
| R-GUARD-1 | M5, M7 | ☑ (M5 part done 2026-10-12: `deleteCount`, `exceedsDeleteGuard` boundary, declined deletes suppressed until either side changes or "Sync now". M7 part done 2026-10-12 (owner checks passed 2026-10-12): confirm modal with "Delete N files" / "Skip deletes this time", skip on close or timeout, threshold setting 1–100 %) |
| R-PATH-1…4 | M4, M6 | ☑ (M4 part done 2026-10-12: NFC and collision detection, naming rules, 400-character limit and containment rules, unit tested; the pre-write re-check is M6; M6 part done 2026-10-12: containment and name rules re-checked before every local write, move, trash and mkdir, in the executor and in ObsidianVault; M8 2026-10-17: a drive-letter-like name (`a:b.md`) is reported invalid-name; still refused before every write) |
| R-IO-1, R-IO-2 | M6 | ☑ (M6 2026-10-12: temp-then-rename and hash-before-write implemented and tested; adapter.rename refuses to overwrite on Ubuntu and the iPad, and the remove-then-rename fallback passed on both) |
| R-NET-1 | M2, M3 | ☑ (M2 and M3, 2026-10-12: auth and Graph go only through the requestUrl transport; lint and the CI script enforce it) |
| R-RES-1 | M3 | ☑ (M3, 2026-10-12: Retry-After with a global pause, full-jitter backoff, run budget; unit tested; M8 2026-10-17: request timeouts (not retried; the commit fragment never times out), quota reads never retry) |
| R-RES-2, R-RES-3 | M3, M6 | ☑ (M3 part done 2026-10-12: 10 MiB upload-session primitives, status and 404 handling; a 12 MiB two-fragment round trip passed on both devices; persistence and resume are M6; M6 part done 2026-10-12: sessions persisted before the first fragment and resumed from nextExpectedRanges, 404 restarts; saves at most 1 s after an op and before every destructive op; crash injection after every mutating call converges) |
| R-UI-1…3 | M2, M7, M9 | ☑ (M9 2026-10-17: R-UI-1 amended, the capability probe removed; the log opens in a window with a copy fallback. M2 part done 2026-10-12: Account section. M7 part done 2026-10-12 (owner checks passed 2026-10-12): every R-UI-1 field; status bar on desktop with the state and last sync time; on mobile the ribbon icon shows the state and Show sync status the time (R-UI-2 amended 2026-10-12, 0.5.1); notices for errors and conflicts only; tested in the pure modules; M8 2026-10-17: the OneDrive storage line (T-D7), the Verbose logging toggle, error notice text for every code, and settings rows that follow the sign-in state (Obsidian caches definitions)) |
| R-SEC-1, R-SEC-2 | M2, M9 | ☑ R-SEC-1 (unit tested); ☑ R-SEC-2 (M2: SecretStorage observed on both devices, including a locked GNOME keyring; M9 2026-10-17: the residual risks are in the README, copied verbatim from threat-model §4 and tested in `test/readme.test.ts`) |
| R-SEC-3 | M3, M8 | ☑ (M3 part done 2026-10-12: typed redacting logger, unit tested; M8 part done 2026-10-13: the sentinel test runs full syncs over the production stack and finds no name, content, token, URL or server message in the ring buffer or any console call) |
| R-SEC-4 | M3, M4 | ☑ (M3 part done 2026-10-12: Graph JSON, ids, names, sizes, tags, hashes, links and transfer URLs validated; M4 part done 2026-10-12: remote-derived paths validated by `remoteToVaultPath`) |
| R-SEC-5 | M1, M9 | ☐ (M1 part done: lockfile, Dependabot, CodeQL, audit, SHA pins, and secret scanning and push protection verified 2026-10-12. M9 session part 2026-10-17: release.yml reviewed for 1.0.0, attestation over the 3 files, tests in `test/workflows.test.ts`. Ticked when owner step 5, `gh attestation verify` on the published 1.0.0 `main.js`, passes) |
| R-SEC-6 | M1 | ☑ (M1, 2026-10-12) |
| R-ENG-1…5 | M1 onward | ☑ (2026-10-17: R-ENG-1 strict TypeScript from the sample structure (M1); R-ENG-2 `eslint-plugin-obsidianmd` recommended in every milestone, README disclosures (M9); R-ENG-3 `src/core` and `src/remote` import no `obsidian` (lint rule, `test/lint-rules.test.ts`); R-ENG-4 the `ContentTransform` seam with the M6 non-identity test; R-ENG-5 lint, typecheck and tests pass with output pasted in every milestone M1–M9) |
