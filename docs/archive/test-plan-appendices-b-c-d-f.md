# Test plan appendices (archived)

Archived from `docs/testing/test-plan.md` on 2026-11-22: B defect report, C UI/UX audit, D UI designer handoff, F execution flows. Appendices A (manual cases) and E (test data) stay in the plan.

## Appendix B. Defect report: manual run of 3–4 November 2026

### OneNGO defect report: manual run of 3–4 November 2026

Defects found while running [the manual test plan](#appendix-a-manual-test-cases-and-results), and the cases that were not fully tested. The plan holds each case’s result; this file holds the detail a developer needs to reproduce and fix each defect.

#### Environment

| Field | Value |
| --- | --- |
| Build | `develop` at `361d226` (3 Nov) and `bf76294` (4 Nov); version 0.1.0 |
| Setup | Local `npm run dev`: app `http://localhost:4200`, API `http://localhost:8080`, integration fixture `https://127.0.0.1:8095` |
| Data | `functional-test-data.md`, organisation `riverbank` |
| Browser | Chromium through Playwright, 1366×900 and 390×844 |
| Not available | Operator console and operator accounts; scheduler tick (`TICK_SECRET` empty); an enrolled authenticator |

Severity follows section 5 of the plan: **Blocker** (wrong data exposure, money or receipts wrong), **Critical** (a P0 case fails with no safe workaround), **Major** (a P1 case fails, or a workaround exists), **Minor** (wording, layout, or a P2 case).

#### Summary

| Severity | Count | Defects |
| --- | --- | --- |
| Blocker | 1 | DEF-17 |
| Critical | 8 | DEF-02, DEF-03, DEF-05, DEF-08, DEF-09, DEF-10, DEF-13, DEF-15 |
| Major | 12 | DEF-01, DEF-04, DEF-06, DEF-07, DEF-11, DEF-12, DEF-14, DEF-16, DEF-18, DEF-19, DEF-30, DEF-31 |
| Minor | 12 | DEF-20 to DEF-29, DEF-32, DEF-33 |

Status as of 6 Nov 2026, on branch `features/defect-fixes` (not merged). Fixed means a code change. Plan means the product already behaved as designed and the test plan was corrected. The original write-up below is unchanged.

| Defect | Status | Where |
| --- | --- | --- |
| DEF-17 | Fixed | `a93cf9e` |
| DEF-02 | Fixed | `fc930b9` |
| DEF-03 | Fixed | `1f4905d` |
| DEF-08 | Fixed | `47f134e` |
| DEF-09 | Fixed | `3e48f87` |
| DEF-05 | Plan | `7eed426` — permissions stay live in Administration |
| DEF-10 | Fixed | `4f43094` — the share panel now warns; an edit share still needs the role's Edit permission |
| DEF-13 | Fixed | `d5dea88` |
| DEF-15 | Fixed | `7122c2c` — "today" is India time, not each organisation's own time zone |
| DEF-01 | Fixed | `2755c15` |
| DEF-04 | Fixed | `843aaf3` |
| DEF-06 | Plan | `2091221` — email falls back to OneNGO's mail |
| DEF-07 | Fixed | `63acb37` |
| DEF-11 | Fixed | `90b84f2` |
| DEF-12 | Fixed | `b443d5b` — record saves retry; file uploads do not |
| DEF-14 | Fixed | `7399097` |
| DEF-16 | Fixed | `a5f01b9` — checked by the import API test, not in the browser |
| DEF-18 | Fixed | `0d6c3a6` |
| DEF-19 | Fixed | `18caad9` — a receipt needs a legal name and a registered address |
| DEF-30 | Fixed | `9a8244f` |
| DEF-31 | Plan | `c897b66` — the opt-in stays in the operator console |
| DEF-20 | Fixed | `aa7ecc2` |
| DEF-21 | Fixed | `1fdb8d4` — the message clears; the browser check used the create form |
| DEF-22 | Fixed | `a65d510` |
| DEF-23 | Fixed | `40a472f` |
| DEF-24 | Fixed | `02a7601` |
| DEF-25 | Fixed | `e51cc1b` |
| DEF-26 | Fixed | `336b36d` |
| DEF-27 | Fixed | `84c7aa4` |
| DEF-28 | Not reproduced | The share search box already clears after a share |
| DEF-29 | Fixed | `4ca7192` |
| DEF-32 | Fixed | `8e9d3a0` |
| DEF-33 | Fixed | `6f78cc5` — a fresh link still showing the form is covered by the server test |

Review on 6 Nov added `e0110d2`, `49c39b2`, `eff396f`, `bc6f09c`, `5b45571` and `3b81aa6` (test expectations, one wiring correction). Two decisions remain: DEF-08 refuses printing for a record type that has no Print receipt action, even for an administrator; DEF-15 uses India time for every organisation.

#### Defects

##### DEF-17 · Blocker · A Viewer can publish a receipt with donor details

- **Cases:** MT-DON-02. **Area:** Donations, receipts.
- **Steps:** Sign in as `viewer@riverbank.example`. Open `/print/receipt/{id}` for a paid donation’s receipt. Choose **Copy public link**. Open the copied `/r/{token}` address in a browser with no session.
- **Expected:** A Viewer, whose role is read-only, cannot create a public link.
- **Actual:** The link is created (`POST /api/print/receipt/{id}/link` returns 200) and opens without sign-in, showing the donor’s name, email, and phone (PAN is hidden). The audit log records “Viewer Member receipt link created”.
- **Note:** The Viewer could also see **Revoke public link**.

##### DEF-02 · Critical · `/people` is still a route

- **Cases:** MT-NAV-01. **Area:** Navigation.
- **Steps:** Sign in as Asha. Open `/people`.
- **Expected:** `/people` is not a route and goes to Home (plan wording updated on 4 Nov).
- **Actual:** It opens Administration → People.
- **Cause:** `apps/onengo/web/src/app/routes.ts` line 73, `{ path: 'people', redirectTo: 'admin/people' }`. `core/shell/shell.ts` line 338 still builds a “People directory” link to `/people` for anyone with the directory permission (not shown in this run).

##### DEF-03 · Critical · Forbidden pages open Home with no message

- **Cases:** MT-NAV-03. **Area:** Navigation, permissions.
- **Steps:** Sign in as `finance@riverbank.example`. Open `/admin`, then `/builder`.
- **Expected:** Each says the person does not have access.
- **Actual:** Each silently opens Home. The bar correctly hides both. The same happens for every persona without the permission.

##### DEF-05 · Critical · Role permissions change live in Administration; Builder has no Roles

- **Cases:** MT-ROL-02, MT-BLD-04, MT-BLD-05. **Area:** Roles, Builder.
- **Steps:** Administration → Roles → Viewer → Permissions.
- **Expected:** Permissions are read-only here; they change in Builder → Roles and apply after publish.
- **Actual:** 46 editable controls and a Save that “updates it straight away”. Builder has no Roles section, so there is no draft or publish step.
- **Note:** Product and plan disagree; one of them must change.

##### DEF-08 · Critical · A Viewer without Print receipt can open the print page

- **Cases:** MT-DON-15. **Area:** Receipts, permissions.
- **Steps:** Sign in as Viewer. Open `/print/receipt/{id}`.
- **Expected:** Refused; the Viewer role does not include the Print receipt action.
- **Actual:** The receipt opens with Download, Print, and the public-link buttons (see DEF-17).

##### DEF-09 · Critical · Pop-ups opened from inside a dialog cannot be clicked

- **Cases:** MT-PPL-07, MT-REC-20 (and blocks MT-PPL-05, MT-PPL-08). **Area:** Shared UI.
- **Steps:** Administration → People → a person → **Suspend** (from the panel or the row menu). Click **Suspend** in the confirmation. Separately: a restricted record → ⋮ → Share → **Ends on** → pick a day.
- **Expected:** The confirmation and the calendar respond.
- **Actual:** Nothing happens; a real mouse click does not register. Nobody can be suspended, and no share end date can be set.
- **Cause:** `apps/onengo/web/src/app/ui/dialog.ts`, `DialogFocus`/`inertTargets`, marks every sibling of an open dialog `inert` when it opens. A confirmation sheet or the `.cdk-overlay-container` that already exists becomes inert and stays so. Last change to the file: `d8cabff` “UX audit fix: dialog-focus” (2 Nov). Whether it happens depends on which elements exist when the dialog opens; Mark as paid’s calendar worked.

##### DEF-10 · Critical · A Can edit share does not allow editing

- **Cases:** MT-REC-19. **Area:** Sharing.
- **Steps:** On a record type set to “Only their own and shared” (QA Field Check), share a record with Directory Member and with the Directory role as **Can edit**. Give the Directory role See on the type. Sign in as Directory Member and open the record.
- **Expected:** The person can edit and save.
- **Actual:** The record opens read-only with no Edit. Can view works.
- **Also:** The share panel offers people whose role cannot see the record type at all; those shares give no access and no warning.

##### DEF-13 · Critical · Builder history cannot restore a version

- **Cases:** MT-BLD-02. **Area:** Builder.
- **Steps:** Publish a change to a list view. Open its History tab.
- **Expected:** An earlier published version can be restored and becomes the newest.
- **Actual:** History lists versions with no restore action. Only ⋮ → Revert to module version exists, which drops all organisation changes.

##### DEF-15 · Critical · Today’s payment date is refused early in the Indian day

- **Cases:** MT-DON-08. **Area:** Donations.
- **Steps:** Between 00:00 and 05:30 India time, Mark as paid with Paid on = today.
- **Expected:** Accepted.
- **Actual:** “The payment date cannot be in the future.” Seen at 03:10 IST on 4 Nov; the same step passed at 23:58 on 3 Nov.
- **Cause (likely):** The future-date check compares with the UTC date, not the organisation’s time zone.

##### DEF-01 · Major · A 9-character password shows no error

- **Cases:** MT-AUTH-04. **Area:** Invitation, reset.
- **Steps:** Open an invitation or reset link. Enter a 9-character password in both fields. Save.
- **Expected:** “Use at least 10 characters”; not saved.
- **Actual:** Not saved, but no error appears. A message from a previous attempt stays on screen.

##### DEF-04 · Major · Date fields do not render in Administration

- **Cases:** MT-ADM-04, MT-AUD-01. **Area:** Administration.
- **Steps:** Administration → Registrations → Add registration. Administration → Audit log → Filters.
- **Expected:** Issue and expiry dates; a date filter.
- **Actual:** Neither renders. Console: “MatDatepicker: No provider found for DateAdapter”.
- **Cause:** `provideFieldDates()` (`ui/date-adapter.ts`) is provided only in `records/records.routes.ts`, not on the Administration routes.

##### DEF-06 · Major · Messages are sent with no connector

- **Cases:** MT-CON-01, MT-DON-14. **Area:** Messaging.
- **Steps:** With no connector, run **Send reminder** on a Raised donation.
- **Expected:** Nothing is sent.
- **Actual:** The email is delivered through OneNGO’s email service. The setup checklist says the same (“Sent through OneNGO’s email service”).
- **Note:** Product and plan disagree.

##### DEF-07 · Major · UPI payments cannot be recorded

- **Cases:** MT-DON-10. **Area:** Donations.
- **Steps:** Mark as paid, method UPI, paid on a past date.
- **Expected:** A reference field; empty refused, filled accepted.
- **Actual:** The form has no reference field. The server answers “Enter the UPI transaction reference.” Cheque and online are likely affected too.

##### DEF-11 · Major · Organisation default language not used for invitations

- **Cases:** MT-NAV-11. **Area:** Language.
- **Steps:** Set the organisation default language to Hindi. Invite a new person. Read the email and open the link.
- **Expected:** Email, set-password page, and first session in Hindi.
- **Actual:** The first session is Hindi; the email and the set-password page are English.

##### DEF-12 · Major · Offline save is not retried

- **Cases:** MT-NAV-12. **Area:** Offline.
- **Steps:** Edit a record, go offline, Save. Come back online.
- **Expected:** The save waits and completes when the connection returns.
- **Actual:** A clear offline message shows and the edit stays, but the save is not retried. “Cannot reach the server” stays; a second Save is needed.

##### DEF-14 · Major · Modules page does not list a module’s definitions

- **Cases:** MT-BLD-06. **Area:** Builder.
- **Actual:** Builder → Modules shows Donations with a description and version only.

##### DEF-16 · Major · Failed-rows file cannot be imported again

- **Cases:** MT-REC-26. **Area:** Import.
- **Steps:** Import a file with one bad row. Download the failed rows. Fix the reason. Import that file.
- **Expected:** The fixed row imports.
- **Actual:** “Enter a valid phone number” — the download writes phones as `'+91 …` (a leading apostrophe). Removing the apostrophe makes it import.

##### DEF-18 · Major · Donation shows the donor’s raw ID

- **Cases:** MT-REC-08. **Area:** Records.
- **Actual:** A donation’s Donor field shows a UUID (e.g. `42a8eebd-…`) instead of the donor’s name or number.

##### DEF-19 · Major · Receipts can be issued before setup is complete

- **Cases:** MT-ADM-03. **Area:** Receipts, setup.
- **Steps:** Before confirming identity and registrations, mark a donation paid.
- **Actual:** `RCPT/2026-27/00006` was issued and prints without the legal name, address, or registrations. After setup, receipts show them.

##### DEF-30 · Major · Sign-in page shows any `?message=` text

- **Cases:** section 21 of the plan. **Area:** Sign-in, security.
- **Steps:** Open `/sign-in?message=Your account is locked. Call +91 99999 00000.`
- **Actual:** The text is shown as the page message, then removed from the address. HTML shows as plain text (no script), but a crafted link can display a convincing false warning.

##### DEF-31 · Major · No way to switch on an installation sign-in provider

- **Cases:** MT-AUTH-19, MT-AUTH-20 (Blocked). **Area:** Sign-in.
- **Actual:** `GET /api/auth/providers?tenant=riverbank` returns `[]`. `saveProviderPolicy` has no caller in any route or screen, so Google sign-in cannot be enabled for an organisation.

##### DEF-20 · Minor · Dates shown month first

- **Cases:** MT-DON-09. **Actual:** Picking 10 November shows `11/10/2026`. The native date adapter uses the browser’s US format, not Indian day-first.

##### DEF-21 · Minor · Stale “required” message on Mark as paid

- **Cases:** MT-DON-08. **Actual:** “Payment method is required for this step” stays after a method is chosen.

##### DEF-22 · Minor · Two buttons labelled Cancel

- **Cases:** MT-DON-11. **Actual:** The cancel-donation dialog has Cancel (close) and Cancel (confirm).

##### DEF-23 · Minor · No confirmation after sending

- **Cases:** MT-REC-18, MT-PPL-04. **Actual:** Send reminder and Resend invitation show nothing on screen after success.

##### DEF-24 · Minor · A person can be added with no role

- **Cases:** MT-PPL-03. **Actual:** Add a person with no role is accepted and invited.

##### DEF-25 · Minor · Time zone and country fields

- **Cases:** MT-SET-02. **Actual:** The time zone list has `Asia/Calcutta` but not `Asia/Kolkata` and cannot be filtered by typing. The country error repeats the hint text.

##### DEF-26 · Minor · Audit log wording

- **Cases:** MT-AUD-01. **Actual:** What repeats the person’s name (“Asha Menon record created…”) and shows “tenant”.

##### DEF-27 · Minor · Role key shown in Settings

- **Cases:** MT-ACC-02. **Actual:** Under the name, Settings shows `admin` instead of “Administrator”.

##### DEF-28 · Minor · Share search keeps the last name

- **Cases:** MT-REC-21. **Actual:** After sharing, the search box still holds the last person’s name.

##### DEF-29 · Minor · Wording slips

- **Cases:** MT-CON-02 and others. **Actual:** “Not setis needed before the connector can be enabled”; “New qa field check”; “1 members”.

##### DEF-32 · Minor · Rate limited while moving through Builder

- **Cases:** MT-BLD-01. **Actual:** Opening about 15 Builder sections quickly returned 429 for one administrator (the 30-per-minute `/api/auth/` limit is reached by refresh and manifest calls).

##### DEF-33 · Minor · Expired invitation still shows the form

- **Cases:** MT-AUTH-03. **Actual:** An 8-day-old invitation shows the set-password form; “expired” appears only after a password is submitted.

#### Not fully tested

Cases with result Blocked, Not run, or Partial, with what is needed to finish them. P0 cases are marked.

##### Blocked: operator console (27 cases)

MT-OP-01 to MT-OP-16 and MT-LIFE-01 to MT-LIFE-11 (P0: OP-01, 02, 03, 05, 07, 08, 09, 10; LIFE-01, 02, 06, 07, 08, 09, 11). Also the suspended half of MT-AUTH-09 (P0).

- **Needed:** the operator console running with operator accounts. Work in progress on `features/dev-operator-console` adds `npm run dev -- --console` with two local operators. Close (MT-LIFE-08, 09) needs a throwaway organisation.

##### Blocked: approvals (6 cases)

MT-REC-15 (P0), MT-REC-16 (P0), MT-IN-01 (P0), MT-IN-02 (P0), MT-IN-03, MT-IN-04.

- **Needed:** a published step that requires approval, and two approvers.

##### Blocked: scheduler tick (5 cases, plus parts of 3)

MT-JOB-02, MT-CON-03, MT-IN-05, MT-IN-06; cancel in MT-REC-26; the background parts of MT-REC-25, MT-REC-27, MT-REC-29.

- **Needed:** `TICK_SECRET` set in `.env` and the server restarted, then `POST /internal/tick` with it. A 15,000-row import is left Running at 400 with cancel requested.

##### Blocked: other preconditions

| Case | Needed |
| --- | --- |
| MT-AUTH-19, MT-AUTH-20 | An operator with the `sign_in` grant switching the shared provider on for the organisation in the operator console, with a step-up and a reason |
| MT-AUTH-22, MT-AUTH-23 | A member with an enrolled authenticator |
| MT-PPL-05, MT-PPL-08 | DEF-09 fixed |

##### Not run

| Case | Why |
| --- | --- |
| MT-NAV-13 | Needs a new web build while a session is open |
| MT-NAV-14 | Needs a real phone’s install prompt |
| MT-ACC-01 | Recorded as “no editable profile fields”; the product has since changed, so re-run |

##### Partial: remaining steps

| Case | Not yet checked |
| --- | --- |
| MT-AUTH-11 | The remembered organisation after a sign-out |
| MT-NAV-05 | Back from a list and from settings |
| MT-NAV-07 | Rename, reorder, and unpin a Home pin |
| MT-NAV-09 | Tamil, Telugu, Bengali, Marathi; persistence across a new sign-in; another member unaffected |
| MT-ADM-08 | Email and payments rows after an email connector is on |
| MT-SET-04 | Default language for new people; API limit stored (later covered by MT-KEY-02) |
| MT-PPL-01, MT-PPL-02 (P0) | Asha’s search and the status, invitation, and two-step columns on Administration → People, under the new wording |
| MT-PPL-06 (P0) | Adding and removing a role for several people at once |
| MT-ROL-01 (P0) | Adding an invited person to a role |
| MT-ACC-04 | A member with two-step on |
| MT-KEY-01 (P0) | Revoke the key and repeat the call; Viewer-only data checked through MT-KEY-02 |
| MT-JOB-01 | Jobs seen by a second administrator who did not start them |
| MT-REC-04 | An Assigned to me filter (none on these lists) |
| MT-REC-07 | A saved edit |
| MT-REC-09 | Starting a related record from a reference field |
| MT-REC-10 | Drag and drop; a camera photo |
| MT-REC-11 | Typed coordinates |
| MT-REC-17 | A voided receipt’s reason |
| MT-DON-02 (P0) | Server refusal of Viewer changes, by calling the API directly |

##### Exploratory charters

| Charter | Status |
| --- | --- |
| Permission edges | Not run |
| Two people, one record | Not run |
| Money boundaries | Partial: amount 1 with fee 0, and 99,999,999.99; fee equal to amount and year-boundary dates not run |
| Language and long text | Partial: Hindi on Home and lists, a 200-character name; Tamil, errors, receipts, and a 500-character reason not run |
| Offline and reload | Not run |
| Keyboard | Not run |

##### Also not covered

- The Builder catalogue was opened kind by kind, but only the list view draft was checked against the live list.
- The Google (OIDC) sign-in happy path; only its refusals were checked, because of DEF-31.
- A connector Deny on reconnect showed no “denied” message; no plan case covers it (see plan section 22).

## Appendix C. UI/UX audit 2026-11-01

### OneNGO UI/UX audit

Date: 2026-11-01  
Environment: local, `http://localhost:4200`  
Organisation: `demo` (Demo Foundation)  
Account: Demo Admin  
Version: 0.1.0  
Browser: Chromium through Playwright  
Measured viewports: 1440 × 1000 and 390 × 844

#### Outcome

Release recommendation: do not treat the current UI as release-ready.

The highest-risk defect is the Theme screen: every editable colour control loads as black and every adjacent text value is empty, while the preview and contrast results use a different, valid theme. **Publish theme** remains enabled. My profile is also unusable for the supplied administrator because it returns **Not found**.

The responsive layouts otherwise switch correctly between desktop side navigation/table layouts and phone bottom navigation/card layouts. The tested phone form had no horizontal overflow, and the compact breadcrumb exposed its full trail with an accessible label.

#### Coverage

The following surfaces were opened and inspected:

- General and organisation sign-in, password, email-code, reset-password entry, and sign-out confirmation.
- Home, Records catalogue, Donors, Donations, Inbox Approvals, Inbox Notifications, More, Settings, language, My profile, and People directory.
- Administration home, People, Add a person, Roles, role membership, Connectors, New connector, API keys, New API key, Background jobs, Audit log, Organisation information, Theme, and Layout.
- Builder catalogue, Donation record-type editor, Roles, Access map, and Modules.
- Record-list search, chips, sort, filters, layout switch, list actions, import entry, create forms, multi-step validation, mobile breadcrumb, and phone Builder read-only mode.
- Desktop and phone responsive states, keyboard focus after dialogs and validation, touch-target dimensions, browser console, and failed network requests.

The test did not publish configuration, create API keys, disable modules, send mail, or permanently create, edit, suspend, or delete business data.

#### Defects

##### UX-001 — Theme editor loads false black/empty values while Publish is enabled

Severity: Major  
Area: Administration → Theme

Steps:

1. Sign in as Demo Admin.
2. Open `/admin/theme`.
3. Inspect the seven colour inputs, their text fields, the preview, and contrast results.

Actual:

- All seven `input[type=color]` values measured `#000000`.
- Every adjacent text input was empty.
- The preview remained blue/white and reported contrast values such as `6.8 : 1` and `14 : 1`, which cannot describe the displayed black controls.
- **Publish theme** was enabled.

Impact:

The editor does not represent the currently published theme. An administrator cannot make a safe informed change and may publish a black-on-black or incomplete theme.

Recommendation:

Populate both controls from one canonical draft model, validate every colour before enabling Publish, and calculate the preview and contrast from those exact draft values. Disable Publish until initial loading and validation finish.

Evidence: [theme-black-controls.png](evidence/ui-ux-2026-11-01/theme-black-controls.png)

##### UX-002 — My profile is unavailable to the supplied administrator

Severity: Major  
Area: Settings → My profile

Steps:

1. Open `/settings`.
2. Choose **Demo Admin — My profile**.

Actual:

The panel opens with only **Not found.** The user cannot view or edit a profile.

Expected:

Every member should have a profile, or the page should provide a recoverable empty state if profile provisioning has not completed.

Recommendation:

Ensure member onboarding creates the profile atomically. If legacy members can lack one, create it on first access or provide an administrator-facing recovery action. Replace the generic error with task-specific guidance.

Evidence: [profile-not-found.png](evidence/ui-ux-2026-11-01/profile-not-found.png)

##### UX-003 — Dialogs do not receive or trap keyboard focus

Severity: Major  
Area: Filters, Import, create forms, profile, language, and administration panels

Steps:

1. Open Donors.
2. Open **Filters**.
3. Press Tab.
4. Repeat with Import or a create form.

Actual:

- Focus remained on the control behind the dialog.
- The next Tab moved to **More actions** behind the filter dialog.
- The dialog had no `aria-modal="true"`.
- The background was not inert.
- Import showed the same behavior: focus remained on the list action trigger outside the dialog.

Impact:

Keyboard and assistive-technology users can unknowingly operate obscured controls and lose context. This also conflicts with the documented requirement that panels trap focus and restore it when closed.

Recommendation:

Use a shared modal primitive that moves focus to the heading, close button, or first field; applies `aria-modal`; makes the background inert; traps Tab/Shift+Tab; closes on Escape where safe; and restores focus to the trigger.

##### UX-004 — Phone controls miss the documented 44 px touch target

Severity: Major  
Area: Global shell and phone record forms

Measured on `/records/donation?create=new` at 390 × 844:

- 23 visible interactive elements had a measured width or height below 44 px.
- Account button: 34 × 34.
- Breadcrumb expander: 32 × 28.
- Back and dialog-close controls: 32 × 32.
- Chips: 24 px high.
- Sort and Filters: 36 px high.
- Cancel and Next: 33 px high.

Impact:

The most frequently used controls are harder to hit accurately, especially for people with motor impairments. This violates the documented 44 px touch-target requirement.

Recommendation:

Increase the interactive box, not only the icon, to at least 44 × 44 CSS pixels. Keep visible spacing compact by using transparent padding where necessary.

Evidence: [new-donation-mobile.png](evidence/ui-ux-2026-11-01/new-donation-mobile.png)

##### UX-005 — Hindi mode leaves the page identity in English

Severity: Major  
Area: Settings and localization

Steps:

1. Open Language.
2. Choose हिन्दी.
3. Return to Settings.

Actual:

Navigation, profile, language, two-step, and About text changed to Hindi, but the page heading and breadcrumb remained **Settings**.

Impact:

The result is visibly mixed-language and makes the product feel unfinished. The manual plan requires published screen text in the selected language with English fallback only for unpublished strings.

Recommendation:

Add the Settings route title and breadcrumb label to every supported locale catalogue. Add a route-level localization test that checks headings, breadcrumbs, document titles, and navigation together.

Evidence: [settings-hindi-mixed.png](evidence/ui-ux-2026-11-01/settings-hindi-mixed.png)

##### UX-006 — New API key role selector has no accessible name

Severity: Major  
Area: Administration → API keys → New API key

Actual:

The role combobox is exposed without an accessible name even though **Acts as role \*** is visually present.

Impact:

A screen reader announces an unidentified combobox on a security-sensitive form.

Recommendation:

Associate the visible label with the native/select trigger through `for`/`id`, `aria-labelledby`, or the framework form-field API. Add an accessibility assertion for every labelled form control.

##### UX-007 — Layout reorder buttons do not identify their item

Severity: Major  
Area: Administration → Layout

Actual:

The screen exposes repeated buttons named only **Up**, **Down**, **Move to More**, and **Move to sidebar**. A screen-reader user cannot tell whether an action applies to Home, Records, Inbox, Builder, Settings, Donations, Donors, People, or Administration.

Recommendation:

Name each action with its item, for example **Move Records up** and **Move Donations to sidebar**. Announce the new order after an action and support keyboard reordering.

##### UX-008 — New connector state is absent from the URL

Severity: Major  
Area: Administration → Connectors

Steps:

1. Open `/admin/connectors`.
2. Choose **New connector**.

Actual:

The panel opens while the address remains `/admin/connectors`.

Impact:

Reload and shared links cannot reproduce the open panel, and browser Back cannot reliably represent the user's state. Other tested flows correctly use URL state, such as `?create=new`, `?add=`, and `?panel=language`.

Recommendation:

Represent the panel with a query parameter or dedicated route and restore it from the address.

##### UX-009 — Validation leaves focus on the submit button

Severity: Major  
Area: Donor, Donation, and Add a person forms

Actual:

After submitting an incomplete form, errors appear next to fields but focus remains on **Create**, **Next**, or **Add and invite**. The same behavior occurred for required donor name and malformed PAN.

Impact:

Keyboard and screen-reader users must search the panel for the error. Long, scrollable phone forms make this especially difficult.

Recommendation:

Focus the first invalid field, connect its error with `aria-describedby`, set `aria-invalid`, and provide a focused error summary when more than one field fails.

Evidence: [new-donor-validation.png](evidence/ui-ux-2026-11-01/new-donor-validation.png)

##### UX-010 — Create dialogs use plural object names

Severity: Minor  
Area: Donors and Donations

Actual:

The headings are **Create Donors** and **Create Donations** while each form creates one record.

Recommendation:

Use the record type's singular label: **Create donor** and **Create donation**.

##### UX-011 — Add a person hides required status until submission

Severity: Minor  
Area: Administration → People → Add a person

Actual:

Email and Name show no required marker initially, although empty submission reports both as required. The role requirement is also not explained before submission.

Recommendation:

Mark required fields consistently before interaction and state that at least one role is required.

##### UX-012 — Excessive processing fee error is not attached to the fee field

Severity: Minor  
Area: New donation, step 2

Steps:

1. Enter amount 1000 and processing fee 1001.
2. Choose Create.

Actual:

The correct message appears only as a panel-level alert: **The processing fee cannot be more than the donation.**

Recommendation:

Keep the summary alert, but also associate the message with Processing fee and focus that field.

##### UX-013 — Audit log exposes implementation language and UUIDs

Severity: Minor  
Area: Administration → Audit log

Actual examples:

- `signed_in · member 54c0db10-b636-4415-9a10-ce3b8eabbfbf`
- `definition.published · definition:theme organisation`
- `settings.changed · tenant 5055392f-cfc2-4e28-9065-108ff6034dd6`

Impact:

Administrators must interpret internal event keys and identifiers instead of understanding what happened.

Recommendation:

Render plain-language summaries such as **Demo Admin signed in** and **Demo Admin published the organisation theme**. Put IDs and raw event payloads in an expandable technical-details section.

##### UX-014 — Select remains available on an empty record list

Severity: Minor  
Area: Donors list → More actions

Actual:

**Select** is enabled while the list says **Nothing matches this view.**

Recommendation:

Disable or hide selection when no rows are available, and explain why if the command remains visible.

##### UX-015 — More navigation does not match the approved information architecture

Severity: Major  
Area: More and Settings

Actual:

More contains links for Builder, Settings, Donations, Donors, People, and Administration. The account card, profile, language, two-step state, and About information are moved behind a separate Settings page.

Expected from the signed-off UI design and manual plan:

- The account card is at the top of More and opens My profile.
- Language, two-step, Builder, and About are direct More rows.
- Record groups are not repeated in More.

Impact:

Common personal settings take an extra navigation step, while Donations and Donors duplicate Records navigation and make More less predictable.

Recommendation:

Align implementation and documentation. Prefer the signed-off hierarchy unless a newer product decision is recorded and the manual plan is updated.

#### Visual and spacing observations

- Desktop Settings and More place a short list in a wide content region and leave most of the viewport empty. This is not a blocker, but grouping personal preferences directly in More would use the space more purposefully and remove one navigation level.
- Desktop forms and record panels correctly remain single-column instead of stretching fields across the viewport.
- Phone create sheets use the full width with no horizontal overflow. The measured New donation sheet was 390 px wide and about 617 px high in an 844 px viewport.
- Labels, field spacing, and section spacing were generally consistent. The most visible wording inconsistency was plural create headings.

#### Verified strengths

- Password inputs use the correct password type and autocomplete attributes.
- Sign-out has a clear confirmation and safe Cancel action.
- Record search, sort, filter, chip, and panel state generally appears in the URL.
- Desktop shows table/card controls; phone correctly hides the layout switch and uses cards.
- Phone breadcrumbs compact to Records › … › Donations and expose **Show the full trail**.
- Required donor and donation validation messages are specific and easy to understand.
- PAN and processing-fee rules produced clear domain-specific messages.
- Builder is read-only on phone and explains that editing requires a tablet or computer.
- The tested phone form had no horizontal overflow.

#### Blocked or intentionally not run

These flows need data, accounts, infrastructure, or permission to make lasting changes:

- Record detail/edit, workflow transitions, receipts, print, sharing, bulk actions, and completed import/export: no donor or donation records existed.
- Approval and rejection behavior: no waiting approvals and no second approver.
- Role-boundary checks for Finance, Viewer, directory-only, and no-access personas: only the administrator credentials were supplied.
- Invitation, email-code completion, password-reset completion, and resend: no mailbox was supplied.
- File upload type/size, logo upload, and attachment preview: no test files were supplied.
- Connector delivery/retry and payment flows: no configured sandbox connector.
- API key secret/revoke/rate-limit checks: creating a persistent key was intentionally avoided.
- Publish/discard/restore, module disable, theme publish, and layout publish: these would alter shared organisation configuration.
- Operator onboarding and lifecycle flows: no operator-console URL or operator account was supplied.
- Offline save recovery: no existing editable record was available.

#### Recommended order of work

1. Fix UX-001 before allowing theme publishing.
2. Restore profile provisioning/access (UX-002).
3. Fix the shared dialog and validation focus primitives (UX-003 and UX-009).
4. Raise phone touch targets globally (UX-004).
5. Correct form accessibility in API keys and Layout (UX-006 and UX-007).
6. Complete localization and align More navigation with the approved information architecture.
7. Address the remaining wording, field-association, and audit-log clarity issues.

## Appendix D. UI designer handoff 2026-11-01

### UI designer handoff — OneNGO audit fixes

#### Working location

- Worktree: `C:\Users\ssarkar392\CEResources\integrated\ngo-worktrees\ui-ux-audit`
- Branch: `features/ui-ux-audit`
- App URL after starting `npm run dev`: `http://localhost:4200`
- Audit: [the UI/UX audit](#appendix-c-uiux-audit-2026-11-01)
- Evidence: [evidence/ui-ux-2026-11-01](evidence/ui-ux-2026-11-01)

Do not use the primary checkout for this work. The audit report and evidence are currently uncommitted in this worktree.

#### Product decisions already made

1. **Settings remains canonical.** Keep personal account details, language, two-step status, and About under Settings. Update older design/manual documentation that still expects these items directly in More.
2. **Account-only identity remains canonical.** Do not restore the removed member-profile APIs. Replace the broken My profile flow with account details already available from the signed-in session.

#### Design objective

Produce implementation-ready interaction and visual guidance for the audit findings, prioritizing safe administration, keyboard accessibility, touch usability, and consistent responsive behavior. Preserve the existing visual language unless a defect requires a change.

#### Priority design work

##### 1. Theme safety

Design the Theme screen so its editable values, preview, contrast results, and publish state always describe the same draft.

Acceptance criteria:

- Stored/default colours appear in both colour pickers and text inputs.
- Publish is unavailable while loading, unchanged, invalid, or saving.
- Invalid colours identify the exact field.
- Preview and contrast update from the visible draft only.
- Reset clearly distinguishes “restore published values” from “restore product defaults.”

Reference: [theme-black-controls.png](evidence/ui-ux-2026-11-01/theme-black-controls.png)

##### 2. Account details

Replace the broken My profile panel with an account-details treatment based on the current account-only backend.

Acceptance criteria:

- Name, email, roles, and two-step state are understandable without implying they are editable.
- The screen explains where an administrator-managed value can be changed.
- No empty modal or generic “Not found” state remains.
- Settings remains the entry point.

Reference: [profile-not-found.png](evidence/ui-ux-2026-11-01/profile-not-found.png)

##### 3. Shared modal and validation behavior

Define one interaction model for create, filter, import, account, language, and administration panels.

Acceptance criteria:

- Opening moves focus to the title, close control, or first field.
- Tab and Shift+Tab remain inside.
- Escape closes non-destructive panels.
- Closing restores focus to the trigger.
- Background controls cannot be reached while the modal is open.
- Failed submission focuses the first invalid field and provides an error summary for multiple failures.
- Desktop uses a centred panel; phone uses a bottom sheet up to 92% of viewport height.

##### 4. Phone touch targets and spacing

Bring all phone interactions to a minimum 44 × 44 CSS-pixel target without making the interface visually heavy.

Measured failures include account, breadcrumb expander, Back, Close, chips, Sort, Filters, and form footer buttons.

Acceptance criteria:

- Interactive boxes are at least 44 × 44; icons may remain visually smaller.
- Adjacent targets have enough separation to avoid accidental taps.
- Sticky form actions do not cover the last field.
- Bottom navigation and safe-area spacing remain intact.
- No horizontal overflow at 390 × 844.

Reference: [new-donation-mobile.png](evidence/ui-ux-2026-11-01/new-donation-mobile.png)

##### 5. Form and action clarity

Provide final copy and states for:

- Singular headings: **Create donor**, **Create donation**.
- Required Add person fields: Email, Name, and at least one Role.
- Processing fee error beside the fee field while retaining a summary.
- New API key role selector with an explicit visible/accessibility label.
- Empty record list with Select hidden or disabled.
- New connector represented by URL state, with Back/reload restoring the panel.

##### 6. Layout reordering

Keep the current Up/Down controls if desired, but make context and feedback explicit.

Acceptance criteria:

- Accessible action names include the item, e.g. **Move Records up**.
- The updated position is announced after every move.
- Disabled states explain fixed items where necessary.
- Sidebar and More groups remain visually distinct.

##### 7. Localization

Complete the Settings page identity in every supported language.

Acceptance criteria:

- Heading, breadcrumb, browser title, navigation, field labels, notices, and dialog labels switch together.
- English appears only as an intentional fallback for an unpublished organisation string.

Reference: [settings-hindi-mixed.png](evidence/ui-ux-2026-11-01/settings-hindi-mixed.png)

##### 8. Audit log readability

Replace raw event keys and UUID-heavy primary text with administrator-friendly summaries.

Acceptance criteria:

- Primary text answers who did what to which item.
- Date/time and area remain scannable.
- Raw IDs and payloads are available only under expandable technical details.
- Unknown events have a safe human-readable fallback.

#### Design constraints

- Preserve single-column record panels and forms at every width.
- Preserve desktop side navigation and phone bottom navigation.
- Preserve address-backed state for panels, tabs, filters, sort, layout, and open records.
- Do not redesign Builder editors for phone; phone remains published-settings/read-only.
- Use colour plus text/icon/status, never colour alone.
- Keep the existing system font and local assets.

#### Expected designer deliverables

1. Annotated desktop and phone states for Theme, account details, a representative modal/form, Layout, and Audit log.
2. A compact interaction specification covering modal focus, validation focus, keyboard behavior, touch targets, loading, error, empty, and saving states.
3. Final copy for singular create headings, required-role guidance, account details, theme reset/publish states, and audit summaries.
4. Any token or shared-component changes needed for implementation.
5. A list of audit findings that require no visual change and can proceed directly to engineering.

#### Engineering plan summary

After design handoff, engineering should implement in this order:

1. Theme safety, account-only Settings, and locale completeness.
2. Shared modal/form accessibility and 44 px touch targets.
3. Connector URL state, form wording/validation, targeted fee error, and empty-list actions.
4. Audit-log summaries and documentation alignment.
5. Focused tests, typecheck/build, then Playwright verification at 1440 × 1000 and 390 × 844.

## Appendix F. Execution flows

Run order for each flow, kept from the coverage-matrix tool that generated the former `test-plan.html`. The smoke set and the regression triggers are in sections 34.1 and 34.2.

### Open a new NGO

Flow `open-ngo`, journey `FT-E2E-01`. One operator session, one valid Riverbank request, then the invited administrator finishes setup and invites Finance. Use a fresh request id.

| Stage | Scenarios, in run order |
| --- | --- |
| Sign in to the console | `FT-OPC-001`, `FT-OPC-003`, `FT-OPC-014` |
| Reject bad drafts, then validate | `FT-OPC-064`, `FT-OPC-041`, `FT-OPC-042`, `FT-OPC-043`, `FT-OPC-044`, `FT-OPC-045`, `FT-OPC-046`, `FT-OPC-047`, `FT-OPC-048`, `FT-OPC-049`, `FT-OPC-050`, `FT-OPC-051`, `FT-OPC-052`, `FT-OPC-053`, `FT-OPC-054`, `FT-OPC-055`, `FT-OPC-056`, `FT-OPC-057`, `FT-OPC-058`, `FT-OPC-059`, `FT-OPC-060`, `FT-OPC-061`, `FT-OPC-062`, `FT-OPC-040`, `FT-OPC-063` |
| Provision once | `FT-OPC-070`, `FT-OPC-071`, `FT-OPC-072`, `FT-OPC-077` |
| Set the invitation password | `FT-AUTH-065`, `FT-AUTH-040`, `FT-AUTH-041`, `FT-AUTH-042`, `FT-AUTH-043`, `FT-AUTH-046`, `FT-AUTH-066` |
| Finish setup and invite Finance | `FT-NAV-001`, `FT-NAV-008`, `FT-ADM-001`, `FT-ADM-002`, `FT-ADM-003`, `FT-ADM-004`, `FT-ADM-005`, `FT-ADM-006`, `FT-ADM-020`, `FT-ADM-021`, `FT-ADM-007`, `FT-E2E-01` |

### Member sign-in

Flow `sign-in`. One member, one organisation. Password, email code, reset, and a second device. Do not lock the account; that is the next flow.

| Stage | Scenarios, in run order |
| --- | --- |
| Find the organisation | `FT-AUTH-001`, `FT-AUTH-002`, `FT-AUTH-007`, `FT-AUTH-008`, `FT-AUTH-005` |
| Password | `FT-AUTH-020`, `FT-AUTH-021`, `FT-AUTH-030` |
| Email code | `FT-AUTH-050`, `FT-AUTH-051`, `FT-AUTH-057`, `FT-AUTH-058` |
| Reset the password | `FT-AUTH-060`, `FT-AUTH-061`, `FT-AUTH-063` |
| Two devices and a deep link | `FT-AUTH-100`, `FT-AUTH-105`, `FT-NAV-011` |

### Locked sign-in

Flow `locked`. A spare member. Five wrong passwords end this password path. Clear the lock with an email code, then with a reset.

| Stage | Scenarios, in run order |
| --- | --- |
| Lock, then clear it | `FT-AUTH-022`, `FT-AUTH-023`, `FT-AUTH-024` |

### Donation to receipt

Flow `donation`, journey `FT-E2E-02`. Finance on Fundraising. Create the donor and donations, mark one paid by UPI, print the receipt, and open the public link signed out. Keep one Raised donation for the reminder and one for Cancel.

| Stage | Scenarios, in run order |
| --- | --- |
| Open the lists | `FT-REC-001`, `FT-REC-010`, `FT-REC-011`, `FT-REC-026` |
| Create the donor | `FT-DON-005`, `FT-DON-002`, `FT-DON-001`, `FT-DON-004`, `FT-DON-003`, `FT-DON-006`, `FT-DON-007`, `FT-DON-008` |
| Create the donation | `FT-REC-042`, `FT-REC-044`, `FT-DON-021`, `FT-DON-022`, `FT-DON-023`, `FT-DON-024`, `FT-DON-020`, `FT-REC-104`, `FT-DON-025` |
| Mark as paid | `FT-DON-027`, `FT-DON-029`, `FT-DON-030`, `FT-DON-026`, `FT-DON-031` |
| Receipt, posting, and public link | `FT-DON-032`, `FT-DON-034`, `FT-DON-035`, `FT-DON-037`, `FT-DON-009`, `FT-DON-038`, `FT-DON-055`, `FT-FIN-026`, `FT-FIN-027`, `FT-FIN-028`, `FT-DON-036` |
| Reminder and cancel | `FT-DON-050`, `FT-DON-051`, `FT-DON-033` |
| Viewer on the same records | `FT-DON-040`, `FT-REC-109`, `FT-E2E-02` |

### Online payment

Flow `gateway`, journey `FT-E2E-03`. One Raised donation and the Razorpay fixture. Send the bad webhooks while it is still Raised, then capture it.

| Stage | Scenarios, in run order |
| --- | --- |
| Pay now | `FT-DON-053`, `FT-DON-054` |
| Bad webhooks, still Raised | `FT-FIN-070`, `FT-FIN-071` |
| Capture, duplicate, and a failed payment | `FT-FIN-068`, `FT-FIN-069`, `FT-FIN-072`, `FT-E2E-03` |

### Approval

Flow `approval`, journey `FT-E2E-04`. A published two-approval step. The requester sends it, two approvers decide from Inbox, then the requester withdraws a second request.

| Stage | Scenarios, in run order |
| --- | --- |
| Request and decide | `FT-WF-020`, `FT-WF-021`, `FT-WF-022`, `FT-WF-023`, `FT-WF-024`, `FT-WF-025` |
| Inbox | `FT-WF-050`, `FT-WF-051`, `FT-WF-053`, `FT-WF-054`, `FT-NAV-009` |
| Withdraw | `FT-WF-030`, `FT-E2E-04` |

### Import and bulk

Flow `import`, journey `FT-E2E-05`. One donor import, then an update by PAN, then a bulk edit on the rows that landed. Jobs stay open in another administrator session.

| Stage | Scenarios, in run order |
| --- | --- |
| Import donors | `FT-REC-170`, `FT-REC-171`, `FT-REC-173`, `FT-REC-174`, `FT-REC-175`, `FT-REC-176`, `FT-REC-178`, `FT-REC-180`, `FT-REC-186`, `FT-REC-187` |
| Bulk on the imported rows | `FT-REC-220`, `FT-REC-222`, `FT-REC-223`, `FT-REC-225`, `FT-REC-226`, `FT-REC-228` |
| Jobs and a role | `FT-REC-233`, `FT-ADM-027`, `FT-E2E-05` |

### New module

Flow `module`, journey `FT-E2E-06`. One Builder draft on a wide window. Add the workflow step, check it, publish it, and confirm Home can use it.

| Stage | Scenarios, in run order |
| --- | --- |
| Draft and publish | `FT-BLD-002`, `FT-BLD-004`, `FT-BLD-005`, `FT-BLD-050`, `FT-WF-034`, `FT-BLD-006`, `FT-BLD-007`, `FT-BLD-008` |
| Members see it | `FT-HOME-003`, `FT-HOME-015`, `FT-E2E-06` |

### Year end

Flow `year-end`, journey `FT-E2E-07`. An organisation whose financial year starts in April. Pay one donation on 31 March and one on 1 April.

| Stage | Scenarios, in run order |
| --- | --- |
| Two dates, two years | `FT-FIN-020`, `FT-FIN-005`, `FT-REC-115`, `FT-E2E-07` |

### Suspend and restore

Flow `incident`, journey `FT-E2E-08`. A disposable organisation. Suspend it, confirm members and the public lookup are refused, then reactivate and sign in again.

| Stage | Scenarios, in run order |
| --- | --- |
| Suspend | `FT-OPC-080`, `FT-OPC-083`, `FT-OPC-084`, `FT-OPC-081`, `FT-OPC-082`, `FT-AUTH-004` |
| Restore | `FT-OPC-085`, `FT-OPC-086`, `FT-E2E-08` |

### Erase a member

Flow `erasure`, journey `FT-E2E-09`. One member who has donations. Erase is refused while they are active. Suspend them, erase them, and confirm the money records stay.

| Stage | Scenarios, in run order |
| --- | --- |
| Suspend, then erase | `FT-ADM-028`, `FT-PRV-004`, `FT-PRV-005`, `FT-PRV-006` |
| What remains | `FT-PRV-008`, `FT-PRV-009`, `FT-PRV-010`, `FT-E2E-09` |

### API key and webhook

Flow `integration`, journey `FT-E2E-10`. One key and one connector. Query, create with the same idempotency key, revoke the key, and receive one signed webhook.

| Stage | Scenarios, in run order |
| --- | --- |
| Key | `FT-ADM-080`, `FT-ADM-081`, `FT-REC-049`, `FT-ADM-082` |
| Webhook | `FT-RUN-023`, `FT-E2E-10` |

### Close an organisation

Flow `closure`, journey `FT-E2E-11`. A disposable organisation that is already suspended. Close it last. Closed stays closed.

| Stage | Scenarios, in run order |
| --- | --- |
| Close | `FT-OPC-087`, `FT-OPC-088`, `FT-OPC-089`, `FT-E2E-11` |

### Share a record

Flow `share`. Two people and one restricted record. Share it, change the level, and remove it in the same panel.

| Stage | Scenarios, in run order |
| --- | --- |
| One record, two people | `FT-REC-130`, `FT-REC-131`, `FT-REC-132`, `FT-REC-133`, `FT-REC-134`, `FT-REC-135`, `FT-REC-136`, `FT-REC-139` |

### Passkey sign-in

Flow `passkey`. Pending the passkey branch. One member on one device: turn the policy on, save a passkey, sign in with it, then remove it.

| Stage | Scenarios, in run order |
| --- | --- |
| Save | `FT-PK-001`, `FT-PK-002`, `FT-PK-003`, `FT-PK-004`, `FT-PK-005`, `FT-PK-006` |
| Sign in and remove | `FT-PK-007`, `FT-PK-008`, `FT-PK-012`, `FT-PK-013` |

### Shell and Home

Flow `shell`. One signed-in member. Resize the window, follow a breadcrumb, and pin a list. No second persona.

| Stage | Scenarios, in run order |
| --- | --- |
| Resize and move | `FT-NAV-002`, `FT-NAV-003`, `FT-NAV-004`, `FT-NAV-012`, `FT-NAV-015` |
| Home | `FT-HOME-002`, `FT-HOME-013` |

### Role matrix

Flow `rbac`. Roles belong to the organisation and can change. Sign a member in and note one destination, one field, and one action they can see. Turn that permission off, publish, and confirm those items are gone on the member's next request. Turn it back on, publish, and confirm they return. The published permission decides visibility. The role name does not.

| Stage | Scenarios, in run order |
| --- | --- |
| Note what the current permission shows | `FT-NAV-005`, `FT-NAV-007`, `FT-HOME-001`, `FT-HOME-007`, `FT-HOME-010`, `FT-HOME-011`, `FT-HOME-016`, `FT-AUTH-105`, `FT-ADM-001`, `FT-ADM-035`, `FT-ADM-040`, `FT-REC-004`, `FT-REC-026`, `FT-REC-109`, `FT-REC-111`, `FT-REC-112`, `FT-REC-151`, `FT-DON-040`, `FT-FIN-030`, `FT-WF-004`, `FT-WF-021`, `FT-WF-025`, `FT-WF-030` |
| The organisation changes the permission and publishes | `FT-BLD-070`, `FT-BLD-071`, `FT-BLD-072`, `FT-ADM-053`, `FT-BLD-003`, `FT-BLD-068`, `FT-BLD-069`, `FT-BLD-043` |
| The same member's next request follows the new permission | `FT-ADM-026`, `FT-AUTH-107`, `FT-ADM-027`, `FT-REC-186`, `FT-REC-202`, `FT-REC-204`, `FT-REC-229`, `FT-FIN-047`, `FT-FIN-067`, `FT-SEC-009`, `FT-ADM-081` |
| A person cannot widen their own access | `FT-ADM-034`, `FT-ADM-084`, `FT-SEC-008`, `FT-ADM-052`, `FT-ADM-031`, `FT-ADM-033`, `FT-ADM-054`, `FT-ADM-055`, `FT-ADM-056`, `FT-AUTH-028`, `FT-AUTH-088`, `FT-AUTH-103` |
| A share adds access the role does not | `FT-REC-130`, `FT-REC-131`, `FT-REC-136`, `FT-REC-137`, `FT-REC-138`, `FT-REC-232`, `FT-REC-235` |
