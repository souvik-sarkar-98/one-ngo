# Legacy data migrator — plan

Status: implemented v1 (M0 to M8), 2026-11-25. Sections 0 to 7 are the plan as approved; sections 8 and 9 at the end list what differs and how each acceptance criterion is tested. It extends the Data migrator (`/admin/migration`) so an organisation can bring people, records, files and books from a legacy system into OneNGO in one controlled, repeatable profile.

"Any legacy data" means any data whose target concept exists in the platform. Where no target exists, section 1 says so and either proposes the smallest addition or marks the item out of scope.

## 0. What I verified, and where the brief was wrong

Every fact below was read in the code. Corrections to the brief come first because the design depends on them.

| # | Brief said | Code says | Effect on the plan |
| --- | --- | --- | --- |
| C1 | "Run is quiet (no automations, mail or receipts)" | `quiet` reaches only the outbox payload (`save/audit.ts`) and the automation engine (`automation-engine.ts`, `p.quiet`). It is not read anywhere else. Scripts still run in a migration save. Their `notify` and `connector.call` effects enqueue `script.notify`, `connector.http` and `connector.webhook` (`save/script-run.ts`, around lines 199–230). Posting and receipt rules fire when a record enters their status (`save/effects.ts`). A new record starts in the primary workflow's `initial` state, so a rule whose `whenStatus` equals that state posts a journal entry and issues a receipt. | "No email or receipt" is not true today for types with scripts or an initial-state rule. Block M0 closes the script gap. The Check refuses the initial-state rule case (M1). |
| C2 | "Uploaded sources deleted after the run" is in scope | Nothing deletes them. `file-catalog.removeUnlinked` skips any file referenced by a `migration_source` row, so each CSV lives forever. `migration_source.columns` keeps up to 3 plaintext sample values per column. `job_item.data.cells` keeps every failed row in plaintext, and `failed.csv` is built from it. | Retention is new work, not a tweak (M2). Sensitive columns need redaction too. |
| C3 | "Verify whether a record can be created in a non-initial workflow state" | It cannot. `create` and `createGranted` always start at `primary?.initial`. `update` keeps the stored state (`moveOf(current)`). Only `transition` changes state, with permission, `from` list, guard, required fields and approvals. `editable()` refuses edits to records in `locked` or `final` states. | Decision 3 below. Also: a record parked in a final state could not be updated by a re-run. |
| C4 | "Record links/relationships beyond reference fields (record_link)" | `record_link` is a table (`001_core.sql`) with RLS and grants. Nothing in `packages/platform/src` reads or writes it except `db-types.ts` and `tenant-export.ts`. | No live concept to target. Out of scope. Many-to-many works today as a child record type with two reference fields (multi-target mapping). |
| C5 | Next free migration number | Files are `001`–`008`; the last `schema_compatibility` level is 8. The architecture doc says "migration 018", which is stale. The migrator tables are in `001_core.sql`. | Next free is `009`. Take the next free number at build time. Fix the doc paragraph (section 9). |
| C6 | `IdentityService.addMember` "account upsert, then membership and roles" | True, and two transactions (`accounts.add` runs through `db.asSystem`, then `withTenant`). But `MemberStore.join` does `on conflict … set status = 'active'`, so re-adding a suspended member reactivates them. `AccountStore.add` on conflict is a no-op update (it keeps the name and password) and returns the existing id. | `addMember` cannot be reused as is for an idempotent migration. A new `importMember` path is needed (M3). |
| C7 | "A role with `require_two_step` locks out people who have not enrolled" | Worse than a lock-out you can fix. `completeSignIn` and `signInVerifiedUser` throw before any session exists when a role requires two-step and TOTP is not enabled. `beginTwoStep` acts only on the signed-in actor (`POST /api/auth/two-step/begin`, `…/confirm`). Nobody can enrol such a person. The Settings screen shows only on/off. | The Check blocks people files that give a `require_two_step` role. Assign that role after the person has signed in and enrolled. |
| C8 | "plain Fastify routes with schema contracts" | The migration plugin (`apps/onengo/server/src/http/plugins/migration.ts`) uses no schemas; `readMapping` validates by hand and returns path-level issues. Other plugins use `schemaOf` contracts (for example `http/contracts/members.ts`). | New routes get a coarse contract in `http/contracts/migration.ts`. Deep validation stays in `readMapping`, which gives better messages. |
| C9 | "no owner access outside the kernel; a test enforces this" | `owner-capabilities.test.ts` counts `.asSystem(` and `db.exec(` outside `packages/platform/src/infrastructure/`; the allowlist `packages/platform/test/owner-capabilities-allowlist.json` is `{}`. | No new owner call may appear in application code. People import needs no new owner capability (see 3.1). |
| C10 | "Person cells resolve only by email or user id of an ACTIVE member" | Confirmed: `resolvePerson` uses `PersonDirectory.find`, where active means member active and account active. A saved person value must also be an active member when set (`personFieldIssues`). | Decision 2: a suspended or missing user cannot fill a person field without a small platform change (M4). |
| C11 | Source formats | `exceljs` is already a declared dependency of `packages/platform`. Node core has no ZIP reader. | XLSX needs no new dependency. ZIP does. |

Verified as stated: the file list and limits (50 files, 10 MB, 20,000 rows, 5 targets, old id ≤ 200); `migration_key` primary key `(tenant_id, type_key, old_id)`; RLS `tenant_isolation` and `app_runtime` grants; the exclusive `migration` job with batch size 100; one `saveTogether` transaction per row; rollups rebuilt once; books applied once after the files; permissions `data:migrate`, `record:<type>:import`, `data:migrate:books`; scrypt-only passwords; `inviteMember` 7-day token and `ensureEmail`; `PeopleService.add` rules; file upload rules (25 MB default, 1 GB quota, sniffed type, uploader-only linking, 24 h cleanup); audit snapshots mask read-protected fields (`maskFor`).

## 1. Capability matrix

| Legacy data | Platform target | Class | Reason |
| --- | --- | --- | --- |
| Records, 1–5 types per row, old-id references | Record types through `RecordService.saveTogether` | Exists (unchanged) | |
| People: account, name, status, locale | `app_user`, `tenant_member` | **v1** | Target exists. No passwords or two-step secrets. |
| People: roles | `role_assignment` (roles must already exist) | **v1** | Limited to roles the actor may grant. Roles with `require_two_step` are refused (C7). |
| Legacy user id on record person fields | Person field, plus new `migration_person_key` | **v1** | The mapping table is the only new identity-adjacent concept. |
| Legacy users that were deleted or are blank | Person field left blank with a Check warning | **v1** | Decision 2. |
| Suspended people linkable from person fields | Person field | **v1 (small, M4)** | One flag so the active-member check accepts a suspended member while migrating. |
| File fields | `file_object` linked by `linkRecordFiles` | **v1** | Attachments uploaded to the profile, a column names each file. |
| Signature fields | `signature` field (PNG ≤ 200 kB) | Later | The save stage stamps `signedAt` with the migration time, so history is lost. Nothing small fixes that. |
| Books: opening journal, next receipt number | `LedgerService.post`, `ReceiptService.continueNumbering` | Exists (unchanged) | |
| Old journal entries, issued receipts, payments | Ledger and receipts | Out | Old transfers are not replayed. Receipts are immutable and numbered by the platform. |
| Chart of accounts, funds, fiscal years, receipt series, roles, record type definitions | Setup | Out | Setup is not data. Books fail clearly when an account code is missing. I did not look for an account-import path. |
| Workflow state | `record.status` | Later (L3) | Decision 3. |
| Original created/updated dates and creator | None (`created_at`, `created_by` are set by the store) | Out | Keep them in ordinary date or person fields the type declares. No platform change proposed. |
| History: audit trail, versions, comments | No target. `audit_event` is append-only evidence of what this platform did; there is no comments or versions table (`record.version` is a counter). | Out for v1 | Decision 4. A `longText` field filled from a column already works today. |
| Shares | `record_share` through `ShareService` | Later (L2) | Needs the people mapping first. Legacy ACLs rarely map cleanly and a wrong share over-exposes a restricted record. |
| Approvals in flight, public form links | `approval_request`, `public_form_link` | Out | Secret tokens and pending decisions should not be fabricated. |
| Record relationships (`record_link`) | None live | Out | C4. |
| XLSX | Same CSV pipeline | Later (L4) | No new dependency (`exceljs`), but memory and sheet-selection UI. |
| JSON lines | Same pipeline | Later (L4) | Trivial parse, but needs a flattening rule for nested values. |
| ZIP bundle (CSV, files folder, manifest) | Same, plus attachments | Later (L5) | Needs a new dependency and zip-bomb guards. v1 uploads many files instead. |
| Direct database connection | None | Out | Credentials, outbound network access and SSRF. No connector type exists for it. |

## 2. The seven open decisions

1. **Email already has an account (maybe in another organisation): reuse and map.** Never fail the row for that reason: failing would tell the administrator the email exists elsewhere, which the brief forbids. Reuse matches `PeopleService.add`, which keeps the account's password and sign-in and names the person only by this organisation's `display_name`. The trade-off is that whoever controls the mailbox gets access, exactly as with a manual add. Only a globally disabled account fails, with the existing generic wording ("cannot be added. Ask the person to contact support."). That wording does reveal "disabled" for one email at a time; see risk R3.
2. **Legacy user referenced by records but not in the people file: leave the person link blank and warn.** Importing them as suspended members is not workable. A member needs an email (`app_user.email` is not null and unique), and deleted users usually have none. Inventing placeholder addresses invents a concept. Failing the row would stop thousands of otherwise good records over one deleted author. The Check lists each distinct unresolved legacy id (first 5, with counts). An option `onMissing: 'fail'` per person mapping exists for fields where blank is unacceptable. The admin who wants the legacy value kept maps the same column to a text field too (the column may fill both; person mappings do not count as "used").
3. **Workflow state: not in v1.** Every migrated record starts in the workflow's initial state; the legacy status can be kept in an ordinary choice or text field. Later (L3): a mapping `state: { column, map }` writes `record.status` directly on create. It needs its own permission (`data:migrate:state`), suppresses posting and receipt rules (the books already carry the opening balances and numbering), creates no approval requests, and the Check blocks a mapped state that a posting or receipt rule keys on unless the admin confirms the books cover it. Records in `locked` or `final` states are skipped on re-run with a "skipped, locked" count. Replaying transitions is rejected: it would fire guards, approvals, journals and receipts for old events. Trade-off: until L3, "Paid" or "Closed" history lives in a field, not in the workflow.
4. **History: leave it in the archive export for v1.** Do not write fake `audit_event` rows; the audit log would no longer be evidence. The supported pattern is a read-only `longText` or `richText` field per record type (set `editPermission` so it is read-only), filled by a normal column mapping. Zero platform work; document it. A first-class "Imported history" display is a later product decision (R5).
5. **Source formats: CSV only in v1, plus multi-file attachment upload.** XLSX and JSON lines are later and cheap. ZIP is later because it needs a dependency and guards (limits in 3.3). Direct database access is out.
6. **Undo: later (L1), scoped narrowly.** v1 gives re-run after fixing the source, which is idempotent. L1 needs a new column, because `migration_key.profile_id` is overwritten on every update (`putKey` `doUpdateSet`) and so cannot tell "created by this profile" from "last touched by". Undo would move created records to the recycle bin, remove memberships and role assignments the profile created, and delete mapping rows. It never touches accounts (global, possibly used by other organisations), books, journal entries, issued receipts or numbering.
7. **Bulk invitations: a later block (L6).** Existing per-person invite works today (`POST /api/admin/people/:userId/invite`). A bulk job needs `ensureEmail`, rate limits and an unsubscribe-safe wording decision. Keeping it out of v1 also keeps "no email is sent during a run" simple to test.

## 3. Design

### 3.1 People are created without a new owner capability

`AccountStore.add(email, displayName)` already exists as a named owner capability (`stores/owner/account.ts`). It returns the id whether the account is new or not and changes nothing on conflict. `MemberDirectory.accountByEmail(tenantId, email)` (owner capability) returns the account status and this organisation's membership status. The migration needs neither created-versus-reused information (which would be a disclosure) nor account deletion. So there is **no new owner call**, and the owner-capabilities test stays green.

New in the application layer:

- `IdentityService.importMember(ctx, input, alongside)`: like `addMember`, but it (a) never reactivates, (b) can create a suspended member, (c) sets locale, (d) adds roles additively under `demandGrant`, (e) writes audit `member.imported`, (f) runs `alongside(tx, userId)` in the membership transaction to write the mapping row, (g) does not call `actorCache.clear()` per row (the caller calls `forgetActors()` once per batch; each membership or role insert already bumps `tenant.access_version` by trigger).
- `MemberStore.importJoin(tx, userId, { displayName, status, locale })`: insert if absent; if present change only `display_name` and `locale`, never `status`.
- `MigrationService` receives an `identity` port limited to `importMember` and `forgetActors` (check `packages/platform/test/layer-graph.ts` allows application → application).

### 3.2 Permissions

| Permission | Needed for | Roles |
| --- | --- | --- |
| `data:migrate` | everything today | unchanged |
| `data:migrate:people` (new) | mapping a people file; running a profile that holds one | Only roles that already hold `*` (the shipped `admin` role). I did not read the product role JSON files; at build, list roles with explicit permission arrays and decide. |
| `members:manage` | also demanded for a people file, because it is what creating people needs today | unchanged |
| `record:<type>:import` | each record target | unchanged |
| Files | no new permission: `data:migrate` plus `record:<type>:import` on the target type | |
| `data:migrate:state`, `data:migrate:undo` | later blocks | |

Add `data:migrate:people` to `roles-service.ts` (SETUP list), `permission-usage.ts`, the session flags (`session/http-api.ts`: `migrationPeople`) and `core/models.ts`. The `migration` job's `requires` stays `data:migrate`; the people batch re-checks `can(ctx.actor, 'data:migrate:people')` and `members:manage` with the creator's current access, and fails the job with a clear message if they were lost.

### 3.3 Data model and migration files

Three small, additive, independently shippable files. Each inserts its `schema_compatibility` row (`additive`) in the same file, with the next free level. Today that is 9, 10, 11; renumber at build. New tables are also added to `TENANT_TABLES` (`infrastructure/postgres/tenant-export.ts`), with the export test updated.

**`009_migration_retention.sql`** (block M2)

```sql
alter table migration_source  add column purged_at timestamptz;
alter table migration_profile add column purged_at timestamptz;
insert into schema_compatibility (schema_level, migration_name, compatibility)
values (9, '009_migration_retention.sql', 'additive');
```

Purge soft-deletes the `file_object` rows (the `file_id` foreign key stays valid) and deletes the stored objects. Old servers select explicit column lists and never name the new columns.

**`010_migration_people.sql`** (block M3)

```sql
create table migration_person_key (
  tenant_id  uuid not null references tenant(id),
  old_id     text not null check (length(old_id) between 1 and 200),
  user_id    uuid not null references app_user(id),
  profile_id uuid references migration_profile(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, old_id)
);
create index migration_person_key_user on migration_person_key (tenant_id, user_id);
alter table migration_person_key enable row level security;
create policy tenant_isolation on migration_person_key
  using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()));
grant select, insert, update on migration_person_key to app_runtime;
insert into schema_compatibility (schema_level, migration_name, compatibility)
values (10, '010_migration_people.sql', 'additive');
```

- This is the internal per-organisation map from legacy user id to new user id. Nothing is added to `app_user`. Legacy ids are text, so mixed UUID, integer and text formats all work. Two legacy ids may map to one user (duplicate legacy accounts); the reverse is blocked by the primary key.
- The foreign key to the global `app_user` follows `tenant_member`. Reads join `tenant_member` and `app_user` (the runtime role may only see members, and only `id, display_name, email, status`).
- Delete grant is added in L1 only.
- Erasure: legacy ids can be personal (an email used as an id). In M3, decide whether privacy erase of a member deletes their mapping row (recommended: yes) and apply the same to `migration_key.old_id` if ids can be personal. Not verified how `erasure` treats these tables today.

**`011_migration_attachments.sql`** (block M6)

```sql
create table migration_attachment (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  profile_id  uuid not null references migration_profile(id) on delete cascade,
  path        text not null check (length(path) between 1 and 255),
  file_id     uuid not null references file_object(id),
  size        bigint not null check (size >= 0),
  uploaded_by text not null,
  created_at  timestamptz not null default now()
);
create unique index migration_attachment_path on migration_attachment (profile_id, lower(path));
create index migration_attachment_file on migration_attachment (file_id);
alter table migration_attachment enable row level security;
create policy tenant_isolation on migration_attachment
  using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()));
grant select, insert, delete on migration_attachment to app_runtime;
insert into schema_compatibility (schema_level, migration_name, compatibility)
values (11, '011_migration_attachments.sql', 'additive');
```

- A new exemption in `file-catalog.removeUnlinked` (`exists(migration_attachment …)`) keeps attachments from the 24 h cleanup, next to the existing `migration_source` exemption. The attachment rows go away with the profile or on purge; once a file is linked to a record it is no longer unlinked anyway.
- `linkRecordFiles` lets only the uploader link an unlinked file. A run by a different administrator than the uploader would fail every file. The Check reports "uploaded by another person; upload again" instead of failing at run time.
- One attachment links once. A second row naming the same attachment is a Check problem; copying is later work.

**No new column on `migration_source` for the file kind.** The kind lives in the stored mapping JSON (3.4), so existing rows stay valid with no data migration.

**Limits** (all explicit, enforced in the service, shown in the UI):

| Limit | Value |
| --- | --- |
| CSV files per profile (people files included) | 50 (unchanged) |
| Rows and size per CSV | 20,000 and 10 MB (unchanged) |
| People per file | the row limit; one file is one target |
| Attachments per profile | 5,000 |
| One attachment | the field's `maxSizeMb`, else 25 MB (`FileService` rules) |
| Attachment path | at most 255 characters, no `..`, no leading `/`, unique ignoring case |
| Total attachment bytes | the organisation's remaining quota (default 1 GB); files count against quota from upload |
| Later ZIP (L5) | at most 5,000 entries, 500 MB expanded, expansion ratio ≤ 100:1, no nested archives, no absolute or `..` paths |

### 3.4 Mapping model

Stored shape of `migration_source.mapping` (extends `mapping.ts`):

```ts
type SourceMapping = RecordsMapping | PeopleMapping;

interface RecordsMapping { kind?: 'records'; targets: MigrationTarget[] }   // old rows have no kind

interface MigrationTarget {              // existing fields unchanged
  key; type; oldId; fields; refs; required;
  persons?: Record<string, { column: string; onMissing?: 'blank' | 'fail' }>;   // new, default {}
  files?:   Record<string, { column: string; separator?: ';' | ','; onMissing?: 'fail' | 'skip' }>; // new, default {}
}

interface PeopleMapping {
  kind: 'people';
  people: {
    oldId: string;                       // column
    email: string;                       // column
    name: string;                        // column
    roles?:  { column: string; separator?: ';' | ','; map?: Record<string, string | null> }
           | { fixed: string[] };
    status?: { column: string; active: string[]; suspended: string[] };
    locale?: string;                     // column
  };
}
```

Example people mapping:

```json
{ "kind": "people",
  "people": { "oldId": "UserId", "email": "Email", "name": "FullName",
    "roles": { "column": "Roles", "separator": ";", "map": { "Admin": "admin", "Clerk": "front-desk", "Guest": null } },
    "status": { "column": "Active", "active": ["1", "yes"], "suspended": ["0", "no"] },
    "locale": "Lang" } }
```

Validation (`readSourceMapping(input, columns, types, roles)`; it dispatches on `kind`, the records path is the current `readMapping`; all issues are returned with paths):

- **People:** `oldId`, `email`, `name` name distinct existing columns. `roles.column` exists; `separator` defaults to `;`. Every `map` value is an existing role key or `null` (ignore). `fixed` keys exist. `status.active` and `status.suspended` are non-empty, disjoint, compared ignoring case. Without `status`, everyone is active. A file is one kind only. The caller needs `data:migrate:people` and `members:manage`.
- **Records, persons:** the field exists and `type === 'person'`, is not also in `fields` or `refs`, and has an existing column. The column is **not** registered in `used`, so it may also fill a text field (decision 2). `fields` for a person field keeps working (email or user id, active members only).
- **Records, files:** the field exists with `type === 'file'`; `separator` only when `multiple`; the column is not used elsewhere; `required` person and file fields still need a mapping through the existing "needs" rule, except that a mapped `persons` or `files` entry satisfies it. Signature fields stay refused (L-matrix).

**Ordering across kinds.** A people file "writes" the pseudo-type `@people`; a record file that uses `persons` "needs" `@people`. `dependencies`, `checkOrder` and `deriveOrder` are unchanged otherwise, so saving a mapping reorders people files first, and a hand order that puts them later is refused with the existing message. Attachments are not files in the order: they are uploaded before the check. Confirm `@people` cannot collide with a record type key (type keys are validated elsewhere; I did not read that rule).

### 3.5 Run semantics

Common: the exclusive `migration` job, batch size 100, per-row `job_item` with `seq = index * 1,000,000 + row`, cancellation before the next batch (rows already written stay), progress `rows done / total rows`, final notice with counts, and the creator's current access re-checked every batch. Counts per file are `created`, `updated`, `failed`, plus a new `warned`.

**People row** (one file, one target; two transactions because the account is global):

1. Parse and validate: email regex and ≤ 254 as in `PeopleService.add`; name required, ≤ 120; old id ≤ 200; roles split, mapped, deduplicated; status; locale (checked against the supported locale list; I did not read it).
2. Look up the legacy id in `migration_person_key`. If linked, read the linked user's email in the tenant transaction and compare it ignoring case. A different email fails the row (rule R-people-1). Do this before touching the account, so a changed email never creates a stray account.
3. `members.accountByEmail(tenantId, email)`. A globally disabled account that is not already a member fails with the generic wording. A member already suspended here is only mapped.
4. If not already linked: `accounts.add(email, name)` (one owner transaction, idempotent).
5. `importMember` in a tenant transaction: create the membership (status from file, never changing an existing status), set locale and display name, add missing roles the actor may grant, write audit `member.imported`, write the mapping row through `alongside`. Suspended members get no roles (the platform refuses roles for suspended people); the Check warns.

Recovery. If the process stops after step 4 and before step 5, only a global account with no membership remains. No organisation can see it, and the next run converges. A batch that was written but not recorded as done is re-executed from the saved job state; every step is idempotent. `forgetActors()` runs once per batch.

New members show as **Invited**: active with `last_signed_in_at` null (the existing meaning in `PeopleService`). No password hash is written, no token is created and no mail function is called.

**Record row:** as today, plus before `saveTogether`:

- `persons`: look up each legacy id in `migration_person_key` joined with membership. Found and active (or suspended with the M4 flag) → the user id. Blank cell → leave blank. Not found → blank plus a `warned` count, or fail the row when `onMissing: 'fail'`. In Check, ids planned by an earlier people file count as found.
- `files`: for each name, find the attachment by path ignoring case. If the existing record already holds that attachment's file id in the field, change nothing. Otherwise put the file id in the field's value (array when `multiple`). `linkRecordFiles` then links it inside the row transaction and enforces `accept`, `maxSizeMb` and "attached elsewhere". Missing attachment: fail the row (default) or skip with a `warned` count. A failed row rolls back, leaves the attachment unlinked and still exempt from cleanup, so the next run retries it.

**Conflict and re-run rules**

| Case | Rule |
| --- | --- |
| Same old id, same email | Update display name and locale if changed; add missing roles; never remove roles; never change status; no change otherwise. |
| Same old id, different email | Fail the row: "This legacy user id is already linked to someone else here." It never re-maps, because records already hold the old link. |
| Two old ids, one email | Both map to the same user; Check warns (duplicate email). Roles are unioned. |
| Same old id twice in a file | The second row is an update, as for records. |
| Person already an active member, not migrated | Linked and left alone (roles added only if listed and grantable). This includes the administrator running the migration. |
| Record re-run, file already attached | No change. |
| Record re-run, different file in the column | The new file replaces it (the old one is unlinked and cleaned up later by the existing rule). |

Running the same profile twice changes nothing the second time except those updates.

**Failed rows.** `failed.csv` is built as today from the stored cells. New messages: `Email is not a valid address`, `Role 'X' does not exist`, `You cannot give the role 'X'`, `This legacy user id is already linked to someone else here`, `This email cannot be added. Ask the person to contact support.`, `File 'x.jpg' was not uploaded`, `File 'x.jpg' is used by another row`, `'Receipt scan' accepts only pdf files`.

### 3.6 Check

Check stays a dry run and now reports problems (block the row) and warnings (do not). `MigrationProblem` gains `severity?`; `MigrationCheck` gains `warnings: { kind, sourceId, fileName, count, samples: string[] }[]`, aggregated by kind and column so it stays small. The 200-problem cap is unchanged.

Check reports, before writing anything:

- People rows: invalid email, missing name, unknown or ungrantable role, `require_two_step` role (blocking, C7), status value in neither list, bad locale, one old id with two emails in the file (problem), duplicate emails across old ids (warning), roles skipped for suspended people (warning). It also reports "already members: n, will be linked" using this organisation's own data only. It does **not** look up accounts in other organisations, so it cannot disclose them. Run-time refusals for disabled accounts are the one problem Check cannot predict.
- Record rows: unresolved legacy user ids (warning, distinct ids), suspended people that cannot be linked (warning, until M4), missing or reused attachments, attachment kind or size against the field, attachments uploaded by another person, quota left against bytes to link.
- Safety guards (M1): a target type whose primary workflow `initial` state is the `whenStatus` of a posting or receipt rule is a blocking error ("saving these records would post a journal entry or issue a receipt"). Enabled scripts on a target type with `notify`, `connector.call` or `ledger.propose` effects are a blocking error until M0 lands, then a warning.

### 3.7 HTTP contracts

Contracts go in `packages/platform/src/http/contracts/migration.ts` using `schemaOf`, with `additionalProperties: false` at the top level and shallow shapes. `readSourceMapping` owns the deep rules.

| Route | Change |
| --- | --- |
| `PUT /api/migrations/:id/sources/:sourceId/mapping` | Body is either `{ targets: [...] }` (unchanged, now with optional `persons`, `files`) or `{ kind: 'people', people: {...} }`. Response is the profile view. 422 carries `FieldIssue[]` with paths such as `/people/roles/map/Admin`. |
| `POST /api/migrations/:id/attachments` | Raw body (like `…/sources`), `x-file-name` is the URI-encoded relative path. 201 `{ count, bytes }`. Refuses a running profile, a duplicate path, a path with `..`, files over their limit, and a 5,001st attachment. |
| `GET /api/migrations/:id/attachments?q=&limit=&offset=` | `{ items: [{ id, path, size, mime, usedBy: number }], total }`. |
| `DELETE /api/migrations/:id/attachments/:attachmentId` and `DELETE /api/migrations/:id/attachments` (clear) | 204. Resets the profile to draft. |
| `POST /api/migrations/:id/purge` | Deletes source CSVs and attachments, empties column samples, clears failed-row cells, sets `purged_at`. Refuses a running profile. Returns the profile view. |
| `GET /api/migrations/:id` | View adds `attachments: { count, bytes }`, `purgedAt`, `check.warnings`; `SourceView.mapping` is the union; `SourceView.kind: 'records' \| 'people'`; counts add `warned`. |
| `GET /api/session` | `migrationPeople` flag (from `session/http-api.ts`). |
| Later | `POST /api/migrations/:id/undo` (L1), `POST /api/migrations/:id/invite` (L6, job). |

Every route keeps `data:migrate`. Attachments and purge use `editable()`, so they are refused while running. Adding or removing an attachment calls `store.reset` so the profile returns to draft and must be checked again.

### 3.8 UI (`/admin/migration`)

Screens: `apps/onengo/web/src/app/admin/migration/migration.screen.ts` and `migration-store.ts`; models and gateway in `core/admin/migration.ts`. The six steps (`files, map, order, books, check, run`) stay; no new step.

- **Files:** the CSV drop area stays. Below it, an "Attachments" panel (optional): drop a folder or many files, shows count and bytes against the 5,000 and quota limits, a searchable list, remove and clear. A short note says each file can be used by one row.
- **Map:** opening a file now asks "What is in this file?": Records or People (a file with no mapping stays unrun, as today).
  - People form: Legacy id column, Email, Name, Roles (column, separator, and a table of each distinct legacy role value found in the sample column mapped to an existing role, or "ignore"), Status (column and which values mean active or suspended), Language. Roles that require two-step are disabled with the reason.
  - Record form: for each person field, a "Legacy user id column" next to the existing email-or-id choice, with "if not found: leave blank / fail the row"; for each file field, a "File name column" with "if missing: fail the row / skip".
- **Order:** people files show first; the existing reason text explains the dependency.
- **Check:** a summary per kind and a "Warnings" list grouped by kind ("12 legacy users in donations.csv are not in people.csv: U-17, U-22 …", "3 files not uploaded"). Blocking problems stay in the problems list and block Run as today.
- **Run and result:** people counts read "added / already here"; a "Delete source files and failed-row data" button (confirm) calls purge; once purged, the failed-rows links say the data was deleted.
- **Strings:** new keys under `ui.admin.migration.*` in `packages/product/locale/en.admin.json`, and the same keys in `packages/product/locale/untranslated.json` as the repo does today (about 100 existing migration keys sit there). No new dependency.

**Wireframe** `docs/wireframes/data-migrator.html`: add steps to the `STEPS` list for `files` with the attachments panel, `map-people`, `map-donors` with a person field and a file field, `check` with warnings, and `result` with the purge action. Redraw the stepper note to say the six steps are unchanged.

### 3.9 Security and privacy review

| Topic | Finding and decision |
| --- | --- |
| Permissions | New `data:migrate:people` plus `members:manage` for people. Roles only within `demandGrant` (the actor can never grant more than they hold). Permissions are re-read each batch with the creator's current access. |
| Cross-organisation disclosure | Check never reads other organisations' accounts. Reuse by email is silent: no "reused" count, no name, no status. The one exception is the generic wording for a globally disabled account, which mirrors `PeopleService.add` (R3). |
| Tenant isolation | Every new table has `tenant_id`, RLS `tenant_isolation` and the narrowest grants. Legacy ids may repeat across organisations; the primary keys include `tenant_id`. |
| Owner access | No new `asSystem` call. Account creation goes through the existing `AccountStore.add` capability and `accountByEmail`. |
| PII in uploaded sources | People files hold names and emails; record files may hold PAN and similar. Today the CSV is kept forever (C2). M2 adds purge, an automatic purge 30 days after a finished or failed run (via the existing file clean-up tick in `composition/scheduler.ts`; confirm cadence), and `purged_at`. |
| Samples and failed cells | After a mapping is saved, samples for columns mapped to sensitive or personal fields are blanked (the UI shows "hidden"). Failed-row cells for columns mapped to sensitive fields are stored empty. Other cells stay, because `failed.csv` is how the administrator fixes the file, and they are removed on purge. |
| Sensitive fields | Values are sealed on save by the normal pipeline (`encrypt.ts`); audit snapshots mask read-protected fields (`maskFor`). The migration adds no logging of values. Check messages include old ids, not field values. The parsed-file cache in `read()` is process memory only. Add a test that a sensitive value appears nowhere in `job_item`, `migration_source`, `audit_event` or logs. |
| Downloads | `failed.csv` can hold plaintext PII; add an audit event `migration.failed_rows_downloaded` (there is none today). |
| Two-step lock-out | Blocked by Check (C7). Documented: assign two-step roles after first sign-in and enrolment. This also exists for manual add today; fixing enrolment is separate. |
| Email | None sent. Mitigation M0 for scripts; Check guard for initial-state posting and receipt rules; no `inviteMember` call. The `user.updated` outbox event from `userUpdated` only updates followed fields. |
| Access-version churn | Each membership or role insert bumps `tenant.access_version`, so every instance revalidates actors. Acceptable; one `forgetActors()` per batch. Load-test a 20,000-person file (M3). |
| Uploader-only linking | Attachments are linkable only by the uploader; Check reports the mismatch. |

### 3.10 Tests

Unit (`packages/platform/test/`):
- `migration-mapping.test.ts`: people mapping rules and paths, role map, status lists, `persons` and `files` rules, a column used for both a person and a text field, kind dispatch with an old mapping lacking `kind`, `@people` ordering (people before records, hand order refused, cycle unaffected).
- New `migration-people.test.ts`: email normalisation, the conflict table, ID mapping with UUID, integer and text legacy ids, role grant refusal, `require_two_step` refusal, suspended-in-file handling.

Integration (`data-migration.test.ts`, extended, plus the real database):
- People then records in one profile; person fields link by legacy id; members show Invited; no `password_hash`, no `password_token`, no `notification` row of channel email, and the mail sender is never called.
- Existing account in another organisation is reused: same `app_user.id`, password hash and TOTP unchanged, name unchanged; nothing about it appears in the Check, in errors or in counts.
- Re-run twice: member, role-assignment, mapping and record counts unchanged; an edited name updates; a changed email for the same legacy id fails; a suspended member stays suspended; a manually added role stays.
- Two organisations with the same legacy ids (people and records) stay separate; a profile of organisation B cannot read A's `migration_person_key`; a cross-tenant insert fails with a row-level-security error (pattern from `migration-007.test.ts`).
- Crash recovery: stop between account and membership (fault injection on the second transaction), re-run converges.
- Files: attach on create; re-run with the same file is a no-op; accept and size refusals; unlinked attachment survives 24 h cleanup; another uploader is reported by Check; used-twice refusal; quota refusal.
- Quiet: a type with a `notify` script enqueues no `script.notify` or `connector.*` during a run (M0); Check blocks the initial-state receipt rule.
- Owner-capabilities test and `layer-graph` test pass unchanged.
- Sensitive plaintext does not appear in stored samples, failed cells, audit or logs. Purge removes CSVs and attachments and clears cells.
- Export test includes the new tables.

End to end (`tests/e2e`): extend `journeys/data/e2e-05-bulk-migration.spec.ts` or add the next free spec in `journeys/data/` for: upload people.csv, donors.csv with an owner column and a photo column, a folder of photos; Check shows two warnings and one blocking problem; fix; run; people list shows Invited; open a donor, see the owner name and the photo; re-run changes nothing; purge removes the failed-rows link; a user without `data:migrate:people` is refused.

## 4. Delivery blocks

Each block ships and tests alone. Effort assumes one engineer, with tests and doc changes inside the block. Migration numbers are the next free ones today.

| ID | Block | Effort | Depends on | Done when |
| --- | --- | --- | --- | --- |
| M0 | Honour `quiet` for scripts: skip enqueuing `script.notify`, `connector.http` and `connector.webhook` in `save/script-run.ts` when `ctx.quiet` | 1 d | — | A saved record in a quiet context with a notify and a connector script enqueues no event; a normal save still does; existing script tests pass |
| M1 | Check severity and warnings, plus guards: initial-state posting or receipt rule is blocking; risky script effects block (warn after M0) | 2 d | M0 | `MigrationCheck.warnings` and `severity` exist and render in the existing Check step; a profile whose type posts or receipts on its initial state cannot be checked as ready |
| M2 | Retention and redaction: migration `009`, `FileService.remove` for unlinked files, `POST /purge`, auto-purge after 30 days, sample and failed-cell redaction for sensitive columns, audit on `failed.csv` download | 3 d | — | After purge the CSVs are gone from the store and `file_object`, samples and cells are empty, a sensitive value is in none of the stored places, and the result screen offers Delete |
| M3 | People target: migration `010`, `readSourceMapping` and `PeopleMapping`, `IdentityService.importMember`, `MemberStore.importJoin`, `data:migrate:people`, Check and run for people files, failed rows | 6 d | M1 | A people file checks and runs: members appear Invited with roles, no email or password is created, a re-run changes nothing, existing accounts are reused without disclosure, `require_two_step` roles are refused, owner and layer tests pass |
| M4 | Person fields by legacy id: `persons` mapping, `@people` ordering, unresolved-person warnings, the `ctx.migrating` check relaxation so suspended members are linkable | 3 d | M3 | A donation's owner column fills the person field from the legacy id; unresolved ids warn and leave blank; `onMissing: 'fail'` fails the row; two organisations with the same legacy ids stay separate |
| M5 | UI for people and legacy user ids: mapping forms, role map table, order and check warnings, strings, wireframe steps | 4 d | M3, M4 (can start on M3) | An administrator maps a people file and a person field in `/admin/migration`; locale and `untranslated.json` updated; wireframe shows the screens; screen tests pass |
| M6 | Files: migration `011`, attachment routes and store, `files` mapping, Check and run linking, cleanup exemption | 6 d | M1, M2 | Files attach to records in the row transaction within size, type and quota rules; re-run is a no-op; unlinked attachments survive cleanup; Check reports every missing, reused or foreign file |
| M7 | UI for attachments and file fields, wireframe step | 3 d | M6 | Folder drop, list and remove work; the file column picker and missing-file option render; wireframe updated |
| M8 | End-to-end journey, architecture paragraph (both docs), user guide, final acceptance run | 2 d | M5, M7 | The journey passes; docs describe the new behaviour; every acceptance criterion in section 5 is covered by a test |
| L1 | Undo: `created_profile_id` on the key tables, `data:migrate:undo`, delete grant on mapping tables, undo job | 4 d | M3, M6 | Undo moves a profile's created records to the recycle bin and removes its created memberships and mappings; books, journal entries, receipts and accounts are untouched |
| L2 | Shares target | 3 d | M3 | Shares load by legacy user id or role through `ShareService`, without notices |
| L3 | Imported workflow state (`data:migrate:state`) | 4 d | M1 | A state column sets the status on create without journals or receipts; Check blocks rule-keyed states |
| L4 | XLSX and JSON-lines sources | 3 d | M3 | A sheet or `.jsonl` file enters the same pipeline within the same limits |
| L5 | ZIP bundle (new dependency, with a stated reason and zip-bomb guards) | 4 d | M6 | A ZIP with CSVs, a files folder and a manifest fills a profile within the 3.3 limits |
| L6 | Bulk invitations after migration (job using `inviteMember`, throttled, needs `ensureEmail`) | 3 d | M3 | An administrator sends invitations to chosen Invited people in a job; each person gets one link; a failure is listed |

v1 is M0 to M8 (about 30 days). M2 can run beside M1, and M3 beside M2.

## 5. Acceptance criteria for v1 (refined)

1. An administrator with `data:migrate`, `data:migrate:people` and `members:manage` migrates people and records in one profile. No password, two-step secret or invitation is created. Members show as **Invited**. A `require_two_step` role in the file is refused by Check.
2. Records' person fields link to the migrated people by legacy user id, for UUID, integer and text ids. Unknown legacy ids leave the field blank with a counted warning; `onMissing: 'fail'` fails the row.
3. Files named in a column attach to the records in the same row transaction, within size, type and quota rules, and the record's `file_object` shows it linked. A missing file fails the row or is skipped, as mapped.
4. Check reports every problem before anything is written: invalid people rows, unresolved legacy users, missing, reused or foreign files, the initial-state receipt rule, and risky scripts.
5. Re-running the same profile creates no duplicates, changes no status and removes no role; edits to names or files update.
6. Two organisations that use the same legacy ids stay separate for records, people and attachments.
7. No email, automation, script notification or receipt comes out of a run; a test asserts the mail sender and outbox.
8. Nothing about an account other organisations hold appears in any error, count or Check result.
9. Source CSVs and attachments can be deleted; sensitive values are not kept in samples or failed-row data.
10. Limits are shown and enforced; the owner-capabilities and layer tests pass; new tables have RLS and appear in the tenant export.

## 6. Documentation updates

- `docs/architecture/ngo-platform-architecture.md` section 6.14 (the "Data migration" bullet, around line 690) and the same text in `docs/architecture.md` (around line 725): replace "migration 018" with the real file numbers, say that tables live in `001_core.sql` plus the new files, add people files, `migration_person_key`, person fields by legacy id, files and attachments, the new permission, retention, the Check warnings, and what is out of scope. Correct the sentence "File and signature fields cannot be filled" (file fields can after M6).
- `docs/wireframes/data-migrator.html`: as in 3.8.
- User guide: `docs/user-guide/` holds `index.html` and `builder-guide.html` (and `apps/onengo-guide` exists). I did not search them for a migrator section; add one at M8 covering: export people and records as CSV, order of files, legacy roles, two-step roles, photos, warnings, re-runs, deleting source data, and the "history in a field" pattern.
- `packages/product/locale/en.admin.json` and `untranslated.json`: new `ui.admin.migration.*` keys.

## 7. Risks and open questions for a person

- **R1 Roles defaults.** Which existing roles, besides `admin` (`*`), should get `data:migrate:people`? I did not read the shipped role JSON.
- **R2 Supported locales.** Which list validates the people `locale` column? Not read.
- **R3 Disabled-account wording.** A run reveals "cannot be added" for globally disabled accounts, one per row. Accept (it matches `PeopleService.add`), or make the wording identical to other generic failures.
- **R4 Two-step enrolment.** A role with `require_two_step` cannot be given to anyone without a prior session, for manual add as well as migration (C7). A real enrolment path (an admin-initiated enrolment link, or letting an unenrolled person reach Settings) is a separate decision.
- **R5 History.** Is a read-only "Imported history" display wanted? The recommended pattern is a field the type declares. A first-class feature is a product change.
- **R6 Retention period.** 30 days to auto-purge sources is my proposal. Legal or donor-data rules may need a different value or a per-organisation setting.
- **R7 Legacy ids as personal data.** If a legacy id is an email or a national id, should erasure remove its mapping rows? Needs a decision and a look at the erasure flow.
- **R8 Attachment ownership.** Only the uploader can link an unlinked file. Is it acceptable that only the person who uploaded can run the profile, or should linking be extended for migration? Extending `linkRecordFiles` touches the core save.
- **R9 Account-import path.** I did not check whether chart-of-accounts, funds or fiscal years can be created by an existing API. If they can, a "setup" kind could be planned; otherwise they stay out.
- **R10 Large people files.** 20,000 people means about 80,000 statements and as many `access_version` bumps, and each instance revalidates actors. M3 must measure it. If it hurts, batch the bump or lower the limit for people files.
- **R11 Signatures and original dates.** Neither can keep legacy timestamps. If auditors need that, it needs a platform change that I have not proposed.

## 8. What differs from this plan

The sections above are the plan as approved. The code differs in these places; the code and the architecture doc (section 6.14) are the source of truth.

- **Warning kinds.** Check warnings are `MigrationWarning { kind, sourceId, fileName, count, column?, target?, samples }` with these kinds: `unresolved-legacy-users`, `missing-attachments`, `optional-target-left-out`, `storage-over-quota`, `script-effects-suppressed`, `already-members`, `duplicate-email`, `roles-skipped-suspended`. Unresolved users and missing files carry the `column` and at most five samples; an optional target the run would leave out carries the `target` key and at most five rows with the reason, and the run counts those rows as warned.
- **Guards** (`application/migration/guards.ts`). A posting or receipt rule on the starting state blocks, also for a parallel workflow without `startsWhen`. Scripts: after M0 a `notify` or `connector.call` script only warns (`script-effects-suppressed`), but a save-hook script allowed `ledger.propose` blocks, because a quiet save does not stop proposed journals and Check cannot know which rows would propose one.
- **Purge rules.** `POST /api/migrations/:id/purge` soft-deletes the source `file_object` rows and deletes unlinked attachments with their bytes (files a record holds stay with the record), blanks samples, clears failed-row cells, stamps `purged_at` on sources and profile, and audits `migration.purged`. A profile with a purged file cannot be checked or run until that file is removed and uploaded again; `failed.csv` of a purged file answers 409. Repeating a purge only purges what was uploaded since. Downloading `failed.csv` is audited as `migration.failed_rows_downloaded`.
- **Automatic purge.** `MIGRATION_RETENTION_DAYS = 30`; the scheduler queues the `migration.purge` job for organisations with finished or failed profiles older than that (`tenantsWithExpiredData`), 20 profiles per batch.
- **Upload response.** `POST /api/migrations/:id/attachments` answers `{ count, bytes }`, the profile's totals (as the plan said); the listing answers `{ items: [{ id, path, size, mime, usedBy }], total }`.
- **People mapping limits.** Role separators are `;` (default), `,` and `|`. A fixed role list holds 1 to 50 keys; status lists hold 1 to 100 values each and may not overlap (compared ignoring case). Role map values are an existing role key or `null`.
- **Erasure.** Migration `010` also creates the `SECURITY DEFINER` function `app_erase_migration_person_key(member)`, which deletes a suspended member's legacy ids in the current organisation (the runtime role has no delete grant). This settles the plan's open question R7: erasure removes the mapping rows.
- **Schema level** is 11 (`009`, `010`, `011`), with `main: 11` in `SERVER_SCHEMA_MINIMUMS`. The new tables are in `TENANT_TABLES`.
- **Messages** use the plan's wording, plus `This legacy user id is already linked to someone else here.` and `This email cannot be added. Ask the person to contact support.` as constants in `application/migration/people.ts`.
- **UI.** The six steps are unchanged; opening a file asks "What is in this file?" (Records or People). The People option is disabled with a reason when the session lacks `migrationPeople`. Attachments are dropped or chosen as a folder or files on the Files step. Strings are under `ui.admin.migration.*`.
- **Not built** (as planned): undo (L1), shares (L2), workflow state (L3), XLSX and JSON lines (L4), ZIP (L5), bulk invitations (L6), signatures, `record_link`.
- **End to end.** The journey is `tests/e2e/specs/journeys/data/e2e-12-legacy-migration.spec.ts` (`e2e-10` and `e2e-11` were taken). It sets up the profile through the API and checks what the administrator sees on screen. It was written against the real labels and routes but has not been executed (see the report of M8).

## 9. Acceptance criteria and the tests that cover them

Backend tests are in `packages/platform/test/`. The journey is `tests/e2e/specs/journeys/data/e2e-12-legacy-migration.spec.ts` (not executed yet).

| # | Criterion | Tests (file: test name) |
| --- | --- | --- |
| 1 | People and records in one profile; Invited; no password, two-step secret or invitation; two-step role refused | `migration-people.test.ts`: "adds Invited members with no password, token or mail, for UUID, integer and text ids"; "refuses a role the migrator may not give and a role needing two-step at check and at run time"; "needs data:migrate:people and members:manage to map, check or run one". `migration-acceptance.test.ts`: "people and records run with no mail, outbox event, email notice, receipt, invitation or automation, …" (one profile). E2E: FT-MIG-901 to 903. |
| 2 | Person fields by legacy id (UUID, integer, text); unknown id blank with a counted warning; `onMissing: 'fail'` fails the row | `migration-persons.test.ts`: "fills the field from UUID, integer and text legacy ids, and leaves a blank cell blank"; "leaves an unresolved id blank, saves the row, counts it as warned and warns once per distinct id"; "with onMissing 'fail' an unresolved id is a blocking problem and fails the row at run time"; "links a suspended member during the run only, …". |
| 3 | Files attach in the row transaction within size, type and quota; missing file fails or skips | `migration-files.test.ts`: "links the attachment to the new record, finding it ignoring case"; "splits a multiple field by its separator and links every file"; "refuses a file the field does not accept, and one over its size, with the normal save messages"; "refuses an upload past the organisation quota"; "fails a row whose file was not uploaded (the default) and skips it with a warning on request". Linking inside the row transaction is implicit in `saveTogether`; no test injects a failure after the link. |
| 4 | Check reports every problem first: invalid people rows, unresolved users, missing, reused or foreign files, initial-state receipt rule, risky scripts | `migration-people.test.ts`: "reports every problem and warning of plan 3.6 from this organisation alone". `migration-persons.test.ts`: unresolved-id warning. `migration-files.test.ts`: "reports a file uploaded by another person at check time, and links nothing"; "refuses an attachment used by two rows, in the check and in the run"; "lists at most five missing names in the warning". `migration-check.test.ts`: "blocks a type whose initial state issues a receipt"; "… posts a journal entry"; "blocks a script that may propose journal entries, …"; "warns, without blocking, about a notify script". |
| 5 | Re-run: no duplicates, no status change, no role removed; edits to names and files update | `migration-people.test.ts`: "changes nothing on a second run, then follows edited names and languages and adds roles only"; "never changes a status: …"; "fails a row whose legacy id is linked to another email, before creating any account". `migration-persons.test.ts`: "is a no-op the second time". `migration-files.test.ts`: "changes nothing when run again with the same file, and replaces it when the column names another". `data-migration.test.ts`: "updates by old id on a second run instead of adding records again". |
| 6 | Two organisations with the same legacy ids stay apart (records, people, attachments) | `migration-people.test.ts`: "keeps two organisations with the same legacy ids and emails apart"; "refuses a cross-tenant insert on migration_person_key with a row-level security error". `migration-persons.test.ts`: "keeps two organisations with the same legacy ids apart". `migration-files.test.ts`: "keeps the attachments of two organisations apart, even with the same paths". `data-migration.test.ts`: "needs the migration permission, the import permission of each record type, and stays in its organisation". |
| 7 | No email, automation, script notification or receipt comes out of a run; asserted on the mail sender and the outbox | **Added:** `migration-acceptance.test.ts`: "people and records run with no mail, outbox event, email notice, receipt, invitation or automation, while a normal save of the same type does send them" (mail sender, `script.*`, `connector.*` and email outbox rows, email notices, receipts and invitation tokens before and after; automation tag unset; a normal save still enqueues the three script events). Also `migration-people.test.ts` (mail sender, tokens, notices), `data-migration.test.ts`: "runs quietly in order, …" (automation off), `script-effects.test.ts`: "quiet saves enqueue neither script.notify nor connector events, …". |
| 8 | Nothing about an account other organisations hold appears in any error, count or Check result | `migration-people.test.ts`: "reuses an existing account silently: same id, password, name, and nothing in the check, errors or counts"; "refuses a globally disabled account that is not a member with the generic wording only"; "reports every problem and warning of plan 3.6 from this organisation alone". No new test was needed. |
| 9 | Sources and attachments can be deleted; sensitive values are not kept in samples or failed rows | `migration-retention.test.ts`: "blanks samples of sensitive and personal columns once the mapping is saved, …"; "stores failed rows without the cells of sensitive columns and keeps the rest"; "leaves a sensitive value in no migration_source, job_item or audit row"; "deletes the files, samples and failed cells, and stamps purged_at"; "purges a finished or failed migration 30 days after it finished, and not before". `migration-files.test.ts`: "deletes unlinked attachments with their bytes and the rows, and leaves files a record holds". |
| 10 | Limits shown and enforced; owner-capabilities and layer tests pass; new tables have RLS and are in the export | Enforced: `migration-files.test.ts`: "refuses the 5,001st attachment and a file over the upload limit"; "refuses bad paths, a path used ignoring case, and a running profile"; "refuses an upload past the organisation quota". **Added:** `migration-acceptance.test.ts`: "has row-level security and a tenant_isolation policy on every migration table"; "is in the organisation export"; "gives the runtime role only the narrow grants, and no delete on the people map". Also `migration-007.test.ts`, `migration-files.test.ts`: "is part of the organisation export and goes with its profile". `owner-capabilities.test.ts` passes. `layer-architecture.test.ts` has four failures that name only connector and identity port files, none from the migration code. **Weak:** "shown" has no screen test (the limits are strings in the Files step); the 50-file and 20,000-row limits are unchanged from before this plan and no test was added for them here. |

Weakest coverage: 3 (the same-transaction guarantee is not fault-injected), 10 ("shown"), and the browser journey, which has not been run.
