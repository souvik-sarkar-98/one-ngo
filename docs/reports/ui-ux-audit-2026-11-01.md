# OneNGO UI/UX audit

Date: 2026-11-01  
Environment: local, `http://localhost:4200`  
Organisation: `demo` (Demo Foundation)  
Account: Demo Admin  
Version: 0.1.0  
Browser: Chromium through Playwright  
Measured viewports: 1440 × 1000 and 390 × 844

## Outcome

Release recommendation: do not treat the current UI as release-ready.

The highest-risk defect is the Theme screen: every editable colour control loads as black and every adjacent text value is empty, while the preview and contrast results use a different, valid theme. **Publish theme** remains enabled. My profile is also unusable for the supplied administrator because it returns **Not found**.

The responsive layouts otherwise switch correctly between desktop side navigation/table layouts and phone bottom navigation/card layouts. The tested phone form had no horizontal overflow, and the compact breadcrumb exposed its full trail with an accessible label.

## Coverage

The following surfaces were opened and inspected:

- General and organisation sign-in, password, email-code, reset-password entry, and sign-out confirmation.
- Home, Records catalogue, Donors, Donations, Inbox Approvals, Inbox Notifications, More, Settings, language, My profile, and People directory.
- Administration home, People, Add a person, Roles, role membership, Connectors, New connector, API keys, New API key, Background jobs, Audit log, Organisation information, Theme, and Layout.
- Builder catalogue, Donation record-type editor, Roles, Access map, and Modules.
- Record-list search, chips, sort, filters, layout switch, list actions, import entry, create forms, multi-step validation, mobile breadcrumb, and phone Builder read-only mode.
- Desktop and phone responsive states, keyboard focus after dialogs and validation, touch-target dimensions, browser console, and failed network requests.

The test did not publish configuration, create API keys, disable modules, send mail, or permanently create, edit, suspend, or delete business data.

## Defects

### UX-001 — Theme editor loads false black/empty values while Publish is enabled

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

### UX-002 — My profile is unavailable to the supplied administrator

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

### UX-003 — Dialogs do not receive or trap keyboard focus

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

### UX-004 — Phone controls miss the documented 44 px touch target

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

### UX-005 — Hindi mode leaves the page identity in English

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

### UX-006 — New API key role selector has no accessible name

Severity: Major  
Area: Administration → API keys → New API key

Actual:

The role combobox is exposed without an accessible name even though **Acts as role \*** is visually present.

Impact:

A screen reader announces an unidentified combobox on a security-sensitive form.

Recommendation:

Associate the visible label with the native/select trigger through `for`/`id`, `aria-labelledby`, or the framework form-field API. Add an accessibility assertion for every labelled form control.

### UX-007 — Layout reorder buttons do not identify their item

Severity: Major  
Area: Administration → Layout

Actual:

The screen exposes repeated buttons named only **Up**, **Down**, **Move to More**, and **Move to sidebar**. A screen-reader user cannot tell whether an action applies to Home, Records, Inbox, Builder, Settings, Donations, Donors, People, or Administration.

Recommendation:

Name each action with its item, for example **Move Records up** and **Move Donations to sidebar**. Announce the new order after an action and support keyboard reordering.

### UX-008 — New connector state is absent from the URL

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

### UX-009 — Validation leaves focus on the submit button

Severity: Major  
Area: Donor, Donation, and Add a person forms

Actual:

After submitting an incomplete form, errors appear next to fields but focus remains on **Create**, **Next**, or **Add and invite**. The same behavior occurred for required donor name and malformed PAN.

Impact:

Keyboard and screen-reader users must search the panel for the error. Long, scrollable phone forms make this especially difficult.

Recommendation:

Focus the first invalid field, connect its error with `aria-describedby`, set `aria-invalid`, and provide a focused error summary when more than one field fails.

Evidence: [new-donor-validation.png](evidence/ui-ux-2026-11-01/new-donor-validation.png)

### UX-010 — Create dialogs use plural object names

Severity: Minor  
Area: Donors and Donations

Actual:

The headings are **Create Donors** and **Create Donations** while each form creates one record.

Recommendation:

Use the record type's singular label: **Create donor** and **Create donation**.

### UX-011 — Add a person hides required status until submission

Severity: Minor  
Area: Administration → People → Add a person

Actual:

Email and Name show no required marker initially, although empty submission reports both as required. The role requirement is also not explained before submission.

Recommendation:

Mark required fields consistently before interaction and state that at least one role is required.

### UX-012 — Excessive processing fee error is not attached to the fee field

Severity: Minor  
Area: New donation, step 2

Steps:

1. Enter amount 1000 and processing fee 1001.
2. Choose Create.

Actual:

The correct message appears only as a panel-level alert: **The processing fee cannot be more than the donation.**

Recommendation:

Keep the summary alert, but also associate the message with Processing fee and focus that field.

### UX-013 — Audit log exposes implementation language and UUIDs

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

### UX-014 — Select remains available on an empty record list

Severity: Minor  
Area: Donors list → More actions

Actual:

**Select** is enabled while the list says **Nothing matches this view.**

Recommendation:

Disable or hide selection when no rows are available, and explain why if the command remains visible.

### UX-015 — More navigation does not match the approved information architecture

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

## Visual and spacing observations

- Desktop Settings and More place a short list in a wide content region and leave most of the viewport empty. This is not a blocker, but grouping personal preferences directly in More would use the space more purposefully and remove one navigation level.
- Desktop forms and record panels correctly remain single-column instead of stretching fields across the viewport.
- Phone create sheets use the full width with no horizontal overflow. The measured New donation sheet was 390 px wide and about 617 px high in an 844 px viewport.
- Labels, field spacing, and section spacing were generally consistent. The most visible wording inconsistency was plural create headings.

## Verified strengths

- Password inputs use the correct password type and autocomplete attributes.
- Sign-out has a clear confirmation and safe Cancel action.
- Record search, sort, filter, chip, and panel state generally appears in the URL.
- Desktop shows table/card controls; phone correctly hides the layout switch and uses cards.
- Phone breadcrumbs compact to Records › … › Donations and expose **Show the full trail**.
- Required donor and donation validation messages are specific and easy to understand.
- PAN and processing-fee rules produced clear domain-specific messages.
- Builder is read-only on phone and explains that editing requires a tablet or computer.
- The tested phone form had no horizontal overflow.

## Blocked or intentionally not run

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

## Recommended order of work

1. Fix UX-001 before allowing theme publishing.
2. Restore profile provisioning/access (UX-002).
3. Fix the shared dialog and validation focus primitives (UX-003 and UX-009).
4. Raise phone touch targets globally (UX-004).
5. Correct form accessibility in API keys and Layout (UX-006 and UX-007).
6. Complete localization and align More navigation with the approved information architecture.
7. Address the remaining wording, field-association, and audit-log clarity issues.
