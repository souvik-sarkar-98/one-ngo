# Kysely migration plan — raw SQL to typed fixed-table queries

Status: **implemented 2026-10-25** (P0, K0–K7 on branch `kysely`; see §9). Approved 2026-10-25. Implements block **B00** (`ngo-release-1-build-blocks.md`, checkpoints K1–K5) on the finished Release 1 code, then reruns B45.

**Decisions (2026-10-25):** install `kysely`; money and big counters stay `string`; K1–K6 run in parallel worktrees (up to four); **PGlite is removed completely**: the app, the seed, the tests and the type generator all use local PostgreSQL. This adds step **P0** before K0, and the type generator reads the schema from PostgreSQL instead of PGlite.

**Local PostgreSQL (surveyed):** PostgreSQL 18.6, portable install at `%LOCALAPPDATA%\postgres` (`pgsql\bin`, data in `data\`, log in `logfile`), no Windows service, `localhost:5432`, trust authentication for local connections, only the `postgres` database exists.

## 1. Goal and non-goals

**Goal.** Every application query against a *fixed* engine table gets compile-time checks on table names, column names, value types and nullability, with no change in behaviour, transactions, locking, row-level security or query plans.

**Not in scope.**

- Migrations stay plain SQL files and remain the schema source of truth. This plan (B00) does not use Kysely's migrator. B00b, the same day, runs those files through `migrateToLatest()` and leaves type generation on `scripts/gen-db-types.mjs`.
- Dynamic record SQL stays parameterised SQL: list/count/aggregate clause building, `buildQuery`, `metadata/index-expressions.ts`, and calls to `app_record_ids`, `app_record_count` and `app_record_agg`.
- Also unchanged: `TENANT_PREAMBLE`, managed-index DDL, and the journal and receipt triggers.
- No schema redesign, renames, query optimisation or business-behaviour change. No Prisma, TypeORM or other ORM.

## 2. Where we start (surveyed 2026-10-25)

| Fact | Value |
| --- | --- |
| Migrations | 13 (`001_core` … `013_people_admin`) |
| Fixed tables | 48 (`tenant`, `app_user`, `tenant_member`, `role`, `definition`, `record`, `record_link`, `job`, `journal_entry`, `receipt`, …) |
| `.query(` call sites in `src/` | 372 across ~45 files |
| Database port | `src/kernel/db.ts`: `SqlExecutor.query(sql, params)`; transactions only through `withTenant()` and `asSystem()`; `joinTransaction()` for one shared transaction |
| Adapters | `pg-database.ts` (node-postgres pool) and `pglite-database.ts` (tests and local); no custom type parsers |
| Column types to map | `timestamptz` 76, `jsonb` 42, `date` 10, `numeric` 8, `bigint` 5, plus `uuid`, `text`, `boolean`, `integer`, arrays |
| Kysely | not installed |

Largest areas by call sites: identity-service 48, definition-service 44, record-service 34, people-service 15, jobs 14, payment-service 13, roles-service 12, connector-service 11, notification-service 11, ledger 11.

## 3. Design

### 3.1 One transaction path (K1)

- **Executor.** A small Kysely dialect in `src/kernel/kysely.ts`: Postgres adapter and query compiler, plus a driver whose single "connection" runs every compiled query through the `SqlExecutor` it was given. No pool, no connection of its own.
- **Entry point.** `typed(tx)` returns `Kysely<DB>` bound to that transaction's executor. Services keep opening transactions exactly as today and mix both styles in one transaction:

  ```ts
  return this.db.withTenant(ctx.tenantId, async (tx) => {
    const k = typed(tx);
    const member = await k.selectFrom('tenant_member').select(['user_id', 'status']).where('user_id', '=', userId).executeTakeFirst();
    // raw SQL in the same transaction still works: tx.query(...)
  });
  ```

- **No nested transactions.** Kysely's own `transaction()` and savepoints are disabled and throw, so `withTenant()`, `asSystem()` and `joinTransaction()` stay the only ways to open a transaction.
- **Row-level security.** Tenant queries run after `TENANT_PREAMBLE` because they share the executor, so row-level security applies unchanged.
- **Both databases.** PGlite and PostgreSQL go through the same code.

### 3.2 Generated, checked-in types (K2)

- **Generator.** `scripts/gen-db-types.mjs`, run as `npm run db:types`, uses only the repo's own dependencies:
  1. connect to the local test database (derived from `DATABASE_URL`) and create a throwaway schema;
  2. run every migration in that schema (dropped afterwards);
  3. read `information_schema.columns` and the primary-key and default metadata;
  4. write `src/kernel/db-types.ts` (`interface DB { tenant: TenantTable; … }`).
- **Stale check.** `npm run db:types -- --check` exits non-zero if the file would change. A vitest test runs the check, so a migration without regenerated types fails CI.
- **Type mapping.** It must match what the adapters actually return today; a test asserts each shape on local PostgreSQL through `PgDatabase`.

  | PostgreSQL | TypeScript (select) | Note |
  | --- | --- | --- |
  | `uuid`, `text` | `string` | |
  | `integer` | `number` | |
  | `bigint`, `numeric` | `string` | exact money and counters; never JS `number` |
  | `boolean` | `boolean` | |
  | `timestamptz`, `date` | `Date` | inserts accept `Date \| string` |
  | `jsonb` | `Json` (or a narrower named type per column, see 3.3) | |
  | arrays | `T[]` | |
  | nullable | `T \| null` | |
  | has default | `Generated<T>` | optional on insert |

- **`record` and `record_link`.** These get types for their fixed columns only. Record data stays `Json`.
- **Spot check first.** If PGlite and node-postgres differ for any type (for example `numeric` or `date`), the mapping records the shape both share, and the step that touches those columns normalises at the edge exactly as the code does now.

### 3.3 Narrow JSON types (optional, per area)

The generator can take a small override map (`scripts/db-type-overrides.json`) that names the TypeScript type for specific `jsonb` columns (for example `definition.body` → `DefinitionBody`, `job.payload` → `JobPayload`). Add overrides only when an area is converted and the type already exists; never invent runtime validation here.

### 3.4 What stays raw, and the guard that keeps it that way (K4)

An architecture test lists the files allowed to call `.query(` with hand-written SQL:

- the adapters, `migrate.ts` and the preamble;
- the dynamic record files: `record-service.ts` (only the dynamic parts), `index-expressions.ts`, `aggregates.ts`, `index-manager.ts` (DDL);
- any query a step explicitly exempts, with a reason comment in the test's allow-list.

**Ratchet.** The allow-list holds each file's current count, and every step lowers it. A new raw query on a fixed table outside the list fails the test.

**Escape hatch.** Inside Kysely, `sql\`…\`` fragments are allowed for expressions Kysely can't express directly (`= any($1)`, jsonb operators, `for update skip locked`, `on conflict … do update`). They are still parameterised and still typed at the table level.

## 4. Steps

Each step is one bounded area, one worktree, one commit, with no behaviour change. **P0** runs first, then **K0**. After K0, steps K1–K6 touch separate files and run in parallel (up to four at a time). K7 runs last.

| Step | Area | Files | Call sites | Notes |
| --- | --- | --- | --- | --- |
| **P0** | Replace PGlite with local PostgreSQL | `kernel/pglite-database.ts` (removed), `http/main.ts`, `scripts/dev-seed.ts`, `scripts/dev.ps1`, `scripts/measure-footprint.ts`, `test/helpers.ts`, `vitest` setup, `.env.example`, `package.json` | — | See §4.1 |
| **K0** | Foundation | `kernel/kysely.ts`, `kernel/db-types.ts`, `scripts/gen-db-types.mjs`, tests, `package.json` | 0 converted | Add `kysely` (one `npm install`, needs approval); dialect over `SqlExecutor`; `typed(tx)`; generator, `--check` test, type-shape test, isolation test; raw-SQL allow-list at current counts |
| **K1** | Kernel | `jobs`, `audit`, `idempotency`, `rate-limit`, `retention`, `outbox-dispatcher`, `tenants`, `tenant-export`, `sequences` | ~35 | Keep `for update skip locked` and the job claim semantics exactly; `sequences` keeps its locking upsert (Kysely `onConflict` or `sql` fragment) |
| **K2** | Identity | `identity-service`, `oidc`, `api-key-service`, `roles-service`, `people-service`, `profile-service`, `pin-service`, `access-service` | ~106 | Biggest area; split into K2a (identity, oidc, api keys) and K2b (roles, people, profiles, pins) if it gets long. People list CTE (`PEOPLE`) may stay a `sql` fragment |
| **K3** | Metadata | `definition-service`, `runtime`, `index-manager` (registry rows only), `builder-support` | ~62 | Definition layering and publish stay in one transaction; `index-manager` DDL stays raw |
| **K4** | Money | `ledger`, `money-accounts`, `payments/payment-service`, `receipts`, `actions/receipt-print` | ~41 | Triggers untouched; `numeric` stays `string` end to end; balance checks and posting order unchanged |
| **K5** | Engines | `approvals`, `notify`, `connectors`, `automation`, `files`, `imports`, `export-service`, `share-service`, `admin`, `person-fields` | ~78 | `share-service` visibility joins checked against the existing sharing tests |
| **K6** | Records (fixed parts) | `record-service` (get by id, version checks, links, history), `record_link` access | part of 34 | `buildQuery`, list/count/aggregate and `app_record_*` calls stay raw; record filter and search plans unchanged |
| **K7** | Finish | allow-list, docs, PostgreSQL run, B45 rerun | — | Allow-list at its final size; full suite on local PostgreSQL; plan-equality test; update the architecture doc's Persistence row and B00 status; rerun B45 and refresh the validation report |

### 4.1 P0 — Replace PGlite with local PostgreSQL

- **Dependencies.** Remove `@electric-sql/pglite` from `package.json` and the lockfile (`npm uninstall --package-lock-only`, so the shared `node_modules` stays usable until the merge). Delete `src/kernel/pglite-database.ts` (file deletion approved with this step).
- **App and seed.** `DATABASE_URL` is required; `.env.example` defaults it to `postgres://postgres@localhost:5432/ngo` and drops `PGLITE_DATA_DIR`. `main.ts`, `dev-seed.ts` and `measure-footprint.ts` use `PgDatabase` only.
- **`dev.ps1`.** Before anything touches the database:
  1. Find the PostgreSQL binaries: `PG_BIN` in `.env`, else `pg_ctl` on `PATH`, else `%LOCALAPPDATA%\postgres\pgsql\bin`.
  2. Find the data folder: `PGDATA` in `.env`, else `%LOCALAPPDATA%\postgres\data`.
  3. If `pg_isready` fails, start it with `pg_ctl start -w -l <data>\..\logfile`, without piping its output, so the shell doesn't wait on the server.
  4. Create the database named in `DATABASE_URL` if it is missing.
  5. Seed when the database is new or empty.

  `-Reset` drops and recreates that database after asking first. The script never stops PostgreSQL.
- **Production-like local runs (decided 2026-10-25).** Local runs use production code on local infrastructure:
  - `NODE_ENV=production`.
  - No `DEV_AUTH` switch at runtime. Header sign-in exists only for tests (`NODE_ENV=test`), and the footprint script signs in for real.
  - No `INSECURE_COOKIES`: cookies are always Secure, which works on `localhost`.
  - Production defaults in `.env.example`, including the breached-password check, which has the same offline fallback as production.
  - Email still writes links to the server log when SMTP isn't configured. A local mail catcher hasn't been approved.
- **Tests.** There is no `TEST_DATABASE_URL` (removed 2026-10-25). Tests derive their database from `DATABASE_URL` by swapping the database name for `<name>_test` (for example `ngo` becomes `ngo_test`). They refuse to run if that equals the dev database. A vitest global setup creates the derived database if missing. Cluster-wide objects (the `app_runtime` and other roles) are created once there, not per test, so parallel workers don't race.
- **Test isolation.** Each test world gets its own schema with a random name. Migrations run in that schema through `PgDatabase`'s `schema` option, and the world drops its schema when it closes. Parallel worktrees can run their suites against the same server at the same time.
- **Checks.**
  - Every migration and security-definer function works when the search path is a non-public schema.
  - Row-level security, `app_runtime` grants and the `app_record_*` functions behave as they did on PGlite.
  - The trigram search test runs with real `pg_trgm`, or uses the fallback when the extension isn't available.
- **Done.** No mention of PGlite is left in `src/`, `scripts/`, `test/` or `package.json`. The full suite passes on local PostgreSQL. `dev.ps1` starts PostgreSQL, creates and seeds the database, and serves the app.

### Per-step checklist

1. Run `npm run db:types -- --check` first. It must be clean.
2. Convert queries one function at a time. Keep the same SQL semantics: columns, ordering, limits, locking, `returning`, conflict handling.
3. Don't change function signatures that other areas call, unless it's a pure type tightening.
4. Lower the allow-list counts for the touched files.
5. Run the area's tests, then root `npx tsc --noEmit` and the full `npx vitest run --maxWorkers=3`.
6. Commit with explicit paths: "Kysely: <area>".

## 5. Tests that prove it (K5)

- Tenant and system transactions through `typed(tx)` on local PostgreSQL.
- Row-level security: a Kysely query in tenant A's transaction can't read or write tenant B's rows.
- Kysely's `transaction()` throws. Rollback of a failed `withTenant()` also undoes Kysely writes. `joinTransaction()` still commits or rolls back as one unit.
- Generated types match the migrations (the `--check` test). Changing a known column without regenerating fails.
- Runtime shapes per column type match the generated types on both adapters.
- `EXPLAIN` for the record filter and search queries is unchanged (existing plan tests stay green).
- The whole existing suite (1,079 tests at the start) passes after every step.

## 6. Risks and how each is handled

| Risk | Handling |
| --- | --- |
| Driver type differences (`numeric`, `bigint`, `date`) between PGlite and node-postgres | K0 shape test on both; the mapping uses the shared shape; no new type parsers in this migration |
| Locking or ordering subtly changes (job claims, sequences, approvals) | Convert like for like; keep `forUpdate()`/`skipLocked()` or a `sql` fragment; the existing concurrency tests must stay green |
| A second connection or transaction sneaks in | The dialect has no pool; `transaction()` throws; an architecture test forbids `new Kysely(` outside `kernel/kysely.ts` |
| Dynamic SQL forced into Kysely loses safety or plans | Explicitly out of scope (§1, §3.4); the allow-list keeps those files raw |
| Types drift after a later migration | The `--check` test fails until `npm run db:types` is rerun and committed (rule already in B00 and release 2's common rules) |
| Merge conflicts across parallel steps | Each step owns distinct files; `db-types.ts` changes only in K0 and in later migrations |
| First download budget | Kysely is server-only and must never be imported by `web/`; an architecture test checks it |

## 7. Done

- K1–K5 are evidenced as in §5.
- Root `npx tsc --noEmit`, `npx tsc -p web/tsconfig.app.json --noEmit`, `npm --prefix web run build` and `npx vitest run` all pass.
- The suite passes on local PostgreSQL (the test database derived from `DATABASE_URL`).
- The raw-SQL allow-list contains only the paths in §1.
- B45 has been rerun and the validation report refreshed.

## 8. Decisions needed before K0

1. **Install `kysely`.** One `npm install kysely` at the root, from the npm registry. Nothing else is needed, because the type generator uses PGlite, which is already installed.
2. **Type generator.** The plan uses a small in-repo generator over PGlite. The alternative, `kysely-codegen`, adds another dependency and needs a running PostgreSQL to read the schema.
3. **Money and counters as `string`.** The plan keeps today's runtime shape. Switching to `number` or `bigint` would be a behaviour change and belongs in its own block.
4. **Parallelism.** After K0, run K1–K6 in parallel worktrees (up to four at a time) or one after another. Parallel is faster, and the areas don't share files.

## 9. As implemented (2026-10-25)

P0 and K0–K6 were built in parallel worktrees and merged into the integration branch `kysely` (`6d15903`); K7 finished it there (`42e1b56`). PGlite is gone: the app, the seed, the type generator and the tests all use local PostgreSQL.

**Raw SQL at the end.** The ratchet counts SQL executor calls (`tx.query(…)`, `pool.query(…)`, `client.query(…)`), down from 372 to **32 in 11 files**. Every remaining file has a reason in `test/raw-sql-baseline.json`:

| File | Calls | Why it stays raw |
| --- | --- | --- |
| `kernel/pg-database.ts` | 8 | The adapter: pool check, `begin`/`commit`/`rollback`, `TENANT_PREAMBLE` |
| `kernel/kysely.ts` | 1 | Runs Kysely's compiled, parameterised SQL through the transaction executor |
| `kernel/migrate.ts` | 1 | The migrator (plain SQL files, `schema_migration`) |
| `engines/records/record-service.ts` | 8 | `app_record_ids` / `app_record_count` / `app_record_agg` calls built by `buildQuery` |
| `engines/records/aggregates.ts` | 1 | `app_record_agg` |
| `metadata/index-manager.ts` | 1 | Managed-index DDL |
| `kernel/retention.ts` | 1 | Batched `ctid` deletes over a list of tables (dynamic table name) |
| `kernel/tenant-export.ts` | 2 | Snapshot isolation statement; paged `select *` over every tenant table (dynamic table name) |
| `identity/people-service.ts` | 5 | The `PEOPLE` CTE (members list, status counts, directory, by-id lookup) with filters on its derived columns |
| `engines/approvals/approval-service.ts` | 3 | Approvals list and count over `unnest()` of the eligible (type, step) pairs |
| `platform.ts` | 1 | Catalog check for the `pg_trgm` extension |

**Deviations from the plan.**

- **Allow-list.** Besides the §1 paths, it keeps the people CTE, the approvals `unnest` queries, the dynamic-table loops in retention and tenant export, and the `pg_trgm` catalog check. The reasons are in the table above. `metadata/index-expressions.ts` stays listed with no calls.
- **Ratchet (K7).** It no longer counts service methods named `query` (`records.query(ctx, …)`, `approvals.query(await context(req), …)`, `this.query(ctx, …)`). They run no SQL and made up 4 of the 38 calls left after K6. Every file that keeps raw SQL must now have a reason in `raw`. Before this, `http/openapi.ts` and `platform.ts` had counts but no reason.
- **Stragglers converted in K7.** The tenant name in `http/openapi.ts` and the SMTP connector lookup in `platform.ts`.
- **Shape test** (§5): runs on PostgreSQL only, since there is no second adapter any more.
- **Type generator** (§8, items 1–2): reads the schema from local PostgreSQL, not PGlite.
- **Plan-equality test (K7).** `test/kysely-plans.test.ts` plans master's SQL against the statements the converted services send now. It covers the job list and count, job items, audit log, roles, pending approvals and the notification inbox, with and without filters, and with sequential scans both on and off. The scans and indexes are identical. The old `($n is null or …)` filters never prevented an index: node-postgres sends unnamed statements, which are always planned with the values bound, so the null branch folded away. The record filter and search plan tests in `test/indexes.test.ts` stay green.

**Result.** Root and web typecheck clean; `npm run db:types -- --check` clean; web build passes. The suite passes on local PostgreSQL with the web build present: **1,114 tests in 101 files**, none skipped (1,079 at the start), and no `ngo_t_%` test schemas are left afterwards. B45 was rerun: 46 of 47 checks pass (`.cursor/docs/reports/release-validation-2026-10-25.md`). The one failure is C4, the initial download at 91.4 of 90 kB. It comes from master's web commits after 2026-10-24; this migration changed nothing in `web/`. The release check now normalises `--root`, because a lowercase drive letter made Vitest fail to load.

### 9.1 Per-machine setup

- **`.env`.** Set `DATABASE_URL`, for example `postgres://postgres@localhost:5432/ngo`; `.env.example` has the default. Optionally set `PG_BIN` and `PGDATA` when PostgreSQL isn't in `%LOCALAPPDATA%\postgres`.
- **`scripts/dev.ps1`.** Starts PostgreSQL if `pg_isready` fails (`pg_ctl start -w`), creates the database named in `DATABASE_URL`, seeds it when it's new, then serves the app. It never stops PostgreSQL. `-Reset` drops and recreates the database after asking.
- **Tests.** They use `<name>_test`, derived from `DATABASE_URL` (for example `ngo_test`). A vitest global setup creates that database, and each test world works in its own random `ngo_t_…` schema, dropped on close.
- **After merging the branch.** Run `npm install` in the checkout, since `kysely` is new and `@electric-sql/pglite` is removed. Then restart the dev server.

### 9.2 After a migration: regenerate the types

1. Add the migration file under `migrations/`.
2. Run `npm run db:types`. It migrates a throwaway schema in the test database, reads the columns and writes `src/kernel/db-types.ts`.
3. Commit `db-types.ts` together with the migration. `npm run db:types -- --check`, which a vitest test also runs, fails while the file is stale.
4. Use `typed(tx)` for new queries on fixed tables. A new raw `.query(` on a fixed table fails the ratchet in `test/kysely-architecture.test.ts`.
