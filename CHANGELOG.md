# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
