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
**Status:** done (2026-10-12). Session work verified, owner actions done and verified with `gh api`. The optional desktop load check is still open; steps are under **Manual check (optional)**.

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

Result: not yet run (optional in M1).

**Acceptance criteria**
- All standard commands pass locally and in CI on both Node versions.
- `main.js` builds. The plugin loads in a desktop Obsidian test vault and shows nothing (manual check, optional in M1).
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
CI on GitHub: the `CI` workflow passed on Node 22.x and 24.x (run 38186164011 at e5c0f13 and run 38186746269 at 5f4663d). `CodeQL` failed on those commits with a configuration error because CodeQL default setup was enabled. The owner turned it off on 2026-10-12; the first run after that is the one for this commit (result recorded in the next commit).

**Tests added:** `test/smoke.test.ts` (runner, ports.ts is erasable-only), `test/lint-rules.test.ts` (every project lint rule, plus disable comments rejected under the full config), `test/manifest.test.ts` (submission rules, versions agree, zero runtime deps, no sample names), `test/hook.test.ts` (hook fast paths), `test/network-check.test.ts` (CI backstop).

**Deviations from this milestone's text** (all recorded in commit messages):
- The Node built-in ban and the dynamic-`import()` ban apply to `src/**` only. Tests and build scripts use Node modules, and only `src/` ships. To back this up, esbuild no longer marks Node built-ins external, so a built-in reaching the bundle by any route fails the build.
- The CI grep one-liner matched the `RemoteContent.fetch(...)` method signature in `src/core/ports.ts` (design §2). It is replaced by `scripts/check-network-apis.sh`, which exempts that exact signature only and also catches `activeWindow.fetch`, `EventSource` and `sendBeacon`.
- `eslint.config.mjs` instead of `.mts`, so `jiti` is not installed (allowed by this milestone). Project rules live in `eslint/project-rules.ts` so they can be unit tested.
- ESLint stays on 9.x (`npm` marks 9.39.5 deprecated). ESLint 10 leaves eslint-plugin-obsidianmd 0.4.2's bundled sub-plugins (import, react) on a nested ESLint 9. Move to 10 when the plugin supports it.
- Actions use current majors (checkout v7.0.1, setup-node v7.1.0, codeql-action v4.38.3), pinned by commit SHA resolved with `git ls-remote`. npm caching in setup-node is off, and `npm ci` runs with `--ignore-scripts` in CI and in the SessionStart hook (T-T7).

**Security review** (`security-reviewer` instructions, run through a general-purpose agent because the agent file only registers at the next session start; base `origin/main`, 31 files):
- Fixed, medium: `activeWindow.fetch` bypassed R-NET-1. Added `window`/`globalThis`/`self`/`activeWindow` × `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`require` to `no-restricted-properties`, and widened the CI script.
- Fixed, medium: project rules could be switched off with `// eslint-disable-next-line <rule> -- reason`. `src/**` now restates obsidianmd's `eslint-comments/no-restricted-disable` list (read from the plugin at load time) plus `no-restricted-imports`/`-globals`/`-properties`/`-syntax`, `no-eval`, `no-implied-eval` and `no-new-func`. Tested.
- Fixed, low: `EventSource`, `navigator.sendBeacon` and bare `require` are now banned. Node built-ins are no longer esbuild externals. The README and SECURITY.md now say the plugin stores its settings and state in its own plugin folder under the config folder (O-POL-2 accuracy). Dependabot `cooldown` is 7 days. `npm ci --ignore-scripts` is used.
- Fixed, info: the hook only lints `src/`, `test/` and `eslint/` and passes `--no-warn-ignored`, so an edit to an unlinted `.ts` file can't block.
- Open, info: the README token-storage residual risk is M9 scope. The action SHAs were resolved from the upstream tags in this session.

**Optional for the owner** (not fixed, no security or requirement impact):
- `npm audit` reports 3 **moderate** advisories: `moment` (GHSA-4p3w-j4w9-5jqw), pulled in by the `obsidian` type package that eslint-plugin-obsidianmd pins at 1.12.3. `obsidian` is external to the bundle and `moment` never ships. It clears when the plugin moves to `obsidian` ≥ 1.14. Dependabot will propose it.
- `test/hook.test.ts` covers only the hook's fast paths. The lint-failure path is covered by the Verify block, because it runs a full `tsc`.

---

## M2: Authentication
**Status:** not started. **Owner prerequisite:** complete [entra-setup.md](entra-setup.md) and have the client ID ready.

**Goal.** Sign in, stay signed in across restarts, refresh, and sign out on both devices (design §4).

**Files and interfaces**
- `src/remote/pkce.ts`: verifier, challenge and state generation (WebCrypto only).
- `src/remote/auth.ts`: `AuthClient` with `buildAuthorizeUrl(redirect)`, `handleCallback(params)`, `parsePastedUrl(url)` and `redeemCode()`. It implements `AccessTokenProvider` (single-flight refresh, rotation).
- `src/remote/http.ts`: an `HttpTransport` decorator that adds `Authorization` only for `https://graph.microsoft.com/` (T-I4).
- `src/platform/request-url-transport.ts`: `HttpTransport` over `requestUrl` with `throw: false`. Converts the body to ArrayBuffer and lower-cases header names.
- `src/platform/token-store.ts`: `TokenStore` over SecretStorage, with the `data.json` fallback and the `backend` field (D-5; design §4).
- `src/main.ts`: protocol handler `mdvaultsync-auth` (also accepting a trailing slash); commands `sign-in` and `sign-out`. Sign-out calls a `StateStore` stub here; M6 swaps in the real store.
- `src/ui/settings-tab.ts`: the Account section only (status, Client ID, Sign in, Sign in another way plus paste box, Sign out, and the token-storage line: a warning for `plugin-data`, a neutral note for `secret-storage`).
- Tests: `test/pkce.test.ts`, `test/auth.test.ts`, `test/http.test.ts`, `test/fakes/fake-http.ts`.

**Acceptance criteria**
- **PKCE** matches the RFC 7636 Appendix B vector: verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` gives challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`. The verifier is 43–128 characters from the allowed alphabet.
- **Callback checks:** the callback is rejected when there's no pending sign-in, when the state is wrong, when it's expired (over 10 minutes), or when the state is reused. An `error` parameter is surfaced without echoing `error_description` into logs.
- **Scope** is exactly `Files.ReadWrite.AppFolder offline_access` (unit test) (T-E2).
- **Refresh:** concurrent `getAccessToken()` calls make one refresh request. The rotated refresh token replaces the stored one before the access token is returned. `invalid_grant` clears the token and sets "sign-in required".
- **Authorization header** never goes to a non-Graph host (unit test).
- **Paste fallback** rejects any origin or path other than `https://login.microsoftonline.com/common/oauth2/nativeclient`.
- **Manual checks** (owner, recorded below):
  1. Ubuntu: Sign in → browser → consent → Obsidian comes forward → "Signed in". Record whether the callback had a trailing slash [I-RU-3].
  2. iPad: same flow through Safari's "Open in Obsidian?" prompt.
  3. One device: "Sign in another way" works end to end. If `nativeclient` doesn't work with `/consumers`, record the result in research.md [I-RU-4] and replace the fallback before closing the milestone.
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

**Verification output**
```
(paste here, plus manual check results 1–8)
```

---

## M3: Graph client, retry, validation, capability probe
**Status:** not started

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

**Verification output**
```
(paste here, plus probe JSON from both devices)
```

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
- `.github/workflows/release.yml`:
  - Triggers on a tag push matching `[0-9]+.[0-9]+.[0-9]+*`.
  - Runs `npm ci`, the standard checks, `npm run build`, then `actions/attest` over `main.js`, `manifest.json` and `styles.css` [O-REL-1], [C-GH-3].
  - Creates a **draft** release with those assets.
  - Job permissions: `contents: write`, `id-token: write`, `attestations: write`. Actions pinned by SHA.
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
| R-ENV-1…4 | M1, M2 | ☐ |
| R-AUTH-1…8 | M2 | ☐ |
| R-SCOPE-1…4 | M4, M5, M7 | ☐ |
| R-TRIG-1…4 | M6 (lock), M7 | ☐ |
| R-CD-1 | M3, M5 | ☐ |
| R-CD-2 | M5, M7 | ☐ |
| R-CD-3, R-CD-4 | M4, M5 | ☐ |
| R-ORDER | M6 | ☐ |
| R-CC-1, R-CC-2 | M3, M6 | ☐ |
| R-CONF-1…4 | M4, M5, M6, M7 | ☐ |
| R-DEL-1…3 | M5, M6 | ☐ |
| R-MOVE-1 | M5, M6 | ☐ |
| R-FIRST-1, R-FIRST-2 | M5, M7 | ☐ |
| R-GUARD-1 | M5, M7 | ☐ |
| R-PATH-1…4 | M4, M6 | ☐ |
| R-IO-1, R-IO-2 | M6 | ☐ |
| R-NET-1 | M2, M3 | ☐ |
| R-RES-1 | M3 | ☐ |
| R-RES-2, R-RES-3 | M3, M6 | ☐ |
| R-UI-1…3 | M2, M7 | ☐ |
| R-SEC-1, R-SEC-2 | M2 | ☐ |
| R-SEC-3 | M3, M8 | ☐ |
| R-SEC-4 | M3, M4 | ☐ |
| R-SEC-5 | M1, M9 | ☐ (M1 part done: lockfile, Dependabot, CodeQL, audit, SHA pins, and secret scanning and push protection verified 2026-10-12; release attestation is M9) |
| R-SEC-6 | M1 | ☑ (M1, 2026-10-12) |
| R-ENG-1…5 | M1 onward | ☐ |
