# One NGO Version 2 Enhancement

Status: summary of the design discussion and the work started on 30 October 2026. This document records what was decided, what was reviewed, and what has actually been done. It is not a replacement for the architecture decision records.

Branch at the time of writing: `develop`, commit `2acb8d0`. Nothing in this work has been pushed. `master` was not changed after `develop` was created.

## 1. Overall goal

Enhance the NGO management platform into a Version 2 shape: keep the product NGOs use, and add a separate operator application for the people who onboard and manage organisations.

Today, onboarding and lifecycle (onboard, status, retry, suspend, reactivate, close) run from a command-line tool that connects to PostgreSQL as the database owner. The operator name is an environment variable, not a signed-in identity. Version 2 replaces that with a real operator sign-in, least-privilege database roles, and two deployable applications that share one engine.

The product itself stays a modular monolith for NGO traffic. The split is about who may run control-plane actions, not about breaking the NGO domain into microservices.

## 2. How the organisation CLI authenticates today

The CLI does not authenticate an operator.

- Entry point: `src/organisation.ts`. It opens the database with `openOperatorDatabase()` and passes `operator: process.env.ONENGO_OPERATOR` into `organisationOperations`.
- Verbs: `src/application/organisations/organisation-command.ts` handles onboard, status, retry, suspend, reactivate and close.
- The operator string is only checked against a pattern (`OPERATOR` in `src/application/organisations/onboarding-service.ts`) and then stored as a label via `operatorId()`. There is no password, token, OAuth device flow, or API key for the person running the command.
- The real credential is `DATABASE_URL`. `src/composition/entry.ts` opens the operator pool from that URL, which is the database owner login. `DATABASE_RUNTIME_URL` is optional and is the tenant runtime login used by the main server.
- Secrets live in the local `.env`, which is gitignored. They were not read out or committed.

This is why the CLI is removed at the end of the plan: it connects as the owner and has no real authentication.

## 3. Better ways to onboard organisations

The first wording of this question was misheard as a request for something lighter-weight or cheaper. The correction was that the goal is the most secure onboarding, even if it costs more to build. No dashboard was to be built at that point; the answer was a recommendation only.

The recommendation was a separate operator service, not a better CLI and not a page inside the NGO app:

- Operators sign in through an identity provider that can prove multi-factor authentication on every sign-in.
- A small local account table says which actions that person may run, so disabling them takes effect immediately and the audit id does not depend on the provider.
- The service uses its own database role. It never hands a database password to an operator.
- Destructive actions require a fresh sign-in (step-up), not just the session from the start of the day.
- The service sits behind Identity-Aware Proxy, and the application still verifies that header itself.
- The NGO admin invitation stays as it is: a single-use hashed link, seven days, sent directly. Changing delivery to an outbox event was considered and rejected because it would change invitation behaviour.

Other options that were set aside: keeping the owner CLI, putting the console inside the main server, treating the identity provider's permission claims as the authority, and one Auth0 Organization per NGO.

## 4. Can the two-app split be built, and how long

Yes. The codebase already leans this way. `test/organisation-onboarding.test.ts` checks that the main server's routes never match onboard, provision, lifecycle or operator. `organisationOperations` is built only by the operator command, never by the main server.

What already exists and should be wrapped, not rewritten:

- `OrganisationOnboardingService`: resumable steps, idempotent request ids, a validate-only mode.
- `OrganisationLifecycleService`: status, retry, suspend, reactivate, close.
- NGO sign-in: email and password, email one-time code, TOTP, and OpenID Connect with PKCE (Google when configured).
- Member invitations and server-side sessions.

What is new: operator accounts, a separate operator server, step-up for destructive actions, a small Angular console, deployment behind access control, and tests.

### Estimate without agents

About 5–7 weeks for one developer who knows this codebase, or 3–4 weeks with two developers, plus a security review before it goes live. The breakdown was roughly 24–37 developer days: a standalone operator entry point, operator identity (accounts, sessions, OIDC with MFA, step-up), the six API routes over the existing services, a minimal console, deployment as a separate App Engine service with private ingress, and security tests. These were rough numbers. The existing services were read; the new pieces were not spiked.

### Estimate with AI agents

About 3–5 weeks for one experienced developer, plus a focused security review. Agents can compress the Angular console, route wiring, migrations and test scaffolding. They should not shorten the time spent checking authentication, access control, database roles, or deployment boundaries. Operator identity design, MFA and step-up rules, and infrastructure placement stay human work.

## 5. Shared base package

Both apps should depend on shared packages. Business rules stay in the NGO engine. The operator app calls that engine; it does not reimplement onboarding.

An earlier chat, [Folder structure and hosting](d409772b-5dc7-4e67-9ab1-ad69b09a2c8d), advised against a monorepo, and said to convert only if a second app has to build and deploy on its own. The operator app is that case, so the proposal uses npm workspaces.

Three earlier constraints were explicitly dropped once the split was accepted: "don't convert to workspaces", "don't rename `src/`", and "keep `product/` at the root".

### What the architecture document already said

`docs/architecture/ngo-management-platform.md` describes one Fastify process and one artifact (ADR-01, ADR-10), one Angular app served by that process (ADR-09 folds the public site into the same app), and the operator console inside that same build (sections 4.2 and 4.3, as they stood). It does not define workspace packages. The shared base was missing from the architecture. Section 11 described one npm package with folders.

### Proposed packages and apps

Private workspace packages, never published:

| Package or app | Role |
| --- | --- |
| `@onengo/kernel` | Protocol and infrastructure primitives only. No tenant, member or NGO concept. Imports no `@onengo/*` package. |
| `@onengo/platform` | The NGO engine: domain, runtime, application, infrastructure, composition, product migrations and schemas. Onboarding stays here. |
| `@onengo/web-kit` | Shared Angular models, i18n, HTTP client, paging and generic components. Created only after the operator web app proves which pieces both apps use. |
| `apps/onengo/server` | NGO API and the deploy job. |
| `apps/onengo/web` | Today's Angular app. |
| `apps/onengo-console/server` | Operator sign-in, sessions, step-up, grants, and the six organisation actions. |
| `apps/onengo-console/web` | Operator console screens. |

Import rules, to be enforced by tests:

- The kernel imports no `@onengo/*` package. The platform imports only the kernel. The web kit imports no app. No app imports another app.
- The main server may import `@onengo/platform/main`, `./contracts` and `./deployment`. It must not import `./operator`.
- The operator server may import `@onengo/platform/operator` and `./contracts`. It must not import `./main`.
- Web apps import `./browser` and `./contracts`, never a server app.

Platform export entries: `./main`, `./operator`, `./contracts`, `./browser`, `./deployment`, `./testing`.

### Reusability and deviation

Question corrected from "usability" to "reusability". Counts are non-test lines, approximate.

Server, about 36,000 lines in about 386 files:

| Slice | Lines | Share | Who uses it |
| --- | --- | --- | --- |
| Kernel candidates (database adapter, crypto, logging, mail, files, HTTP basics, errors) | about 2,000 | about 5% | Both |
| NGO engine (domain, runtime, application, stores, shared rules) | about 30,000 | about 83% | Both, because the operator app calls the engine |
| Main-server-only HTTP | the rest | | Main server |

The operator CLI already reuses the engine by calling `createPlatform`. The split adds little new server reuse. Most of the churn is extracting the kernel. The kernel is smaller than a first look suggested: `pg-database.ts` is bound to `app_runtime` and the tenant preamble, so only the generic half belongs in the kernel. Many "generic" Angular widgets import record types, the shell store or i18n, so they are not drop-in shared. Cleaner candidates include icon, menu button, nav, table rows and card rows. Shareable web code was estimated at about 4–9%.

A smaller layout with two shared packages instead of three keeps most of the benefit. The plan still has three packages, but `@onengo/web-kit` waits until phase 7 so it is not built for hypothetical reuse.

Deviation from today: one package becomes workspaces; `src/` splits across `packages/platform` and `apps/onengo/server`; `web/` becomes `apps/onengo/web`; `product/` moves under the platform package; two new apps appear. The engine folders move as one block so imports inside them do not change.

## 6. Data access: still no ORM

Checked in the code, not in a proposal. The project does not use Prisma, TypeORM or Sequelize. Kysely is the typed query builder over PostgreSQL, used widely (on the order of 62 files at the time of the check). Migrations are plain SQL. PostgreSQL-specific behaviour (row-level security, triggers, functions) stays SQL. ADR-12 stands. The plan keeps pg, Kysely and SQL.

## 7. First architecture review

A review of the written plan, before any files were created. The important findings, later accepted or refined:

1. The main server also holds the owner login, because its system pool uses `DATABASE_URL`. Fix: rotate the owner password so only the deploy job keeps it.
2. Kernel candidate files import engine port types, so the kernel is not actually independent. Fix: move port types first (step 6a) and implementations second (step 6b), leaving re-export files at the old paths.
3. Moving onboarding into a shared surface would widen what every importer can see. Fix: onboarding and lifecycle stay in the engine, exposed only through `@onengo/platform/operator`.
4. `operatorId()` rejects a string shaped like `issuer|subject`. Fix: store `operator_account.id` (a UUID) and replace the free-text operator id with a verified principal.
5. Two services on one database can skew versions. Fix: one deploy job runs migrations; both services ship from the same commit; migrations are add-before-use.
6. Google tokens may not report MFA. Operators need a provider whose MFA is verifiable. For NGOs, provider MFA counts only through an explicit mapping.
7. Network placement is not proof of caller identity. Verify the Identity-Aware Proxy header, and give each service its own service account.
8. The two services share the `appspot.com` parent domain, so cookies must be host-only `__Host-` cookies with different names.
9. The operator service sends invitations, so it needs its own `SMTP_*` and `ENCRYPTION_KEY`. Moving the invitation onto an outbox event was rejected.
10. The engine does not import `http/`, so it can move as one block.
11. A wildcard package export will not resolve the existing `.js` imports. Use TypeScript path mappings and an esbuild alias while the move is in progress.
12. Tests break as soon as files move. Create `@onengo/platform/testing` in the block move.
13. Re-export files may only re-export, or new code will land in them.
14. A UI kit compiled from source requires matching Angular versions. ng-packagr is the fallback.
15. The engine's main export is the full NGO API and must be guarded by a test, now on `@onengo/platform/main`.
16. The new decision record must explain why this split differs from ADR-09, which rejected a separate public site.

## 8. Independent GPT-5.6 review

A second review, done fresh with GPT-5.6, without reusing the first review's conclusions, and without modifying the repository. It conditionally approved the split, subject to four gates before any files move:

1. Least-privilege database roles.
2. A corrected kernel boundary (protocol and infrastructure only).
3. Explicit package, artifact and schema compatibility contracts.
4. A hardened operator backend-for-frontend. Auth0 can authenticate operators, but the app still keeps server-side sessions and one-time step-up state.

### Auth0-only operator identity

Considered because the user asked about not storing operator accounts locally and connecting the operator app straight to Auth0.

Rejected as the authority. Auth0 (or any provider that can prove MFA) authenticates. A local `operator_account` table authorizes each action and supplies the audit UUID. Provider permission claims are not the source of truth. Auth0 Organizations, one per NGO, were rejected because operators work across NGOs and picking the target becomes error-prone. There is no local operator password, including for break-glass. Grants change through an audited command. If the provider is migrated, `operator_account.id` stays the same and re-linking issuer and subject is an audited command.

### Main-server sign-in: optional provider plus email and password

The identity provider is optional per NGO. An NGO may enable OpenID Connect. Otherwise people use the email and password (and email code) flow that already exists. Both paths must converge on one pipeline so session issuing, tenant scope, throttling and audit are not duplicated. A weaker method must not bypass a stronger policy. Google is currently offered to every installation; it becomes a template each NGO turns on. Passwords stay enabled by default. Turning them off requires two strongly protected admins, so an NGO cannot lock itself out.

### Recommendations accepted from this review

Narrow entry points instead of the broad `Platform` interface. Main API contracts live in the engine, not in the main-server app, so web apps never depend on a server app. Extract the web kit only after the operator web app proves reuse. Enable workspaces before moving code. esbuild must bundle workspace packages, because `--packages=external` would leave them out. Test each artifact from a clean deployment folder. Asset paths become an explicit option with a manifest, because re-export files do not fix runtime paths. Re-export files get an allowlist with owner, reason and expiry, and a ratchet down to zero. Local sessions, OIDC state and one-time step-up records stay even when Auth0 is used. Short tokens, refresh rotation, back-channel logout and local revocation, because blocking a user at the provider does not invalidate tokens already issued. JWKS caching with one bounded refetch, and tests for key rotation. Destructive step-up fails closed while the provider is down. Structured audit stores issuer, subject, display snapshot, permissions, `auth_time`, assurance and session ids next to the operator UUID. Step-up also covers reactivate, because it reverses a suspension. The NGO principal stays in the engine; the kernel returns only a protocol result. The two apps share protocol and crypto primitives, not principals. Identity linking is hardened: atomic insert, refuse conflicts and ambiguity, no automatic relink, an audit entry, and step-up before an admin relinks. Sessions record the method that created them; disabling a method revokes that NGO's sessions from that method. Every package is `"private": true`.

### Recommendations rejected

Auth0 as the only authority, with no local account. Auth0 permission claims as the source of truth. Auth0 Organizations per NGO. Step-up for onboard and retry: onboard is idempotent and has a validate-only mode, and retry resumes the same request. Dual approval for close, until the team is larger and close has its retention check. An ORM. Publishing packages. Changing how the NGO admin invitation is delivered.

## 9. Approved plan

The final plan was written in the chat, with every review comment marked accepted or rejected and a one-line reason. It was treated as approved, then implementation started. Two conflicts between the reviews were resolved in the plan:

- Database: after rotation, the owner password is held only by the deploy job. The operator server is the only serving process with cross-tenant control-plane rights, through `ngo_operator`. No serving process owns tables.
- Operator identity: the provider authenticates; `operator_account` authorizes and is the audit id.

### Database roles

| Role | Used by | May do |
| --- | --- | --- |
| Owner, rotated at cutover | Deploy job only | DDL, migrations, re-encryption |
| `ngo_main_runtime` (member of `app_runtime`) | Main server | Tenant traffic under row-level security |
| `ngo_main_system` | Main server | Listed security-definer system functions only. No `operator_*` tables and no lifecycle writes |
| `ngo_operator` | Operator server | Onboarding, lifecycle, `platform_audit`, `operator_*` tables, onboarding functions |
| `ngo_operator_runtime` (member of `app_runtime`) | Operator server | The tenant steps that onboarding runs |

No serving role owns tables, has `BYPASSRLS`, or is a member of the owner.

### Operator requirements

Separate identities: operators exist only in `operator_account`, never in `app_user` or `tenant_member`. Own token secret and `__Host-` cookie. Member tokens are refused by the operator server, and operator tokens by the main server. Authorization-code flow with PKCE. Server-held state, nonce and verifier. Every sign-in needs fresh MFA evidence the provider proves. Google used directly is not accepted for operators. Actions (`onboard`, `status`, `retry`, `suspend`, `reactivate`, `close`) are granted per operator. Revocation applies on the next request. Suspend, reactivate and close need a one-time step-up record: `max_age=0`, fresh MFA, `auth_time` within 5 minutes, used once. Audit stores the operator UUID plus issuer, subject, display snapshot, action, permission, `auth_time`, assurance and session ids.

### Main-server sign-in

Three stages in `application/identity/sign-in/`: verify the credential, resolve the account and enforce assurance, issue the session. Password, email code and OpenID Connect all pass through it. Email code alone is never strong assurance. A provider counts as MFA only through an explicit per-provider mapping; otherwise local TOTP follows. Per-NGO policy covers methods, providers, whether passwords are on, assurance per role, and recovery.

### Compatibility

One version across workspace packages. One migration stream, run only by the deploy job. `SCHEMA_LEVEL` is the last migration number. Each server declares the minimum level it needs and refuses to start below it, or when the database contains a newer migration marked `breaking`. Release order: run the deploy job once, then deploy both services from the same commit.

### Migrations reserved

`028_service_roles`, `029_system_functions`, `030_operator_identity`, `031_audit_actor`, `032_tenant_auth_policy`, `033_session_method`. Final numbers are assigned in the order they land.

> Superseded before first release: migrations 001 to 033 were merged into six final-state files, `001_core`, `002_identity`, `003_ledger_money`, `004_record_query`, `005_organisation_privacy` and `006_operator`. `SCHEMA_LEVEL` is 6; minimums are `main: 5`, `operator: 6`. Migration numbers cited elsewhere in the documents refer to the old files; see `docs/architecture/migration-schema-analysis.html`.

### Phases

| Phase | Work |
| --- | --- |
| 0 | ADR-14 to ADR-18, update the architecture doc, record the baseline test count |
| 1 | In today's layout: service roles, operator identity and audit, narrow `src/api/` entry points, then enable workspaces with no file moves |
| 2 | Move the engine, `product/` and engine tests into `packages/platform` as one block. Move entry points and `http/` to `apps/onengo/server` and `web/` to `apps/onengo/web`. Add the build script and the clean-folder artifact test |
| 3 | Remove temporary deep imports. Publish only the named exports. Schema compatibility check at startup |
| 4 | Kernel extraction, 6a then 6b, with re-export files and a ratchet |
| 5 | NGO sign-in pipeline, assurance levels, per-NGO policy |
| 6 | Operator server and operator web app |
| 7 | Web kit, from components both web apps use |
| 8 | Deploy the operator service behind Identity-Aware Proxy, rotate the owner password, delete the organisation CLI |
| 9 | Ratchet the re-export files to zero and finish the documentation |

Each step was planned as one pull request that leaves `npm run ci` green and never lowers the test count. See section 14 for the later decision to skip full test runs while building.

### Deliberately left out

An ORM. Publishing any package. Provider RBAC or Auth0 Organizations as the authorization source. A local password for operators. Operator management screens (grants go through the audited command). Step-up for onboard and retry. Dual approval for close. Listing or searching all organisations (lookup by code or request id only). Bulk or CSV onboarding, usage metering, and a device-login CLI. Changing admin-invitation delivery. MySQL, passkeys and offline capture, which stay on their own roadmap. A separate multi-agent implementation plan, which was to be the next document after this plan was approved.

## 10. Web core reorganisation

Committed as `b3a370d` ("Group web core modules into feature folders and tighten three server edge cases"), before phase zero. This was existing uncommitted work, analysed and committed so the tree was clean. It is not part of the package split.

Flat files under `web/src/app/core` moved into `fields/`, `http/`, `i18n/`, `shell/`, and `records/` with subfolders `bulk`, `gateway`, `import`, `list`, `print`, `record` and `sharing`. Imports were updated, including `web/scripts/locale-areas.mjs`, `test/setup-text.ts` and `test/web-architecture.test.ts`. Locale import depth became `../../../../../`. The README source path is now `legacy/ngo-platform`, and the `i18n-text.ts` path was updated.

## 11. Three small server fixes

Same commit, `b3a370d`:

- `IdentityService` no longer has `assignRole`, `removeRole` or `suspendMember`. The roles pick is `'save' | 'grants' | 'assign'`.
- A payment webhook whose stored secret no longer decrypts throws. `configuredCredentials()` returns null when the gateway is not set up, and a secret that fails to decrypt is not treated as "not configured".
- Creating a money account uses `ON CONFLICT DO NOTHING` on `(tenant_id, code)` for its ledger account, instead of swallowing every insert error.

## 12. Deletion of the App Engine deploy files

Committed as `421e537`, kept separate from the web reorganisation so it can be reverted on its own. Deleted from the repository root:

- `app.yaml`
- `cron.yaml`
- `azure-pipelines.yml`
- `.npmrc` (the root registry config only)

`web/.npmrc` remains. It names the public npm registry and holds no credentials.

These files had been added on purpose in `f4b7285` ("Add App Engine deploy files, monitoring definitions, and product locale"). Deleting them may not have been intended. The commit has not been pushed, so reverting `421e537` restores them.

The commit message says the architecture doc section 4.4 still describes them. That citation is wrong. The files are described in `docs/operations/devops-handover.md` (sections 0.4 and 1) and in the CI and deploy parts of `docs/architecture/ngo-management-platform.md`. An attempt to amend the message was blocked, so the message still says section 4.4. The docs were not updated to match the deletion. The approved plan puts a new `app.yaml` and `cron.yaml` under `apps/onengo/server` and `apps/onengo-console/server` later, so the root copies are not the long-term home either way.

## 13. The `block/C-composition` branch

While looking for a `develop` branch, the only other local branch was `block/C-composition`, at `23310ad`, message "WIP block C (old base)". This clone has no remote and no `develop` until section 15. `block/C-composition` was not used as the base for Version 2. It is an older work-in-progress branch and was left as it was.

## 14. Decision to skip test runs while building

A baseline `npx vitest run` was started during phase zero, before the instruction to stop running tests. Result:

- 1,652 tests passed
- 2 tests failed
- 5 test files failed in total (3 suites failed to load, plus the 2 failing tests)
- 140 test files, about 6 minutes

Failures:

- `test/alerts.test.ts` reads `ops/monitoring/metrics`, which is not at the repository root.
- `web/src/app/builder/editors/generic/previews.test.ts` and `schema-form.test.ts` read `modules/donations` from the repository root.
- `test/migrate.test.ts` reads `migrations` from the repository root.
- `test/kysely-architecture.test.ts` flags `web/package-lock.json` because the boundary scan sees the word `kysely` there.

These look like path fallout from an earlier folder move (commit `f4b7285` updated docs and script paths, and moved product content). They were not fixed. The instruction after that run was: do not run the suite up front and do not wait on long test sessions. Build first, and test part by part later. The baseline numbers were still written into section 14 of the architecture doc so the later ratchet has a starting point. No test run has been started since that instruction.

## 15. Commits, master, and the develop branch

Instructions, in order:

1. Analyse uncommitted work and commit it before phase-zero decision records. Do not push.
2. Do not keep editing the current tree in place for the structure change. Branch from `develop`, not from `master`. Never touch `master`. Merge back to `develop` only when the work is done. The organisation CLI stays until the last step.
3. This clone had no `develop` branch and no git remote, so there was nothing to branch from except `master` and `block/C-composition`. Work stopped and that was reported.
4. Then: create a local branch named `develop` from the current master tip (the two commits above). Do not push it. Do not modify `master` further. Carry the uncommitted phase-zero edits onto `develop`.

What happened:

- `b3a370d` and `421e537` were created on `master` before the "never touch master" instruction. They are the master tip. They were not pushed.
- `develop` was created from that tip and checked out. `master` was not moved again.
- Phase zero was committed on `develop` as `2acb8d0`.
- A later status check: `develop` checked out, working tree clean, no phase-one code started.

Recent history on `develop`:

```text
2acb8d0 Phase 0: record ADR-14 to ADR-18 and update the architecture doc for two deployables
421e537 Remove App Engine deploy files, the Azure pipeline and the npm registry config
b3a370d Group web core modules into feature folders and tighten three server edge cases
453f9c4 Make the architecture guards self-contained and type-check the web tests
bccfd02 Release 2: organisation-specific sign-in screen (O11)
f4b7285 Add App Engine deploy files, monitoring definitions, and product locale; update docs and scripts paths
```

## 16. Phase zero, completed on develop

Committed only in `docs/architecture/ngo-management-platform.md` (`2acb8d0`). No application code.

### ADR-14

Two deployables over shared private workspace packages: main server and main web for NGOs, operator server and operator web for platform operators, over `@onengo/kernel`, `@onengo/platform` and later `@onengo/web-kit`. Onboarding stays in the engine behind `OperatorControlPlane`, exported only through `@onengo/platform/operator`. Revises ADR-01 and ADR-10. Unlike the public site (ADR-09), the console has different users, privileges and threat model.

### ADR-15

Service database roles, as in section 9. Migrations 028 and 029. A compromised serving process cannot run DDL or read across tenants outside the listed functions.

### ADR-16

The provider authenticates. `operator_account` authorizes and its UUID is the audit identity. Backend-for-frontend sessions. Step-up for suspend, reactivate and close. Grants only through an audited command. Migrations 030 and 031.

### ADR-17

One sign-in pipeline, assurance levels, per-NGO OpenID Connect opt-in, per-NGO policy, method recorded on the session, two-admin rule before passwords can be turned off. Migrations 032 and 033.

### ADR-18

One version, one migration stream, `SCHEMA_LEVEL`, `additive` and `breaking` markers, both services released from the same commit.

ADR-01, ADR-07 and ADR-10 in the summary table now point at these revisions. ADR-07 still rejects an external provider for NGO members; ADR-16 is the exception for operators.

### Doc sections updated

- 4.2: the shared installation lists a separate `operator` App Engine service. The CLI is described as today's stand-in and as something removed at cutover.
- 4.3: retitled. One main artifact for both installation modes; the operator console is a second deployable.
- 11: target workspace tree added. The "as built" tree is unchanged.
- 13: ADR-14 through ADR-18 added.
- 14: baseline test count recorded.
- The implementation-status note points at section 11 for both the current layout and the planned one.

## 17. What has not been done

- Phase 1 has not started: no service-role migrations, no `operator_account`, no `src/api/` entry points, no workspaces.
- Phases 2 through 9 have not started.
- The organisation CLI is still in the tree: `src/organisation.ts`, `organisation-command.ts`, the `organisation:*` scripts, and `ONENGO_OPERATOR`. Removing them is the last step, after the operator service exists and the owner password has been rotated.
- No pull request, and no push.
- The multi-agent execution plan was left as the next document after approval. Implementation then started directly, so that separate planning document was not written.
- This summary file is uncommitted until someone asks for a commit.

## 18. Working agreements for the rest of the build

- Stay on `develop`. Do not modify `master`. Do not push unless asked.
- Do not run the full test suite at the start of a phase. Test the piece just built, later.
- Report after each block: what was done, which files changed, and what is blocked or deferred.
- Do not commit unless asked. Do not read `.env` secrets into a commit or a document.
- The organisation CLI removal remains the final step.

## 19. Repo-root tooling

Added here because section 5 names the packages and not the files that sit above them. The approved plan's repository root is:

```text
one-ngo/
  package.json                   # private; workspaces ["packages/*","apps/*"]; typecheck, test, build, ci, ci:audit
  package-lock.json              # one lockfile for every workspace
  tsconfig.base.json             # shared compiler options; temporary "paths" for deep imports during phase 2 only
  vitest.workspace.ts            # one project per package and app
  .env.example                   # sections: DEPLOY_*, MAIN_*, OPERATOR_*
  docs/architecture/             # ADR-14 to ADR-18 added in phase 0
  utilities/
    start-dev.ts
    data/
      dev-seed.sql              # local organisations to onboard; raw SQL only
    db-types.ts                  # writes packages/platform/src/infrastructure/postgres/db-types.ts
    maintenance/                 # measure.mjs
  packages/
    common/                      # build-app.ts; shared builder; --production enables optimized server and web artifacts
    kernel/  platform/  web-kit/
  apps/
    onengo/          server/  web/
    onengo-console/  server/  web/
```

## 20. Folder trees from the approved plan

Section 5 gives each package a role. These are the directory trees from the approved plan. `←` marks where today's code moves from. Folders marked unchanged move whole, so imports inside them do not change.

### `@onengo/kernel`

The kernel imports no `@onengo/*` package and contains no tenant, member or NGO concept.

```text
packages/kernel/
  package.json                   # private; exports ".", "./ports", "./errors", "./db", "./http", "./oidc",
                                 #   "./crypto", "./observability", "./notify", "./files", "./env"
  src/
    ports/                       # phase 6a: port types the kernel implements
      logger.ts                  ← src/domain/ports/logger.ts
      transaction.ts             ← src/domain/ports/transaction.ts (TransactionManager, Tx, TransactionOptions)
      email-transport.ts         ← src/application/notifications/ports/email-transport.ts
      file-store.ts              ← src/application/files/ports/file-store.ts
      credentials.ts             ← src/domain/identity/ports/credentials.ts
      password-breach.ts         ← src/domain/identity/ports/password-breach.ts
      http-host.ts               ← ErrorsApi, ShutdownHost, asApplicationError from application/*/http-api.ts
      field-issue.ts             ← FieldIssue from src/http/contracts/errors.ts
      index.ts
    errors/
      platform-error.ts          ← src/shared/errors.ts
    db/                          # phase 6b: mechanics only, no tenant preamble
      pool.ts                    ← generic half of src/infrastructure/postgres/pg-database.ts
      database.ts                ← src/infrastructure/postgres/database.ts + db.ts
      tx.ts                      ← src/infrastructure/postgres/tx.ts
      kysely-executor.ts         ← driver from src/infrastructure/postgres/kysely.ts, generic over the DB type
      migrate.ts                 ← src/infrastructure/postgres/migrate.ts (folder passed in)
      database-support.ts        ← src/infrastructure/postgres/database-support.ts
      db-errors.ts  db-json.ts  readiness.ts
    http/
      create-server.ts           ← shared Fastify setup from src/http/server.ts (headers, request ids, error hook)
      errors.ts  cors.ts  json-body.ts  validation.ts  client-address.ts  lifecycle.ts  download.ts
      static.ts                  ← src/http/plugins/static.ts
      rate-limit.ts              ← src/infrastructure/http/rate-limit.ts
      iap.ts                     # new: verifies x-goog-iap-jwt-assertion
    oidc/
      client.ts                  ← protocol half of src/application/identity/oidc.ts (discovery, PKCE, state, nonce)
      verify.ts                  # issuer, audience, signature, nonce, auth_time, amr, acr
      jwks.ts                    # cache, one bounded refetch on unknown kid, rotation
      result.ts                  # ExternalAuthResult { issuer, subject, email, emailVerified, authTime, amr, acr, sid }
      safe-next.ts               ← safeNextPath from oidc.ts
    crypto/
      crypto.ts                  ← src/infrastructure/crypto/crypto.ts
      credential-crypto.ts  password-sources.ts
      tokens.ts                  # access-token sign and verify
      cookies.ts                 # __Host- cookie helpers
      totp.ts
    observability/  log.ts  alerts.ts  silent-logger.ts
    notify/         transports.ts
    files/          file-store.ts  file-type.ts
    env/            environment.ts  ← generic half of src/composition/entry.ts
  test/
```

### `@onengo/platform`

```text
packages/platform/
  package.json                   # private; exports "./main", "./operator", "./contracts", "./browser",
                                 #   "./deployment", "./testing"; nothing else is importable
  src/
    api/
      main.ts                    # createMainPlatform, MainPlatform, MainOptions, Paths, assertCompatibleSchema
      operator.ts                # createOperatorControlPlane, OperatorControlPlane, OperatorPrincipal,
                                 #   OperatorTables (Kysely types for operator_* tables), lifecycle types
      contracts.ts               # main and operator HTTP request and response types and JSON Schemas
      browser.ts                 # expression language, permissions, patches, number formats, rich text
      deployment.ts              # prepareDeployment, reencryptSensitiveFields, SCHEMA_LEVEL, compatibility rules
      testing.ts                 # contract-test support and fixtures
    platform.ts                  ← src/platform.ts (paths and asset manifest required)
    prepare-deployment.ts        ← src/prepare-deployment.ts
    assets.ts                    # new: product/, QuickJS WASM, sandbox worker, web root located from options
    composition/                 ← src/composition/* unchanged, including organisations.ts
    domain/                      ← src/domain/* unchanged; ports moved in 6a keep re-export files
      identity/
        assurance.ts             # new: assurance levels and what each sign-in method and provider proves
        auth-policy.ts           # new: per-NGO methods, providers, password on/off, assurance per role
    runtime/                     ← src/runtime/* unchanged
    application/                 ← src/application/* unchanged except identity/
      identity/
        sign-in/                 # new three-stage pipeline
          verify-password.ts     ← password and lock-out checks from identity-service.ts
          verify-email-code.ts   ← from identity-service.ts
          verify-oidc.ts         ← tenant half of oidc.ts, over @onengo/kernel/oidc
          resolve-account.ts     # account, membership, linking, method allowed by NGO policy
          enforce-assurance.ts   # role assurance; asks for local TOTP when the provider can't prove it
          issue-session.ts       # one refresh family, one access token, one audit entry
        identity-service.ts      # thin facade over sign-in/ (existing callers unchanged)
        oidc.ts                  # provider configuration per NGO; flow uses sign-in/
        people-service.ts  roles-service.ts  profile-service.ts  access-service.ts  ...
      organisations/
        onboarding-service.ts    # stays; takes OperatorPrincipal instead of a string
        lifecycle-service.ts     # stays; takes OperatorPrincipal
        control-plane.ts         # new: the narrow OperatorControlPlane facade
        organisation-command.ts  # transitional CLI support; deleted in phase 8
        organisation-service.ts  http-api.ts  ports/
    infrastructure/              ← src/infrastructure/* minus kernel files
      postgres/
        tenant-database.ts       ← tenant half of pg-database.ts (app_runtime, app_bind_tenant, preamble)
        kysely.ts                # Kysely<DB> over the kernel executor
        db-types.ts  tenants.ts  tenant-directory.ts  tenant-export.ts  retention.ts  sql-fragments.ts
        query-compiler/
        stores/                  # all current stores
          auth-policy-store.ts   # new
          owner/                 # all current owner stores; system work calls security-definer functions
      audit/  connectors/  jobs/  outbox/  payments/  transfer/  contract-tests/
      crypto/                    secret-rotation.ts  connector-secrets.ts  payment-secrets.ts
      http/                      idempotency.ts  idempotency-status.ts  ports/
    shared/                      ← src/shared/* unchanged (errors.ts re-exports the kernel after 6a)
  product/                       ← product/* unchanged
    locale/  modules/  platform/  schemas/
    migrations/
      001 ... 027                unchanged
      028_service_roles.sql      # ngo_main_runtime, ngo_main_system, ngo_operator, ngo_operator_runtime
      029_system_functions.sql   # security-definer functions for cross-tenant system work
      030_operator_identity.sql  # operator_account, operator_session, operator_login_state, operator_step_up
      031_audit_actor.sql        # platform_audit actor columns; requested_by becomes operator_account_id (uuid)
      032_tenant_auth_policy.sql # per-NGO methods, provider enablement, assurance, recovery admins
      033_session_method.sql     # refresh_token.method, for method-disable revocation
  test/                          ← engine tests (same relative depth)
    security/  layer-architecture.test.ts  layer-allowlist.json  layer-baseline.ts
    kysely-architecture.test.ts  raw-sql-baseline.json
    service-roles.test.ts        # each role can do only its listed work; no role owns tables or has BYPASSRLS
    auth-pipeline.test.ts        # every method passes through resolve, assurance and issue
    assurance-downgrade.test.ts  # a weaker method can't sign in a role that requires stronger assurance
    oidc-opt-in.test.ts          # a provider not enabled for an NGO is neither listed nor accepted
    compatibility.test.ts        # schema-level rules
```

### `@onengo/web-kit`

Created in phase 7, from components that main-web and operator-web both use. Peer dependency is Angular at the same version as both apps. If compiling the kit from source fails, ng-packagr is the fallback (section 7, item 14).

Phase 7 also checks the initial-download budget of 90 kB compressed. That is the same budget the main web app is already held to (architecture doc section 12 and the release-1 web note: initial download against a 90 kB budget). Extracting shared components must not push the main app over 90 kB. Re-export files stay in main-web so existing imports keep working.

```text
packages/web-kit/
  package.json                   # private; peerDependencies Angular (exact match with both apps)
  src/
    public-api.ts
    models/   rows.ts  list.ts  form.ts  crumbs.ts
    tokens/   shell-port.ts  product.ts
    i18n/     i18n.ts  i18n-text.ts  languages.ts  translate.pipe.ts
    http/     http.ts
    paging/   paged-controller.ts
    logic/    reorder.ts  links.ts  autocomplete.ts  safe-next.ts
    ui/       app-bar.ts  icon.ts  menu-button.ts  nav.ts  panel.ts  form-panel.ts  form-problems.ts
              screen-heading.ts  page-back.ts  table-rows.ts  card-rows.ts  breadcrumb.ts  autocomplete.ts
              (more only when operator-web uses them)
    styles/   app-bar.css  nav.css  breadcrumb.css  table-rows.css  autocomplete.css
  test/
```

### `apps/onengo/server`

```text
apps/onengo/server/
  package.json                   # private; deps @onengo/kernel, @onengo/platform (./main, ./contracts, ./deployment)
                                 # build delegates to packages/common/build-app.ts onengo --production
  app.yaml                       # service: default; its own service account
  cron.yaml
  src/
    main.ts                      ← src/main.ts (logins: DATABASE_RUNTIME_URL, DATABASE_SYSTEM_URL)
    deploy.ts                    ← src/deploy.ts (the only holder of DATABASE_OWNER_URL)
    http/
      server.ts                  ← src/http/server.ts
      context.ts  idempotent.ts  ← src/http/*
      plugins/                   ← src/http/plugins/* except static.ts
        admin.ts  auth.ts  builder.ts  files.ts  internal.ts  organisation.ts
        payments.ts  privacy.ts  records.ts  session.ts
  test/
    http.test.ts  auth-flows.test.ts  security/s4-http.test.ts
    artifact.test.ts             ← test/server-bundle.test.ts, run from a clean deployment folder
    no-operator-access.test.ts   # no @onengo/platform/operator import; no lifecycle routes; role refused on operator tables
```

### `apps/onengo/web`

```text
apps/onengo/web/                   ← web/ (one block)
  package.json  angular.json  tsconfig*.json  ngsw-config.json  proxy.conf.json  scripts/
  src/app/
    app.ts  routes.ts
    admin/  builder/  home/  inbox/  more/  pages/  people/  print/  pwa/  records/  shell/  services/
    core/
      server.ts                  # export * from '@onengo/platform/browser'
      contracts.ts               # from '@onengo/platform/contracts'
      admin/  auth/  builder/  fields/  inbox/  organisation/  people/  records/  shell/  testing/  ...
    ui/                          # NGO widgets; generic ones re-export the kit after phase 7
      cf-*  expression-field  record-picker  share-panel  role-preview  permission-field
      live-preview  diagram  widget  file-field/  location-field/  rich-text-field/  signature-field/
      baseline/  styles/
```

### `apps/onengo-console/server`

```text
apps/onengo-console/server/
  package.json                   # private; deps @onengo/kernel, @onengo/platform (./operator, ./contracts only)
                                 # build delegates to packages/common/build-app.ts onengo-console --production
  app.yaml                       # service: operator; IAP; its own service account and secrets
  src/
    main.ts                      # logins: OPERATOR_DATABASE_URL (ngo_operator), OPERATOR_RUNTIME_URL
    operators/directory.ts       # operator accounts, grants and the audit read; every change is audited
    cli.ts                       ← src/organisation.ts (transitional; resolves the operator to operator_account; deleted in phase 8)
    composition.ts
    operators/
      actions.ts                 # OPERATOR_ACTIONS and STEP_UP_ACTIONS (suspend, reactivate, close)
      authorize.ts               # operator_account.status and granted actions, checked on every request
      principal.ts               # builds OperatorPrincipal { operatorId (uuid), issuer, subject, display,
                                 #   authTime, amr, sessionId } from a verified sign-in
      provider.ts                # IdP adapter over @onengo/kernel/oidc; Auth0 by default, any provider with verifiable MFA
      sign-in.ts                 # authorization code + PKCE; refuses without fresh MFA evidence
      sessions.ts                # opaque session id in a __Host- cookie; tokens held server-side;
                                 #   refresh rotation; back-channel logout by sid; local revocation
      step-up.ts                 # one-time record bound to session, action, target and nonce;
                                 #   max_age=0 plus MFA; verified server-side, then used once
      csrf.ts
    infrastructure/
      operator-store.ts          # Kysely over OperatorTables
    http/
      server.ts                  # create-server + iap.ts verification; no tenant context
      plugins/
        operator-auth.ts         # /op/auth/login, /callback, /step-up, /refresh, /logout, /backchannel-logout
        organisations.ts         # onboard, status, retry, suspend, reactivate, close
  test/
    organisation-onboarding.test.ts  ← test/organisation-onboarding.test.ts
    sign-in.test.ts              # PKCE, state, nonce, issuer, audience; no MFA evidence means refused
    authorize.test.ts            # each action refused without its grant or for a disabled account
    step-up.test.ts              # suspend, reactivate and close need fresh auth_time and MFA; record used once
    sessions.test.ts             # revocation, rotation, back-channel logout, CSRF
    audit.test.ts                # operator UUID plus issuer, subject and snapshot recorded
    isolation.test.ts            # member tokens and cookies refused; no import of @onengo/platform/main
    artifact.test.ts
```

### `apps/onengo-console/web`

```text
apps/onengo-console/web/
  package.json  angular.json  tsconfig*.json
  src/app/
    app.ts  routes.ts
    services/        operator-api.ts (over @onengo/platform/contracts)  operator-session.ts
    sign-in/         sign-in.page.ts  callback.page.ts  step-up.page.ts
    organisations/   find.screen.ts  status.screen.ts  onboard.screen.ts  onboard-store.ts
                     lifecycle-panel.ts  retry-panel.ts
```

## 21. Named system functions

Section 9 says `ngo_main_system` may call only listed security-definer functions. The list from the approved plan, moved into functions owned by the owner role in migration 029, is:

- sign-in lookup across tenants
- outbox dispatch
- jobs
- scheduler tick
- retention
- the current owner stores' cross-tenant reads and writes

`ngo_main_system` still has no access to `operator_*` tables and no lifecycle writes. The owner login itself is used only by `deploy.ts` and `fields:reencrypt`.

## 22. Web bridge file names

Section 5 says the web apps import `@onengo/platform/browser` and `@onengo/platform/contracts`. The files that change are the current bridges:

- `web/src/app/core/server.ts` becomes `export * from '@onengo/platform/browser'` (in the plan this file lives at `apps/onengo/web/src/app/core/server.ts`).
- `web/src/app/core/contracts.ts` imports from `@onengo/platform/contracts` (in the plan, `apps/onengo/web/src/app/core/contracts.ts`).

Those two files replace the in-repo bridges that re-export rules out of `src/shared` and the HTTP contract types. This is review comment R31.

## 23. Operator screen list

Section 5 names the operator web app and not its screens. The approved console is lookup by code or request id, not a list of every organisation. Screens and pages:

| Path | What it is |
| --- | --- |
| `sign-in/sign-in.page.ts` | Start of provider sign-in |
| `sign-in/callback.page.ts` | Return from the provider |
| `sign-in/step-up.page.ts` | Fresh sign-in before suspend, reactivate or close |
| `organisations/find.screen.ts` | Look up by organisation code or request id |
| `organisations/status.screen.ts` | Status of one organisation or request |
| `organisations/onboard.screen.ts` | Onboard, with validate-only |
| `organisations/onboard-store.ts` | Client state for the onboard flow |
| `organisations/lifecycle-panel.ts` | Suspend, reactivate and close |
| `organisations/retry-panel.ts` | Resume a failed onboard |
| `operators/operators.screen.ts` | Operators, their actions and logins. Manage operators, with a fresh two-factor check |
| `activity/activity.screen.ts` | Read of `platform_audit` |
| `services/operator-api.ts` | Calls over `@onengo/platform/contracts` |
| `services/operator-session.ts` | Session held by the operator server |

An operator with Manage operators changes accounts, actions and logins in the console. Each change needs a fresh two-factor check and is written to `platform_audit`. The first operator is inserted with SQL. Local development uses `utilities/seed/console-operator.sql`. A database administrator does that for production. There is no grant command.

Operator sign-in refuses a token whose `amr` does not show MFA. Auth0 is accepted when an MFA action puts `mfa` in `amr`. The operator server verifies the Identity-Aware Proxy header `x-goog-iap-jwt-assertion` itself. Completing an NGO admin invite still goes through `completePasswordToken`, which uses up every open token for that person.

## 24. Session notes

Two points from the conversation that are not product decisions:

- The session opened with the question "why the voice conversation is not coming". That was a call-setup problem, before any question about the CLI.
- When implementation was approved, the instruction was to use the maximum context window and the highest-end model available, then work phase by phase. The independent review had already been run on GPT-5.6. The implementation itself continued in this session on the develop branch.
