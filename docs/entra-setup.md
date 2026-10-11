# Microsoft Entra setup for MDVaultSync

MDVaultSync signs in to your **personal** Microsoft account through an app registration that you own. This guide creates one. It takes about 15 minutes and costs $0, but Microsoft requires a credit or debit card for identity verification in step 1 (see [cost-estimate.md](cost-estimate.md)).

At the end you'll have an **Application (client) ID**, a GUID you paste into the MDVaultSync settings.

Status: drafted in session 1 from Microsoft documentation. Microsoft redesigns the portal often. M2 checks every step against the live portal and corrects the wording; check the box when that's done.
- [ ] Verified against the live portal (M2)

## Why each step exists
- Since June 2024, every app registration must live in a Microsoft Entra directory (tenant) [I-REG-1].
- A personal Microsoft account (outlook.com, hotmail.com, live.com) doesn't come with one. The documented way to get one is an Azure free account [I-REG-2]. The Microsoft 365 Developer Program no longer accepts personal accounts [I-REG-3].
- The app is registered as a **public client** under the "Mobile and desktop applications" platform. That means no secret, and refresh tokens last about 90 days. The "Single-page application" platform would cap them at 24 hours [I-TL-2], [I-AC-6].

## Step 1: Create the tenant with an Azure free account
1. Open https://azure.microsoft.com/free and choose **Start free** (or **Try Azure for free**).
2. Sign in with the **same personal Microsoft account** whose OneDrive will hold the vault.
3. Complete the sign-up:
   - phone verification (a real mobile number; VoIP numbers are rejected);
   - card verification (credit or debit, not prepaid). You may see a temporary hold of about $1, which is released [C-AZ-1].
4. Accept the agreement. Azure creates a subscription and a directory called **Default Directory**.
5. To stay at $0:
   - Don't create any Azure resources.
   - Leave the spending limit on.
   - Decline every "upgrade to pay-as-you-go" prompt.
   - After 30 days the subscription is disabled. This is expected; the directory and the app registration remain [C-AZ-2], [C-AZ-4].

## Step 2: Register the application
1. Open the Microsoft Entra admin center at https://entra.microsoft.com and sign in with the same account.
2. If the top-right corner shows more than one directory, switch to **Default Directory** (gear icon → *Directories + subscriptions*).
3. Go to **Entra ID → App registrations** (older layouts: *Identity → Applications → App registrations*) and choose **New registration**.
4. Fill in the form:
   - **Name:** `MDVaultSync`. This name becomes the OneDrive folder `Apps/MDVaultSync`. Renaming the app later does *not* rename the folder [G-AF-1].
   - **Supported account types:** **Personal Microsoft accounts only** [I-REG-4].
   - **Redirect URI:** platform **Public client/native (mobile & desktop)**, value `obsidian://mdvaultsync-auth`. Type it exactly, all lowercase, with no trailing slash and no `?` [I-RU-2].
5. Choose **Register**.
6. On the **Overview** page, copy the **Application (client) ID** and keep it for step 5.

## Step 3: Add the fallback redirect URI
1. Open **Authentication** (it may be labelled *Authentication (Preview)*).
2. Under **Mobile and desktop applications**, add a second redirect URI: `https://login.microsoftonline.com/common/oauth2/nativeclient`. The portal often offers it as a checkbox [I-RU-4]. This is the redirect for "Sign in another way", where you paste the final URL.
3. Confirm **Allow public client flows** is **No**. MDVaultSync doesn't use device code sign-in [I-DC-1].
4. Make sure no **Web** or **Single-page application** platform is configured. Either one would break sign-in [I-AC-5], [I-AC-6].
5. Choose **Save**.

## Step 4: Set API permissions
1. Open **API permissions**.
2. Remove **User.Read** if it's listed (⋯ → *Remove permission*). MDVaultSync doesn't need it, and least privilege applies.
3. Choose **Add a permission → Microsoft Graph → Delegated permissions** and select:
   - `Files.ReadWrite.AppFolder` ("Have full access to the application's folder (preview)") [I-REG-5]
   - `offline_access` (under *OpenId permissions*), which allows refresh tokens.
4. Choose **Add permissions**. Don't use "Grant admin consent". It isn't needed for personal accounts: you consent yourself at first sign-in.

Check the manifest (optional). Under **Manifest**, `signInAudience` should be `PersonalMicrosoftAccount` and `api.requestedAccessTokenVersion` should be `2`. The portal sets both when you pick "Personal Microsoft accounts only" [I-REG-4].

## Step 5: Connect MDVaultSync
1. In Obsidian, open **Settings → MDVaultSync**. Paste the client ID into **Client ID**.
2. Choose **Sign in**. Your browser opens Microsoft's sign-in page.
   - The consent screen says the app is **unverified**. That's expected for an app you registered yourself [I-REG-6].
   - The consent screen should show "Have full access to the application's folder". If it asks for anything more, stop and check step 4.
3. After you approve, the browser asks to open Obsidian. Allow it. Settings should show you as signed in.
4. If Obsidian doesn't open, choose **Sign in another way**, sign in again, copy the full address from the blank page you land on, and paste it into the box.

## Removing access
To disconnect every device at once, remove MDVaultSync at https://account.microsoft.com/privacy/app-access [C-MSA-1]. Changing your Microsoft account password also revokes its tokens [I-TL-4]. To delete the registration itself: Entra admin center → App registrations → MDVaultSync → **Delete**. Your OneDrive files in `Apps/MDVaultSync` are not deleted.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| `AADSTS50011` redirect URI mismatch | The redirect URI in step 2 or 3 has a typo, uppercase letters, a trailing slash, or the wrong platform |
| `AADSTS7000218` client secret required | A **Web** platform was added; remove it (step 3) |
| `AADSTS9002326` or `9002327` cross-origin errors | A **Single-page application** platform was added; remove it |
| `AADSTS700016` application not found | Wrong client ID, or the app is in a different directory |
| `unauthorized_client` / account type error | Supported account types isn't "Personal Microsoft accounts only" |
