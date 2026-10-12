# Security policy

## Supported versions
Only the latest release of MDVaultSync gets security fixes. Update to the latest release before you report a problem.

## Reporting a vulnerability
**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

1. Open https://github.com/caseke/MDVaultSync/security/advisories/new, or go to the repository's **Security** tab and click **Report a vulnerability**.
2. Describe the problem, the affected version, and the steps to reproduce it. Leave out real tokens, account details and note contents.

What to expect:
- An acknowledgement within **7 days**.
- Updates as the report is investigated, and credit in the advisory if you want it.
- A fix in a new release, followed by a published GitHub Security Advisory.

## Scope
Examples of what's in scope: leaks of the refresh or access token, synced files written outside the vault or into the Obsidian config folder or hidden folders, data sent to hosts other than Microsoft's sign-in and OneDrive services, remote code loading, and sync behavior that loses data.

The accepted residual risks are listed in [docs/threat-model.md](docs/threat-model.md) §4. For example, other Obsidian plugins run in the same JavaScript context and can read the token. Reports about those risks are still welcome if you can show a practical mitigation.
