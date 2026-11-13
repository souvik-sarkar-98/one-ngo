# Backend building blocks

The pre-existing rows are the 2026-10-25 snapshot of section 5.1 in `ngo-backend-enhancement-plan.md`; Track A was added from the updated section 5.1 on 2026-10-26. Section 5.1 is authoritative. Before scheduling a pre-existing row, reconcile its status here; when any block changes state, update section 5.1 first, then this sheet.

**Shared rules for any row that is not Merged or Blocked.**

1. Start only after every block named under "Start after" in What to do is Merged.
2. Branch `block/<ID>-<short-name>` and worktree `ngo-worktrees/<ID>` from the current tip of `backend_enhancement`.
3. Change only what that row describes. Do not install a package, call the public internet, or push to a remote. Stop and ask a person when the row says so.
4. Before merge, in the worktree, run `npx tsc --noEmit`, then `npx vitest run test/layer-architecture.test.ts test/kysely-architecture.test.ts test/web-architecture.test.ts test/route-guard.test.ts`, then the tests named in the row.
5. Merge into `backend_enhancement` with `--no-ff`. Do not run the full suite. `ngo-worktrees/run-suite.ps1` runs on `backend_enhancement` after each round of merges.

**One branch, not two.** D11 includes D5. D6 includes P3. H2 includes H3. H4 includes H5. X2 includes X3. O2 includes O7. D11 starts only after D9 has merged.

## Track F — Foundations

| Block | Status | What to do |
| --- | --- | --- |
| F1 | Merged | Done (`f5b496d`). Unique and trigger database errors return 422. No further work. |
| F2 | Merged | Done (`6b9a576`). The route guard reads registered routes and an exact public list. No further work. |
| F3 | Merged | Done (`51781fa`). Layer test is in place and payment confirmation lives in `application/`. No further work. |
| F4 | Merged | Done (`a3a7144`). The architecture doc matches the code. ADR-11 is plain Fastify. ADR-12 is no ORM. No further work. |
| F5 | Merged | Done (`8ca083e`). `npm run build:server` writes `dist/server.js` and `npm start` runs it with plain `node`. No further work. |
| F6 | In progress | Finish `block/F6-startup-work`. Move migrations, platform re-sync, `profiles.ensureAll()` and shipped-module publishing out of process start into a deploy step or job. Process start only checks the schema and does not walk every organisation. A second instance must not republish definitions. Exit tests: `migrate`, `server-bundle`, `tenancy`, `metadata`. |

## Track D — Data correctness and persistence

| Block | Status | What to do |
| --- | --- | --- |
| D1 | Committed, verifying | On `block/D1-record-query` (`9cb090e`), confirm `record-service.ts` builds no list SQL and that query and plan tests pass unchanged. Merge if they do. Exit tests: `kysely-plans`, `query-aggregates`, `list-view`, `approvals-query`. |
| D2 | Not started | Start after D1 and F1. One `withTenant()` transaction and one pool connection per create, update and transition. Split the save into stages in this order: authorize, merge, conditions, signatures, copy-from, calculate, script, validate, unique, rules, write, posting and receipt effects, audit and outbox. Put one file per stage in `src/runtime/records/save/`. Delete the separate `withTenant()` calls inside `prepare()`. Keep stage order and validation messages. Do not add script effects. Exit tests: new `test/save-transaction.test.ts` (one pool checkout per save; two concurrent saves of one unique value end with exactly one 422), plus `save-pipeline`, `core-rules`, `donations`, `donations-module`, `record-actions`, `db-errors`, `tenancy`, `money-payments`, `merge`, `sharing`. |
| D3 | Merged | Done (`efc5fed`). Affected-row counts reach Kysely. No further work. |
| D4 | In progress | Finish `block/D4-people-approvals-kysely`. Convert the 5 people queries and 3 approvals queries to Kysely typed common table expressions. The raw-SQL baseline must drop from 32 to 24 or fewer. Exit tests: `people-profiles`, `people-admin`, `people-pick`, `approvals-query`, `kysely-plans`, `kysely-architecture`. |
| D5 | Not started | Do not start a branch. This work is part of D11: column overrides for job state and outbox envelopes. |
| D6 | Not started | Start after D1. Includes P3. Build the record-query AST from section 11.4 of the plan, covering every filter, sort and aggregate the query module supports. Validate it against the published definition and compile it to the current JSON expressions. In a new migration, reject clauses outside that grammar inside the database functions, and grant execute only to the runtime role. Do not change query results, indexes, or add a MySQL compiler. Exit tests: new `test/dynamic-sql-hostile.test.ts`, plus `kysely-plans`, `query-aggregates`, `list-view`, `indexes`, `approvals-query`, `bulk`, `tenancy`. |
| D7 | Not started | Start after D8 has merged (both rework jobs and the outbox) and F3 is Merged. Add `src/kernel/capabilities.ts` with named owner capabilities: provisioning, outbox claim, job claim, identity lookup, retention, and any narrower capability the current `asSystem()` callers need. Wire them in `platform.ts`. No service outside `src/kernel/` may call `asSystem()`. Stop and ask if a caller needs general owner access. Exit tests: new `test/owner-capabilities.test.ts`, plus `identity`, `auth-flows`, `jobs`, `tenancy`, `people-admin`, `money-payments`, `connectors`, `files`, `indexes`, `hardening`. |
| D8 | Committed, verifying | On `block/D8-idempotent-handlers` (`52af5c2`), confirm each outbox and job handler is idempotent and that a failed handler does not re-run handlers that already succeeded for that event. Migration 014 is part of this block. Exit tests: replay cases in `jobs` and `workflow-automation` showing no duplicate emails, webhooks or transitions. |
| D9 | Not started | Start after F6. First prove two assumptions with a throwaway test: a parameterless `sql.raw(file)` runs a multi-statement file through Kysely's driver, and Kysely's PostgreSQL migration lock is transaction-scoped. If either is false, stop and report. Then replace the custom dialect, driver, adapter and `FILE_LOCK` in `src/kernel/migrate.ts` with Kysely's standard PostgreSQL dialect, and call `migrator.migrateUp()` once per pending file with transactions on. Keep `SqlFileMigrationProvider`. Exit tests: `migrate`, `migration-007`, `kysely`, including a failure inside a file that leaves no schema change and no history row, and a simulated crash whose restart leaves schema and history consistent. |
| D10 | Merged, web build unverified | Backend work is done (`7545382`). After the Web packages row is unblocked, run `npm run web:build`. No further backend change. |
| D11 | Not started | Start after F6 and D9. Includes D5. Stop and ask before installing `kysely-codegen`. Add it as a development dependency, add the config (PostgreSQL dialect, `numeric` as string, output `src/kernel/db-types.ts`, column overrides for job state and outbox envelopes), and point `npm run db:types` at the F6 migrate command plus `kysely-codegen`. Delete `scripts/gen-db-types.mjs`, `scripts/gen-db-types.d.mts` and `scripts/db-type-overrides.json`. Confirm `--verify` exists in the installed version before using it as the stale check. Remove casts on the overridden JSON columns in `src/kernel/jobs.ts` and `src/kernel/outbox-dispatcher.ts`. Exit tests: `kysely`, `jobs`, `migrate`. `npm run db:types` on a clean tree must leave `src/kernel/db-types.ts` unchanged. A migration merged without regenerating must fail the suite. `numeric` and `int8` still read as `string`. |
| D12 | Not started | Optional. Skip unless a person schedules it. Make the table lists in `src/kernel/retention.ts` and `src/kernel/tenant-export.ts` into `keyof DB`, and use Kysely builders for batched deletes and paged reads, keeping `ctid` as a small `sql` fragment. Add `{ isolation, readOnly }` to `withTenant()`. Exit tests: `import-export`, `hardening`, `tenancy`, `kysely-architecture`. The raw-SQL baseline must fall by the calls removed. |

## Track H — HTTP layer

| Block | Status | What to do |
| --- | --- | --- |
| H1 | Committed, verifying | On `block/H1-http-helpers` (`f5b4f2b`), confirm routes no longer call `context(req)` by hand, `sendOnce()` is unchanged, and the builder draft-route sign-in fix holds. Exit tests: `http`, `route-guard`, `auth-flows`, `db-errors`. |
| H2 | Not started | Start after H1. Includes H3. Split `src/http/server.ts` into Fastify plugins under `src/http/plugins/`: auth, records, builder, administration, payments and webhooks, files and imports, internal and static. One public scope and one authenticated scope. The authenticated scope resolves context in the H1 hook. Keep paths, methods, status codes and headers. Register the raw-body parser only inside the webhook plugin. Do not add request schemas or a router facade. Exit tests: `route-guard` (registered routes identical before and after), `http`, `hardening`, `auth-flows`, `app-api`, `api-keys`, `money-payments`, `files`, `import-export`, `connectors`, `server-bundle`. Add a case: a webhook signed over the exact raw bytes verifies, and a non-webhook JSON route no longer exposes raw text. |
| H3 | Not started | Do not start a branch. This work is part of H2: the raw body stays only in the webhook plugin. |
| H4 | Not started | Start after H2. Includes H5. Add `src/http/contracts/` with TypeScript interfaces and Ajv `JSONSchemaType` schemas for authentication, API keys, roles, members, settings, approvals and money, plus a shared error schema. A malformed body returns 400. A valid body that the business rejects stays 422. Add response schemas only for security-sensitive views. An API-key token appears only in the create response. No connector secret or refresh token appears in any response. Fix `ActionResult.open` so the code and the OpenAPI document agree. Do not put a response schema on configured record data. Exit tests: new `test/http-contracts.test.ts` and new `test/response-secrets.test.ts`, plus `http`, `api-keys`, `roles-api`, `people-admin`, `admin-screens`, `money-payments`, `auth-flows`, `identity`. |
| H5 | Not started | Do not start a branch. This work is part of H4: response schemas and the `ActionResult.open` fix. |
| H6 | Not started | Start after H4 and D1. Add fixed outer envelopes, such as `{ data, expectedVersion }`, for record save, transition, query, aggregate, bulk operations and definition drafts. Published definitions still validate the contents. Exit tests: envelope cases in `http-contracts.test.ts` (a bad envelope returns 400; a field published after start-up is accepted without a restart), plus `app-api`, `record-actions`, `bulk`, `query-aggregates`, `definition-model`, `builder-support`. |
| H7 | Not started | Start after H4, and only after the Web packages row is unblocked. The web HTTP gateway imports the shared fixed contracts. Remove every `get<T>()` cast on a contracted route. Exit tests: `npm run web:build`, the web gateway unit tests, `web-architecture`, `web-build`. |

## Track S — Security and privacy

| Block | Status | What to do |
| --- | --- | --- |
| S1 | Not started | Start after F5. Stop and ask a person to name and approve the JWT, OIDC and TOTP libraries and their versions before installing them. Replace token signing and verification, OIDC key verification, and TOTP. Keep membership, roles, sessions and password hashing local. Existing tokens and enrolled TOTP secrets must keep working. Run `npm run measure:footprint` before and after and record both figures in the merge commit. Exit tests: `identity`, `auth-flows`, `password-policy`, `pins`, `api-keys`, `crypto`, `server-bundle`. |
| S2 | Not started | Start after D2. Stop and ask where the encryption key comes from in each environment. Add an encrypt stage to the D2 save pipeline for fields marked sensitive, and decrypt on read, export and masking. Store a key version with each ciphertext. Add a re-encrypt job for rotation. Exit tests: new `test/field-encryption.test.ts` (ciphertext in the table; reads, exports and masking unchanged; rotation re-encrypts and old versions still decrypt), plus `field-types`, `import-export`, `save-pipeline`, `people-profiles`, `crypto`. |
| S3 | Not started | Start after S2. Stop until counsel confirms the financial retention period and the product owner approves the erasure rules. Add consent records, an erasure command that pseudonymises personal fields and keeps amounts, dates and receipt numbers, and retention rules in `src/kernel/retention.ts`. Update the business document. Exit tests: new `test/erasure.test.ts`, plus `hardening`, `donations`, `core-rules`, `import-export`. |
| S4 | Not started | Not an agent build. Start after D2, D6, D7, H2 and S1. An external reviewer covers records, files, jobs, scripts, configuration, exports, identity and money. An agent may assemble the review pack (route inventory, owner-capability list, hostile-input tests, tenancy tests) and may fix accepted findings as separate blocks named `S4-<n>`, each following the shared rules. Done when findings are fixed or accepted by an owner in writing. |

## Track X — Override scripts

| Block | Status | What to do |
| --- | --- | --- |
| X1 | Not started | Start after D2. Write a design in `docs/architecture/` for scripts that return effects: declared inputs, effect types (`ledger.propose`, `records.create`, `notify`, `connector.call`), validation, and a test-run preview. Publish the effect schema with the other definition schemas. Stop for a tech-lead review before X2 starts. Exit tests: `definition-kinds`, `definition-model`, `metadata`. |
| X2 | Not started | Start after X1 is reviewed. Includes X3. The sandbox returns effects and does not call the host. The host validates each effect and applies it in the save transaction. Add the validate, after-save, workflow-guard and custom-button hooks. A test run returns effects and writes nothing. Publishing a finance script writes an audit event and queues a treasurer notification through the outbox. Exit tests: new `test/script-effects.test.ts` (a journal line and a notification are applied in the save transaction; an unbalanced proposal is rejected and nothing is written; a test run writes nothing; a finance-script publish produces the audit row and the outbox event), plus `sandbox`, `save-pipeline`, `workflow-automation`, `record-actions`, `core-rules`. |
| X3 | Not started | Do not start a branch. This work is part of X2: finance-script publish writes an audit event and notifies the treasurer. |

## Track O — Operations and performance

| Block | Status | What to do |
| --- | --- | --- |
| O1 | Not started | Start after F5 and F6. A person supplies the hosted PostgreSQL connection and the target instance size. Run `npm run build:server` and `npm run measure:footprint` with the database awake and again with it paused. Record memory, cold start and p95 save latency in section 13 of `architecture/ngo-platform-architecture.md` against the budget: under 250 MB, under 4 s, under 500 ms. Report a missed budget. Do not fix it in this block. |
| O2 | Not started | Start after F6. Includes O7. Add a readiness route that queries the database. On `SIGTERM`, stop accepting requests, finish in-flight requests and the current outbox run, then close the pool. Add an access-version counter, bumped on role and membership changes and checked like `config_version`, so every instance drops a stale actor cache. Move rate limits to PostgreSQL or document them as per instance. Set and document the cron interval for each installation mode. Exit tests: new `test/lifecycle.test.ts` (readiness fails with the database stopped; shutdown finishes an in-flight request; two instances refuse a removed role within the agreed time), plus `http`, `hardening`, `jobs`, `roles-api`, `fine-permissions`, `server-bundle`. |
| O3 | Not started | Start after O2. A person chooses the alert channel and creates the hosted alert policies. Emit a structured event for a permanently failed outbox event or job, for the error rate, and for memory. Write the alert and dashboard definitions under `deploy/` or `docs/operations/`. Exit tests: a forced permanent job failure emits the alert event, plus `jobs`. |
| O4 | Blocked | A person runs this, not an agent. Needs the hosted database. Restore a backup into a fresh database and pass the smoke tests within the agreed recovery time. |
| O5 | Merged, pipeline not yet run | Code is merged (`ba5d7c8`): `npm run ci`, `npm run ci:audit`, `azure-pipelines.yml`. A person creates the pipeline in Azure DevOps, gives it credentials for the company npm registry, and adds a build-validation branch policy on `backend_enhancement` and `master`. No further code. |
| O6 | Blocked | A person runs this, not an agent. Needs Razorpay and Cashfree sandbox credentials. Order, signed webhook and duplicate delivery must work against each sandbox. |
| O7 | Not started | Do not start a branch. This work is part of O2: role and membership changes reach every instance, rate limits are shared or documented as per instance, and the cron interval is set. |

## Track M — Shared installation

| Block | Status | What to do |
| --- | --- | --- |
| M1 | Not started | Start after F6 and D7. Follow R2-B01 in `.cursor/docs/plans/ngo-release-2-build-blocks.md` for the organisation lifecycle. In this repo, provisioning runs only from the deploy command, and lifecycle code uses only D7 capabilities. No lifecycle step runs during process start. Exit tests: R2-B01 checkpoints O1–O11, `owner-capabilities`, `tenancy`. |
| M2 | Not started | No build. After M3, a person writes the decision on usage metering and an operator web console. Release 2 stays without a public operator console until that decision. |
| M3 | Not started | A person runs the shared pilot with two NGOs after R2-B01, S4, O1, O2, O3 and O4. Done when the automated suite and the pilot show no cross-organisation access and the budgets are met. An agent does not start this. |

## Track P — Database portability

| Block | Status | What to do |
| --- | --- | --- |
| P1 | Not started | Write an ADR: PostgreSQL is the shared-mode database; MySQL is single-NGO only until a shared-mode design is approved. Add a start-up check that refuses an unsupported provider and installation-mode pair. Exit tests: a unit test of that start-up check. |
| P2 | Not started | Start after D1, D2 and D7. Define the persistence ports in section 11.3 of the plan and move Kysely and SQL executor types behind `infrastructure/postgres`. Move the D6 compiler behind the `RecordQuery` port. Exit tests: a layer-test rule that fails on a Kysely or SQL-executor import outside `src/infrastructure/` and `src/kernel/`, plus the record, ledger, receipt and tenancy tests listed under D2. |
| P3 | Not started | Do not start a branch. This work is part of D6: the validated query AST and the PostgreSQL compiler. P2 only moves that compiler behind `RecordQuery`. |
| P4 | Not started | Start after P2. Create `src/infrastructure/contract-tests/` covering tenancy, ledger, receipts, optimistic writes, jobs, outbox, migrations and indexes. PostgreSQL must pass the suite. Every later provider must run the same suite. |
| P5 | Not started | Do not start until a customer needs MySQL and a support budget exists. Start after P1, P2, D6 and P4. Build MySQL migrations and stores for one database per NGO. Exit tests: MySQL passes the P4 contract suite, including financial and migration-recovery cases. |
| P6 | Not started | Start after P5, O1 and O4, and only if P5 is scheduled. Publish MySQL provider limits, footprint and backup-restore results. |
| P7 | Not started | Start after P5 and M1, and only if P5 is scheduled. Spike shared MySQL as one database per NGO: provisioning, operations cost, export, and automated cross-tenant tests. A person approves it, or MySQL stays single-NGO only. |

## Track A — Five-layer architecture completion

These are behaviour-preserving ownership blocks. Start only after the preceding A block is merged. Do not combine a security finding, route/API change, migration, validation change or other business behaviour with a move. Every block removes its exact temporary architecture exceptions before merge.

| Block | Status | What to do |
| --- | --- | --- |
| A1 | Not started | Start after H7, P4 and S4. Replace regex import checks with TypeScript compiler analysis; classify layers and second-level capabilities; baseline only exact current edges with reason, owner and removal block. Enforce package ownership and type-only infrastructure imports of core-owned ports. Exit: `tsc`, layer, persistence, Kysely and web architecture tests. |
| A2 | Not started | Remove `Platform` and direct runtime/domain/infrastructure dependencies from HTTP. Give each plugin a small application-facing API; move route orchestration into use cases; preserve route inventory, contracts, statuses, headers, raw webhook bytes and payment outbox flow. Exit: HTTP, guards, auth, records, payments, files, connectors, lifecycle, bundle and architecture tests. |
| A3 | Not started | Move generic record behaviour to `runtime/records`; move records/actions/import/export coordination to application; move CSV, transfer and file adapters to infrastructure. Delete the affected records/actions/imports engine folders without changing save order, transaction counts, messages or formats. Exit: record, save, action, query, bulk, sharing, file, import/export, finance, tenancy and architecture tests. |
| A4 | Not started | Move metadata/builder to runtime definitions plus application publishing; approvals to workflows; automation, expressions and scripts to their runtime owners. Sibling runtime services may not call each other. Preserve schemas, hooks, expressions, effects, workflows and indexes. Exit: metadata, definition, builder, approval, automation, sandbox, script, index and architecture tests. |
| A5 | Not started | Consolidate identity, ledger, receipts, accounts, payments, organisations, privacy and permissions in domain; move coordination to application and keep ports beside the capability. Preserve all identity, finance, privacy and permission behaviour. Exit: identity, roles, people, payments, core rules, receipts, privacy, organisation and architecture tests. |
| A6 | Not started | Split and remove `kernel/`: PostgreSQL, jobs, outbox, files, notify, connectors, transfer, audit, crypto, sequences and observability go to infrastructure; policy and ports go to their owning core capability. Do not create a replacement catch-all. Exit: provider contracts, database generation/migrations, jobs/outbox, files/connectors, crypto, hardening, tenancy, owner-capability and architecture tests. |
| A7 | Not started | Make `platform.ts` the only composition root and entry points thin. Move organisation command orchestration to application. Rename `deployment.ts` to `prepare-deployment.ts`, retain the esbuild `deploy` alias, `dist/deploy.js`, npm command names, arguments, environment, logs and exit codes. Exit: typecheck, build/bundle, deploy/migration, metadata, tenancy, organisation and entry-point architecture tests. |
| A8 | Not started | Delete all temporary exceptions and legacy top-level folders; enforce the final roots, port rules and package restrictions; reconcile all path documentation. Run typecheck, architecture and all A1–A7 focused tests, then `npm run ci` and the full suite on `backend_enhancement`. Record evidence in section 5.1. |

## Track G — Guardrails first, then conformance

Behaviour-preserving, like Track A. Block G adds the rules; blocks H, R, D, I and C fix what the rules report, in any order (they touch different folders), and F reconciles at the end. The rules now allow no violations and have no pending list. Do not add entries to `layer-allowlist.json` or `package-allowlist.json`.

| Block | Status | What to do |
| --- | --- | --- |
| G | Done (branch `block/G-guardrails`) | Rules for runtime and application sibling decoupling, application re-exports of lower layers, executable values in port files, allowlist expiry read from section 5.1, `src/domain/ports/` no longer exempt from the persistence test, and wiring-only composition; the pending file and the violation document. Exit: `npx tsc --noEmit`; layer, persistence, kysely, composition, owner-capabilities and infrastructure-parity tests. |
| H | Merged (`6cba842`) | HTTP to application use cases and no domain or runtime values or re-exports in `src/http/`: payment confirmation through `application/payments`, `http/contracts/privacy.ts`, `main.ts` passes `platform.http`. Clears the `http-reexport` entries and the http-facing entries of the other rules. |
| R | Merged (`43147e7`) | Runtime and application sibling decoupling: approval service, automation engine, run-action, record service and script sandbox, administration service, connector service, import service. Clears the `runtime-sibling` and `application-sibling` entries. |
| D | Merged (`9820f69`; two policy moves and transaction opening deferred, see section 5.1) | Domain purity: SQL executor types out of `domain/ports/`, transactions (`asTx`, `joinTx`, `transactions`) out of domain, constants out of port files, password-policy ports; domain keeps rules and application opens transactions; session, role, API-key and consent policy into domain. Clears the `port-values` (const, function, class) and `persistence` entries. |
| I | Merged (`d6e8feb`) | Infrastructure ownership: tenant-directory split, duplicate Logger port and tenant-context re-export shims, `InfrastructureError` brand. Clears the `port-values` value re-export entries. |
| C | Merged (`fb55cb5`) | Composition: wiring takes explicit dependencies, not `Platform`; `PlatformOptions` use core port types; `tenantExport.audit` into an application use case; `modulesDir` and `schemaDir` from `PATHS`. Clears the `composition` entries. |
| F | Not started | Repo independence and documentation: reconcile all docs and paths after H, R, D, I and C; the pending file is gone. |

## Other rows in section 5.1

| Block | Status | What to do |
| --- | --- | --- |
| Test timeout fix | Merged | Done (`ad3a05a`). Test database connections get 20 seconds. No further work. |
| Test speed fix | Merged | Done (`a2233a1`). `synchronous_commit` is off on test databases, and Vitest uses at most 6 workers. No further work. |
| Web packages | Blocked | A person runs one online `npm --prefix web ci` from the company registry. `web/node_modules` is empty, so the web build and web tests cannot run. D10's remaining check and H7 wait on this. |
