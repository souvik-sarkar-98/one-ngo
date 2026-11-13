# OneNGO manual test plan

Manual checks for the organisation app, Administration, Builder, and the operator console. Behaviour follows [the user guide](../user-guide/index.html). The Donations module is the worked example of records, workflow, money, and receipts. Another organisation may publish different record types; run the Records cases against whatever that organisation has published, and run the Donations cases only when that module is on.

Date: 2026-10-31.

Last run: 2026-11-03, with a second session on 2026-11-04 for cases left Not run (waiting periods were simulated by moving expiry times back in the database), local environment, organisation `riverbank`, with the data in `functional-test-data.md`. The Status column holds that run's result; section 19 has the environment.

## 1. Purpose

Confirm that a person can sign in to the right organisation and do only the work their role allows, that an administrator can finish setup and publish configuration, and that an operator can open an organisation and later suspend, reactivate, or close it without losing its records.

## 2. Scope

| In this plan | Held for a separate pass |
| --- | --- |
| Operator sign-in, find, onboard, retry, suspend, reactivate, close | Operator grant changes. Those are the audited `grant` command on the deploy machine, not a screen. Use them only to prepare accounts. |
| Member sign-in: password, email code, invitation, reset, identity provider, two-step | Live payment-gateway charges. The setup checklist has an optional payments row; do not take a real payment unless a sandbox is configured for this run. |
| Home, Records, Inbox, and the other destinations. There is no `/people` route. More only folds links that do not fit | Load, stress, and endurance |
| Administration: people, roles, connectors, API keys, jobs, audit, settings | Automated unit and integration tests already in this repository |
| Builder drafts and publish | Browser matrix beyond the two viewports below |
| Donations: donor, donation, paid, receipt, Finance and Viewer | |

## 3. Environments and devices

Prepare one environment and name it on the results sheet (local, shared test, or a release candidate).

| Need | What “ready” means |
| --- | --- |
| Organisation app | Sign-in page loads. Health of the API is not a user test; if the app will not load, stop and file a blocker. |
| Operator console | Separate address from the organisation app. Identity provider requires a fresh multi-factor check. |
| Mail | A mailbox you can read, for invitations, email codes, and reset links. If mail is not connected, mark every case that needs a message as Blocked, and do not treat that as a pass. |
| Two organisations | One for the main run. A second, only if you will check “Use another organisation”. |
| Viewports | A phone-width window (bottom bar, cards, Builder catalogue only) and a desktop-width window (side navigation, table layout, breadcrumbs, definition editing). |
| Files | A small PNG, JPEG, or WebP under 1 MB; one image over 1 MB; a CSV under the import limits; a file type a file field rejects. |

Record the organisation-app address, the operator-console address, the build or version from **More → About this app**, the browser, and the date.

## 4. Accounts and data

Create these during the run, in the order in section 6. Do not reuse a password from a previous environment.

| Who | How they exist | Password or sign-in |
| --- | --- | --- |
| Operator, full | Existing operator account that may onboard, retry, suspend, reactivate, and close | Identity provider with multi-factor |
| Operator, lookup | Existing operator account that may find an organisation and may not change its lifecycle | Identity provider with multi-factor |
| Asha Menon | First administrator, created by onboarding | Sets a password from the invitation. Use a short sentence of at least 10 characters that is not her name, her email, or the organisation name. Example shape: `quiet lake path nineteen`. |
| Finance member | Invited by Asha into the Finance role from the Donations module | Own invitation and password |
| Viewer | Invited into the Viewer role | Own invitation and password |
| Directory-only member | A role with `people:read` and nothing else. Used to confirm there is no `/people` route and no people list outside Administration | Own invitation and password |
| No-access member | A role with no record, people, admin, or builder permission | Own invitation and password |

Organisation request used by the onboard cases (change the request id if this code already exists):

```json
{
  "requestId": "riverbank-2026-10-31",
  "organisation": {
    "code": "riverbank",
    "displayName": "Riverbank Trust",
    "legalName": "Riverbank Charitable Trust",
    "contact": { "email": "office@riverbank.example", "phone": "+91 80 4000 1200" },
    "address": {
      "line1": "12 Lake Road",
      "city": "Bengaluru",
      "state": "Karnataka",
      "postalCode": "560001",
      "country": "IN"
    },
    "timezone": "Asia/Kolkata",
    "defaultLanguage": "en",
    "region": "asia-south1"
  },
  "administrator": { "name": "Asha Menon", "email": "asha@riverbank.example" },
  "modules": ["donations"],
  "financialYear": { "startMonth": 4, "current": "2026-27" },
  "receiptPrefix": "RCPT"
}
```

Reserved codes, for the negative onboard case: `admin`, `api`, `app`, `internal`, `onengo`, `operator`, `sign-in`, `support`, `www`.

## 5. How to record a result

| Result | Use it when |
| --- | --- |
| Pass | Every expected result in the case happened. |
| Fail | Any expected result did not happen. File a defect and quote the case id. |
| Partial | Some steps ran and their expected results happened; the remaining steps were not run. The note names what is left. |
| Blocked | A precondition is missing (mail, a second operator, an enrolled authenticator, the Donations module). |
| Not run | Left for a later pass. |

Defect severity, for the tester’s first judgement:

| Severity | Examples |
| --- | --- |
| Blocker | Cannot sign in to a live organisation; a person sees another organisation’s data; a receipt number is wrong or repeated; money is posted to the wrong state; close or suspend deletes records; a revoked API key still works. |
| Critical | A P0 case fails and there is no safe workaround. |
| Major | A P1 case fails and a workaround exists. |
| Minor | Wording, layout, or a P2 case, with the task still possible. |

## 6. Order of execution

Run in this order. Lifecycle cases sign everyone out and then close the organisation, so they are last.

1. Operator sign-in and onboard (section 8).
2. Invitation and sign-in (section 9).
3. Shell, home, language (section 10).
4. Administration setup, people, and settings (section 11).
5. Records, inbox, and Donations (sections 12, 13, and 15). Role permission changes are made in Administration → Roles (section 11) and sit before the permission checks that depend on them.
6. Connectors, API keys, jobs, and audit, using the jobs created by import and bulk edit (section 11).
7. Suspend, reactivate, and close (section 16).

## 7. Release smoke

Run these before any wider pass. A fail on a P0 smoke case stops the release candidate.

`MT-OP-01`, `MT-OP-05`, `MT-OP-07`, `MT-OP-08`, `MT-AUTH-01`, `MT-AUTH-07`, `MT-AUTH-09`, `MT-NAV-02`, `MT-NAV-06`, `MT-ADM-03`, `MT-PPL-07`, `MT-REC-06`, `MT-REC-16`, `MT-IN-02`, `MT-KEY-01`, `MT-BLD-02`, `MT-DON-02`, `MT-DON-08`, `MT-DON-12`, `MT-LIFE-01`, `MT-LIFE-02`, `MT-LIFE-09`.

## 8. Operator console

Sign-in is separate from member sign-in. The console shows an action only when that operator account includes it.

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-OP-01 | P0 | Open the operator address. Choose **Continue to identity provider**. Complete that provider’s sign-in, including a fresh multi-factor check. | Find is shown. The organisation app session, if any, is unchanged. | Blocked: the operator console was not running and the test data has no operator accounts. |
| MT-OP-02 | P0 | Sign in with an account whose token does not show multi-factor. | Sign-in is refused. Find, Onboard, and status stay closed. | Blocked: no operator console or accounts. |
| MT-OP-03 | P0 | Sign in as the lookup operator. Find an active organisation. | Status is shown. Suspend, reactivate, close, and retry are absent. | Blocked: no operator console or accounts. |
| MT-OP-04 | P1 | On Find, search for a code that does not exist, then for a request id that does not exist. | The page says there is no such organisation or onboarding request. | Blocked: no operator console or accounts. |
| MT-OP-05 | P0 | Open Onboard. Paste the Riverbank request with a new request id. Choose **Validate**. | Validation succeeds. **Provision** becomes available. No organisation exists yet: Find by that code still says there is no such organisation. | Blocked: no operator console or accounts. |
| MT-OP-06 | P1 | Validate separate drafts that break one rule each: request id of 2 characters; code `ab`; code `RiverBank`; code `-river`; code `www`; country `India`; language `fr`; time zone `Kolkata`; financial year `2026` with start month 4; financial year start month 0; receipt prefix `rcpt`; a 13-character receipt prefix; 21 registrations; a module key this installation does not publish. | Each draft names the broken field. Provision stays unavailable. | Blocked: no operator console or accounts. |
| MT-OP-07 | P0 | After MT-OP-05 succeeds, choose **Provision**. | The result shows the organisation code and the request id. The first administrator is invited. | Blocked: no operator console or accounts. |
| MT-OP-08 | P0 | Find by the new code, then again by the request id. | Status shows the organisation active, the request, and recent history. The invitation is sent. | Blocked: no operator console or accounts. |
| MT-OP-09 | P0 | Submit the same request id and the same body again. | The existing organisation is returned. A second organisation is not created. | Blocked: no operator console or accounts. |
| MT-OP-10 | P0 | Submit the same request id with a different legal name. | The request is refused. The stored organisation is unchanged. | Blocked: no operator console or accounts. |
| MT-OP-11 | P1 | Start a new request id whose code is `sign-in`. Validate. | The code is refused as reserved. | Blocked: no operator console or accounts. |
| MT-OP-12 | P1 | Validate a request whose module list names a module and omits a module it depends on. Skip if this installation’s published modules have no dependency. | Validation names the missing dependency. | Blocked: no operator console or accounts. |
| MT-OP-13 | P1 | Validate a request with a receipt prefix and an empty module list, then a request with `donations` and prefix `RCPT`. | The prefix is refused when nothing issues receipts. It is accepted with Donations. | Blocked: no operator console or accounts. |
| MT-OP-14 | P1 | Find a request that stopped before it became active, by request id. As an operator who may retry, choose **Retry failed work**. Read status again. | Work continues from the last finished step. A second organisation is not created. The step order is request, organisation, profile, administrator role, modules, receipt prefix, financial year, administrator, readiness, then active. | Blocked: no operator console or accounts. |
| MT-OP-15 | P1 | Validate a request, edit one field, and try to provision without validating again. | Provision is unavailable until Validate succeeds on the edited text. | Blocked: no operator console or accounts. |
| MT-OP-16 | P1 | Sign out of the operator console. Use the browser Back button. | The session has ended. Protected pages return to sign-in. | Blocked: no operator console or accounts. |

## 9. Invitation and sign-in

The organisation page is `/o/{code}/sign-in`. The general page asks for a code and remembers the last organisation until **Use another organisation**.

Identity provider precondition, for MT-AUTH-19 and MT-AUTH-20. The organisation’s own Administration → Organisation settings → **Sign-in methods** is read-only by design: “Password sign-in, email codes and single sign-on are set by the platform operator. Ask them to change these.” The opt-in lives in the operator console. An operator holding the `sign_in` grant opens the organisation’s Sign-in page there (`/organisations/sign-in?code=riverbank`), chooses **Verify to make a change** for a fresh multi-factor step-up, types a reason for the audit, ticks **Offered on the sign-in page** under the shared provider (Google), and chooses **Save opt-in**. A step-up allows one change within five minutes, so verify again before each further change. Google then appears on `/o/riverbank/sign-in`, and Sign-in methods lists it.

Locally the shared provider is the integration fixture’s OIDC. The fixture serves HTTPS with a certificate signed by its own local CA (`ca.crt`), which the server trusts through `NODE_EXTRA_CA_CERTS` but a browser does not. For a browser run, install that CA in the browser or operating-system trust store first; otherwise the redirect to the provider stops on a certificate warning.

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-AUTH-01 | P0 | Open Asha’s invitation. Set a password of at least 10 characters that is not a common password, not a sequence, and not built from her name, email, or “Riverbank”. Save. Sign in on the Password tab with that email and password. | The invitation is accepted. Sign-in opens Home. | Pass, run with a new member (QA Invitee) because Asha was already active. The invitation link points to `localhost:8080`, not the web app. |
| MT-AUTH-02 | P0 | Open the same invitation link again. | The link is refused as already used. | Pass |
| MT-AUTH-03 | P1 | Open an invitation older than 7 days, or one an administrator has replaced. | The link is refused as expired or already used. The page tells the person to ask for a new invitation. | Pass, with DEF-33: the invitation was aged to 8 days in the database; it is refused with “Ask for a new one”, but only after the person fills in and submits a password. The replaced-invitation variant passed under MT-PPL-04. |
| MT-AUTH-04 | P1 | On a reset or invitation, enter a password of 9 characters. | The page says to use at least 10 characters. The password is not saved. | Fail DEF-01: the password is not saved, but no error is shown; a message from the previous attempt stays on screen. Only the standing hint mentions 10 characters. |
| MT-AUTH-05 | P1 | Enter `password1234`, then `abcdefghij`, then `1111111111`. | Each is refused as too easy to guess, with the suggestion to use a short sentence. | Pass |
| MT-AUTH-06 | P1 | For Asha at Riverbank, try a password that is mostly `asha` or `riverbank` plus fewer than 6 other characters. | The page says not to build the password around the name, email, or organisation. | Pass (`riverbank12` and `qainvitee123`) |
| MT-AUTH-07 | P0 | On the organisation page, Password tab, sign in with the right email and password. | Home opens. The bar shows only the places this role allows. | Pass |
| MT-AUTH-08 | P0 | Sign in with the right email and a wrong password. | Sign-in fails. Home does not open. The message does not show whether a later correct password would work for a different reason. | Pass |
| MT-AUTH-09 | P0 | On the general sign-in page, enter a wrong organisation code. Then sign in to an organisation an operator has suspended. | The organisation is not available for sign-in. | Partial: a wrong code says the organisation is not available. The suspended case is blocked by the missing operator console. |
| MT-AUTH-10 | P1 | After a logo and legal name are saved, open `/o/riverbank/sign-in` signed out. | The organisation name and logo are shown. | Pass |
| MT-AUTH-11 | P1 | Sign in through the general page, sign out, and open the general page again. | The last organisation code is filled in. | Partial: after a sign-in, `/sign-in` went straight to Riverbank. Not checked after a sign-out. |
| MT-AUTH-12 | P1 | Choose **Use another organisation**. Enter the other organisation’s code and a member of that organisation. | Sign-in goes to the second organisation. Riverbank data is not shown. | Pass (Shared Member into Harbour Relief; a Riverbank record address says Record not found) |
| MT-AUTH-13 | P1 | Email code tab. Enter a member email. Choose **Email me a code**. Enter the code within 10 minutes. Sign in. | The code arrives. Sign-in opens Home. | Pass |
| MT-AUTH-14 | P0 | Request a code for an address that is not a member, and for an address that is. | Both requests say a code is on its way. The page does not say which address is registered. Only the member receives a usable code. | Pass |
| MT-AUTH-15 | P1 | Request a code, wait more than 10 minutes, and submit it. | The code is refused. | Pass. The code was expired in the database instead of waiting. |
| MT-AUTH-16 | P0 | Password tab, **Forgot password?** Enter the member email. Open the link. Set a new valid password and confirm it. Sign in with the new password. | The link works. The new password signs in. The previous password does not. | Pass |
| MT-AUTH-17 | P0 | Open the same reset link again. Separately, open a reset link older than 30 minutes. | Both are refused. | Pass. The reused link is refused; a link aged past 30 minutes in the database is refused. |
| MT-AUTH-18 | P0 | Stay signed in on a second device. Complete a password reset on the first. | Every device is signed out, including the one that was left open. | Pass |
| MT-AUTH-19 | P1 | With the opt-in above in place, open `/o/riverbank/sign-in` and choose **Sign in with Google** as an existing member. If the role requires two-step and an authenticator is already enrolled, enter the 6-digit code. | The provider button is offered outside the Password and Email code tabs. Sign-in completes and Home opens. The extra step, when required, is offered. | Blocked: the operator console was not running and the test data has no operator accounts, so no opt-in could be made. |
| MT-AUTH-20 | P1 | With the same opt-in in place, complete the identity provider as a person who is not a member of the organisation. | Sign-in does not create a member and does not open Home. The page returns to sign-in with a message. | Blocked: no operator console or accounts, so no opt-in could be made. |
| MT-AUTH-21 | P0 | Give a role that requires two-step to a person with no authenticator. Sign in as that person. | Sign-in stops and tells them to ask an administrator. There is no setup or QR screen. | Pass (`twostep@riverbank.example`) |
| MT-AUTH-22 | P1 | Sign in as a person whose two-step is already on. Enter the current 6-digit code. Then try a wrong code. | The current code opens Home. The wrong code does not. More shows two-step as On. | Blocked: no member has an enrolled authenticator. |
| MT-AUTH-23 | P2 | After the password or provider step, wait more than 5 minutes before the authenticator code. | The extra step has expired. Sign-in must be started again. | Blocked: no member has an enrolled authenticator. |
| MT-AUTH-24 | P0 | Sign in on two devices. Sign out on one. | That device returns to sign-in. The other device stays signed in. | Pass |
| MT-AUTH-25 | P1 | While signed out, open `/records`, `/admin`, `/builder`, and `/print/receipt/{id}`. | Each request goes to sign-in. After sign-in, the person returns to the page they asked for when they are allowed to see it. | Pass |

## 10. Shell, home, language, and offline

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-NAV-01 | P0 | Sign in as Asha. Visit Home, Records, Inbox, Settings, Administration, and Builder. Open `/people`. | Each of those opens. People is not a destination. `/people` is not a route and goes to Home. Inbox shows a number only when approvals are waiting. | Fail DEF-02: People is not a destination. `/people` opens Administration → People instead of Home. Home, Records, Inbox, and Settings open. |
| MT-NAV-02 | P0 | Sign in as the directory-only member. Look through the bar, More, Home, and Settings, then open `/people`. | People is not shown in any of those places. `/people` is not a route. It goes to Home and does not open Administration or a people list. | Pass. People is absent, and `/people` opens Home. |
| MT-NAV-03 | P0 | Sign in as Finance, who cannot administer or configure. | Administration and Builder are absent. `/admin` and `/builder` say they do not have access. | Fail DEF-03: both are absent from the bar, but `/admin` and `/builder` silently open Home. |
| MT-NAV-04 | P1 | Repeat MT-NAV-01 at phone width and at desktop width. | Phone uses the bottom bar and cards. Desktop uses the side bar. Record lists can switch between Cards and Table on desktop only. | Pass |
| MT-NAV-05 | P1 | From a record list and from a settings page, use Back. On desktop, read the breadcrumb. | Back returns to the place they came from. The breadcrumb shows the trail on the larger screen. | Partial: the desktop breadcrumb shows the trail. Back was not checked. |
| MT-NAV-06 | P0 | Sign in as the no-access member and open Home. Then sign in as Finance and open Home. | The no-access home says they have no access to records yet and should get a role from an administrator. Finance is greeted by name and sees the pages and figures that role allows. | Pass |
| MT-NAV-07 | P1 | Open a record list. Choose **Pin to my Home**. On Home, rename the pin, move it up or down, and unpin it. | The pin appears only on that person’s Home. Rename, order, and unpin apply only there. | Partial: the Donors pin appears on Asha’s Home. Rename, order, and unpin were not checked. |
| MT-NAV-08 | P1 | Choose **Pin to everyone’s Home**. Sign in as another member before anyone publishes the page. | The other member does not see the pin. After the page is published in Builder, members who may see that page do. | Pass |
| MT-NAV-09 | P1 | More → Settings → Language. Choose Hindi, then Tamil, Telugu, Bengali, and Marathi, then English. | The choice sticks for this person across a new sign-in. It does not change another member’s language. | Partial: Hindi applies, survives a reload, and English restores. The other languages, a new sign-in, and another member were not checked. |
| MT-NAV-10 | P2 | In a language where some screen text is unpublished, walk Home, Records, and More. | Unpublished strings appear in English. Published strings appear in the chosen language. | Pass. Mixed labels such as “नया donor” result. |
| MT-NAV-11 | P1 | Set the organisation default language to Hindi. Invite a new person and open their first session before they choose a language. | Their first session and messages use Hindi until they choose their own language. | Fail DEF-11: the first session is in Hindi, but the invitation email and the set-password page are in English. |
| MT-NAV-12 | P1 | Open a record, turn the network off, and try to save an edit. Turn the network on and save. | What is already on screen stays. Save waits until the connection returns, then succeeds. | Fail DEF-12: offline, the edit stays and a clear message shows. After reconnecting the save is not retried; a second Save was needed. |
| MT-NAV-13 | P2 | When a new version is available, read the prompt and reload. | The app asks for a reload. After reload, the new version from About this app is shown. | Not run |
| MT-NAV-14 | P2 | On a phone, use the browser’s install prompt if it is offered. Open the installed app. | The installed app reaches the same sign-in and the same organisation. The shortcut icon is a known bug: Windows Chrome shows a letter instead of the organisation logo. | Not run |

## 11. Administration and account

Asha’s role sees every administration area. A person who can manage people or roles can open Roles. Each other area needs its own permission.

### Setup and organisation settings

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-ADM-01 | P0 | Open More → Administration as Asha, then as a person whose only admin permission is people. | Asha sees People, Roles, Connectors, API keys, Background jobs, Audit log, and Organisation settings, plus the Builder links. The people-only administrator sees People and Roles, and does not see the other areas. | Pass |
| MT-ADM-02 | P0 | Open Organisation settings before any checklist row is confirmed. | Each row is Done, Still to do, or Optional. Required rows that are open are Still to do. The page does not say setup is complete. | Pass |
| MT-ADM-03 | P0 | Enter legal name, contact email, and registered address. Save identity. Choose **Confirm the identity**. | The identity row becomes Done. The legal name is the one later printed on receipts. | Pass, with DEF-19: a receipt issued before this step (`RCPT/2026-27/00006`) prints without the legal name; the app allowed it. |
| MT-ADM-04 | P1 | Add a registration with type `80g` and a number. Add the same type and number again. Add one whose expiry is before the issue date. Add `12a` and `fcra` with valid dates. | The duplicate and the inverted dates are refused. The valid registrations are saved. | Fail DEF-04: the issue and expiry date fields do not render (Administration routes have no date provider), so the dates cannot be entered. The duplicate is refused and 80G, 12A, and FCRA save. |
| MT-ADM-05 | P0 | Confirm the current financial year is open. Then try to change the start month. | The year row can be confirmed. After a year is open, or after a receipt exists, the start month stays fixed. | Pass |
| MT-ADM-06 | P1 | Review receipt numbering and choose **I have reviewed the receipt series**. | That checklist row becomes Done. | Pass |
| MT-ADM-07 | P0 | Invite a second person into Finance. Return to the checklist. | The operational-role row becomes Done. When every required row is Done, the page says setup is complete. | Pass. The row was already Done from the test data; the page then said setup is complete. |
| MT-ADM-08 | P2 | Read the email and payments rows with no connector, then after an email connector is on. | Both stay Optional. The email row says whether mail goes through the organisation’s connector, through OneNGO’s email service, or not at all. | Partial: with no connector both are Optional and email says “Sent through OneNGO’s email service”. Not checked with a connector. |
| MT-SET-01 | P1 | Read the organisation code and the sign-in link. Try to edit the code. | The code and the link are shown so they can be sent to members. The code cannot be edited on this page. | Pass |
| MT-SET-02 | P1 | Set country to `IN`, a website to `https://riverbank.example`, and a website without `https://`. Save display name, phone, and time zone. | `IN` and the `https://` website save. A website without `https://` is refused. Display name is what people see in the app. | Pass, with DEF-25: the time zone list offers only `Asia/Calcutta`, not `Asia/Kolkata`, and cannot be filtered by typing; the country error repeats the hint. |
| MT-SET-03 | P1 | Upload a PNG under 1 MB, then a WebP, then a JPEG, then a file over 1 MB, then a GIF. | PNG, JPEG, and WebP at or under 1 MB appear in the app, on the sign-in page, and on receipts issued after the upload. Larger files and other types are refused. | Pass (PNG, WebP, JPEG save; over 1 MB and GIF refused; the logo shows in the app bar, on sign-in, and on a receipt issued afterwards) |
| MT-SET-04 | P1 | Set default language, read storage use, and set API requests per minute to a small whole number. | Default language applies to new people and to messages. Storage shows quota used, in whole gigabytes. The API limit is stored for the key cases below. | Partial: storage shows “0 MB of 1 GB used”. Default language and the API limit were not changed. |

### People, roles, and your own account

The people list is Administration → People. There is no `/people` route. It is not a destination in the bar, More, Home, or Settings.

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-PPL-01 | P0 | As Asha, look through the bar, More, Home, and Settings. Then open Administration → People and search for Asha. Repeat the look-around as the directory-only member, and open `/people`. | The list is only at Administration → People, with names, roles, and contact details. It is absent everywhere else. `/people` is not a route and goes to Home. The directory-only member is not shown a people list. | Partial: the directory-only member has no people list, and `/people` opens Home. Asha’s search on Administration → People was not repeated in this note. |
| MT-PPL-02 | P0 | On Administration → People, read one person's row. Confirm there is no second people list and no `/people` route. | Status, invitation, and two-step are on this Administration screen, because it is the only people screen. `/people` goes to Home. | Partial: there is no second people list. Status, invitation, and two-step on Administration → People were not read in this run. |
| MT-PPL-03 | P0 | Administration → People → **Add a person**. Name, email, at least one role, invitation selected. **Add and invite**. | The person appears as invited. The mail contains one link. | Pass, with DEF-24: the app also accepts a person with no role. |
| MT-PPL-04 | P1 | Resend the invitation before it is used. Open the first link, then the second. | The first link no longer works. The new link works and is valid for 7 days. | Pass, with DEF-23: Resend shows no message on screen. |
| MT-PPL-05 | P1 | Suspend a person. Try to send them an invitation. Reactivate, then send it. | The invitation is refused while they are suspended. After reactivation it can be sent. | Blocked by DEF-09: a suspension cannot be confirmed. |
| MT-PPL-06 | P0 | Change one person’s roles. Select several people and add a role, then remove a role. | Each person’s next request uses the new roles. A removed role disappears immediately. | Partial: adding and removing one person’s role applies on their next page. Several people at once was not checked. |
| MT-PPL-07 | P0 | With the person signed in on two devices, suspend them. | Both devices are signed out. Sign-in is refused until reactivation. Their name remains on records, approvals, and the audit log. Their profile stays, read-only. | Fail DEF-09: the Suspend confirmation cannot be clicked, from the person panel or the row menu. |
| MT-PPL-08 | P1 | Reactivate that person. | They can sign in again. The sessions that suspension ended stay ended. | Blocked by DEF-09: nobody could be suspended. |
| MT-PPL-09 | P1 | Put a person with no authenticator into a role that requires two-step. | The Two-step column shows Required · not set. Their sign-in stops as in MT-AUTH-21. | Pass |
| MT-ROL-01 | P0 | Administration → Roles. Open Finance. Add an active person and an invited person. Remove one. | Membership changes immediately. The page shows what the role allows and who has it. | Partial: run on Viewer. Adding and removing an active person applies immediately. An invited person was not added. |
| MT-ROL-02 | P0 | On that role page, open the **Permissions** tab. Read the line above the grid. Turn one permission off and choose **Save**. | Permissions are edited here. The tab says “What this role allows. Saving updates it straight away.” There is no draft and no publish: Save stores the change at once, the page reports “Role saved.”, and a holder of the role is affected on their next action. | Pass. The Permissions tab is editable and saves at once; the earlier Fail recorded an expectation the product does not have. |
| MT-ACC-01 | P1 | More → the person’s card → My profile. Edit a profile field the organisation allows. | The field saves. Name and email stay as the administrator set them. | Not run: the product has no profile fields a member can edit. |
| MT-ACC-02 | P1 | As the member, try to change the name and email on My profile. | Those fields are not editable. An administrator changes them. | Pass, with DEF-27: the profile shows the role key `admin`, not “Administrator”. |
| MT-ACC-03 | P2 | Open My profile for a person who has no editable profile fields. | The profile says there is nothing there they can change. | Pass. The profile says name and email are changed by an administrator; nothing is editable. |
| MT-ACC-04 | P1 | Read two-step under More for a person with it off, and for a person with it on. | The row shows Off or On. It does not offer a setup code. | Partial: Off is shown with no setup code. No member has two-step on. |
| MT-ACC-05 | P2 | Open About this app. | A version is shown. | Pass (0.1.0) |

### Connectors, API keys, jobs, and audit

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-CON-01 | P1 | With no email connector on the organisation, trigger a message the product would send (for example a donation reminder, once Donations is in use). Read the **Outgoing email** row on the setup checklist. Repeat on an installation that has no mail of its own. | Email falls back from the organisation’s own HTTP email sender, to its SMTP connector, to the installation’s mail. Where the installation has mail configured, the message is sent through OneNGO’s email service and the checklist row reads “Sent through OneNGO’s email service”. Where neither exists, nothing is sent, the notification is skipped with “Email is not configured for this organisation.”, and the checklist row reads “No email is sent until an email connector is set up”. | Partial: with no connector the reminder went through OneNGO’s email service and the checklist said so. An installation without mail of its own was not checked. |
| MT-CON-02 | P1 | New connector. Create one SMS or webhook with a secret, switch it on, save, and send a test where the form offers one. Re-open it. | The secret is shown as Set and cannot be read back. Replacing it needs a new value. The test delivery is listed as retrying, delivered, or failed. | Pass, with DEF-29: webhook to the local fixture; secret shown as Set with Replace; test delivered. The missing-secret message reads “Not setis needed”. |
| MT-CON-03 | P1 | On a failed delivery, choose **Retry now**. | That delivery is attempted again and the list updates. | Blocked: the failed delivery is listed with its reason. Retry now made no new try; deliveries appear to wait for the scheduler tick, which cannot run locally (TICK_SECRET is empty). |
| MT-KEY-01 | P0 | New API key named `ledger-reader`, acting as Viewer. Copy the secret at creation. Call `POST /api/records/donor/query` with `Authorization: ApiKey <id>.<secret>`. Reload the key page. Revoke the key and repeat the call. | The secret is shown once, with the header. The call returns only what Viewer may read. After reload the secret is gone. After revoke the same header is refused, and a new key is required to continue. | Partial: the secret is shown once with the header and is gone after reload. The API call and revoke were not run; the key is still active. |
| MT-KEY-02 | P1 | Set API requests per minute to 2. Send a third request inside the same minute with a key whose role may read donors. | The third request is refused. A later minute succeeds again. | Pass (limit set to 2; with a Viewer key the third donor query in a minute got 429, and the next minute succeeded; limit restored to 120) |
| MT-JOB-01 | P1 | After an import and a bulk change, open Background jobs as an administrator who is not the person who started them. | Both jobs are listed for the whole organisation, as Waiting, Running, Done, Failed, or Cancelled. | Partial: imports and system jobs are listed for the organisation with their states. No second administrator holds the jobs permission. |
| MT-JOB-02 | P1 | Start an import large enough to still be running. Cancel it. Open a failed job. | Cancel stops the job before the end. The failed job shows the failed rows. | Blocked: Cancel job is recorded, but jobs advance only on the scheduler tick, which cannot run locally (TICK_SECRET is empty). The 15,000-row import stays Running at 400. |
| MT-AUD-01 | P0 | After a role change, a setting save, and a paid donation, open the audit log. Filter by that person, by the record type, by the date, and by the area. | Each event shows who, which area, and when. Areas include records, people, roles, setup, connectors, API keys, money, files, and the organisation. There is no control that undoes the event. | Fail DEF-04, DEF-26: the date filter does not render (no date provider). Events show who, area, and when, but each entry repeats the person’s name and some say “tenant”. The Area filter works; there is no undo. |

## 12. Records

Run these against Donations once that module is on, and against any other published type that has the feature named in the case. Skip a case the published type does not offer (no file field, no workflow, no receipt) and mark it Not run, with the type name in the notes.

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-REC-01 | P0 | Open Records. | Types the role may read are listed. Donors and donations sit under Fundraising when Donations is on. Types in no group sit under Other. | Pass |
| MT-REC-02 | P1 | Search the type names. | The list narrows to matching types. | Pass, after adding ten QA record types so there are thirteen. The search box appears and narrows the list; no match says so. |
| MT-REC-03 | P1 | Open a type. Search. Open Filters and set status, a date, and an amount where the list offers them. Remove one chip. | The list matches the search and the filters. Removing one chip leaves the others. | Pass (Donations: search, payment method, amount) |
| MT-REC-04 | P1 | Apply **Assigned to me** and **Shared with me**. | Each list contains only work that involves this person. | Partial: Shared with me lists the shared record for Finance and Directory Member. These lists have no Assigned to me filter. |
| MT-REC-05 | P1 | On desktop, switch Cards and Table. Narrow to phone width. | Both layouts show the same records on desktop. Phone width uses cards. | Pass |
| MT-REC-06 | P0 | Choose **New**. Leave a required field empty and save. Fill the required fields and save. | The form names each missing field. A complete form creates the record. | Pass (Donors) |
| MT-REC-07 | P1 | Open the record, choose **Edit**, change a field, and **Save changes**. Edit again and **Cancel edit**. | The first change is kept. Cancel leaves the record as it was after the save. | Partial: Cancel leaves the record unchanged. A saved edit was not checked. |
| MT-REC-08 | P1 | On a donation with a donor selected, edit the copied donor name. Read the net amount. | Copied fields stay locked while the donor link is set. Net amount is amount minus the fee, and is not typed in. | Pass, with DEF-18: the Donor field on the record shows a raw ID instead of the donor. |
| MT-REC-09 | P1 | On a reference field, pick an existing record, and start a related record from the field. | The link is stored. The new related record can be chosen. | Partial: picking an existing donor stores the link. Starting a related record was not checked. |
| MT-REC-10 | P1 | On a file field, drop an allowed file, pick one, and take a photo if the device offers it. Then try a type or size the field rejects. | Allowed files attach. Rejected files do not. | Partial: on QA Field Check, a picked PDF attaches, `.exe` is refused as an unsupported type, and a 3 MB image is refused over the 2 MB limit. Drag and drop could not be simulated; no camera on desktop. |
| MT-REC-11 | P2 | On a location field, use the device location, then type coordinates. | Either source stores a location the record shows again. | Partial: the device location is stored and shown again. Typed coordinates were not tried. |
| MT-REC-12 | P2 | On a signature field, sign on the line and save. | The signature is on the record after reopening. | Pass |
| MT-REC-13 | P2 | On a rich text field, apply bold, a list, a heading, a quote, a web link, and an email link. | Each is stored and shown when the record is reopened. | Pass (heading, bold, list, quote, web link, email link) |
| MT-REC-14 | P0 | Open a record in a state that offers a step. Fill what the step asks for. Choose the step name. | The record moves to the next state. A step that issues a receipt shows the receipt number. | Pass |
| MT-REC-15 | P0 | Run a step that needs approval, as the requester. Open Inbox as that same person and try to approve it. | The request is in Inbox. The requester cannot approve their own request. | Blocked: no published step needs approval. |
| MT-REC-16 | P0 | As a second person who is allowed to approve, approve it. Have a third person change the record while the approval is open, then try to approve the stale request. | Enough distinct approvals apply the step. A stale request asks for a refresh, and the decision can be made again after that. | Blocked: no published step needs approval. |
| MT-REC-17 | P1 | On a record with a receipt, open **Receipts** and **Print**. On a voided receipt, read the row. | Print opens the receipt. A voided receipt shows the reason. | Partial: Print opens the receipt. No voided receipt exists. |
| MT-REC-18 | P1 | On a donation in Raised, run **Send reminder** from the record and from the row menu, as Finance. As Viewer, look for the same action. | Finance sees the action in both places when the state offers it. Viewer does not. | Pass, with DEF-23: after sending, no confirmation is shown. |
| MT-REC-19 | P0 | Share the record with a person by name and with a role, once as Can view and once as Can edit. Leave **Ends on** empty. | View can open and cannot save. Edit can save. The share has no end date. | Fail DEF-10: run on QA Field Check (own and shared). Can view opens and cannot save. Can edit, by person and by role, shows no Edit. |
| MT-REC-20 | P1 | Share with an end date of today, and try an end date of yesterday. | Today is accepted and the share ends after that day. Yesterday is refused. | Fail DEF-09: the Ends on calendar inside the share panel cannot be clicked, so no end date can be set. |
| MT-REC-21 | P1 | Remove the person and the role from the share panel. | Those shares end immediately. | Pass, with DEF-28: the share search box keeps the last name after sharing. |
| MT-REC-22 | P1 | On the list, choose **Import**. Download the sample. Fill two valid rows. Map every column. Create new records. Leave automations off. Start. | The sample matches this list’s columns. The preview counts creates. Both rows exist afterwards. | Pass. Automations default to on in the import and were turned off. |
| MT-REC-23 | P1 | Import again with a matching field set to update, one row changed and one new. | The matching row is updated. The other row is created. | Pass (update when PAN matches) |
| MT-REC-24 | P1 | Import a file with one bad row and one good row. Map no columns and try to continue. Try a file over 10 MB or over 20,000 rows if you can produce one safely. | The bad row is skipped and counted as a problem. At least one mapped column is required. An oversized file is refused before import. | Pass (bad PAN row skipped and counted; no mapped column refused; 10 MB and 20,000-row files refused) |
| MT-REC-25 | P1 | Start an import, close the panel, and keep working. Turn automations on for one run and off for another. | Work continues. A notification opens the result. Automations run only for the run that asked for them. | Partial: the panel closes and work continues; runs with automations on and off. The large run never finished without the scheduler tick, so no notification. |
| MT-REC-26 | P1 | Cancel an import before it finishes. Download the failed rows, fix them, and import that file. | Cancel stops the run. The corrected file imports the rows that were wrong. | Fail DEF-16: the corrected failed-rows file is refused because the file adds an apostrophe to phone numbers. Cancel is Blocked as in MT-JOB-02. |
| MT-REC-27 | P1 | Export a short list. Export a list large enough to run in the background. | The short list downloads. The large list arrives through a notification. | Partial: the short list downloads. A background export needs the scheduler tick, which cannot run locally. |
| MT-REC-28 | P0 | Select several rows. **Edit fields**. Change one field. Apply. | Each selected record is updated, or reported as waiting for approval, or failed, with the same checks as a single edit. Unselected rows are unchanged. | Pass (two donors’ City changed; others unchanged) |
| MT-REC-29 | P1 | Select every record matching the current filters. Share them. Close the panel. On another run, choose **Stop** before the last row. | A notification arrives when the job finishes. Stop ends the job before the last row. Some rows may be done, waiting, or failed. | Partial: bulk share of the one QA Field Check record finished as 1 done, with no notification. Stop needs a larger set. |
| MT-REC-30 | P1 | Open a record from its list. Copy the address. Open it signed out, sign in as someone who may read it, and open it as someone who may not. | The address is `/records/{type}?id={id}`. The reader lands on the record. The other person is told they do not have access. | Pass |

## 13. Inbox

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-IN-01 | P0 | Leave an approval waiting. Move between Home and Records. Leave the app open for a little over a minute. | The Inbox number equals the approvals waiting for this person. It refreshes on navigation and about once a minute. | Blocked: no published step needs approval. |
| MT-IN-02 | P0 | Open Approvals. Read the requester, how long it has waited, and how many approvals are still needed. Open the record. Choose **Approve**. | The approval is recorded immediately. The step applies when enough distinct people have approved. | Blocked: no published step needs approval. |
| MT-IN-03 | P1 | Reject a different request and add a reason. Reject another and leave the reason empty. | Both rejections are recorded. The reason is stored when one was entered. | Blocked: no published step needs approval. |
| MT-IN-04 | P1 | Have someone else resolve the request. Then approve it from the stale list. | The page asks for a refresh. After refresh the decision matches the current request. | Blocked: no published step needs approval. |
| MT-IN-05 | P1 | Mark one notification read. Mark all read. | The one is read and the others stay unread. Mark all clears the list. | Blocked: no notifications; job notifications need the scheduler tick, which cannot run locally. |
| MT-IN-06 | P1 | Open the notification for a finished import, export, and bulk change. | Each opens its result. | Blocked: finished-job notifications need the scheduler tick, which cannot run locally. |

## 14. Builder

Builder needs the setup permission. Editing a definition needs the desktop-width window.

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-BLD-01 | P1 | Open Builder on a phone, then on a desktop. | The catalogue can be browsed on the phone. Editing a definition is available on the larger screen. | Pass, with DEF-32: moving quickly through about 15 Builder sections returned 429 Too Many Requests. |
| MT-BLD-02 | P0 | Change a list view label. Save the draft. Check it. Publish. Confirm the live list uses the new label. Discard a second draft. Open history and restore the previous published version. | The first change is live only after publish. Discard drops the unpublished draft. Restore makes the older published version the newest one, and the live list follows it. | Fail DEF-13: the draft is not live, Check passes, Discard works, and publish goes live. History lists versions but has no restore. |
| MT-BLD-03 | P1 | Edit a definition the catalogue marks as shipped. Publish. | The edit is kept as a patch on that module. The catalogue still marks it shipped. | Pass (Donors list label; then reverted to the module version) |
| MT-BLD-04 | P0 | Administration → Roles. Open Viewer → **Permissions**. Turn a permission off and choose **Save**. Open Builder → Access. Then open `/builder/roles`. | Saving applies at once; there is nothing to publish. A member with that role loses the permission on their next action. The access map matches the saved permissions. `/builder/roles` redirects to Administration → Roles. | Pass. Roles are Administration’s live setup, not a Builder draft; the earlier Fail recorded an expectation the product does not have. |
| MT-BLD-05 | P1 | Administration → Roles → **New role**. Give it a name and create it. | The role exists as soon as it is created, with no permissions and no members, and there is nothing to publish. Nobody gains the role. Add people from Administration → Roles or from the person’s page. | Pass. Create opens the new role on its Permissions tab with nobody in it. |
| MT-BLD-06 | P1 | Open Modules. Read Donations. | The module lists the definitions it added. Finance and Viewer exist when it is enabled. | Fail DEF-14: Modules shows Donations with a description and version, not the definitions it added. Finance and Viewer exist under Roles. |

Catalogue kinds to open once each, on a throwaway draft you discard: record types, workflows, list views, record groups, pages, actions, automations, message templates, posting rules, receipt rules, scripts, themes, translations, and the access map. For each, confirm the draft is not live until publish. File one defect per kind that cannot be opened, and do not file a pass for the whole catalogue because one kind opened.

Roles are not a catalogue kind. They are the organisation’s live setup, edited under Administration → Roles, where Save applies straight away (MT-ROL-02, MT-BLD-04, MT-BLD-05). `/builder/roles` redirects there.

Status: every kind opened. Only the list view draft was checked against the live list. Opening the kinds quickly in a row returned 429 Too Many Requests once, on scripts; it opened after a pause.

## 15. Donations

Preconditions: the Riverbank request included `donations`, setup has an open financial year, and the receipt series has been reviewed. Finance holds the Donations Finance role. Viewer holds the Donations Viewer role.

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-DON-01 | P0 | Sign in as Finance. Open Records. | Fundraising contains Donors and Donations. | Pass |
| MT-DON-02 | P0 | Sign in as Viewer. Open a donor and a donation. Try to create, edit, mark paid, cancel, remind, or print as an action Viewer does not have. | Viewer can read donors and donations. Changes and those actions are refused. | Partial, with DEF-17: the screens hide create, edit, steps, and reminder; server refusal was not checked. Viewer can create a public receipt link that shows the donor’s name, email, and phone to anyone without sign-in. |
| MT-DON-03 | P0 | As Finance, create a donor with name, email, phone, city, and PAN `ABCDE1234F`. | The donor is saved with a number of the form `DNR/` plus a sequence. | Pass (as Asha, with PAN `QAZWS4321K` because `ABCDE1234F` belongs to Ravi Kumar; `DNR/00004`) |
| MT-DON-04 | P1 | Save a PAN of `abcde1234f`, then `ABCDE12345`, then a second donor with `ABCDE1234F`. | The lowercase and the wrong shape are refused with the PAN message (five letters, four digits, one letter). The duplicate PAN is refused. | Pass |
| MT-DON-05 | P0 | Create a donation linked to that donor, amount `1000`, fee `10`. | Donor name, email, phone, and PAN copy from the donor and stay locked. Net amount shows `990`. Status is Raised. The number looks like `DON/{financial year}/{sequence}`. | Pass (`DON/2026-27/00010`) |
| MT-DON-06 | P1 | Set the fee to `1001` on a donation of `1000`. | Save is refused: the processing fee cannot be more than the donation. | Pass |
| MT-DON-07 | P1 | Try an amount of `0`. Mark the donation paid, then try to edit the amount. | Amount below 1 is refused while Raised. After Paid, the amount cannot be edited. | Pass |
| MT-DON-08 | P0 | On a Raised donation, **Mark as paid**. Choose Bank transfer, paid on today, and a reference. | Status becomes Paid. Payment method and paid-on were required. | Fail DEF-15, DEF-21: passed at 11:58 pm on 3 Nov; the method-required message stays after a method is chosen. At 3:10 am on 4 Nov (India time), a payment dated today was refused as in the future. The form has no reference field. |
| MT-DON-09 | P0 | Mark another donation paid with a paid-on date after today. | The step is refused: the payment date cannot be in the future. Status stays Raised. | Pass, with DEF-20: the chosen date shows month first (`11/10/2026` for 10 November). |
| MT-DON-10 | P1 | Mark as paid with method UPI and an empty reference. Then with a reference. | The empty reference is refused. With a reference, the donation becomes Paid. | Fail DEF-07: the empty reference is refused, but the form has no field to enter one, so a UPI payment cannot be recorded. |
| MT-DON-11 | P1 | Cancel a Raised donation. Then try to mark that donation paid, and try to cancel a Paid donation. | Cancel moves it to Cancelled. Paid and Cancelled offer no further transition. | Pass, with DEF-22: the cancel dialog has two buttons both labelled Cancel. |
| MT-DON-12 | P0 | Mark a donation paid after the receipt series is reviewed. Open Receipts. | A receipt number is issued from the series (prefix `RCPT` when the organisation was opened with that prefix). The audit log contains the money event. The donor’s total given and donations paid include this paid donation and exclude cancelled and still-raised ones. | Pass (`RCPT/2026-27/00007`; Ravi Kumar ₹3,301 across 6 paid) |
| MT-DON-13 | P1 | Issue a second receipt in the same financial year, and compare the numbers. | The sequence increases. Numbers do not repeat. | Pass (00006 then 00007) |
| MT-DON-14 | P1 | On a Raised donation, as Finance, run **Send reminder** with no email connector, then with one on and a template in place. | With no connector the reminder goes through OneNGO’s email service, because the installation has mail configured. Nothing is sent only where the installation has no mail either, and the notification is then skipped with “Email is not configured for this organisation.” With a connector on, the delivery is listed on that connector. | Partial: with no connector the reminder was delivered through OneNGO’s email service. Not checked with a connector. |
| MT-DON-15 | P1 | Print the receipt from the record and open `/print/receipt/{id}` while signed in as Finance, then as Viewer if Viewer cannot print. | Finance gets a printable receipt that shows the legal name and the current logo. A person without the action is refused. | Fail DEF-08: Viewer, whose role does not include Print receipt, can open `/print/receipt/{id}`. The receipt shows the legal name; no logo was uploaded. |

## 16. Suspend, reactivate, and close

Run this section last, on Riverbank, with the full operator. Tell the administrator before suspending unless you are rehearsing an incident. None of these actions deletes records.

The first click of suspend, reactivate, or close sends the operator through a fresh identity-provider check. Type the reason after you return, then click the same action again.

| ID | Pri | Steps | Expected | Status |
| --- | --- | --- | --- | --- |
| MT-LIFE-01 | P0 | Find active Riverbank. Choose Suspend. Complete the fresh multi-factor check. Return, enter a reason, and choose Suspend again. | The organisation becomes Suspended. The reason is in the operator history. | Blocked: no operator console or accounts. |
| MT-LIFE-02 | P0 | As Asha, try to sign in. Call the API with a key that worked before suspension. Open a record that existed before, from an operator status view or after reactivation. | Member sign-in is refused. The API key is refused. Records are still there after reactivation. | Blocked: no operator console or accounts. |
| MT-LIFE-03 | P1 | Choose Suspend, complete the check, and return without having typed the reason yet. Look at the reason field. | The reason is empty. It is entered after the check. | Blocked: no operator console or accounts. |
| MT-LIFE-04 | P1 | Enter a reason of 500 characters and one of 501. | 500 characters is accepted. 501 is refused. | Blocked: no operator console or accounts. |
| MT-LIFE-05 | P1 | On a suspended organisation, try Suspend. On an active organisation, try Close and try Reactivate. | Suspend is only offered from Active. Close is only offered from Suspended or from provisioning that failed. Reactivate is only offered from Suspended. | Blocked: no operator console or accounts. |
| MT-LIFE-06 | P0 | Reactivate, with a fresh multi-factor check. | The organisation is Active. Asha can sign in again. | Blocked: no operator console or accounts. |
| MT-LIFE-07 | P0 | After reactivation, check the old session and the old API key. | The ended session is still ended. The stopped key still does not work. A new sign-in works. A new API key works. | Blocked: no operator console or accounts. |
| MT-LIFE-08 | P0 | Suspend again. Choose Close, complete the check, enter a reason, and confirm Close. | The organisation is Closed. | Blocked: no operator console or accounts. |
| MT-LIFE-09 | P0 | Try to sign in as Asha. Try to reactivate. Find the organisation by code. | Sign-in is refused. Reactivate is not offered. Status still shows the organisation, and its records remain for export and retention. | Blocked: no operator console or accounts. |
| MT-LIFE-10 | P1 | Start Suspend for Riverbank, and use that same return check to try Close, or to try Suspend on a different organisation. | The check is refused. Each check works once, and only for the action and organisation it was requested for. | Blocked: no operator console or accounts. |
| MT-LIFE-11 | P0 | As the lookup operator, open an active organisation and attempt the lifecycle actions by URL if the buttons are hidden. | The actions are absent, and a direct attempt is refused. | Blocked: no operator console or accounts. |

## 17. Exploratory charters

Time-box each charter at 45 minutes. Note the role, the record type, and anything you would file.

| Charter | What to try | Status |
| --- | --- | --- |
| Permission edges | A share that grants edit on one record, while the role grants read on the type. A share that has ended. A bulk edit that includes one record the person cannot change. | Not run |
| Two people, one record | Both open Edit. One saves. The other saves. Repeat during an open approval. | Not run |
| Money boundaries | Amount `1`, a large amount, fee `0`, fee equal to the amount, paid on the first and last day of the financial year. | Partial: amount `1` with fee `0` marked paid, and `99999999.99` cancelled. The rest were not run. |
| Language and long text | Hindi and Tamil on Home, a record form, an error, and a receipt. A 200-character donor name. A 500-character suspend reason. | Partial: Hindi on Home and a list; the 200-character donor name truncates cleanly on Home. The rest were not run. |
| Offline and reload | Lose the network on New, on Import, and on Approve. Reload mid-edit. | Not run |
| Keyboard | From sign-in through saving a record, using Tab, Enter, and Escape, at desktop width. | Not run |

## 18. Exit

The run is complete when every case is Pass, Fail, Blocked, or Not run, and every Fail has a defect id.

| Gate | Rule |
| --- | --- |
| Smoke | Every smoke case in section 7 is Pass. |
| Donations release | Every P0 in sections 8, 9, 15, and 16 is Pass on an organisation that has the module. |
| Wider release | Every P0 is Pass. P1 fails have an accepted workaround or a fix. Blocked cases are listed with the missing precondition. |
| Close | MT-LIFE-09 has been run on a disposable organisation, or an explicit decision says this build will not be checked for close. |

## 19. Results sheet

Copy this table for the run.

| Field | Value |
| --- | --- |
| Environment | Local (`npm run dev`), 2026-11-03 run |
| Organisation app | `http://localhost:4200` |
| Operator console | Not running |
| Version (About this app) | 0.1.0 |
| Browser and viewports | Chromium through Playwright; 1366×900 and 390×844 |
| Organisation code | `riverbank` |
| Tester | AI agent with Playwright |
| Date | 2026-11-03 and 2026-11-04 |
| Scheduler tick | Not available: `TICK_SECRET` is empty, so background jobs stop after their first batch and failed deliveries are not retried |

| ID | Result | Defect | Notes |
| --- | --- | --- | --- |
| | Pass / Fail / Blocked / Not run | | |

## 20. Defects from the 2026-11-03 and 2026-11-04 runs

Each Fail above is a product bug. The same defect id is used where several cases show one bug. Steps to reproduce, expected and actual results, and known causes are in [the defect report](defect-report.md).

| ID | Severity | Cases | Bug |
| --- | --- | --- | --- |
| DEF-01 | Major | MT-AUTH-04 | A password of 9 characters is not saved, and the page shows no error. A message from an earlier attempt stays on screen. |
| DEF-02 | Critical | MT-NAV-01 | `/people` is still a route. It opens Administration → People. There should be no such route; that address should go to Home. |
| DEF-03 | Critical | MT-NAV-03 | Finance is kept out of the bar, but `/admin` and `/builder` open Home with no message that access was refused. |
| DEF-04 | Major | MT-ADM-04, MT-AUD-01 | Date fields do not render on Administration screens, so a registration cannot record issue and expiry, and the audit log cannot be filtered by date. |
| DEF-05 | Critical | MT-ROL-02, MT-BLD-04, MT-BLD-05 | Role permissions are edited and saved immediately under Administration → Roles. Builder has no Roles section, so there is no draft and no publish step. |
| DEF-06 | Major | MT-CON-01, MT-DON-14 | With no email connector, a donation reminder is still sent through OneNGO’s email service. |
| DEF-07 | Major | MT-DON-10 | Mark as paid refuses an empty UPI reference, and the form has no field for a reference, so a UPI payment cannot be recorded. |
| DEF-08 | Critical | MT-DON-15 | A Viewer, whose role does not include Print receipt, can open `/print/receipt/{id}` and read the receipt. |
| DEF-09 | Critical | MT-PPL-07, MT-REC-20 | A confirmation or pop-up opened from inside a dialog cannot be clicked: the dialog marks it inert. Suspend cannot be confirmed, and a share end date cannot be picked. |
| DEF-10 | Critical | MT-REC-19 | A Can edit share, to a person or a role, does not let them edit the record. The share panel also offers people whose role cannot see the record type, and those shares give no access. |
| DEF-11 | Major | MT-NAV-11 | With the organisation default set to Hindi, the invitation email and the set-password page are in English. |
| DEF-12 | Major | MT-NAV-12 | A save made while offline is not retried when the connection returns, and the "Cannot reach the server" message stays. |
| DEF-13 | Critical | MT-BLD-02 | Builder history lists published versions but has no way to restore one. Only Revert to module version is offered. |
| DEF-14 | Major | MT-BLD-06 | The Modules page shows a module’s description and version but not the definitions it added. |
| DEF-15 | Critical | MT-DON-08 | Mark as paid refuses today’s date as in the future between midnight and 5:30 am India time. The check uses the UTC date, not the organisation’s time zone. |
| DEF-16 | Major | MT-REC-26 | The failed-rows file writes phone numbers with a leading apostrophe, and importing that file again refuses the phone as invalid. |
| DEF-17 | Blocker | MT-DON-02 | A Viewer can create a public receipt link. Anyone with the link sees the donor’s name, email, and phone without signing in. |
| DEF-18 | Major | MT-REC-08 | A donation’s Donor field shows the donor record’s raw ID instead of the donor’s name or number. |
| DEF-19 | Major | MT-ADM-03 | Receipts can be issued before setup is complete; such a receipt prints without the legal name and registrations. |
| DEF-20 | Minor | MT-DON-09 | Date fields show month first (`11/10/2026` for 10 November) in an Indian organisation. |
| DEF-21 | Minor | MT-DON-08 | On Mark as paid, “Payment method is required” stays on screen after a method is chosen. |
| DEF-22 | Minor | MT-DON-11 | The cancel step dialog has two buttons both labelled Cancel: one closes the dialog, the other cancels the donation. |
| DEF-23 | Minor | MT-REC-18, MT-PPL-04 | Send reminder and Resend invitation finish with no confirmation on screen. |
| DEF-24 | Minor | MT-PPL-03 | A person can be added and invited with no role. |
| DEF-25 | Minor | MT-SET-02 | The time zone list offers `Asia/Calcutta` but not `Asia/Kolkata`, cannot be filtered by typing, and the country error repeats the hint. |
| DEF-26 | Minor | MT-AUD-01 | Audit log entries repeat the person’s name in What and show the internal word “tenant”. |
| DEF-27 | Minor | MT-ACC-02 | Settings shows the role key (`admin`) instead of the role’s name. |
| DEF-28 | Minor | MT-REC-21 | After sharing, the share panel’s search box keeps the last person’s name. |
| DEF-29 | Minor | MT-CON-02 | Wording: the connector’s missing-secret message reads “Not setis needed”; the list button reads “New qa field check”; a role page says “1 members”. |
| DEF-30 | Major | Section 21 | The sign-in page shows any text passed in `?message=`, so a crafted link can display a false warning. |
| DEF-31 | Major | MT-AUTH-19, MT-AUTH-20 | No screen or route switches an installation sign-in provider, such as Google, on for an organisation. |
| DEF-32 | Minor | MT-BLD-01 | One administrator moving quickly through about 15 Builder sections is rate-limited (429). |
| DEF-33 | Minor | MT-AUTH-03 | An expired invitation still shows the set-password form; it is refused only after the person submits a password. |

## 21. Public API review, 2026-11-04

Checked against the local app and the service sandbox: the routes that answer without sign-in, their rate limits, and the sign-in callbacks.

Held as designed:

- Per address, per minute: organisation lookup and public receipt links 20 (shared), `/api/auth/*` 30, other `/api/*` 300, `/webhooks/*` 600. A spoofed `X-Forwarded-For` does not change the address.
- Five wrong passwords lock that address for 15 minutes, with the same answer for unknown addresses. Email codes and reset links are capped at 3 per address and 10 per IP in 15 minutes, silently.
- Unknown receipt tokens answer in the same time as real ones. Webhooks with a bad signature, or for an unknown organisation, get 401.
- Oversized bodies, broken JSON, and unexpected fields are refused. The scheduler tick refuses calls without its secret.
- OIDC callback: a missing, forged, or error-bearing callback redirects to sign-in with a fixed message. State is single-use and hashed; nonce, PKCE, issuer, audience, and verified email are checked.
- Connector OAuth against the demo: Allow connects; replaying the callback, a forged state, and an empty callback are refused.

Risks to keep in view:

| Risk | Detail |
| --- | --- |
| Per-address limits live in each server’s memory | With several App Engine instances each one counts separately, so the real limit is the configured number times the instance count, and it resets when an instance restarts. Account lockout and email caps are in the database and stay firm. |
| Anyone can lock password sign-in for an address | Five wrong guesses lock it for 15 minutes. A deliberate trade-off: the person can still sign in with an email code, and the lock does not reveal who is registered. |
| Lookup and receipt links share one allowance | 20 per minute per address. A busy office behind one shared public address could hit it. |
| Sign-in page shows any `?message=` text (DEF-30) | Shown as plain text, so no script runs, but a crafted link can display a convincing false warning. |
| No way to switch on an installation sign-in provider (DEF-31) | Google sign-in cannot be enabled for an organisation from any screen or route, so MT-AUTH-19 and MT-AUTH-20 stay Blocked. |

## 22. Observations not filed as defects

Seen during the 2026-11-03 and 2026-11-04 runs. Each is either caused by the local setup or the test data, or needs a product decision before it can be called a bug.

| Observation | Why it is not a defect yet |
| --- | --- |
| Invitation and reset links point to `localhost:8080`, not the web app on `4200`. | The links follow `PUBLIC_BASE_URL` in the local `.env`. Check the setting in each deployed environment. |
| Seeded members show as Invited although they can sign in with a password. | The test data set passwords directly instead of accepting invitations. |
| An organisation administrator can change the organisation’s own storage quota. | Product decision: whether the quota belongs to the operator instead. |
| In Hindi, some labels mix Hindi and English, such as “नया donor”. | Expected fallback for unpublished translations (MT-NAV-10). The Donations module wording needs translating. |
| Large background jobs stop after their first batch, and failed connector deliveries are not retried. | `TICK_SECRET` is empty in the local `.env`, so the scheduler tick is refused. Retest with a tick (MT-JOB-02, MT-REC-26, MT-REC-27, MT-IN-05, MT-IN-06, MT-CON-03). |
| After choosing Deny on a connector’s consent page, the connector page still shows the earlier connection and no “denied” message. | No plan case covers Deny on reconnect. Product decision: whether a denied reconnect should say so. |
