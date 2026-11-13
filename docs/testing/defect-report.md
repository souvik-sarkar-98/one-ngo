# OneNGO defect report: manual run of 3–4 November 2026

Defects found while running [the manual test plan](manual-test-plan.md), and the cases that were not fully tested. The plan holds each case’s result; this file holds the detail a developer needs to reproduce and fix each defect.

## Environment

| Field | Value |
| --- | --- |
| Build | `develop` at `361d226` (3 Nov) and `bf76294` (4 Nov); version 0.1.0 |
| Setup | Local `npm run dev`: app `http://localhost:4200`, API `http://localhost:8080`, integration fixture `https://127.0.0.1:8095` |
| Data | `functional-test-data.md`, organisation `riverbank` |
| Browser | Chromium through Playwright, 1366×900 and 390×844 |
| Not available | Operator console and operator accounts; scheduler tick (`TICK_SECRET` empty); an enrolled authenticator |

Severity follows section 5 of the plan: **Blocker** (wrong data exposure, money or receipts wrong), **Critical** (a P0 case fails with no safe workaround), **Major** (a P1 case fails, or a workaround exists), **Minor** (wording, layout, or a P2 case).

## Summary

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

## Defects

### DEF-17 · Blocker · A Viewer can publish a receipt with donor details

- **Cases:** MT-DON-02. **Area:** Donations, receipts.
- **Steps:** Sign in as `viewer@riverbank.example`. Open `/print/receipt/{id}` for a paid donation’s receipt. Choose **Copy public link**. Open the copied `/r/{token}` address in a browser with no session.
- **Expected:** A Viewer, whose role is read-only, cannot create a public link.
- **Actual:** The link is created (`POST /api/print/receipt/{id}/link` returns 200) and opens without sign-in, showing the donor’s name, email, and phone (PAN is hidden). The audit log records “Viewer Member receipt link created”.
- **Note:** The Viewer could also see **Revoke public link**.

### DEF-02 · Critical · `/people` is still a route

- **Cases:** MT-NAV-01. **Area:** Navigation.
- **Steps:** Sign in as Asha. Open `/people`.
- **Expected:** `/people` is not a route and goes to Home (plan wording updated on 4 Nov).
- **Actual:** It opens Administration → People.
- **Cause:** `apps/onengo/web/src/app/routes.ts` line 73, `{ path: 'people', redirectTo: 'admin/people' }`. `core/shell/shell.ts` line 338 still builds a “People directory” link to `/people` for anyone with the directory permission (not shown in this run).

### DEF-03 · Critical · Forbidden pages open Home with no message

- **Cases:** MT-NAV-03. **Area:** Navigation, permissions.
- **Steps:** Sign in as `finance@riverbank.example`. Open `/admin`, then `/builder`.
- **Expected:** Each says the person does not have access.
- **Actual:** Each silently opens Home. The bar correctly hides both. The same happens for every persona without the permission.

### DEF-05 · Critical · Role permissions change live in Administration; Builder has no Roles

- **Cases:** MT-ROL-02, MT-BLD-04, MT-BLD-05. **Area:** Roles, Builder.
- **Steps:** Administration → Roles → Viewer → Permissions.
- **Expected:** Permissions are read-only here; they change in Builder → Roles and apply after publish.
- **Actual:** 46 editable controls and a Save that “updates it straight away”. Builder has no Roles section, so there is no draft or publish step.
- **Note:** Product and plan disagree; one of them must change.

### DEF-08 · Critical · A Viewer without Print receipt can open the print page

- **Cases:** MT-DON-15. **Area:** Receipts, permissions.
- **Steps:** Sign in as Viewer. Open `/print/receipt/{id}`.
- **Expected:** Refused; the Viewer role does not include the Print receipt action.
- **Actual:** The receipt opens with Download, Print, and the public-link buttons (see DEF-17).

### DEF-09 · Critical · Pop-ups opened from inside a dialog cannot be clicked

- **Cases:** MT-PPL-07, MT-REC-20 (and blocks MT-PPL-05, MT-PPL-08). **Area:** Shared UI.
- **Steps:** Administration → People → a person → **Suspend** (from the panel or the row menu). Click **Suspend** in the confirmation. Separately: a restricted record → ⋮ → Share → **Ends on** → pick a day.
- **Expected:** The confirmation and the calendar respond.
- **Actual:** Nothing happens; a real mouse click does not register. Nobody can be suspended, and no share end date can be set.
- **Cause:** `apps/onengo/web/src/app/ui/dialog.ts`, `DialogFocus`/`inertTargets`, marks every sibling of an open dialog `inert` when it opens. A confirmation sheet or the `.cdk-overlay-container` that already exists becomes inert and stays so. Last change to the file: `d8cabff` “UX audit fix: dialog-focus” (2 Nov). Whether it happens depends on which elements exist when the dialog opens; Mark as paid’s calendar worked.

### DEF-10 · Critical · A Can edit share does not allow editing

- **Cases:** MT-REC-19. **Area:** Sharing.
- **Steps:** On a record type set to “Only their own and shared” (QA Field Check), share a record with Directory Member and with the Directory role as **Can edit**. Give the Directory role See on the type. Sign in as Directory Member and open the record.
- **Expected:** The person can edit and save.
- **Actual:** The record opens read-only with no Edit. Can view works.
- **Also:** The share panel offers people whose role cannot see the record type at all; those shares give no access and no warning.

### DEF-13 · Critical · Builder history cannot restore a version

- **Cases:** MT-BLD-02. **Area:** Builder.
- **Steps:** Publish a change to a list view. Open its History tab.
- **Expected:** An earlier published version can be restored and becomes the newest.
- **Actual:** History lists versions with no restore action. Only ⋮ → Revert to module version exists, which drops all organisation changes.

### DEF-15 · Critical · Today’s payment date is refused early in the Indian day

- **Cases:** MT-DON-08. **Area:** Donations.
- **Steps:** Between 00:00 and 05:30 India time, Mark as paid with Paid on = today.
- **Expected:** Accepted.
- **Actual:** “The payment date cannot be in the future.” Seen at 03:10 IST on 4 Nov; the same step passed at 23:58 on 3 Nov.
- **Cause (likely):** The future-date check compares with the UTC date, not the organisation’s time zone.

### DEF-01 · Major · A 9-character password shows no error

- **Cases:** MT-AUTH-04. **Area:** Invitation, reset.
- **Steps:** Open an invitation or reset link. Enter a 9-character password in both fields. Save.
- **Expected:** “Use at least 10 characters”; not saved.
- **Actual:** Not saved, but no error appears. A message from a previous attempt stays on screen.

### DEF-04 · Major · Date fields do not render in Administration

- **Cases:** MT-ADM-04, MT-AUD-01. **Area:** Administration.
- **Steps:** Administration → Registrations → Add registration. Administration → Audit log → Filters.
- **Expected:** Issue and expiry dates; a date filter.
- **Actual:** Neither renders. Console: “MatDatepicker: No provider found for DateAdapter”.
- **Cause:** `provideFieldDates()` (`ui/date-adapter.ts`) is provided only in `records/records.routes.ts`, not on the Administration routes.

### DEF-06 · Major · Messages are sent with no connector

- **Cases:** MT-CON-01, MT-DON-14. **Area:** Messaging.
- **Steps:** With no connector, run **Send reminder** on a Raised donation.
- **Expected:** Nothing is sent.
- **Actual:** The email is delivered through OneNGO’s email service. The setup checklist says the same (“Sent through OneNGO’s email service”).
- **Note:** Product and plan disagree.

### DEF-07 · Major · UPI payments cannot be recorded

- **Cases:** MT-DON-10. **Area:** Donations.
- **Steps:** Mark as paid, method UPI, paid on a past date.
- **Expected:** A reference field; empty refused, filled accepted.
- **Actual:** The form has no reference field. The server answers “Enter the UPI transaction reference.” Cheque and online are likely affected too.

### DEF-11 · Major · Organisation default language not used for invitations

- **Cases:** MT-NAV-11. **Area:** Language.
- **Steps:** Set the organisation default language to Hindi. Invite a new person. Read the email and open the link.
- **Expected:** Email, set-password page, and first session in Hindi.
- **Actual:** The first session is Hindi; the email and the set-password page are English.

### DEF-12 · Major · Offline save is not retried

- **Cases:** MT-NAV-12. **Area:** Offline.
- **Steps:** Edit a record, go offline, Save. Come back online.
- **Expected:** The save waits and completes when the connection returns.
- **Actual:** A clear offline message shows and the edit stays, but the save is not retried. “Cannot reach the server” stays; a second Save is needed.

### DEF-14 · Major · Modules page does not list a module’s definitions

- **Cases:** MT-BLD-06. **Area:** Builder.
- **Actual:** Builder → Modules shows Donations with a description and version only.

### DEF-16 · Major · Failed-rows file cannot be imported again

- **Cases:** MT-REC-26. **Area:** Import.
- **Steps:** Import a file with one bad row. Download the failed rows. Fix the reason. Import that file.
- **Expected:** The fixed row imports.
- **Actual:** “Enter a valid phone number” — the download writes phones as `'+91 …` (a leading apostrophe). Removing the apostrophe makes it import.

### DEF-18 · Major · Donation shows the donor’s raw ID

- **Cases:** MT-REC-08. **Area:** Records.
- **Actual:** A donation’s Donor field shows a UUID (e.g. `42a8eebd-…`) instead of the donor’s name or number.

### DEF-19 · Major · Receipts can be issued before setup is complete

- **Cases:** MT-ADM-03. **Area:** Receipts, setup.
- **Steps:** Before confirming identity and registrations, mark a donation paid.
- **Actual:** `RCPT/2026-27/00006` was issued and prints without the legal name, address, or registrations. After setup, receipts show them.

### DEF-30 · Major · Sign-in page shows any `?message=` text

- **Cases:** section 21 of the plan. **Area:** Sign-in, security.
- **Steps:** Open `/sign-in?message=Your account is locked. Call +91 99999 00000.`
- **Actual:** The text is shown as the page message, then removed from the address. HTML shows as plain text (no script), but a crafted link can display a convincing false warning.

### DEF-31 · Major · No way to switch on an installation sign-in provider

- **Cases:** MT-AUTH-19, MT-AUTH-20 (Blocked). **Area:** Sign-in.
- **Actual:** `GET /api/auth/providers?tenant=riverbank` returns `[]`. `saveProviderPolicy` has no caller in any route or screen, so Google sign-in cannot be enabled for an organisation.

### DEF-20 · Minor · Dates shown month first

- **Cases:** MT-DON-09. **Actual:** Picking 10 November shows `11/10/2026`. The native date adapter uses the browser’s US format, not Indian day-first.

### DEF-21 · Minor · Stale “required” message on Mark as paid

- **Cases:** MT-DON-08. **Actual:** “Payment method is required for this step” stays after a method is chosen.

### DEF-22 · Minor · Two buttons labelled Cancel

- **Cases:** MT-DON-11. **Actual:** The cancel-donation dialog has Cancel (close) and Cancel (confirm).

### DEF-23 · Minor · No confirmation after sending

- **Cases:** MT-REC-18, MT-PPL-04. **Actual:** Send reminder and Resend invitation show nothing on screen after success.

### DEF-24 · Minor · A person can be added with no role

- **Cases:** MT-PPL-03. **Actual:** Add a person with no role is accepted and invited.

### DEF-25 · Minor · Time zone and country fields

- **Cases:** MT-SET-02. **Actual:** The time zone list has `Asia/Calcutta` but not `Asia/Kolkata` and cannot be filtered by typing. The country error repeats the hint text.

### DEF-26 · Minor · Audit log wording

- **Cases:** MT-AUD-01. **Actual:** What repeats the person’s name (“Asha Menon record created…”) and shows “tenant”.

### DEF-27 · Minor · Role key shown in Settings

- **Cases:** MT-ACC-02. **Actual:** Under the name, Settings shows `admin` instead of “Administrator”.

### DEF-28 · Minor · Share search keeps the last name

- **Cases:** MT-REC-21. **Actual:** After sharing, the search box still holds the last person’s name.

### DEF-29 · Minor · Wording slips

- **Cases:** MT-CON-02 and others. **Actual:** “Not setis needed before the connector can be enabled”; “New qa field check”; “1 members”.

### DEF-32 · Minor · Rate limited while moving through Builder

- **Cases:** MT-BLD-01. **Actual:** Opening about 15 Builder sections quickly returned 429 for one administrator (the 30-per-minute `/api/auth/` limit is reached by refresh and manifest calls).

### DEF-33 · Minor · Expired invitation still shows the form

- **Cases:** MT-AUTH-03. **Actual:** An 8-day-old invitation shows the set-password form; “expired” appears only after a password is submitted.

## Not fully tested

Cases with result Blocked, Not run, or Partial, with what is needed to finish them. P0 cases are marked.

### Blocked: operator console (27 cases)

MT-OP-01 to MT-OP-16 and MT-LIFE-01 to MT-LIFE-11 (P0: OP-01, 02, 03, 05, 07, 08, 09, 10; LIFE-01, 02, 06, 07, 08, 09, 11). Also the suspended half of MT-AUTH-09 (P0).

- **Needed:** the operator console running with operator accounts. Work in progress on `features/dev-operator-console` adds `npm run dev -- --console` with two local operators. Close (MT-LIFE-08, 09) needs a throwaway organisation.

### Blocked: approvals (6 cases)

MT-REC-15 (P0), MT-REC-16 (P0), MT-IN-01 (P0), MT-IN-02 (P0), MT-IN-03, MT-IN-04.

- **Needed:** a published step that requires approval, and two approvers.

### Blocked: scheduler tick (5 cases, plus parts of 3)

MT-JOB-02, MT-CON-03, MT-IN-05, MT-IN-06; cancel in MT-REC-26; the background parts of MT-REC-25, MT-REC-27, MT-REC-29.

- **Needed:** `TICK_SECRET` set in `.env` and the server restarted, then `POST /internal/tick` with it. A 15,000-row import is left Running at 400 with cancel requested.

### Blocked: other preconditions

| Case | Needed |
| --- | --- |
| MT-AUTH-19, MT-AUTH-20 | An operator with the `sign_in` grant switching the shared provider on for the organisation in the operator console, with a step-up and a reason |
| MT-AUTH-22, MT-AUTH-23 | A member with an enrolled authenticator |
| MT-PPL-05, MT-PPL-08 | DEF-09 fixed |

### Not run

| Case | Why |
| --- | --- |
| MT-NAV-13 | Needs a new web build while a session is open |
| MT-NAV-14 | Needs a real phone’s install prompt |
| MT-ACC-01 | Recorded as “no editable profile fields”; the product has since changed, so re-run |

### Partial: remaining steps

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

### Exploratory charters

| Charter | Status |
| --- | --- |
| Permission edges | Not run |
| Two people, one record | Not run |
| Money boundaries | Partial: amount 1 with fee 0, and 99,999,999.99; fee equal to amount and year-boundary dates not run |
| Language and long text | Partial: Hindi on Home and lists, a 200-character name; Tamil, errors, receipts, and a 500-character reason not run |
| Offline and reload | Not run |
| Keyboard | Not run |

### Also not covered

- The Builder catalogue was opened kind by kind, but only the list view draft was checked against the live list.
- The Google (OIDC) sign-in happy path; only its refusals were checked, because of DEF-31.
- A connector Deny on reconnect showed no “denied” message; no plan case covers it (see plan section 22).
