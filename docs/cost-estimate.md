# MDVaultSync cost estimate

**Target:** $0 per month. **Expected cost:** $0 per month.

**Payment method:** one component requires a card even though it never charges: the Azure free account used to get an Entra tenant (row 1). Nothing else asks for payment details.

Fact IDs refer to [research.md](research.md). "SUMMARY" means the fact came from a search-engine summary because the primary page couldn't be loaded during research. Those are listed under "to re-check" at the end.

| # | Component | Cost | Payment method needed? | Notes | Facts |
|---|---|---|---|---|---|
| 1 | **Azure free account** (the only documented way to get an Entra tenant with a personal Microsoft account) | $0 | **Yes: credit or debit card (not prepaid) plus phone verification.** A temporary hold of about $1 may appear and is released. | The $200 credit lasts 30 days. After that, Azure *disables the subscription* unless you upgrade. **Do not upgrade to pay-as-you-go.** The spending limit is on by default; leave it on. Create no Azure resources. The project needs no subscription after the tenant exists. | [I-REG-1], [I-REG-2], [I-REG-3], [C-AZ-1], [C-AZ-2], [C-AZ-3] |
| 2 | **Microsoft Entra tenant (Default Directory), Entra ID Free** | $0 | No (beyond row 1) | The directory remains after the subscription is disabled [C-AZ-4]. Limits: 50,000 objects, 250 resources per non-admin user [C-EN-1]. This project needs 1 app registration. **Inferred, verify in M2:** the app registration keeps issuing tokens after the free subscription is disabled. The check: sign in again after day 30 and confirm it works. | [C-AZ-4], [C-EN-1] |
| 3 | **App registration** (public client, personal accounts) | $0 | No | No client secret or certificate, so nothing expires. Not publisher-verified: the consent screen says "unverified", which is expected for a personal app [I-REG-6]. Publisher verification would require Microsoft Cloud Partner Program membership and is out of scope. | [I-REG-4], [I-REG-6] |
| 4 | **Microsoft Graph API** | $0 | No | OneDrive file APIs are not metered. The only metered API left is a OneDrive for *Business* sensitivity-label call, and metered APIs need confidential clients anyway [C-GR-1]. Usage is bounded by throttling, not billing [G-THR-4]. | [C-GR-1] |
| 5 | **OneDrive storage** (personal free tier) | $0 within 5 GB | No | The 5 GB is shared with Outlook.com attachments and other Microsoft 365 apps [C-OD-1]. Items in the recycle bin count against quota until the bin empties [G-DEL-2]. If the vault outgrows 5 GB, Microsoft 365 Basic (100 GB) is the owner's choice, not a project requirement. The plugin shows quota-exceeded errors clearly (T-D7). | [C-OD-1], [G-DEL-2] |
| 6 | **GitHub public repo** | $0 | No | Free plan. | — |
| 7 | **GitHub Actions** (CI, CodeQL, release) | $0 | No | Standard hosted runners are free for public repos [C-GH-1]. Larger runners are paid; never select them. | [C-GH-1] |
| 8 | **CodeQL, secret scanning, push protection** | $0 | No | Free for public repos [C-GH-2]. | [C-GH-2] |
| 9 | **Dependabot** (alerts and version updates) | $0 | No | Jobs run on free standard runners [C-GH-4]. | [C-GH-4] |
| 10 | **Artifact attestations** | $0 | No | Free on the Free plan for **public** repos only. If the repo ever becomes private, they need Enterprise Cloud [C-GH-3]. | [C-GH-3] |
| 11 | **npm registry** (installing dev dependencies) | $0 | No | Nothing is published to npm. | — |
| 12 | **Obsidian app** (iPad, Ubuntu) | $0 | No | Free for personal and commercial use since Feb 2025 [C-OBS-1]. Obsidian Sync is *not* used. | [C-OBS-1] |
| 13 | **BRAT plugin** | $0 | No | Open source community plugin. A GitHub token is optional for public repos [O-BRAT-1]. | [O-BRAT-1] |
| 14 | **Obsidian Community directory submission** (later) | $0 | No | Needs a free Obsidian account linked to GitHub [O-SUB-5]. | [O-SUB-5] |
| 15 | **Apple developer account** | Not needed | — | The plugin runs inside the Obsidian app; nothing is signed for iOS. | — |
| 16 | **Domain or hosting** | Not needed | — | No redirect page is hosted (D-4); the only redirect is `obsidian://mdvaultsync-auth`. | [I-RU-4] |

## How to keep row 1 at $0
1. Sign up at https://azure.microsoft.com/free with the personal Microsoft account. Enter the card and phone when asked.
2. Don't create any Azure resources (VMs, storage accounts and so on). App registrations aren't Azure resources and are never billed.
3. Leave the spending limit on. Ignore or decline the "upgrade to pay-as-you-go" prompts.
4. On day 30 the subscription is disabled. This is expected and harmless here, because the Entra directory remains [C-AZ-4].
5. If Azure says the account isn't eligible for a free account, it offers pay-as-you-go instead, which has **no spending limit**. That still costs $0 with no resources created, but a mistake would be billed. See entra-setup.md "If Azure says you're not eligible". An existing subscription's directory works too.
6. Optional: remove the card from the billing profile after the subscription is disabled, if the portal allows it. This is not verified; check it when you get there.

## To re-check (search summaries or inferences)
| Item | Why | When |
|---|---|---|
| Card and phone requirement wording | Only a summary of the Azure FAQ was available [C-AZ-1] | During M2 sign-up; record what the form actually asked for |
| App registration works after the subscription is disabled | Inferred from [C-AZ-4] | Re-test sign-in at least 30 days after sign-up; note it in plan.md under M9 |
| 5 GB free OneDrive quota | Summary only [C-OD-1] | M8: read `quota.total` if the scope allows it [G-QT-1] |
| GitHub Actions and Dependabot free for public repos | Summary only [C-GH-1], [C-GH-4] | M1: confirm the Actions usage page shows $0 |
