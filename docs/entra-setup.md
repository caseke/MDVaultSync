# Microsoft Entra setup for MDVaultSync

MDVaultSync signs in to your **personal** Microsoft account through an app registration that you own. This guide creates one. It takes about 15 minutes and costs $0, but Microsoft requires a credit or debit card for identity verification in step 1 (see [cost-estimate.md](cost-estimate.md)).

At the end you'll have an **Application (client) ID**, a GUID you paste into the MDVaultSync settings.

Status: drafted in session 1 from Microsoft documentation. Microsoft redesigns the portal often. M2 checks every step against the live portal and corrects the wording; check the box when that's done.
- [ ] Verified against the live portal (M2)

## Why each step exists
- Since June 2024, every app registration must live in a Microsoft Entra directory (tenant) [I-REG-1].
- A personal Microsoft account (outlook.com, hotmail.com, live.com) doesn't come with one. The documented way to get one is an Azure free account [I-REG-2]. The Microsoft 365 Developer Program no longer accepts personal accounts [I-REG-3].
- The app is registered as a **public client** under the "Mobile and desktop applications" platform. That means no secret, and refresh tokens last about 90 days. The "Single-page application" platform would cap them at 24 hours [I-TL-2], [I-AC-6].

## Before you start
- **Already have an Entra tenant you control** (not your employer's)? Skip step 1 and use it. In step 2, switch to that directory instead of "Default Directory".
- **Install MDVaultSync first** so you can finish step 5. Until release 1.0.0 (plan M9) it is installed through BRAT. BRAT needs a published GitHub release; before 1.0.0 these are 0.x pre-releases (see plan M2, "How to run the manual checks"). If BRAT says "No releases found in this repository", no release has been published yet.
  1. Install **BRAT** from Obsidian's Community plugins.
  2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
  3. Enter `caseke/MDVaultSync`.
  4. Enable MDVaultSync in Community plugins.

## Step 1: Create the tenant with an Azure free account
1. Open https://azure.microsoft.com/free and choose **Start free** (or **Try Azure for free**).
2. Sign in with the **same personal Microsoft account** whose OneDrive will hold the vault.
3. Complete the sign-up:
   - phone verification (a real mobile number; VoIP numbers are rejected);
   - card verification (credit or debit, not prepaid). You may see a temporary hold of about $1, which is released [C-AZ-1].
4. Accept the agreement. Azure creates a subscription and a directory, usually called **Default Directory**. The name may differ, for example `<yourname>outlook.onmicrosoft.com`; any name works. Note what it is called.
   - **If Azure says you're not eligible** for a free account (you had one before, or you already have a subscription), it will offer **pay-as-you-go**. Pay-as-you-go has *no* spending limit. It still costs $0 as long as you create no resources, because app registrations aren't billed. But a mistake later could cost money. If you accept it, create nothing in Azure except what this guide says. If you already have a subscription, its directory works and you don't need a new one.
5. To stay at $0:
   - Don't create any Azure resources.
   - Leave the spending limit on.
   - Decline every "upgrade to pay-as-you-go" prompt.
   - After 30 days the subscription is disabled. This is expected; the directory and the app registration remain [C-AZ-2], [C-AZ-4].

## Step 2: Register the application
1. Open the Microsoft Entra admin center at https://entra.microsoft.com and sign in with the same account.
2. If the top-right corner shows more than one directory, switch to the directory from step 1 (gear icon → *Directories + subscriptions*).
   - You may see a banner saying ADAL and Azure AD Graph "no longer receive new feature updates". It is shown to every tenant and is about legacy libraries and APIs that MDVaultSync doesn't use. MDVaultSync calls the Microsoft identity platform v2.0 endpoints and Microsoft Graph (`graph.microsoft.com`) directly. App registration is still the current method, so continue. ([Azure AD Graph retirement](https://learn.microsoft.com/graph/migrate-azure-ad-graph-overview))
3. Go to **Entra ID → App registrations** (older layouts: *Identity → Applications → App registrations*) and choose **New registration**.
4. Fill in the form:
   - **Name:** `MDVaultSync`. This name becomes the OneDrive folder `Apps/MDVaultSync`. Renaming the app later does *not* rename the folder [G-AF-1].
   - **Supported account types:** **Personal accounts only** (older portal label: "Personal Microsoft accounts only"). Not "Any Entra ID Tenant + Personal Microsoft accounts", which would also admit work and school accounts [I-REG-4].
   - **Redirect URI:** platform **Public client/native (mobile & desktop)**, value `obsidian://mdvaultsync-auth`. Type it exactly, all lowercase, with no trailing slash and no `?` [I-RU-2].
5. Choose **Register**.
6. On the **Overview** page, copy the **Application (client) ID** and keep it for step 5.

## Step 3: Check the authentication settings
1. Open **Authentication** (it may be labelled *Authentication (Preview)*).
2. Under **Mobile and desktop applications**, `obsidian://mdvaultsync-auth` must be the **only** redirect URI. The portal offers suggested URIs as checkboxes; leave them all **unticked**, including `https://login.microsoftonline.com/common/oauth2/nativeclient`. MDVaultSync had a paste fallback that used it; it was removed on 2026-10-12, so if you ticked it earlier, untick it and save [I-RU-4]. `https://login.live.com/oauth20_desktop.srf` (LiveSDK) belongs to Microsoft's older Live SDK, and `msal<client-id>://auth` is the MSAL library's default scheme. MDVaultSync uses neither, and every extra redirect URI is one more place Microsoft will deliver an authorization code.
3. Confirm **Allow public client flows** is **No**. MDVaultSync doesn't use device code sign-in [I-DC-1].
4. Under **Settings**, set **Enable Live SDK support** to **No**. It provides compatibility with Microsoft's legacy Live Connect SDK (`login.live.com`), which MDVaultSync doesn't use. *Unverified:* Microsoft Learn doesn't document this toggle [I-REG-7]. If the first sign-in fails with an account-type or consent error, set it back to Yes and retry before troubleshooting further.
5. Make sure no **Web** or **Single-page application** platform is configured. Either one would break sign-in [I-AC-5], [I-AC-6].
6. Under **App instance property lock**, choose **Configure**. Turn on **Enable property lock**, tick **All properties**, and save. New apps have the lock enabled by default since June 2026, so confirm **All properties** is ticked. MDVaultSync uses no signing or verification credentials and no token encryption key, so locking them costs nothing and blocks anyone from adding credentials to the app later [I-REG-8].
7. Choose **Save**.

## Step 4: Set API permissions
1. Open **API permissions**.
2. Remove **User.Read** if it's listed (⋯ → *Remove permission*). MDVaultSync doesn't need it, and least privilege applies.
3. Choose **Add a permission → Microsoft Graph → Delegated permissions**. Pick **Microsoft Graph**, not the legacy *Azure Active Directory Graph*, which was retired Aug 31 2025. Then select:
   - `Files.ReadWrite.AppFolder` ("Have full access to the application's folder (preview)") [I-REG-5]
   - `offline_access` (under *OpenId permissions*), which allows refresh tokens.
4. Choose **Add permissions**. Don't use "Grant admin consent". It isn't needed for personal accounts: you consent yourself at first sign-in.

Check the manifest (optional). Under **Manifest**, `signInAudience` should be `PersonalMicrosoftAccount` and `api.requestedAccessTokenVersion` should be `2`. The portal sets both when you pick "Personal accounts only" [I-REG-4].

## Step 5: Connect MDVaultSync
1. In Obsidian, open **Settings → MDVaultSync**. Paste the client ID into **Client ID**.
2. Choose **Sign in**.
   - The consent screen says the app is **unverified**. That's expected for an app you registered yourself [I-REG-6].
   - The consent screen should show "Have full access to the application's folder". If it asks for anything more, stop and check step 4.
   - A small window opens in Obsidian. Tap or click **Open Microsoft sign-in**.
3. After you approve, the browser asks to open Obsidian. Allow it. Settings should show you as signed in.
4. If the browser never offers to open Obsidian, the device has no handler for `obsidian://` links. MDVaultSync has no other sign-in method. On Ubuntu, check `xdg-mime query default x-scheme-handler/obsidian`; the Flatpak and .deb installs register one.

## Final check
On the app registration, confirm each of these:
| Where | Expected |
|---|---|
| Overview → Supported account types | Personal Microsoft accounts only (the Overview page may word it differently; the manifest `signInAudience` = `PersonalMicrosoftAccount` is the authoritative check) |
| Authentication → platforms | Only **Mobile and desktop applications**; no Web, no Single-page application |
| Mobile and desktop redirect URIs | Only `obsidian://mdvaultsync-auth` |
| Authentication → Allow public client flows | No |
| Authentication → Enable Live SDK support | No |
| Authentication → App instance property lock | Enabled, All properties |
| API permissions | Microsoft Graph, Delegated: `Files.ReadWrite.AppFolder`, `offline_access`, and nothing else |
| Manifest | `"signInAudience": "PersonalMicrosoftAccount"`, `"requestedAccessTokenVersion": 2` |
| Certificates & secrets | Empty: no client secrets, no certificates |
| Copied | The Application (client) ID |

## Removing access
To disconnect every device at once, remove MDVaultSync at https://account.microsoft.com/privacy/app-access [C-MSA-1]. Changing your Microsoft account password also revokes its tokens [I-TL-4]. To delete the registration itself: Entra admin center → App registrations → MDVaultSync → **Delete**. Your OneDrive files in `Apps/MDVaultSync` are not deleted.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| `AADSTS50011` redirect URI mismatch | The redirect URI in step 2 or 3 has a typo, uppercase letters, a trailing slash, or the wrong platform |
| `AADSTS7000218` client secret required | A **Web** platform was added; remove it (step 3) |
| `AADSTS9002326` or `9002327` cross-origin errors | A **Single-page application** platform was added; remove it |
| `AADSTS700016` application not found | Wrong client ID, or the app is in a different directory |
| `unauthorized_client` / account type error | Supported account types isn't "Personal accounts only" |
