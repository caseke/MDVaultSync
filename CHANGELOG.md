# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- M1 scaffold: an empty plugin (`src/main.ts`) that loads in Obsidian, and the module contracts in `src/core/ports.ts` (design §2).
- Quality gate: ESLint with `eslint-plugin-obsidianmd` plus project rules, strict `tsc`, Node's built-in test runner, and an esbuild production build.
- Project lint rules (`eslint/project-rules.ts`): no `obsidian` import in `src/core` or `src/remote`, no `fetch`/XHR/WebSocket or Node networking and file modules in `src`, no `eval` or dynamic `import()`, and RemotePort content methods only from `src/core/remote-content.ts`.
- CI on Node 22 and 24 (lint, typecheck, test, build, `npm audit`, network-API check), CodeQL, and Dependabot. All actions are pinned by commit SHA.
- Claude Code project config: a post-edit lint and typecheck hook, a dependency-install session hook, and a `security-reviewer` subagent.
- `LICENSE` (MIT), `SECURITY.md` (private vulnerability reporting), and a README with the required disclosures.

### Security

- Security review hardening: network APIs are banned through `activeWindow`, `window`, `self` and `globalThis`, plus `EventSource`, `sendBeacon` and `require`. Inline `eslint-disable` comments can't switch off the project rules in `src`. Node built-ins fail the build instead of being left external. `npm ci` runs with `--ignore-scripts`. Dependabot waits 7 days before proposing new releases.
