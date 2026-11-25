# Roadmap

What is planned or open. Built behaviour is in `architecture.md` and `user-guide.html`. The full text of the plans this page condenses is in `archive/release-2-build-blocks.md` and `archive/pwa-plan.md`. The backend block status (section 5.1, read by tests) stays in `plans/ngo-backend-enhancement-plan.md`.

## 0. Product 1.0.0: eight modules as configuration

**Status.** Written as definition packages under `packages/product/modules/`. No engine code changed. Each package passes the schema checks and the publish-time cross-reference rules as a set. Not yet loaded into a running tenant or exercised in the app; that is the next step.

**Shipping.** A package reaches an organisation only when its folder is named in `SHIPPED_MODULES` (see `deployment.md`). The default is still `donations`, so nothing new goes live until that variable is changed.

| Module | Version | Depends on | What it adds |
| --- | --- | --- | --- |
| `donations` | 0.2.3 | none | Unchanged. Built before 1.0.0 |
| `expenses` | 1.0.0 | donations | Claims with bill attached; treasurer approves; paying posts to the ledger |
| `earnings` | 1.0.0 | donations | Other income (interest, sales, service fees) with posting rules |
| `physical-assets` | 1.0.1 | none | Asset register with disposal. No depreciation |
| `members` | 1.2.0 | donations | Member profile (name parts, gender, date of birth, present and permanent address, link to a person, generated Member ID); one-time membership fee with receipts from the `MEM` series |
| `governance` | 1.0.0 | members | Meetings with agenda and minutes; resolutions passed by office-bearer vote; notices emailed to members with a delivery record |
| `projects` | 1.0.0 | none | Projects with goals and milestones; events with date, venue and attendee list |
| `beneficiaries` | 1.0.0 | projects | Beneficiary record; consent per purpose; case notes with follow-up dates |

**Known limits in 1.0.0**

1. The books have one bank ledger account, `BANK`, and one cash account, `CASH`, both from donations. The `bank-accounts` module (`BANK_2`, `BANK_3` and the bank balances report) was removed; the expense, earning and membership-fee forms offer only `BANK` and `CASH`. A real bank account is a money account attached to `BANK` (see 2). A second real bank has no ledger account of its own until a module adds one. There is no bank balances report. Bank reconciliation is built as an API only (statement import, matching, booking, sign-off; permission `money:reconcile`), with no screen.
2. Per-account UPI is built in the engine, through money accounts (`money_account`: key, kind `bank`, `cash`, `wallet` or `investment`, ledger account, UPI ID). A payment on a money account builds a `upi://` link to that account's UPI ID. The money page (`/accounts`) lists accounts with their ledger code, UPI ID and balance, and opens new ones for people with `money:accounts:manage`. Bank details are not stored. A money account gets its own generated ledger code (for example `BANK_MAIN`), unless it is opened with a `ledgerCode`, which attaches it to an existing asset ledger account such as `BANK`. The money page has a `ledgerCode` field and an Edit action. The donations "Pay now" action uses a money account keyed `upi`, which installing Donations now creates on `BANK`, without a UPI ID; set it with Edit. An organisation that installed Donations before this change does not get the account.
3. No depreciation on physical assets.
4. The one-time membership fee is not enforced. The fee total is a rollup only.
5. Expense approval is by permission, with no approval block. An approver can approve their own claim. Accepted for 1.0.0.
6. Notices go to one member at a time through a bulk action. There is no broadcast.
7. Events have no public registration. Member self-service is not defined.
8. Reports sit under "Other", because no report groups were written.
9. Beneficiary and consent records are restricted in visibility.

**Open decision.** The engine now lets a money account attach to an existing ledger account (`ledgerCode` on `POST /api/money/accounts`). Still open: a `ledgerCode` field on the money page, and creating the money accounts when a module is enabled so the attachment is not a manual step. The rest of the finance work is in `plans/finance-system-plan.md`.

## 1. Release 2: onboarding, lifecycle, configuration portability

| Block | What | Status |
| --- | --- | --- |
| R2-B01 | Operator-assisted onboarding, lifecycle (active, suspended, closed), structured NGO identity, organisation sign-in links, issuer snapshots on receipts | Built. See `architecture.md` and the operator console |
| R2-B02 | Export and import of configuration packages (`.onengo-config`) | Planned, not built |

### Decisions that still bind

1. OneNGO is the fixed product name, not tenant data. `tenant.name` is the NGO display name; the legal name is separate.
2. Provisioning is operator-assisted and idempotent. It is never a public endpoint, and no initial password is ever shared (a single-use, seven-day invitation is sent).
3. An organisation is not available for sign-in until provisioning and required setup are complete.
4. A receipt keeps the issuer details it was issued with. Later changes never rewrite it.
5. Each NGO signs in at `/o/<code>/sign-in`. Email-first discovery is deferred.
6. Configuration moves as a reviewed package, never as tenant data. Import stages a change set and changes nothing until an authorised administrator applies it.
7. Out of scope: self-registration, subscription billing, a public control plane.

### R2-B02: configuration packages

**Goal.** A portable, versioned package that moves a validated setup between NGOs. It contains no records, people, credentials or secrets. It does not replace record CSV import and export or the operator-only full tenant backup.

**Checkpoints**

| | Rule |
| --- | --- |
| CP1 | One versioned, deterministic format. No tenant database ids |
| CP2 | Export all published configuration, or selected modules or definitions, and show what is included |
| CP3 | No members, assignments, records, files, balances, receipts, approvals, jobs, audit events, API keys, connector configuration or secrets |
| CP4 | Safe upload: size, entry-count and path limits, checksums, JSON schemas. Traversal, links, duplicate paths and archive bombs are refused |
| CP5 | Whole-package validation before anything changes: engine compatibility, module dependencies, schemas, cross-references, permissions, scripts |
| CP6 | Preview in plain language: additions, changes, unchanged, missing prerequisites, conflicts. Nothing applies implicitly |
| CP7 | Reviewed, atomic apply that rechecks target versions and bumps the configuration version once |
| CP8 | Shipped definitions export as patches against a named base version. Tenant-owned ones export in full |
| CP9 | Separate permissions for export, import, publish and script publish. Everything is audited |
| CP10 | Usable from the Builder on desktop. Phones see status and reports but do not apply |

**Format.** A ZIP named `*.onengo-config` of canonical UTF-8 JSON, with `manifest.json` (format `onengo/config-package/1`, version, engine version, scope, required modules, item list) and `checksums.json` (SHA-256 of every other file). Optional content: `definitions/<kind>/<key>.json`, `patches/<module>/<kind>/<key>.json`, `roles.json`, `ledger-accounts.json`, `receipt-series.json`, `portable-settings.json`. Checksums detect damage; they do not make a package trusted.

**Included.** Published definitions, extension patches, module requirements, customised roles (no assignments), ledger account code, name and type (no balances), receipt series metadata (no counters), allow-listed portable settings.

**Excluded.** Organisation identity and logo, tenant key and lifecycle, people and memberships, records and files, all money data, connectors and credentials, API keys and sign-in providers, jobs, notifications, audit events, quotas, drafts and history. A definition that refers to something excluded records a prerequisite in the manifest.

**Import.** Staged in `configuration_import` and `configuration_import_item`. Statuses: `uploaded`, `inspecting`, `needs_decisions` or `ready`, `applying`, `applied`; terminal `invalid`, `failed`, `discarded`, `expired`. Items are classified `add`, `change`, `unchanged`, `missing_prerequisite`, `base_mismatch`, `conflict`, `unsupported`. Decisions are apply incoming, keep target, or omit an optional item. Keys are never renamed on import. A missing shipped module may be enabled with explicit confirmation; an unknown module or incompatible base blocks.

**Apply.** Requires `config:import` and `config:publish`, plus `config:script:publish` when a script is included. Re-reads the configuration version and every target checksum, returns to `needs_decisions` if the target moved, then writes everything in one transaction through a service-level change-set operation (not through the HTTP publish routes). There is no automatic rollback for roles, accounts or receipt series; definitions keep their normal restore history.

**Security.** Treat every package as untrusted. Stream ZIP entries, never extract to a shared directory. Reject absolute paths, `..`, backslashes, symlinks, duplicate or case-colliding names, encrypted entries. Default limits: 25 MB compressed, 100 MB uncompressed, 5,000 entries, 2 MB per JSON file. Imported scripts never run during upload, inspection or preview. Fetch nothing from a URL. Never log package bodies.

**Builder.** A "Configuration packages" area under Builder → Modules: export, upload, review, item detail, apply, result report, discard.

**Done when** CP1 to CP10 are evidenced and typecheck, tests and web build pass.

### Follow-up work carried over from Release 1

1. Bulk Share uses a panel built for a selection (person or role by autocomplete, can view or can edit, optional end date), replacing the panel where the role is typed as a key.
2. The Builder role view ("What can this role see?") moves onto the shared `ui/live-preview`, and `ui/role-preview` is retired.
3. Business documents were removed on 2026-11-22. If they are wanted again, decide that first.

### Open product questions

1. Should saving a person field refuse an invited member who has never signed in? The picker already offers only active members.
2. Should a record action's payment link open a page in the app (`/payments/<id>`), or should the server stop returning the link?

## 2. PWA: web, Android, iOS

Status: proposed. Install, the service worker, update prompt and offline banner exist (`apps/onengo/web/src/app/pwa/`, `apps/onengo/web/ngsw-config.json`, `packages/platform/src/application/organisations/install-manifest.ts`). Offline saves are blocked and nothing is queued.

| Phase | Work |
| --- | --- |
| 1. Same behaviour on every platform | Retry a save once when the connection returns, sending the record version so a concurrent change is rejected (defect DEF-12 in `archive/test-plan-appendices-b-c-d-f.md`). Confirm sign-in persists in an installed iOS app. Keep several installed organisations from mixing state (they share one origin and one service worker). Test on Chrome Android (low-end), Safari iPhone (installed), Chrome or Edge desktop, Firefox desktop |
| 2. Web Push, no Firebase | VAPID keys per installation, a `push_subscription` table, a `push` notify channel and `notification.push` outbox event using `web-push`. A 404 or 410 deletes the subscription. Short text only: no donor names or amounts by default. A "Turn on notifications" switch in My profile; on iOS only inside the installed app (16.4 or later). In-app and email stay the defaults |
| 3. Offline capture | Opt in per form, new records on field forms first. Definitions and unsent records in IndexedDB with client-generated ids so a resend makes no duplicate. Sync on reconnect and on open (Safari and Firefox have no Background Sync). Show "3 waiting to send". Server treats a repeated client id as the same request. Do not let a person sign out with records waiting |
| 4. Store listing (optional) | Android: a Trusted Web Activity can list the same PWA. iOS needs a native wrapper and review, and a native app is outside the first delivery. FCM belongs here only |

Limits: HTTPS only; a push payload is about 4 KB; the service worker runs only in production builds, so test push against one; delivery is best effort.

Decisions needed: which forms work offline first; whether push text may ever contain names or amounts; how long an installed app stays signed in; whether a Google Play listing is wanted.
