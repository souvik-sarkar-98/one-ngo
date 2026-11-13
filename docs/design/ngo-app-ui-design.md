# NGO Platform — app UI design

Status: signed off, 2026-10-23; first-release additions, people, Administration, access and breadcrumb wireframes approved 2026-10-24. Shell chrome updated 2026-10-25 (static app bar, page heading, sign-out on the initials, record groups only on Home and Records). Visuals (illustrative; count badges on Home and Records are not built, see section 13):

- Step-by-step journeys, phone and desktop side by side: `.cursor/docs/design/wireframes/ngo-app-navigation-flows.html`
- Earlier whole-app overview (superseded where it differs from this document): `legacy/legacy-docs/diagrams/ngo-app-ui-layout.html`

This document is the single source for the build. Where the two HTML pages and this document disagree, this document wins.

## 1. Principles

1. **One set of controls.** Phone, tablet and desktop use exactly the same components: app bar, navigation items, chips, search box, Sort and Filters buttons, filter pills, row menu, create button, panels, form fields and buttons. Width changes only the arrangement.
2. **The address is the state.** Every screen, tab, filter, sort, scroll depth, open record and form step is in the address. Back, reload, shared links and notifications reproduce the exact screen on any device.
3. **Configuration, not code.** Lists, groups, related records, donor copying and forms come from published definitions, editable per organisation.
4. **One logic, many layouts.** List behaviour lives in the list session and record behaviour in the record session (framework-free core). Screens only draw.
5. **Nothing loaded from outside.** System fonts, the local icon font, no remote assets. The service worker caches the app itself, never record data.

## 2. Sizes and arrangement

| | Phone (below 760px) | Tablet (760–1099px) | Desktop (1100px and up) |
| --- | --- | --- | --- |
| Navigation | Bottom bar | Side rail | Side rail |
| List rows | Cards | Table, compact columns | Table, all columns |
| Cards/Table switch | Hidden (always cards) | Shown | Shown |
| Panels | Slide up from the bottom, up to 92% of the height | Centred, up to 720px wide, single column | Centred, up to 720px wide, single column |
| Create button (+) | Above the bottom bar, right | Bottom right | Bottom right |
| Builder editors | Read-only catalogue | Full | Full |

## 3. Shell and navigation

- **App bar** (all sizes): static. Hardcoded product name **NGOOne**, the organisation logo when one is available (same-origin path or an embedded image; remote addresses are not loaded), the organisation name, the inbox bell with its badge, and the account initials. The bar does not take the page name. Clicking or hovering the initials opens **Sign out**. Choosing it shows a warning that this device will be signed out and the person must sign in again, with Cancel and Sign out.
- **Page heading** in the content of every screen, left-aligned: the screen name. **Back** is on that same row, immediately left of the heading, and only off the top-level destinations (Home, Records, Inbox, More). Sign-in, reset password and the print view keep their own titles and have no app bar.
- **Four destinations**, in this order: **Home**, **Records**, **Inbox**, **More**. Same icons and labels in the bottom bar and the side rail.
- **Inbox badge** = number of approvals waiting for me. Unread notifications are counted on the Notifications chip only.
- Record types are no longer listed in the navigation; they are on Home and the Records screen.
- **Breadcrumb** (added 2026-10-24) on every route, in one line directly under the app bar:
  - **Trail:** the destination first (Home, Records, Inbox, More), with no leading "Home" in front of the other destinations (decided 2026-10-24), then:
    - record lists: the record group (from record groups; "Other" when none) and the record type's plural label; the open record's number and title when `id` is set, or "New <type>" when `create=new`; and a last item for panel modes where it means something ("Edit", a step label such as "Mark as paid", an action label, "Share", "Import", an opened file);
    - Inbox › Approvals or Notifications;
    - pages: More › <page label> (Home pages show Home);
    - More › People (directory), More › My profile, More › Language;
    - More › Administration › People, Roles, Connectors, API keys, Jobs, Audit log or Settings › <item> (for example a person, a role, a connector, "Add a person");
    - Builder › <kind> › <definition> › <tab or selection> (for example Builder › Record types › Donation › Field: Donor name).
  - **Examples:** Records › Fundraising › Donations › DON/2026-27/00040 · Ravi Kumar › Mark as paid; Inbox › Approvals; More › Administration › Roles › Finance.
  - **Links:** every item except the last links to its address; going back to a list keeps that list's own chip, search, filters and sort. The last item is plain text and marks the current page.
  - **Desktop and tablet:** the full trail.
  - **Phones:** one compact line: the first item, "…", and the last item; tapping "…" opens a small menu with the full trail; a long last item ends with an ellipsis. Back stays on the page heading, left of the title.
  - **Labels** are translated like all screen text; record titles and definition labels come from the record and the definitions.
  - **None on** sign-in, reset password and the print view (print layout).

| Destination | Address | Content |
| --- | --- | --- |
| Home | `/` | Heading "Home", then the greeting; one card per record group with its record types and quick "New …" |
| Records | `/records` | Search box (when more than eight record types), groups with collapsible headers, record types with their descriptions |
| A record list | `/records/:type?…` | See section 5 |
| Inbox | `/inbox?tab=approvals\|notifications` | See section 7 |
| More | `/more` | Account card (initials, name, email; tapping it opens **My profile**, `/more?panel=profile`, for everyone; no separate entry), pages, **Administration** (for administrators), language, two-step sign-in, Builder, About this app. Record groups are not listed here. Sign out is on the account initials, not on this screen. |
| Administration | `/admin`, `/admin/people`, `/admin/roles`, `/admin/connectors`, `/admin/api-keys`, `/admin/jobs`, `/admin/audit`, `/admin/settings` | People, who has which role, and operational settings, each with its own permission. See section 8b. `/people` is not a screen and opens Home |
| Builder | `/builder`, `/builder/:kind/:key` | Catalogue on all sizes; editors on tablet and desktop |
| Sign-in | `/sign-in`, `/reset-password` | Centred card; buttons stack full width on phones |

## 4. Record groups

- Shown on Home (one card per group) and on Records (a section header per group, collapsible, remembered per person). Not repeated on More.
- The Records screen is a **single column on every size**: groups stack one below the other, as on phones. Wide screens never place groups side by side.
- New definition kind **`recordGroup`**: `{ key, label, order?, recordTypes[] }`. One group per definition, so modules ship their own groups and organisations add or patch groups as usual. Versioned and published like every definition.
- A record type is in at most one group (the lowest `order` wins). Record types in no group are listed under **Other**, so nothing disappears by mistake.
- Record types a person cannot read are left out; groups left empty are hidden.
- The Donations module ships **Fundraising**: Donors, Donations.
- Builder: a visual "Record groups" editor (add, rename, reorder, remove groups; add or remove record types). Until it is built, the existing JSON editor works for this kind.

## 5. Record list (every record type)

Top to bottom, the same on every size:

1. **Chips** (status views from the list view, e.g. Mine · Outstanding · Closed).
2. **Toolbar:** search box, **Cards/Table** switch (tablet and desktop only), **Sort** button, **Filters** button with a count of active filters.
3. **Filter pills**, each removable, when filters are active.
4. **Rows**: cards on phones; a table on wider screens. Both show the **⋮ row menu** (Edit, then the allowed workflow steps) and highlight the record opened last.
5. **Infinite scroll**: the next page loads near the end; "Loading more…", then "End of list". A **Load more** button appears for keyboard users and people who reduce motion.
6. **Create button (+)**, shown only when the active chip allows create.

Details:

- **Sort**: the Sort button opens a menu of sortable columns; on the table, column headers do the same. Each click cycles ascending, descending, cleared; the current direction is shown with ▲ or ▼ in both places.
- **Filters**: one Filters panel with the list view's filters (choice lists, yes/no, date ranges, number ranges, text). Reset and Apply. Pills mirror what is applied.
- **Table columns**: the list view's `columns`. Tablet shows `compactColumns` when the list view sets it; otherwise the title, the first subtitle field and the status.
- **Search** runs 300 ms after typing stops.
- **Empty and error states**: "Nothing matches this view." with Clear filters; load errors show Retry in place.

## 6. Record panel (detail, edit, steps, create)

A record always opens in the record panel, on every size and in both list layouts. There is no separate record page any more.

The panel's content is a **single column on phones**: detail sections, form fields, and the create stepper stack one below the other, exactly as on phones. Wider screens centre the panel (up to 720px wide). A form may lay its fields out in **two or three columns** on wide screens, but only when its list view (create, edit) or action (form) sets `columns`; the default is one column. The fields marked "on their own row" take the whole width, and the rest fill the grid left to right in their configured order. A two-column form widens the centred panel to 880px, a three-column form to 1080px. Phones always draw one column, whatever is configured. Detail sections and workflow-step forms stay one column.

Form fields may show a **placeholder**: grey example text in an empty field (for example `ABCDE1234F`). It is set per field in the record type (or per action field) and is not stored.

- **Detail**: title = the record title; sections from the list view, collapsible:
  - field sections (label/value rows; fields hidden by `visibleWhen` are left out);
  - receipts;
  - **related sections**: records of another type that point at this one (e.g. a donor's donations), showing the latest ten, the count, and an optional total of a number or money field. Tapping one opens it in its own list.
- **Pending approval** shown at the top of the detail with Approve and Reject (Reject asks for a reason).
- **Footer actions**: allowed workflow steps (primary or secondary), then **Edit**. Step buttons are disabled while an approval is pending.
- **Edit** (`panel=edit`): number and status summary, then the list view's edit fields. Locked fields (`editableWhen`) are read-only. Cancel / Save.
- **Workflow step** (`panel=step:<key>`): the fields the step requires, then the fields the state it moves to reveals (`visibleWhen`) and lets the person fill, so a value that belongs to the new state can be entered as the step runs (e.g. a donation's payment reference). All judged against the state it moves to. Cancel / step label.
- **Create** (`create=new&createStep=<n>`): the list view's create steps as a stepper ("Step 1 of 2"), Cancel/Back and Next/Create; or a single form when there are no steps.
- **Fields** use the same Material controls everywhere: outlined text, number, email and phone inputs (with the matching phone keyboard), text areas, select, date picker, checkbox, and the **record picker** for reference fields (section 8).
- **Checks**: required fields are checked before sending; server problems appear under the field and in a notice.
- **After saving**: the panel returns to the detail view; the row updates in place; a short message appears (e.g. "Mark as paid — receipt RCPT/2026-27/00012 issued."). After create, the new record appears at the top of the list.

## 7. Inbox

- Two chips: **Approvals** (count of items waiting) and **Notifications** (count of unread). Address `/inbox?tab=…`.
- Opens on Approvals when anything is waiting, otherwise on Notifications.
- **Approvals** work like a record list:
  - **Controls:** search, Sort, Filters (Type, Step, Requested by) and pills.
  - **Rows:** cards on phones, a table on tablet and desktop.
  - **Only common workflow fields**, the same for every record type:
    - Record (number and title; opens the record);
    - Type;
    - Step;
    - Status change (from → to);
    - Requested by;
    - Waiting since;
    - Approvals (given / needed);
    - the Approve and Reject buttons.

    Record-specific fields such as an amount are seen by opening the record.
  - **Sort by:** Waiting since, Record, Type, Step, Requested by.
  - **Order:** longest waiting first.
  - **Opening a row:** shows the record panel with the request at the top, so the whole record can be checked before deciding.
  - **Reject:** opens a small panel for an optional reason (no browser prompt boxes).
  - **Decided requests** leave the list.
  - **Empty:** "Nothing is waiting for you."
  - **Address:** `/inbox?tab=approvals&type=…&step=…&sort=…`.
  - **Server:** the approvals inbox needs to return the record title, the step's from and to statuses, and the request time, and to accept search, sort, filters and paging.
- **Notifications**: newest first; unread marked New; tapping one marks it read and opens its record; read ones dimmed; **Mark all read**. Empty: "No notifications."

## 8. Donors

- New record type **Donor** in the Donations module, in the Fundraising group:
  - name (required, searchable);
  - email and phone (searchable);
  - PAN (sensitive);
  - address and city;
  - notes.
- **Donor list view**: chip All; rows show name, email and phone; table columns name, email, phone, city. The detail has a Donor section and a related **Donations** section totalling `amount`. A "New donation for <name>" action opens create with the donor already chosen.
- **Donation** gains a **Donor** reference field. Its existing donor fields (name, email, phone, PAN) gain `copyFrom` and `editableWhen: "isEmpty(record.donor)"`:
  - when a donor is chosen, their details are filled in and locked in the form, and the server copies them on save;
  - copying happens only when the chosen donor changes, so a donation keeps the details as they were;
  - with no donor chosen, details can be typed in as today (existing donations keep working unchanged).
- **Record picker** (any reference field): type to search the referenced type by its searchable fields; up to eight matches with a second line (email or phone); **New <type> "<typed text>"** creates one with the name and selects it; ✕ clears the choice.
- Permissions: Finance gets `record:donor:*`; Viewer gets `record:donor:read`. Choosing a donor requires being able to read donors.
- New field option **`copyFrom`** `{ reference, field }` on any record type: the source field must exist on the referenced type and have a compatible type.

## 8a. Builder

Screens: `.cursor/docs/design/wireframes/ngo-builder-screens.html`. The Builder uses the same controls as the rest of the app. Editors are for tablet and desktop; phones show the catalogue and published settings read-only.

- **Catalogue**:
  - chips per kind with counts, search, Sort, Filters;
  - a table showing the name, kind, key, where each definition comes from (module, organisation, or a module definition the organisation has changed), its state, and the last change;
  - **+ New** for every kind, or start from a ready-made record type (Beneficiary, Expense, Asset).
- **One editor frame** for every kind:
  - Visual, JSON, Changes and History tabs;
  - Discard draft, Check, Publish;
  - automatic draft saving.
  - **Publish** shows a plain-language summary of what changes for people, with warnings.
  - **History** restores any version as a new draft.
  - Module definitions show "Organisation vs module" changes and offer "Revert to module version".
- **Record type**:
  - general details and numbering, with a preview of the next number;
  - a reorderable fields table whose badges summarise each field's rules;
  - a **field panel** with Basics, Rules, Reference, Copy from a chosen record, Conditions and Calculated;
  - a Rules tab;
  - "Used by", which blocks removing a field while something uses it.
- **Expression editor** (new), used by every expression:
  - field and function suggestions;
  - a live check;
  - "Try it" on a real or sample record.
- **Workflow**:
  - a diagram drawn from the definition;
  - a states table;
  - a steps table with a step panel: from and to states, fields it asks for, a condition with its message, the permission, and approval (approvers, how many, only when).
- **List view**, with a live phone and desktop preview:
  - chips;
  - filters;
  - row layout;
  - table columns and tablet columns;
  - default layout and page size;
  - record panel sections, which can be fields or **related records** with a total and "New … for this record";
  - the create form (one page or steps, built by dragging fields), chips and prefill;
  - edit fields and chips.
- **Record groups** (new):
  - drag to order;
  - one group per record type;
  - an "Other" list;
  - a preview.
- **Templates**: subject and message with placeholders, a preview with a real record, and "Send a test to me".
- **Automations**:
  - trigger: created, updated, status change, or schedule (shown in plain words);
  - a condition;
  - ordered actions: set fields, run a step, create a record, notify;
  - an on/off switch.
- **Posting and receipt rules**: status, condition, date, memo, debit and credit lines, and a balance check on a sample record; series and amount for receipts.
- **Scripts** (advanced): code, order and limits; "Try it" in the sandbox; publishing needs the script permission.
- **Theme**: colour tokens and radius, a live preview, and a contrast check.
- **The Builder holds only definitions** (decided 2026-10-24). People, who has which role, and operational settings (connectors, API keys, jobs, audit log, organisation settings) are in Administration in the app (section 8b). There are no Builder screens for them (decided 2026-10-24).
- **Roles** (Builder 18; definitions only):
  - role name and two-step requirement;
  - the permission grid: per record type (see, create, edit, see sensitive, see all, share, import, export, bulk, each workflow step and record action), money and setup permissions (including "See people", `people:read`, added per role and not to every role by default), and the permission strings the organisation uses on chips, steps, actions, sections, fields, widgets and links;
  - the member count is read-only and links to Administration › Roles; there is no members tab;
  - "What can this role see?" opens the access map's role view.
- **Permissions on parts of screens** (decided 2026-10-24). There is no separate permission definition: permissions are the generated ones (`record:<type>:…`, `…:transition:<step>`, `…:action:<key>`, money, setup) plus free-text permission strings. What a role sees is decided element by element:
  - list view chips, workflow steps and record actions: their `permission` (exists);
  - create and edit: the record type's create and update permissions (exist);
  - **record panel sections** (list view): a `permission`; the section is hidden without it (new);
  - **fields**: `readPermission` ("Who can see"; "Sensitive" is the same as `record:<type>:sensitive`), and `editPermission` ("Who can change"; read-only without it) (new). A field a person may not read shows the same mask as sensitive fields, `***` with no partial characters, and that person cannot filter, sort or sum by it (decided 2026-10-24);
  - list toolbar functions: Import, Export, Select and bulk, Share follow their record type permissions (exist);
  - **page widgets and link items**: a `permission`, in addition to the page audience (new);
  - app areas: each Administration area (its own permission), Builder (`config:read`, `config:publish`), money screens. `people:read` does not add a screen.
  - Wherever a permission is entered, the Builder offers an **autocomplete** of known permissions (generated ones plus every permission string already used, with where it is used), still allowing a new one.
- **Access map** (Builder 24–25; new): one read-mostly screen listing every element above with the permission it requires and the roles that hold it:
  - filters by area, record type and role, and "Only problems";
  - warnings for permissions no role holds;
  - inline changes for the overridable ones (fields, sections, chips, steps, actions, widgets and links) with the permission autocomplete, saved as drafts of each owning definition and published together (decided 2026-10-24);
  - a role view, "What can Viewer see?", with a plain-language summary and a live preview of the list and record panel as that role sees them.
- **Accounts** (there is no person profile record):
  - an account is a member. Adding a person does not create a `person` record. Name, email and roles belong to the account and are changed in Administration › People;
  - the directory lists active accounts: name, email and roles.
  - **My profile** (Settings, everyone), the account card:
    - shows the name, email and organisation;
    - name and email are changed by an administrator.
  - **Suspending:**
    - signs the person out everywhere;
    - the account stays, and the name stays on records, approvals and the audit log;
    - they leave the directory; administrators still see them under the Suspended chip;
    - people are suspended, never deleted.
  - **Person field type** (`person`), for any record type, for example "Case worker", "Visited by" or "Fundraiser":
    - chosen with the record picker, which searches active people;
    - stored as the person's user id and shown as their name;
    - lists can filter by it, including "Assigned to me";
    - notifications can go to "the person in field X".
- **Modules**: turn on or off, and review updates against the organisation's own changes.

## 8b. Administration (app; added 2026-10-24)

Wireframes: app Journeys 21 (People directory and Administration) and 23 (operational settings).

- **Where:** `/admin`, from More ("Administration"), on every size, with the same list controls and panels as records. Shown only to people with at least one administration permission; each area inside is shown only with its own permission.
- **People** (`/admin/people`, "Manage people", `members:manage`): the only people list. `/people` is not a screen and opens Home.
  - status chips Active, Invited (added, never signed in), Suspended and All; the two-step state; the create button, the row ⋮ and selection;
  - **Add a person** (`?add`): email, name, roles, and "Send the invitation email now";
  - **a person** (`?person=<id>`): roles, sign-in and invitation state, Resend invitation, Suspend (confirmed in the panel), Reactivate.
- **Roles** (`/admin/roles`, "Manage people" or "Manage roles"): membership only:
  - every role with its member count; a role (`/admin/roles/<key>`) lists its members with Remove, and the create button adds people (`?add`);
  - the same assignment is possible from a person's panel;
  - removing the last person who can manage roles is refused;
  - what a role allows is not shown or changed here: "What this role allows" opens Builder 18.
- **Connectors** (`/admin/connectors`, `admin:connectors`): SMS, WhatsApp and webhooks; what uses each; settings with secrets shown only as set or not set; Test; the delivery log with Retry now.
- **API keys** (`/admin/api-keys`, `admin:api-keys`): list with role and last use, create (name, role) with the secret shown once, revoke, link to the API documentation.
- **Background jobs** (`/admin/jobs`, `admin:jobs`): everyone's imports, bulk operations and rebuilds with progress, failed items and Cancel. People always see their own jobs from their notifications.
- **Audit log** (`/admin/audit`, `admin:audit`): read-only, who changed what and when, with filters by person (including API keys), area, record type and date.
- **Organisation settings** (`/admin/settings`, `admin:settings`): name, default language, storage use against the quota and the quota, API requests per minute per key.
- The permission names `admin:audit` (audit log) and `admin:settings` (organisation settings) are final (decided 2026-10-24).
- **Suspending** follows section 8a (Accounts, My profile, Suspending).

## 9. Address contract

| Parameter | Screen | Meaning |
| --- | --- | --- |
| `view=cards\|table` | Record list | Layout on tablet and desktop; ignored on phones |
| `chip`, `q` | Record list | Chip and search |
| `<field>=a,b`, `<field>=true\|false`, `<field>From` / `<field>To`, `<field>=text` | Record list | Filters |
| `sort=field` / `sort=-field` | Record list | Sort |
| `show=n` | Record list | Rows loaded (page multiples, at most 500) |
| `filters=open` | Record list | Filters panel open |
| `id`, `panel=edit\|step:<key>` | Record list | Record panel and its mode |
| `create=new`, `createStep=n`, preset parameters (e.g. `donor`) | Record list | Create panel |
| `tab=approvals\|notifications` | Inbox | Inbox tab |
| `status`, `role`, `q`, `sort`, filter parameters, `person`, `add` | Administration › People (`/admin/people`) | Status chip, filters, search, sort, the open person, the Add a person panel |
| `/admin/roles/:key`, `add` | Administration › Roles | The open role, the Add people panel |
| `/admin/connectors/:key`, `status`, `job`, filter parameters | Administration › Connectors, Background jobs, Audit log | The open connector, job status chip, the open job, filters |
| `panel=profile\|language` | More | My profile panel, language panel |

History: changing chip, search, filters, sort, depth or layout replaces the current entry and returns to the first page; opening or closing a record or create, changing panel mode or create step, and switching Inbox tab add one, so Back steps back through them. `/records/:type/:id` and `/records/:type/new` redirect into this pattern.

Breadcrumb: derived entirely from the address and the definitions, with no parameters of its own; reloading or sharing a link reproduces the same trail.

## 10. Installable and store app

- **Installable web app (now)**:
  - manifest with name, icons and brand colour, opening in its own window;
  - a service worker caching the app shell only;
  - an offline banner showing the last loaded list, with changes blocked;
  - a "A new version is ready — Reload" message;
  - safe-area padding.
- **Known bug — installed icon (2026-11-03).** The installed shortcut should use the organisation logo when one is set, and the shared heart when it is not. On Windows, Chrome still draws a letter (the first letter of the organisation name) on the shortcut and the taskbar. The icon file itself is a square PNG of the logo, served as `image/png` with a cacheable response, and a changed icon address still does not replace the letter after the app is removed and installed again. The app name and the sign-in page it opens are unaffected. A WebP logo is not drawn into that square and falls back to the heart.
- **Store apps (later, Capacitor)**:
  - the same build;
  - a configurable API address and mobile sign-in with the token in secure storage;
  - hardware Back mapped to the address history;
  - push notifications opening the right screen;
  - camera and share sheet.
- **Offline capture (later)**: saves queued on the device and sent when online.

## 11. Accessibility and touch

- Touch targets at least 44px on touch screens.
- Visible focus everywhere; Enter opens a focused row.
- Panels trap focus and return it to the row on close.
- Reduced motion turns off slide animations and shows Load more.
- Colour is never the only signal; status badges carry text.
- The breadcrumb is a navigation landmark labelled "Breadcrumb"; its last item carries `aria-current="page"`; the phone "…" button has an accessible name ("Show the full trail") and its menu is reachable by keyboard.

## 12. What goes away

- **Table layout's own controls**: its toolbar, status tabs and inline filter card. It now uses the shared controls.
- **Record page**: the full-page record form; records always open in the record panel.
- **Old navigation**: record types listed in the side navigation, and the top bar's Inbox link and Sign out button. Record types move to Home and Records. Sign out moves to the account initials, with a confirmation.
- **Inbox**: the desktop approvals table and the browser prompt box for reject reasons.

## 13. Decisions (signed off 2026-10-23)

1. **No record counts** on Home or the Records screen: record types are listed by name only. The count badges in the HTML mockups are not built.
2. **`compactColumns`** is added to the list view as an optional setting for tablet tables. Without it, tablets show the title, the first subtitle field, and the status.
3. **Existing donations** are not linked to donors automatically. A tool that suggests matches by email or phone may come later.
4. **Record groups** get a visual editor in the Builder in this build.
5. **Record panel is one column on phones, and up to three columns on the web only where a form's list view or action asks for them** (section 6).
6. **Records screen is single column on the web too**: groups stack, never side by side (section 4).

## 13a. First release additions (2026-10-23)

Everything below ships in the first release. The architecture is in `.cursor/docs/architecture/ngo-platform-architecture.md` §5.6, §6.2 and §6.7–6.10 (server) and §10.6–10.8 (web app). Wireframes for the new screens are still to be drawn.

1. **Fast lists without migrations**: indexes for references, unique fields, and filtered or sorted fields are created automatically when definitions are published. Search is fast on large lists.
2. **Languages**: English, Hindi, Tamil, Telugu, Bengali and Marathi for all screen text. Organisations can translate their own labels and messages in the Builder (Translations grid). Each person chooses a language in More.
3. **Record actions**: organisations add buttons to the record panel and the row menu, for example Send reminder, Pay now and Print receipt. An action can ask for a few fields first, and runs steps such as setting fields, running a workflow step, notifying people, calling a webhook, creating a payment, or opening the receipt print view.
4. **Pages and pinned views**:
   - **Home** is a configurable page with counts, totals, charts, pinned lists, links and the record groups.
   - **Extra pages** appear in More.
   - **Pinning:** anyone can pin a list to their Home from the list's ⋮ menu, and administrators can pin it for everyone.
   - **Counts:** the record-type lists on Home and Records still show no counts; counts appear only in configured widgets.
5. **Visual editors for everything**: every kind of setting gets a visual editor generated from its rules, including new kinds. Hand-built editors remain for record types, workflows, list views, pages and translations.
6. **Connectors**: SMS, WhatsApp and outgoing webhooks, configured and switched on per organisation in Administration (section 8b), with a test button and a delivery log. Nothing is sent unless configured.
7. **Field options**:
   - **unique values**, for example one donor per PAN;
   - **format rules** with a message;
   - **multiple choice**;
   - **totals kept on a record**, for example a donor's total given and number of donations.

8. **Public API and import/export**:
   - **API keys** per organisation, each acting with a chosen role, created and revoked in Administration (section 8b).
   - **Documentation** for the API is generated from the organisation's own setup.
   - **CSV import** from any record list: upload, match columns to fields, check every row before anything is saved, run, then see what failed and download it.
   - **Create or update:** an import can update existing records that match a unique field.
   - **CSV export** of the current list or the selected rows.
9. **Attachments**: a file field for photos, PDFs, documents and spreadsheets.
   - **Adding files:** choose, drag and drop, or take a photo on a phone.
   - **Viewing:** images and PDFs preview in the record panel.
   - **Storage:** files are stored outside the database, with a storage limit per organisation.
10. **Record sharing**: a record type can be set to "only their own and shared".
    - **What people see:** their own records, records shared with them or their role, and everything only if allowed.
    - **Sharing:** from the record panel, with read or edit access and an optional end date.
    - **List chip:** a "Shared with me" chip appears automatically.
11. **Bulk actions**: select rows (checkboxes in the table, long-press or Select on cards), or "all that match". Then, from the bulk bar:
    - run a workflow step or a bulk action;
    - set fields;
    - share;
    - export.

    Large runs continue in the background with progress and a notification when done.

12. **New field types**:
    - **Location**: "Use my location" or typed coordinates, with a label. Lists can filter by "within X km". There are no maps inside the app; an optional "Open in maps" link is shown.
    - **Signature**: sign with a finger, mouse or pen. It records who signed and when, and appears on the print view.
    - **Rich text**: bold, italic, lists, headings, quotes and links. Text is cleaned of anything unsafe.
13. **More than one workflow per record type**:
    - **Alternatives:** records can follow one of several workflows, chosen when they are created (for example by programme).
    - **Parallel:** a record can run a second workflow at the same time (for example case closure beside intake).
    - **Record panel:** shows each workflow's state, with its steps grouped by workflow.
14. **People and profiles (added 2026-10-24)**:
    - **Administration** in the app at `/admin`, from More, for administrators: People (adding, invitations, roles, suspending), Roles (who has which role), connectors, API keys, background jobs, the audit log and organisation settings. The Builder keeps only definitions. People are not a destination in the bar or in More.
    - **Fine-grained visibility:** besides chips, steps and actions, record panel sections, fields ("Who can see", "Who can change"), page widgets and links can each require a permission; the Builder's access map shows what each part requires and which roles hold it.
    - **Profiles:** one profile per person (record type `person`), with fields the organisation adds; each field can be "changeable by the person" and "shown in the directory".
    - **My profile** for everyone, opened from their name at the top of More, changing only the fields they are allowed to.
    - **Person fields** on any record type (for example "Case worker"), with "Assigned to me" filters and notifications to that person.
    - Details in sections 8a (Builder: roles, permissions on parts of screens, access map, profile fields) and 8b (Administration).

The four navigation destinations (Home, Records, Inbox, More) stay as designed.

## 14. Build order (after sign-off)

Superseded by the twelve phases in the architecture document (§7), which include the first-release additions. The list below is kept for history.

1. **Backend**: the `recordGroup` kind, `copyFrom`, related sections, and the Donor definitions and permissions, with tests.
2. **Shell**: the app bar, bottom bar and side rail, and the Records, Home and More screens with groups.
3. **One records screen**: the shared controls and record panel on every size; the table becomes rows only; the record page is removed (with approval for the deletions).
4. **Inbox**: the Approvals and Notifications tabs, the approval cards, and the reject panel.
5. **Record picker**: the donor picker, "New donor", and the related Donations section.
6. **Installable web app.**
7. **Finish**: full tests, architecture doc update, local commit.
