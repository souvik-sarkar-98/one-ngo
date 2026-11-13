# Release 2 — Organisation onboarding, lifecycle and configuration portability

Status: planned, 2026-10-24.

Release 2 introduces the fixed product brand **OneNGO**, an operator-assisted way to onboard, configure, activate, suspend and reactivate an NGO, and portable configuration packages for moving a validated setup between NGOs. The onboarded NGO keeps its own identity throughout the application and on its documents. It builds on the Kysely typed-persistence foundation from Release 1 Phase 1.

This release deliberately does not include anonymous self-registration, subscription billing or a public platform-operator web console. An authorised OneNGO operator provisions an approved NGO through a local/deployment command. The NGO's primary administrator then completes setup inside the tenant application. This keeps cross-tenant administration out of the tenant-facing product until a separately secured control plane is designed.

## Order at a glance

`Release 1 validated → Phase 1: R2-B01 onboarding and lifecycle → Active organisation → Phase 2: R2-B02 export, inspect, import as staged changes, review and apply configuration`

## Release 2 decisions

1. **OneNGO is product identity, not tenant data.** It is a fixed application constant and cannot be changed by an NGO administrator.
2. **`tenant.name` is the NGO display name.** Add a separate legal name; do not overload one field with both meanings.
3. **An NGO may have several registrations.** Registration details are rows, not one registration-number column.
4. **The logo is a managed tenant asset.** Keep the binary in the existing file store and a durable tenant-asset reference in the database. It must not be treated as an unlinked upload by cleanup.
5. **Provisioning is operator-assisted and idempotent.** Re-running the same approved request resumes or returns the same organisation; it never creates a duplicate tenant.
6. **No initial password is shared.** The primary administrator receives the existing single-use, seven-day set-password invitation.
7. **Activation is explicit.** An organisation is not available for normal sign-in while provisioning has failed or required setup is incomplete.
8. **Issued legal documents keep issuer snapshots.** A later change to an NGO's name, address, logo or registration must not rewrite an old receipt.
9. **Tenant isolation remains mandatory.** Tenant runtime APIs cannot list, create or mutate other NGOs.
10. **Organisation-specific links are the Release 2 sign-in path.** Each NGO has `/o/<organisation-code>/sign-in`; the page resolves the active NGO, shows OneNGO with its display name and logo, and asks only for the person's credentials. Verified email-first organisation discovery is deferred.
11. **Configuration moves as a reviewed package, not as tenant data.** Export contains portable published configuration and no operational records, people, credentials or secrets. Import validates and stages a change set; it never changes published behaviour until an authorised administrator reviews and applies it.

## Carried over from Release 1

Added 2026-10-24 from the Release 1 validation (`.cursor/docs/reports/release-validation-2026-10-24.md`). These are not yet scheduled into a block; place each one when its block is planned.

### Follow-up work

1. **Bulk Share uses a panel built for a selection.** The bulk bar's Share currently has its own small panel where the role is typed as a key, because the record panel's share panel lists one record's existing shares and does not fit a selection. Build a selection share panel on the same shared pieces (person or role chosen with the autocomplete, Can view or Can edit, optional end date), with no list of existing shares, and replace the bulk bar's panel with it.
2. **The Builder role view uses the shared live preview.** The access map's "What can this role see?" draws with its own `ui/role-preview`; the list view editor's `ui/live-preview` is the shared control. Move the role view onto `ui/live-preview` (it already supports previewing as a role through `listPreview({ …, permissions })`), then retire `ui/role-preview`.
3. **Business documents for the NGO Platform.** None exists yet; the workspace rule expects one per capability under `ngo-platform/docs/business/<domain>/<entity>/business-document.html`, reconciled against the server and the web app. Capabilities that need one: record types, fields and field options (location, signature, rich text, file, person); workflows (several per record type) and approvals; record lists, record panel and record groups; record actions and the receipt print view; Home, pages and pins; translations and languages; connectors (SMS, WhatsApp, webhooks); import and export; files; record sharing and restricted visibility; bulk operations; people directory, profiles and My profile; roles, fine-grained permissions and the access map; API keys and the public API; background jobs; audit log and organisation settings; the Builder (drafts, publish, history, modules); the installable app; donors and fundraising (Donations module 0.2.x). Release 2's own capabilities (onboarding and lifecycle, configuration package export and import) get theirs as they are built.

### Open product questions

Decide these before the block that touches them is implemented.

1. **Can a person field hold an invited member?** The person picker offers only active members (signed in at least once, not suspended), as the architecture defines "active". Saving a person field still accepts an invited member who has never signed in, so imports and direct API calls can assign work to them. Should saving refuse invited members too? Refusing is consistent with the picker but stops an administrator from assigning work to someone they have just invited.
2. **Should a record action's payment link open a page in the app?** After an action, the server may send the app to `/payments/<id>`. The app has no payment page, so the record panel shows the server's message and does not follow the link. Should Release 2 add a payment page (status, amount, the UPI or payment link, and its record), or should the server stop returning that link?

## Common rules

- Work in `ngo-platform/` and follow the architecture and code rules in `.cursor/docs/plans/ngo-release-1-build-blocks.md`.
- Use the Release 1 B00 Kysely path for fixed-table application queries while retaining parameterised SQL in the explicitly excluded paths.
- Use migrations and the existing `Database` tenant/system transaction boundaries. Every tenant-owned table has row-level security and `app_runtime` grants consistent with the existing migrations.
- Do not expose `provisionTenant()` as a public endpoint.
- Do not accept a password in the onboarding input, logs or command history.
- Do not make the product brand translatable or tenant-editable.
- No remote logo fallback or other remotely loaded branding asset.
- Every state transition and operator action is audited.
- New behaviour requires service, API/command and isolation tests.
- Done means `npx tsc --noEmit`, `npx vitest run`, and `npm --prefix web run build` pass.

---

## Phase 1 — Organisation onboarding and lifecycle

### R2-B01 Organisation onboarding and lifecycle

- **Depends on:** Release 1 B00 (Kysely typed persistence), B15 (files), B20b (people and administration), B24 (translations), B25 (shell), B34b (organisation settings), and B45 (finished release).
- **Delivers:** OneNGO product branding; structured NGO identity; idempotent operator-assisted provisioning; primary-administrator invitation; organisation-specific sign-in links; setup readiness; activation, suspension and reactivation; immutable issuer identity on receipts.
- **Checkpoints:** O1–O11 below.

#### Checkpoints

- **O1 Product identity:** Sign-in, shell, About metadata and browser titles use the fixed name OneNGO. The active NGO display name remains visible in the shell. Browser titles use `<screen or NGO> | OneNGO`.
- **O2 Organisation identity:** Legal name, display name, contact details, structured address and multiple registrations are stored and validated separately.
- **O3 Organisation assets:** An NGO logo is stored through `FileStore`, linked as a tenant asset, protected by tenant isolation and excluded from unlinked-file cleanup.
- **O4 Provisioning:** One approved input creates exactly one tenant, profile and initial configuration. The operation is idempotent and records progress so interrupted provisioning can resume.
- **O5 Defaults:** Selected shipped modules are enabled through the normal module service. Their roles, accounts and receipt series are installed through existing module setup. The requested fiscal year is opened.
- **O6 Primary administrator:** The account is created or reused, added only to the new tenant, given the administrator role and sent a single-use invitation after the tenant transaction commits.
- **O7 Readiness and activation:** Required setup has explicit readiness checks. Normal sign-in is refused until the tenant is active.
- **O8 Lifecycle:** An authorised operator can inspect status, retry failed provisioning, suspend and reactivate an organisation without deleting its data.
- **O9 Audit and isolation:** Operator actions, provisioning steps and lifecycle changes are auditable. Tenant actors cannot invoke them or discover another NGO's data.
- **O10 Legal document history:** Each issued receipt retains the issuer identity that applied when it was issued.
- **O11 Organisation-specific sign-in:** `/o/<organisation-code>/sign-in` resolves only active NGOs, shows OneNGO with the NGO display name and same-origin logo, loads that NGO's sign-in providers and removes organisation-code entry from the normal form. Invitations use this route, the last successful NGO is remembered, and generic sign-in retains an explicit organisation-code fallback.

#### Data model

Extend `tenant`:

- keep `name` as the display name;
- add `legal_name`;
- expand lifecycle status to `provisioning`, `active`, `provisioning_failed`, `suspended` and `closed`;
- retain `key` as the immutable organisation code used in sign-in links and the fallback organisation-code form;
- keep deployment region as operator-owned data.

Add `organisation_profile`, one row per tenant:

- `tenant_id`;
- primary email and phone;
- website;
- structured postal address;
- country and timezone;
- setup completion metadata.

Add `organisation_registration`, zero or more rows per tenant:

- stable id and `tenant_id`;
- registration type and number;
- issuing authority;
- issue date and optional expiry date;
- optional notes;
- uniqueness within the tenant for type and number.

Add `tenant_asset`:

- `tenant_id`;
- asset kind, initially `logo`;
- `file_id`;
- update metadata;
- one active asset per tenant and kind.

Update file cleanup so a file referenced by `tenant_asset` is linked. Logo downloads use a same-origin authenticated file route and verify the requesting tenant.

Add an operator-owned `organisation_onboarding` record outside tenant runtime access:

- immutable request/idempotency key;
- submitted onboarding input with sensitive values minimised;
- state and current provisioning step;
- nullable created tenant id;
- failure code and safe failure message;
- timestamps and operator identity.

Do not give `app_runtime` access to onboarding records. Provisioning reads and writes them only through a system transaction.

Add a platform audit stream, or an equivalent owner-only audit table, for onboarding and lifecycle actions. Do not place pre-tenant activity in a tenant audit table.

#### Onboarding input

Validate one JSON document before any write:

- immutable requested organisation code;
- display and legal names;
- registration rows;
- primary contact and postal address;
- country, timezone, default language and hosting region;
- primary administrator name and email;
- initial modules;
- fiscal-year start/current fiscal year;
- optional receipt prefix;
- request/idempotency key.

Reject unknown module keys, invalid locales, invalid registration rows, duplicate organisation codes and unsafe receipt prefixes before provisioning begins. Return field-addressed validation errors suitable for a future operator UI.

#### Provisioning orchestration

Create an `OrganisationOnboardingService` as the only application service allowed to coordinate tenant creation. The operator command calls this service; it must not duplicate provisioning SQL.

The service performs these resumable steps:

1. Lock or create the onboarding request by idempotency key.
2. Reserve and create the tenant in `provisioning` state.
3. Save profile and registration data.
4. Create the standard Organisation Administrator role with the permissions required to finish setup.
5. Enable each selected shipped module through `DefinitionService.enableModule()`.
6. Apply requested receipt prefix overrides through supported configuration, without editing shipped files.
7. Open the requested fiscal year.
8. Create or reuse the global user, add tenant membership and assign the administrator role.
9. Run readiness checks.
10. Mark the tenant active.
11. After commit, create and send the existing primary-administrator invitation with the organisation-specific OneNGO link. A delivery failure is recorded and retryable; it does not create another tenant or administrator.

Database-only steps should commit atomically where practical. For work that cannot share one transaction, persist the completed step and make the next run resume safely. A failure records a safe error and leaves the tenant unavailable to normal sign-in.

#### Operator command

Add a command such as:

```text
npm run organisation:onboard -- --input <local-json-file>
```

The command:

- requires an explicitly configured operator identity;
- reads sensitive input from a file rather than command-line values;
- supports validation-only mode;
- prints the organisation id, code, status and completed step;
- never prints passwords, invitation tokens, connector secrets or full sensitive registration payloads;
- exits non-zero on validation or provisioning failure;
- can safely be rerun with the same idempotency key;
- supports status and retry operations.

Add separate explicit commands for suspend and reactivate. Closing an organisation is a state transition with retention checks, not deletion.

#### Tenant administrator setup

Extend Organisation settings with:

- display and legal names;
- primary contact and address;
- registrations;
- logo upload, replace and remove;
- default language and timezone;
- fiscal-year and receipt identity summary.

Fields owned by the platform, including organisation code, hosting region, lifecycle status and product brand, are read-only or absent from tenant settings.

Add a setup checklist visible to the primary administrator until complete:

- organisation identity confirmed;
- required registration details present;
- current fiscal year open;
- receipt series reviewed;
- at least one operational role has a member;
- outbound email status shown;
- payment setup optional unless an enabled module requires it.

The checklist is advisory after activation except for conditions that make legal issuance unsafe. Server rules remain authoritative.

#### Organisation-specific sign-in

The wireframe is `.cursor/docs/design/wireframes/release-2-sign-in-wireframe.html`.

The canonical sign-in address is:

```text
/o/<organisation-code>/sign-in
```

For example, `/o/helpinghands/sign-in` resolves the immutable tenant key `helpinghands`. The route is organisation context, not proof of identity: organisation codes and sign-in links are not secrets.

The route:

- normalises the organisation code and resolves only a tenant whose lifecycle status is `active`;
- loads a minimal public sign-in identity: organisation code, display name and same-origin logo only;
- displays OneNGO and the NGO display name, with the logo when configured;
- asks for email and password, email code or an available organisation-specific identity provider, but not the organisation code;
- sends the resolved tenant key to the existing tenant-aware authentication services;
- loads identity providers only after the organisation has been resolved;
- stores only the last successfully used organisation code in browser storage;
- sets the browser title to `<NGO display name> | OneNGO`;
- offers **Use another organisation**, which clears the remembered code and opens the generic sign-in fallback.

The generic `/sign-in` route:

- redirects to the last successfully used active organisation when one is remembered;
- otherwise shows **Sign in using organisation code**;
- accepts a code and navigates to its canonical organisation-specific route rather than submitting credentials itself;
- gives the same unavailable response for an unknown, provisioning, failed, suspended or closed organisation;
- never provides public organisation search, autocomplete or membership discovery.

Invitation and reset links carry the organisation code and return the person to the canonical organisation-specific sign-in route after completion. An authenticated organisation switcher and verified email-first discovery are outside this block.

Expose only the minimum active-organisation branding needed by the unauthenticated route. Rate-limit its lookup, return no legal, registration or contact data, and never accept a tenant-supplied remote logo URL. All credential checks, active-membership checks, tenant-specific two-step rules, lockouts, refresh-token rotation and audit remain server-authoritative.

#### Product and NGO presentation

Use these presentation rules:

- product mark: `OneNGO`;
- shell: OneNGO product mark plus the active NGO display name;
- Home title: NGO display name;
- browser title: `<screen or NGO display name> | OneNGO`;
- canonical sign-in: OneNGO plus NGO display name and logo; no organisation-code field;
- generic sign-in: remembered-organisation redirect or organisation-code fallback;
- invitation: `You have been invited to <NGO display name> on OneNGO`, linking to that NGO's canonical sign-in context;
- NGO-generated email and receipts: NGO identity first, with optional `Powered by OneNGO` in the footer;
- no tenant-supplied remote logo URL.

#### Receipt issuer snapshot

When issuing a receipt, persist the issuer identity needed to reproduce it:

- legal and display names;
- relevant registration numbers;
- postal address and contact details;
- logo asset/version reference or an immutable rendered asset reference.

The print view reads this snapshot for an issued receipt. Draft previews may read current organisation settings.

#### Security and operational rules

- Only the owner/system context may call onboarding and lifecycle orchestration.
- Tenant bearer tokens, API keys and tenant roles are never accepted as operator authority.
- Organisation codes are normalised, immutable and unique.
- Organisation-specific links are identifiers, not credentials; knowing one never bypasses user authentication or membership checks.
- Unauthenticated organisation resolution returns only the active NGO's display name and same-origin logo and is rate-limited.
- Unknown and every non-active lifecycle state have the same public response.
- Release 2 has no public organisation directory, autocomplete or email-based membership discovery.
- Reusing a primary-administrator email reuses the global account but grants membership only in the new tenant.
- Suspending an NGO revokes or invalidates all tenant sessions and blocks API-key use for that tenant.
- Reactivation does not silently re-enable expired credentials or failed connectors.
- Logs contain ids and state transitions, not invitation tokens or full legal/contact payloads.
- Export and eventual closure preserve the existing tenant data-portability and retention rules.

#### Tests

Add tests for:

- valid input, every validation failure and validation-only mode;
- first provisioning and an exact idempotent replay;
- interruption after every persisted step followed by successful resume;
- duplicate organisation code with a different request;
- module setup, default roles, accounts, receipt series and fiscal year;
- new and existing global administrator accounts;
- invitation sent only after commit, failed delivery and retry;
- invitation and reset completion return to the correct canonical organisation sign-in route;
- sign-in refused while provisioning, failed, suspended or closed;
- canonical sign-in resolves an active NGO, hides the organisation-code field, shows the correct OneNGO/NGO identity and loads only that NGO's providers;
- unknown and non-active organisation links have indistinguishable public responses;
- generic sign-in redirects a valid remembered organisation, removes an invalid remembered value, and supports the explicit code fallback;
- **Use another organisation** clears only the remembered organisation context, not another browser user's credentials or server sessions;
- organisation-brand lookup returns no legal, registration, contact or cross-tenant data and is rate-limited;
- suspend revokes tenant sessions and blocks tenant API keys; reactivate restores access only for valid credentials;
- cross-tenant reads of profile, registrations, logo and setup state;
- tenant actors refused from all operator operations;
- logo replacement and cleanup protection;
- fixed OneNGO branding with the correct active NGO name;
- settings permissions and audit events;
- receipt issuer snapshot unchanged after organisation identity is edited.

#### Ready-to-paste implementation prompt

```text
Implement block R2-B01 of OneNGO release 2. Apply the common rules in
.cursor/docs/plans/ngo-release-2-build-blocks.md.

Read the whole R2-B01 block, then inspect the current tenant schema,
provisionTenant(), dev-seed flow, module enablement, people invitations,
organisation settings, FileStore cleanup, session resolution, receipts and
print view before coding.

Build the operator-assisted Organisation Onboarding & Lifecycle capability
exactly as specified:
- fixed OneNGO product identity with the active NGO display name;
- structured NGO profile, registrations and managed logo;
- owner-only onboarding state and audit;
- idempotent, resumable provisioning service and local/deployment command;
- selected module setup, fiscal year and primary administrator invitation;
- canonical /o/<organisation-code>/sign-in links, remembered-organisation
  redirect and organisation-code fallback, without public search or discovery;
- readiness, activation, suspension and reactivation;
- tenant administrator profile/settings and setup checklist;
- immutable issuer identity on issued receipts.

Do not create public signup, billing, email-first organisation discovery or an
operator web UI. Do not expose
provisionTenant() directly, accept initial passwords, allow tenant credentials
to perform platform operations, or store/fetch remote logo URLs.

Add migrations, server/domain code, command, web settings/setup UI, translations
and tests. Migrations remain SQL; use the Release 1 B00 Kysely path for the new fixed
tables and their application queries. Keep tenant isolation and existing module
behaviour intact.

Done: O1–O11 are evidenced; typecheck, tests and web build pass. Commit
"Release 2: organisation onboarding and lifecycle".
```

---

## Phase 2 — Configuration portability

### R2-B02 Export and import configuration packages

- **Depends on:** R2-B01; Release 1 B02–B06 (definition kinds and module model), B07 (jobs), B15 (files), B20d (fine-grained permissions), B21 (Builder support APIs), B35 (draft and change review), B43 (modules), and B45 (finished release).
- **Delivers:** a portable, versioned OneNGO configuration package; export of selected or complete published configuration; safe upload, validation and comparison; reviewed and atomic import; Builder screens for the workflow; audit and import reports.
- **Does not replace:** Release 1 record CSV import/export or the operator-only full tenant JSONL backup. A configuration package contains no operational records and cannot restore an NGO's data.
- **Checkpoints:** CP1–CP10 below.

#### Checkpoints

- **CP1 Portable package:** One versioned, deterministic package format carries definitions, module provenance and safe setup configuration without tenant database ids.
- **CP2 Explicit scope:** Export supports all published configuration or selected modules/definitions and shows exactly what will be included.
- **CP3 No data or secrets:** Members, role assignments, records, files, balances, journal entries, receipts, approvals, notifications, jobs, audit events, API keys, connector configuration and every credential or secret are absent.
- **CP4 Safe upload:** Import enforces compressed and uncompressed limits, file-count limits, expected paths, checksums, unique entries and JSON schemas; path traversal, links, duplicate paths and archive bombs are refused.
- **CP5 Whole-package validation:** Engine compatibility, module dependencies, definition schemas, cross-references, permissions, scripts and fixed setup items are checked together before any target configuration changes.
- **CP6 Preview and conflicts:** The administrator sees additions, changes, unchanged items, missing prerequisites and conflicts in plain language and can inspect source/target JSON. Nothing is applied implicitly.
- **CP7 Reviewed apply:** Import stays in staging until an authorised administrator confirms it. Apply is transactional, rechecks the target versions, publishes the change set together, uses normal publish events and increments configuration version once.
- **CP8 Provenance preserved:** Product/module definitions export as extension patches against named base versions; tenant-owned definitions export as complete bodies. Import does not silently turn shipped definitions into detached tenant copies.
- **CP9 Permissions and audit:** Export, import and apply have separate permissions; script activation additionally requires the existing script-publish permission. Export, upload, decisions, apply and discard are audited.
- **CP10 Builder experience:** Configuration export and import are usable from the Builder on desktop, with progress and an accessible review report; phones show status and reports but do not apply a package.

#### Package format

Use a ZIP archive with the extension `.onengo-config`. It contains canonical UTF-8 JSON only; configuration logos, record files and other binaries are not part of this first format.

Required root files:

- `manifest.json`;
- `checksums.json`.

Optional content:

- `definitions/<kind>/<key>.json` for complete tenant-owned published definitions;
- `patches/<module-key>/<kind>/<key>.json` for organisation patches to product, platform or module definitions;
- `roles.json`;
- `ledger-accounts.json`;
- `receipt-series.json`;
- `portable-settings.json`.

`manifest.json` includes:

- format id `onengo/config-package/1`;
- package id, label and semantic version;
- created timestamp;
- source OneNGO engine version;
- optional source organisation display name, never its database id;
- export scope;
- required modules with versions;
- every included item with kind, key, provenance and checksum;
- feature flags required to understand the package.

`checksums.json` contains a SHA-256 checksum for every other file over its exact canonical bytes. Checksums detect damage and unexpected modification; they do not make an untrusted package trusted. The import review must identify the package as organisation-provided unless a future signing scheme proves another origin.

Sort files and JSON object keys deterministically so exporting unchanged configuration twice produces the same content except for package id and creation timestamp. Package keys, definition keys and file names use the existing key rules; never derive archive paths from unchecked input.

#### Export scope

Export published configuration only. Open drafts, superseded versions and history remain in the source NGO.

Include when selected:

- tenant-owned published definitions of every supported kind;
- extension patches to platform and module definitions, with the exact base module key, version, definition version and checksum;
- module requirements, but not product-shipped module files themselves;
- customised roles with labels, permissions and two-step requirement, but no members or assignments;
- ledger account code, name and type, but no balance, opening, journal or transaction data;
- receipt-series key, label, prefix and reset rule, but no counters or issued receipts;
- portable settings explicitly allow-listed by schema, such as default language and timezone.

Exclude:

- organisation identity, legal name, registrations, contact details and logo;
- tenant key, region, lifecycle and subscription/operator settings;
- people, profiles, memberships and role assignments;
- records, links, imports, shares and attached files;
- ledger balances, fiscal periods, entries, payments, receipts and sequence counters;
- connectors, endpoints, transport configuration and encrypted credentials;
- API keys, sign-in providers, password/TOTP material and tokens;
- jobs, notifications, audit events, rate limits, usage and storage quotas;
- drafts, version history and local browser preferences.

When an included definition refers to excluded configuration, record a prerequisite in the manifest. Examples are a webhook connector key, payment provider, money account or language that the target administrator must configure locally. Never export a placeholder secret.

Export permissions:

- `config:export` may create and download configuration packages;
- sensitive definition values still follow their existing read permissions;
- exporting scripts additionally requires `config:script:read`;
- every export records scope, package checksum and actor in the audit log, without storing package contents there.

Small packages stream directly. Larger packages use the existing job runner and managed file storage, notify the creator when ready, expire after a short configured retention period, and count against the organisation's storage quota while retained.

#### Import staging model

Add fixed Kysely-backed tables:

- `configuration_import`: tenant, uploaded file, package metadata, status, source checksum, creator, expiry, target configuration version, validation and apply summary;
- `configuration_import_item`: import id, item identity and type, source/base/target checksums, classification, selected decision, validation issues and plain-language changes.

Statuses:

`uploaded → inspecting → needs_decisions | ready → applying → applied`

Terminal statuses:

`invalid`, `failed`, `discarded`, `expired`

The uploaded archive is a managed import asset and must not be removed by unlinked-file cleanup before the import expires or is discarded. Cleanup removes expired staging rows and package files in bounded batches.

Staging stores package content and decisions, not published definitions or Builder drafts. Discarding an import has no configuration side effects.

#### Validation and comparison

Inspection performs, in order:

1. Validate archive safety and checksums.
2. Validate the manifest and package-format version.
3. Check engine compatibility and known feature flags.
4. Resolve required modules and exact base versions/checksums.
5. Validate each definition through the existing schema registry.
6. Validate all cross-references with the package items and target published configuration considered together.
7. Check roles and permissions against generated and used permissions.
8. Check ledger accounts and receipt series against target fixed configuration.
9. Check imported scripts with the normal script limits and flag every script for explicit review.
10. Compare each item with the current target and capture the target configuration version.

Classify each item as:

- `add`;
- `change`;
- `unchanged`;
- `missing_prerequisite`;
- `base_mismatch`;
- `conflict`;
- `unsupported`.

For changed items, show the existing plain-language definition changes plus source and target JSON. For patches, reuse the module update/rebase rules and identify paths changed by both the target and the package.

Release 2 decisions are limited to:

- apply incoming;
- keep target;
- omit optional item.

Renaming keys during import is not supported because it would require rewriting arbitrary expressions, scripts and references. Resolve a key collision by changing and re-exporting the source configuration.

Missing product modules are never uploaded from an organisation package. The review may offer to enable a shipped module already available in this OneNGO installation, with explicit confirmation. An unknown module or incompatible base remains blocking.

#### Apply rules

Immediately before apply:

- require `config:import` and `config:publish`;
- require `config:script:publish` if any selected script is added or changed;
- re-read the current configuration version and every target checksum;
- return to `needs_decisions` if the target changed since inspection;
- rerun schemas, cross-references and prerequisite checks over the final selected set.

Apply the selected change set in one tenant transaction:

- insert new published versions for selected definitions and patches while preserving module provenance;
- supersede prior published versions through the normal definition service;
- create or update customised roles, never assignments;
- create missing ledger accounts, but block type changes or destructive account replacement;
- create or update unused receipt-series metadata, but block unsafe changes once numbers have been issued;
- apply only allow-listed portable settings;
- write item-level audit details plus one package-level event;
- enqueue the same publish, index and rebuild events as equivalent Builder publishes;
- increment `tenant.config_version` once after the whole set succeeds.

Any failure rolls back the transaction. Do not call each existing publish route over HTTP. Add a service-level multi-definition/change-set operation that shares the normal schema, cross-reference, permission, history, audit and event rules.

There is no automatic destructive rollback for roles, accounts or receipt series in Release 2. Definition versions retain their normal restore history. The apply report must state what was changed and how to restore definitions.

#### Builder experience

Add **Configuration packages** under Builder › Modules:

- Export: choose all published configuration, modules or individual definitions; show included and excluded categories; create and download the package.
- Import: upload or drop a `.onengo-config` file; show inspection progress; never parse an archive in the browser as the authority.
- Review: summary counts, package provenance, engine/modules, prerequisites, warnings, scripts, and filters for additions, changes, conflicts and unchanged items.
- Item detail: plain-language changes, source and target JSON, provenance and decision controls.
- Apply: confirmation names the number of definitions, roles, accounts, receipt series and settings; scripts receive a separate warning.
- Result: immutable summary, downloadable JSON report and links to affected Builder definitions.
- Discard: removes staging and the retained upload after confirmation.

Use existing Builder layout, panels, rows, jobs and translated text. Phones may inspect status and download reports but show “Use a larger screen to review and apply configuration.”

#### Routes and permissions

Add tenant-authenticated Builder routes equivalent to:

- create configuration export and get its status/download;
- upload configuration import;
- get import summary and paged items;
- save item decisions;
- revalidate;
- apply;
- discard;
- download the final report.

The server defines the exact HTTP shapes in the normal core port and HTTP adapter. Enforce:

- `config:export` for export;
- `config:import` for upload, inspect, decide and discard;
- `config:publish` for apply;
- `config:script:read` for exporting scripts;
- `config:script:publish` for applying scripts.

Add these permissions to the catalogue, role editor, access map and generated OpenAPI description. Tenant API keys may use them only when their assigned role explicitly holds them.

#### Security and operational rules

- Treat every imported package as untrusted input.
- Inspect ZIP entries while streaming; never extract them to a shared working directory.
- Reject absolute paths, `..`, backslashes as separators, symlinks, duplicate/case-colliding names, encrypted entries and unsupported compression.
- Default limits: 25 MB compressed, 100 MB uncompressed, 5,000 entries and 2 MB per JSON file; make deployment limits lowerable.
- Parse JSON with the existing depth/size safeguards and reject duplicate semantic item keys.
- Imported scripts never run during upload, inspection or preview.
- Template preview and rich text continue through their existing sanitisation.
- Do not fetch package dependencies, schemas, logos or modules from a URL.
- Do not log package bodies, scripts, registration-like values or file bytes.
- The source NGO never receives access to the target NGO, and package ids never become authorisation.
- Full tenant backup/export remains an owner-only operational capability and is visibly distinguished from configuration portability.

#### Tests

Add tests for:

- deterministic export and manifest/checksum verification;
- all included configuration categories and every excluded data/secret category;
- selected-scope export and permission combinations;
- direct and job-backed export, expiry and cleanup;
- valid package inspection and whole-set cross-reference validation;
- corrupted checksum, malformed manifest, unsupported version and incompatible engine;
- archive traversal, absolute path, backslash, symlink, duplicate path, case collision, encrypted entry, too many files, oversized entry and compression bomb;
- custom definitions, module patches and platform patches preserving provenance;
- missing module, unknown module, base mismatch and rebase conflict;
- add, change, unchanged, keep-target and omit decisions;
- scripts requiring explicit review and both script permissions;
- target configuration changing between inspection and apply;
- successful atomic apply, failure rollback, one configuration-version increment and normal publish/rebuild events;
- role import without members; account and receipt-series safe/unsafe conflicts;
- no connector configuration, credentials, API secrets, user ids, operational rows or organisation identity in an export;
- tenant isolation for packages, staging, reports and retained files;
- audit events without package bodies or secrets;
- Builder address/session logic, phone restrictions and accessible review summaries;
- configuration-package business document reconciled with server and web behaviour.

#### Ready-to-paste implementation prompt

```text
Implement block R2-B02 of OneNGO release 2. Apply the common rules in
.cursor/docs/plans/ngo-release-2-build-blocks.md.

Read R2-B02 completely, then inspect the definition store and extension patches,
module package loader and update/rebase flow, schema and cross-reference checks,
roles, ledger accounts, receipt series, tenant settings, FileStore cleanup, job
runner, audit, Builder draft/change review, the full tenant JSONL export, and
Release 1 record CSV import/export.

Build portable `.onengo-config` packages exactly as specified:
- deterministic export of selected or complete published configuration;
- full definitions for tenant-owned items and versioned patches for shipped
  definitions, preserving module provenance;
- safe roles, account metadata, receipt-series metadata and allow-listed
  portable settings;
- no records, people, assignments, organisation identity, files, operational
  money data, credentials, connector configuration, API keys or secrets;
- streamed archive validation, checksums, strict limits and staging;
- whole-package schema, cross-reference, dependency and conflict analysis;
- reviewed decisions and one transactional, version-checked apply;
- Builder export, upload, review, apply, result and discard screens;
- separate export/import/publish/script permissions, audit, reports and cleanup.

Do not reuse the full tenant backup as the portable format, publish on upload,
run imported scripts during inspection, fetch dependencies from URLs, silently
detach module definitions, rename keys, or partially apply a failed package.

Use Release 1 B00 Kysely for the fixed staging tables and queries; migrations
remain SQL. Add tests for CP1–CP10 and create/update the layer-neutral business
document at
ngo-platform/docs/business/platform/configuration-portability/business-document.html.

Done: CP1–CP10 are evidenced; typecheck, tests and web build pass. Commit
"Release 2: configuration package export and import".
```
