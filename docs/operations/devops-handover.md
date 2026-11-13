# DevOps handover: deferred operations blocks

Status: 2026-10-26. Applies to branch `backend_enhancement` at `9e8e492` or later.

These five blocks of `docs/plans/ngo-backend-enhancement-plan.md` need hosted systems or account access that the build agents do not have, so they are handed to a DevOps engineer:

| Block | Task | Needs |
| --- | --- | --- |
| O5 | Turn on the GitHub Actions workflows and make CI block merges | GitHub repository admin, a Google Cloud workload identity for the deploy job |
| O3 | Apply the alert metrics, policies and dashboard | Google Cloud project, Logging Admin and Monitoring Editor roles |
| O4 | Backup and restore drill on the hosted database | Hosted PostgreSQL admin, a throwaway database, Cloud Storage access |
| O1 | Measure memory, cold start and save latency on the target environment | A staging App Engine service and a staging hosted database |
| O6 | Verify Razorpay and Cashfree against their sandboxes | Sandbox accounts with both providers, a public staging URL |

Do them in the order of this document. O5 protects everything after it; O3 gives you the dashboard O1 reads; O4 and O1 use the staging environment that O6 also needs.

When a block is done, update its row in section 5.1 of `docs/plans/ngo-backend-enhancement-plan.md` with the date, the results and anything that failed, and tell the development team about every failure. Never paste a secret into a document, a commit, a pipeline file or a ticket.

---

## 0. Before you start

### 0.1 What the server needs

The server reads its settings from environment variables (listed with comments in `.env.example`). It never reads `.env` in production.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL only: a `postgres://` (or `postgresql://`) connection string to PostgreSQL 15 or later, for one-NGO and shared installations. MySQL and every other database are not supported (architecture section 4.7, ADR-13). The server and the deploy step check this at start: another scheme, MySQL, or a server older than PostgreSQL 15 logs `Start-up failed` with one of the messages in section 4.7 and exits with code 1 before anything is migrated. For a hosted provider, use its pooled TLS connection string. |
| `INSTALLATION_MODE` | no | `one-ngo` (default when unset) or `shared`. Any other value stops the server and the deploy step at start (`Start-up failed`). |
| `DATABASE_POOL_SIZE` | no | Default 3. Free tiers allow few connections. |
| `TOKEN_SECRET` | yes | At least 32 characters. Changing it signs everyone out. |
| `ENCRYPTION_KEY` | yes | 32 random bytes, base64. Encrypts two-step secrets, connector and gateway credentials, and sensitive record values (PAN, phone and similar). **If it changes or is lost, none of these can be read** unless the old key is in `ENCRYPTION_KEY_PREVIOUS`. Keep it with the database backups' access controls (O4). |
| `ENCRYPTION_KEY_PREVIOUS` | no | Earlier `ENCRYPTION_KEY` values, comma separated. Sensitive record values, two-step secrets and connector and gateway credentials under them still read. After a rotation, run `npm run fields:reencrypt` (section 0.2) and remove the old key once its jobs are done (architecture section 7.5). |
| `PUBLIC_BASE_URL` | yes | The address people use, e.g. `https://ngo-staging.example.org`. Used in emailed links, sign-in redirects and webhook URLs. |
| `SHIPPED_MODULES` | no | Default `donations`. Read by the deploy step. |
| `TICK_SECRET` | no | Only for a scheduler other than App Engine cron: lets it call `POST /internal/tick` with `Authorization: Bearer <value>`. App Engine cron needs no secret (section 0.4). |
| `MEMORY_ALERT_MB` | no | Default 300. Threshold for the `memory.high` alert (O3). |
| `FILE_STORE_BUCKET`, `FILE_STORE_PREFIX` | yes when hosted | Cloud Storage bucket and key prefix for uploaded files and exports. Without them files go to the instance's local disk, which App Engine discards. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | no | Without them, sign-in codes and invitations are not sent. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ISSUER`, `OIDC_ALLOWED_DOMAINS`, `OIDC_PROVIDER_ID`, `OIDC_PROVIDER_LABEL` | no | The shared OpenID Connect sign-in provider each NGO may opt into. An empty `OIDC_ISSUER` means Google. Redirect URI: `<PUBLIC_BASE_URL>/api/auth/oidc/callback`. Keep `OIDC_PROVIDER_ID` unchanged once NGOs have opted in. The older `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS` and `GOOGLE_ISSUER` are still read when the `OIDC_*` value is empty, and are deprecated. |
| `CONNECTOR_ALLOWED_HOSTS` | no | Comma-separated host names that SMS, WhatsApp, webhook, http and oauth connectors may call even though they resolve to a private, loopback or other non-public address. Empty (the default) allows none. Connectors call `https://` addresses only and never follow redirects. |
| `BREACHED_PASSWORD_CHECK` | no | `online` (default) or `off`. |

**Organisation sign-in from the console.** Operators with the `sign_in` grant set each organisation's sign-in policy, its opt-in to the shared provider (optionally limited to its own email domains), and its own OpenID Connect providers. Every change needs a fresh step-up and a reason, and is written to `platform_audit` and the organisation's audit without secrets. Client secrets are stored in `connector.secret_enc` under `ENCRYPTION_KEY`, so the console service gets the main `ENCRYPTION_KEY` (and `ENCRYPTION_KEY_PREVIOUS` during a rotation) beside its own `OPERATOR_ENCRYPTION_KEY`. `npm run fields:reencrypt` re-encrypts these secrets with the other connector credentials. To show the shared provider, the console reads the non-secret `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_PROVIDER_ID`, `OIDC_PROVIDER_LABEL` and `OIDC_ALLOWED_DOMAINS`; it never needs `OIDC_CLIENT_SECRET`. An operator with Manage operators grants that action from the console. The first operator is inserted in SQL; local development uses `utilities/seed/console-operator.sql`.

**OAuth connectors.** An organisation's `oauth` connector (for example a Google account used by an http email sender) is registered with the provider by its administrator, not through environment variables. The redirect URI to register is `<PUBLIC_BASE_URL>/api/connectors/oauth/callback`, so `PUBLIC_BASE_URL` must be the exact public address. The client secret and the access and refresh tokens are stored in `connector.secret_enc`, encrypted under `ENCRYPTION_KEY`. Losing the key means every oauth connector must be connected again, and a key rotation needs `npm run fields:reencrypt` like the other connector credentials.

Store every secret in Google Secret Manager. App Engine standard does not inject Secret Manager values into environment variables by itself, so the deploy job must read them and pass them at deploy time (for example by generating a temporary `app.yaml` that is never committed). Agree the mechanism with the development team before the first deploy.

### 0.2 How a release is built and deployed

Section 3.3 of `docs/architecture/ngo-platform-architecture.md` is the reference. In short, on the build machine or in CI:

```powershell
npm ci
npm --prefix web ci
npm run build:server        # dist/server.js and dist/deploy.js
npm run web:build           # web/dist/web/browser
$env:DATABASE_URL = '<target database>'
npm run deploy:prepare      # migrations, platform package, organisation re-sync, profiles, shipped modules
gcloud app deploy           # only if deploy:prepare succeeded
```

- The deploy step runs **once per release, from one place at a time, before** the new version starts. Running it again is harmless.
- The server itself never migrates. If the deploy step was not run, the new version refuses to start (`Start-up failed` in the log, exit code 1) and the old version keeps serving.
- `npm start` runs `node --enable-source-maps dist/server.js`. `dist/` must stay directly under the package root.
- **Re-encrypting sensitive values.** Run `npm run fields:reencrypt` (the deploy step with `--reencrypt-sensitive-fields`; `npm run fields:reencrypt:dev` runs the source) **once after the first deploy that includes field encryption (S2)**, which encrypts values stored before it in plain form, and **once after every key rotation** (old key moved to `ENCRYPTION_KEY_PREVIOUS`, new key in `ENCRYPTION_KEY`). It needs the same `DATABASE_URL`, `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS` as the server, does the deploy step's work first, rewrites every two-step secret and connector or gateway credential that is not under the current key, then queues one `fields.reencrypt` job per record type with stored sensitive values in every active organisation, and logs only counts (`"message":"sensitive field re-encryption queued"` with `organisations`, `recordTypes`, `twoStepSecrets` and `connectorSecrets`). A stored secret that no configured key opens fails the run and changes nothing. The serving instances run the jobs on their ticks; each job's progress and result (`checked`, `rewritten`) are on the job. Running it again while jobs are still queued queues nothing new. Remove an old key from `ENCRYPTION_KEY_PREVIOUS` only after every job is done. Normal start and the plain deploy step never queue these jobs.

### 0.3 Known gaps that need a developer first

Raise these with the development team before you plan the work; each blocks part of a block below.

1. **App Engine deploy files are a starting point only.** `app.yaml` and `cron.yaml` now exist at the repository root (and `.gcloudignore`), matching section 0.4 below, but their placeholder values (staging host, instance class, scaling) need review with the development team before the first deploy, and every secret still comes from Secret Manager at deploy time, never committed.
2. **`npm run measure:bundle` refuses a non-local database** on purpose. O1 on the hosted database therefore uses the manual steps in section 4, or a developer adds an explicit remote mode.
3. **The web app has no payment page.** A create-payment response includes checkout data for the provider's widget, but no screen in the app shows it. O6 completes payments with the providers' own test tools (section 5.4).

### 0.4 Staging environment (starting point, verify before use)

O1 and O6 need a staging App Engine service in `asia-south1` and a staging hosted PostgreSQL database (Mumbai region where the provider offers one). Use a **copy of test data only**, never production data.

A starting `app.yaml`, for the development team to review:

```yaml
runtime: nodejs22
instance_class: F1
entrypoint: node --enable-source-maps dist/server.js
automatic_scaling:
  min_instances: 0
  max_instances: 1
env_variables:
  PUBLIC_BASE_URL: https://<staging host>
  DATABASE_POOL_SIZE: "3"
  MEMORY_ALERT_MB: "300"
  # TOKEN_SECRET, ENCRYPTION_KEY, DATABASE_URL, TICK_SECRET, SMTP_*:
  # injected at deploy time from Secret Manager, never committed.
```

A `.gcloudignore` should exclude `node_modules/`, `.data/`, `.env` and `coverage/`; App Engine installs `dependencies` from the root `package.json` itself.

**Scheduler: App Engine cron (primary).** App Engine cron calls `GET /internal/tick` with its `X-Appengine-Cron: true` header, which the server accepts only when it runs on App Engine (App Engine strips that header from outside requests). No secret is involved. A `cron.yaml` next to `app.yaml`:

```yaml
cron:
  - description: Scheduler tick
    url: /internal/tick
    schedule: every 60 minutes
```

Deploy it with `gcloud app deploy cron.yaml` (it is separate from the service deploy) and check it under App Engine → Cron jobs, where "Run now" gives a 200 with the tick's counts. Use `every 60 minutes` for a one-NGO installation and `every 5 minutes` for the shared installation (section 4.5 of the architecture doc).

**Scheduler: Cloud Scheduler (alternative).** For a host other than App Engine, or if cron cannot be used, call `POST /internal/tick` with the bearer secret. GET never accepts the secret.

```powershell
gcloud scheduler jobs create http ngo-tick `
  --location=asia-south1 --schedule="every 60 minutes" `
  --uri="https://<staging host>/internal/tick" --http-method=POST `
  --headers="Authorization=Bearer <TICK_SECRET>"
```

Keep the tick secret in Secret Manager and set `TICK_SECRET` on the service; the command above puts it in the job definition, so restrict who can read Cloud Scheduler jobs. Without `TICK_SECRET`, POST accepts only the App Engine cron header.

---

## 1. O5: GitHub Actions CI and CD

**Goal:** production deploys only from `master`, only after the test gate passes, only after a person approves, and a bad release moves traffic back by itself. Stage deploys from `develop` after the same gate, to Cloud Run in its own project, with no required reviewer. The full picture is in `docs/operations/deployment-plan.html`.

**Test gate (`.github/workflows/ci.yml`).** It runs on every pull request and on every push to `develop` and `master`. Two jobs run in parallel, and a third job, named **CI gate**, fails unless both passed:

| Job | What it runs | What it catches |
| --- | --- | --- |
| Typecheck, build, test | `npm ci`, then `npm run ci` against a throwaway `postgres:16` service | Type errors, broken builds of both servers and all web apps, every vitest test (unit, PostgreSQL, row-level security), and the artifact tests that start the real bundle, check it refuses a database the deploy step has not prepared, and check two clean builds are identical |
| Dependency audit | `npm run ci:audit` | Known high-severity vulnerabilities in production dependencies |
| CI gate | Reads the two results | Gives branch protection one name to require |

The Playwright suite in `tests/e2e` is not in the gate. It needs the seeded local environment that `npm run dev` builds, and that script is PowerShell for Windows. It becomes a gate when a Linux-friendly way to start that environment exists.

**Stage (`.github/workflows/cd-stage.yml`).** `ci.yml` calls it after **CI gate** passes on `develop`. It builds both servers, migrates the stage database, stores that environment's secrets in Secret Manager, and deploys two Cloud Run services (`ngo` and `ngo-console`) in `asia-south1` with no minimum instances and a maximum of one. A new revision gets no traffic until `GET /health` answers. Traffic then moves, the public addresses are checked, and a failure sends traffic back to the previous revisions. Cloud Scheduler posts to `/internal/tick` once an hour with `TICK_SECRET`. Playwright then opens both sign-in pages. Rollback is `.github/workflows/rollback-stage.yml`, run from `develop`.

**Deploy (`.github/workflows/cd.yml`).** `ci.yml` calls it after **CI gate** passes on `master`; nothing else starts it. A manual run of the CI workflow on `master` is also gated and redeploys.

1. The `prod` environment waits for a required reviewer.
2. Build both servers from the exact commit, then fill the `REPLACE_WITH_` placeholders. A missing secret stops the run here, before the database or Google Cloud is touched.
3. Record which version of each service serves traffic now.
4. `npm run deploy:prepare` migrates the database with `DATABASE_OWNER_URL`.
5. Deploy both services as new versions with `--no-promote`, named `g<commit>-r<run number>`.
6. `.github/scripts/smoke-test.mjs` curls `GET /health` on each new version and expects `{"status":"ok"}`.
7. Move all traffic to the new versions, then curl `GET /health` on the public addresses. If that fails, traffic moves back to the recorded versions and the run fails.
8. Deploy `cron.yaml`. Old versions stay until the cleanup workflow removes them.
9. A separate job runs Playwright against the public addresses (`tests/e2e/post-deploy`). It opens the app sign-in page and the console sign-in page. It does not sign in and it does not write records. The suite in `tests/e2e/specs` stays out of this job because those tests create donors, donations and API keys. A failure here leaves the new version serving; use the rollback workflow to go back. The Playwright report is uploaded as an artifact.

**Rollback (`.github/workflows/rollback.yml`).** Run it on `master` with a version name from a deploy summary. It checks the version exists on both services, moves traffic, and curls `GET /health` on both public addresses. It does not undo migrations, so a migration must work with the release before it. It does not re-run the Playwright job.

**Cleanup (`.github/workflows/cleanup.yml`).** This is the same shape as the deploy repository's GCP cleanup, reduced to production. It is not part of a release. On Monday, Wednesday and Friday at 17:00 UTC it reports what it would delete and deletes nothing. A person runs it from the Actions tab to delete, and only after unticking dry run. The `prod` reviewers approve either run. It removes App Engine versions that carry no traffic and sit outside the newest five per service, files older than three days in the App Engine staging bucket, and untagged Artifact Registry images. A version whose traffic split cannot be read is kept.

### Steps

1. Push this branch and merge it, so GitHub can see the workflow files. This checkout has no remote until one is added.
2. Create the production Google Cloud project, enable App Engine, Cloud Build, Cloud Scheduler and the IAM Credentials API, and create the App Engine app once in Mumbai: `gcloud app create --project=<project> --region=asia-south1`. The workflow will not create it.
3. Create a deploy service account and a workload identity pool that trusts only this repository's `master` branch. Give the deploy service account permission to deploy App Engine versions, change traffic, deploy cron, and act as the two runtime service accounts. Treat the role list in `docs/operations/deployment-plan.html` as a starting point and tighten it after the first run.
4. Create the production database and its logins once, and run `npm run deploy:prepare` once by hand with the owner URL so the group roles exist. The deployment plan lists the statements. The first pipeline run cannot pass its smoke checks until the logins exist.
5. In GitHub, create the environment `prod`. Add a required reviewer, and limit deployments to the `master` branch.
6. On `prod`, set the variables and secrets listed in the deployment plan (10 variables, 10 secrets). Use environment-level values, not repository-wide ones.
7. Protect `master` and `develop`: require the **CI gate** check and a pull request before merging.
8. For stage, create a second Google Cloud project so it does not use production's App Engine hours. Enable Cloud Run, Cloud Build, Secret Manager, Cloud Scheduler, and the IAM Credentials API. Create two runtime service accounts and a deploy service account whose workload identity trusts only `develop`.
9. Create the GitHub environment `stage` with no required reviewer, and limit it to `develop`. Set the same variable and secret names as `prod`, plus the secret `TICK_SECRET`. `PUBLIC_BASE_URL` and `CONSOLE_PUBLIC_BASE_URL` may be empty on the first run: the health check uses the Cloud Run addresses. Set them to those addresses and run again before anyone signs in, because the first revision otherwise advertises `https://pending.invalid`.

### Done when

- A pull request shows **CI gate**, and cannot merge while it fails.
- A push to `develop` deploys stage only after the gate passes, and deploys nothing to production.
- A push to `master` deploys production only after the gate passes and a `prod` reviewer approves.
- A release that fails its public smoke checks returns traffic to the previous version without a person acting.
- The rollback workflow moves production to an older version and passes its checks.
- `npm run ci:audit` passes or its findings are listed for the development team.

Record: the first green gate run, the first production release name, the date **CI gate** became a required check, and the workload identity pool.

---

## 2. O3: alerts and dashboard

**Goal:** the four alert conditions the server logs reach a person, and the "NGO platform" dashboard exists.

**What the server does:** it writes one JSON log line per event to stdout, which App Engine sends to Cloud Logging. Entries an alert watches carry a fixed `alert` field:

| `alert` | Severity | Logged when | First response |
| --- | --- | --- | --- |
| `outbox.failed_permanently` | ERROR | A background event (email, SMS, webhook, automation, payment step) failed its fifth and last attempt | Read `eventType`, `tenantId` and the error. Usually a connector setting. To retry after the fix, set that `outbox_event` row back to `pending` with `attempts` 0; handlers that already finished do not run again |
| `job.failed` | ERROR | A background job (import, bulk operation, rebuild, file clean-up) stopped with an error | Read `kind`, `jobId` and the error. The person who started it can start it again once fixed |
| `http.unhandled_error` | ERROR | A request got a 500 from an unexpected error. The policy fires above 5 in 5 minutes | Users see a request id; search for it in the entry's trace field. A burst right after a deploy points at the release: route traffic back to the previous version |
| `memory.high` | WARNING | An instance's resident memory is above `MEMORY_ALERT_MB` (default 300 of the F1 instance's 384 MB) | Look for a large import or export, or growth since a deploy. Steady load means a larger instance class |

The definitions are in `docs/operations/monitoring/` (read `docs/operations/monitoring/README.md` too): one log-based metric per alert in `metrics/` (the file name is the metric name), one alert policy per metric in `policies/`, and `dashboard.json`.

### Steps

1. **Prerequisites.** The Logging Admin and Monitoring Editor roles on the installation's project, and the `gcloud` alpha and beta components (`gcloud components install alpha beta`).
2. **Choose the notification channel** (email, SMS or chat) with the product owner, and create it in Cloud Monitoring → Alerting → Edit notification channels. Note its id from `gcloud beta monitoring channels list --project=<project>`.
3. **Apply, metrics first** (the policies and dashboard refer to them). From the repository root, in PowerShell:

   ```powershell
   $project = '<project id>'
   Get-ChildItem docs/operations/monitoring/metrics/*.json | ForEach-Object {
     gcloud logging metrics create $_.BaseName --project=$project --config-from-file=$_.FullName
   }
   $channel = "projects/$project/notificationChannels/<channel id>"
   Get-ChildItem docs/operations/monitoring/policies/*.json | ForEach-Object {
     gcloud alpha monitoring policies create --project=$project --policy-from-file=$_.FullName --notification-channels=$channel
   }
   gcloud monitoring dashboards create --project=$project --config-from-file=docs/operations/monitoring/dashboard.json
   ```

   These files were checked only as valid JSON; gcloud has not been run against them. If gcloud rejects a field, note the exact error and send it to the development team rather than editing the file in place.
4. **Do not run `create` twice.** It makes duplicates. For later changes use `gcloud logging metrics update`, `gcloud alpha monitoring policies update <policy id>` and `gcloud monitoring dashboards update <dashboard id>` (`docs/operations/monitoring/README.md` has the full commands).
5. **Check that an alert fires.** From Cloud Shell or another Bash shell (PowerShell mangles the JSON quotes):

   ```bash
   gcloud logging write ngo-alert-check '{"alert":"job.failed","kind":"alert-check","message":"Alert check"}' \
     --project=<project id> --payload-type=json --severity=ERROR \
     --monitored-resource-type=gae_app --monitored-resource-labels=module_id=default,version_id=alert-check
   ```

   Within a few minutes an incident opens and the channel receives it. The incident closes by itself 30 minutes after the last matching entry. Repeat with `memory.high` at severity WARNING.
6. **Tune** the error-rate threshold (5 in 5 minutes, in `policies/http-error-rate.json`) to the installation's real traffic after a week of data.

**Limits:** the policies and the dashboard filter on `resource.type="gae_app"`. On another host, each policy and dashboard tile needs that changed; the metrics themselves match only the `alert` field.

### Done when

- The four metrics, four policies and the dashboard exist in the project.
- A test entry for `job.failed` and one for `memory.high` each reached the channel.

Record: project, channel type, the date applied, and any gcloud errors.

---

## 3. O4: backup and restore drill

**Goal:** prove that the hosted database can be restored into a fresh database, that the platform runs on the restored copy, and how long that takes. Agree the recovery point and recovery time with the product owner.

### 3.1 Agree the targets first

Propose these to the product owner and record what is agreed:

| Target | Proposal for a one-NGO installation | Meaning |
| --- | --- | --- |
| Recovery point objective (RPO) | 24 hours | At most one day of changes may be lost |
| Recovery time objective (RTO) | 4 hours | The service is back within four hours of the decision to restore |

The shared installation usually needs tighter targets and a paid database with point-in-time recovery.

### 3.2 What a backup must contain

| Part | Where it lives | How to back it up |
| --- | --- | --- |
| All records, accounts, receipts, ledger, definitions, audit, migration history | PostgreSQL (one schema, normally `public`) | The provider's backups, plus your own `pg_dump` |
| Uploaded files and exports | Cloud Storage bucket (`FILE_STORE_BUCKET`, prefix `FILE_STORE_PREFIX`) | Object versioning on the bucket, or a scheduled copy to a second bucket. The database stores only references to these objects |
| `ENCRYPTION_KEY` | Secret Manager | Without the same key, restored two-step secrets, gateway and connector credentials, and sensitive record values cannot be read. Keep it, with its version history, as carefully as the backups |
| `TOKEN_SECRET` | Secret Manager | Not needed for data. A different value only signs everyone out |

Free hosted tiers may keep few or no backups and may not offer point-in-time recovery; check the provider's current terms. If the tier cannot meet the agreed RPO, schedule your own `pg_dump` (step 3.3.1) to a Cloud Storage bucket in the same region, encrypted at rest, with access limited to the operations team.

### 3.3 The drill

Use a staging database that holds test data. Time every step.

1. **Take the backup.**

   ```powershell
   pg_dump --format=custom --no-owner --file=ngo-backup.dump "<source DATABASE_URL>"
   ```

   Keep the default, which includes privileges (`GRANT`s) and row-level security policies. The platform depends on both.
2. **Create a fresh, empty target database** on the same or another PostgreSQL 15+ server.
3. **Create the runtime role on the target server first.** `pg_dump` does not copy roles, and the restored privileges refer to `app_runtime`:

   ```sql
   do $$ begin
     if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
       create role app_runtime nologin;
     end if;
   end $$;
   grant app_runtime to <the user the server connects as>;  -- not needed if that user is a superuser
   create extension if not exists pg_trgm;                    -- if the provider allows it; search works without it, only slower
   ```

4. **Restore.**

   ```powershell
   pg_restore --no-owner --role=<target owner user> --dbname="<target DATABASE_URL>" ngo-backup.dump
   ```

   Read every warning. Errors about `app_runtime` or grants mean step 3 was missed.
5. **Check the schema is current.** Run the deploy step against the restored copy; it must apply **no** migrations:

   ```powershell
   $env:DATABASE_URL = '<target DATABASE_URL>'
   npm run deploy:prepare
   ```

   The final log line lists what it applied; it should be empty for migrations. A restored copy from an older release would apply the newer migrations here, which is also a valid test.
6. **Start the server on the restored copy** with the original `ENCRYPTION_KEY` and a staging `PUBLIC_BASE_URL`, then run the smoke tests:

   | Check | Expected |
   | --- | --- |
   | `GET /health` | 200 `{"status":"ok"}` |
   | `GET /ready` | 200 `{"status":"ready"}` |
   | Sign in as a known test member | Works (two-step too, which proves the encryption key) |
   | Open a record list, e.g. Donations | The same records and counts as the source |
   | Open a record with an attachment | The file downloads (proves the bucket restore) |
   | Issue a new receipt on the restored copy | Its number continues from the last one in the source, with no gap and no reuse |
   | Administration → Audit | Recent source events are present up to the backup time |

7. **Measure** the time from step 2 to the last passing smoke test, and the age of the newest data in the restored copy. Compare with the agreed RTO and RPO.
8. **Clean up.** Drop the target database and delete the local `ngo-backup.dump`. Never leave a dump of personal data on a workstation.

### Done when

- A restore into a fresh database passed every smoke test within the agreed recovery time.
- The backup schedule and retention meet the agreed recovery point, and are written down (provider backups, your `pg_dump` job, bucket versioning, where the encryption key is kept).

Record: the agreed RPO and RTO, measured restore time, data age, the provider and tier, any warnings from `pg_restore`, and the schedule in place.

---

## 4. O1: footprint on the target environment

**Goal:** measure memory, cold start and save latency of the bundled server on the target App Engine instance class (F1) against the hosted database, once with the database awake and once after it has paused. Budgets (section 12 of the architecture doc):

| Measure | Budget | Local result (2026-10-25, shared laptop) |
| --- | --- | --- |
| Resident memory, peak with two concurrent script saves | under 250 MB | 144 MB |
| Cold start to the first signed-in API response | under 4 s | 4.7 s median, 3.0 to 9.9 s (missed; the machine was loaded) |
| Save latency, 95th percentile | under 500 ms | 18 ms create, 38 ms pay |

A missed budget is reported, not fixed by you.

### Steps

1. **Deploy to staging** as in section 0.2, against the staging database, with `instance_class: F1`, `min_instances: 0` and a donations test organisation and admin created by the development team.
2. **Database awake, cold start.** Make sure no instance is running (App Engine → Instances shows none; wait about 15 minutes after the last request). Then, in PowerShell:

   ```powershell
   $base = 'https://<staging host>'
   $t = [Diagnostics.Stopwatch]::StartNew()
   do { try { $ok = (Invoke-WebRequest "$base/health" -UseBasicParsing -TimeoutSec 30).StatusCode -eq 200 } catch { $ok = $false } } until ($ok)
   $health = $t.ElapsedMilliseconds
   $body = @{ tenant = '<organisation code>'; email = '<test admin email>'; password = '<test password>' } | ConvertTo-Json
   $login = Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType 'application/json' -Body $body
   Invoke-RestMethod "$base/api/people/me" -Headers @{ Authorization = "Bearer $($login.accessToken)" } | Out-Null
   "first /health $health ms; first signed-in response $($t.ElapsedMilliseconds) ms"
   ```

   Repeat five times, waiting for the instance to stop each time. Report the median and the range.
3. **Database paused.** Let the hosted database reach its idle pause (provider-specific; check its console), confirm it shows as suspended, then repeat step 2 against a stopped instance. Report separately; this is the worst case for the first visitor after a quiet period.
4. **Memory.** On the O3 dashboard, or Monitoring → Metrics explorer → `appengine.googleapis.com/system/memory/usage` for the staging version, read the peak during step 5. Also check the logs for any `memory.high` entry.
5. **Save latency under load.** With the instance warm, create 200 donations and mark each paid, two clients at the same time, and take the 95th percentile of the request times. The simplest way is a small PowerShell loop that calls the records API (ask the development team for the two request bodies for the donations module, or for a remote mode of `npm run measure:bundle`, gap 2). Cloud Logging's request latency for `/api/records` gives a second reading.
6. **Clean up** the test records or drop the staging database copy.

### Done when

The three figures, awake and paused, are recorded against the budgets in section 13 of `docs/architecture/ngo-platform-architecture.md` (the development team updates the file from your figures if you prefer) and in the O1 row of the status table.

Record: date, instance class, database provider and region, number of runs, median and range for each figure.

---

## 5. O6: payment gateway sandboxes

**Goal:** for each of Razorpay and Cashfree, an order is created, a signed webhook marks the payment paid, a duplicate webhook changes nothing, and a forged webhook is refused. All in sandbox or test mode only.

Gateway credentials are stored through an admin route (section 5.2 step 4); the app has no screen for them yet.

### 5.1 How the platform talks to the providers

| | Razorpay | Cashfree |
| --- | --- | --- |
| Create order (server calls out) | `POST https://api.razorpay.com/v1/orders`, Basic auth with key id and key secret | `POST https://sandbox.cashfree.com/pg/orders` when the stored environment is `sandbox` (the default), `https://api.cashfree.com` for `production`; headers `x-client-id`, `x-client-secret`, `x-api-version: 2023-08-01` |
| Webhook URL to register | `<PUBLIC_BASE_URL>/webhooks/payments/razorpay/<organisation code>` | `<PUBLIC_BASE_URL>/webhooks/payments/cashfree/<organisation code>` |
| Signature the server checks | `X-Razorpay-Signature` = HMAC-SHA256 of the raw body with the **webhook secret** | `x-webhook-signature` = base64 HMAC-SHA256 of `x-webhook-timestamp` + raw body, with the **client secret** (the stored webhook secret is not used for Cashfree) |
| Events acted on | `payment.captured` (paid), `payment.failed` (failed); others are stored and ignored | Payment status `SUCCESS` (paid), `FAILED` (failed); others ignored |
| Duplicate detection | `X-Razorpay-Event-Id` header, else event name plus payment id | Event type plus payment id |

The organisation code in the webhook URL is the organisation's sign-in code. The server answers 200 `{ok:true}` to a valid webhook and 401 `{ok:false}` to an invalid one. The staging host must be reachable from the internet over HTTPS, and outbound calls to the provider hosts above must be allowed.

### 5.2 Set up each provider

1. Create or get a **sandbox / test-mode** account. Do not use live keys.
2. Generate test API keys (Razorpay: key id and key secret in test mode; Cashfree: client id and client secret for the sandbox).
3. Register the webhook URL from 5.1. Razorpay: subscribe to `payment.captured` and `payment.failed`, and set a webhook secret. Cashfree: enable the payment success and failure webhooks.
4. Store the credentials for the test organisation, signed in as a member with the `payments:configure` permission (an organisation admin has it). Use `$base` and the access token from the sign-in in section 4 step 2 (`$token = $login.accessToken`). `Read-Host` keeps the secrets out of the command history:

   ```powershell
   $auth = @{ Authorization = "Bearer $token" }
   $razorpay = @{
     keyId         = '<Razorpay test key id, rzp_test_...>'
     keySecret     = Read-Host 'Razorpay key secret'
     webhookSecret = Read-Host 'Razorpay webhook secret'
   } | ConvertTo-Json
   Invoke-RestMethod "$base/api/admin/payment-gateways/razorpay" -Method Put -ContentType 'application/json' -Body $razorpay -Headers $auth

   $cashfree = @{
     keyId       = '<Cashfree sandbox client id>'
     keySecret   = Read-Host 'Cashfree client secret'
     environment = 'sandbox'
   } | ConvertTo-Json
   Invoke-RestMethod "$base/api/admin/payment-gateways/cashfree" -Method Put -ContentType 'application/json' -Body $cashfree -Headers $auth

   Invoke-RestMethod "$base/api/admin/payment-gateways" -Headers $auth
   ```

   | Request | Body | Answer |
   | --- | --- | --- |
   | `PUT /api/admin/payment-gateways/razorpay` | `keyId`, `keySecret`, `webhookSecret`, all required | 204, no body |
   | `PUT /api/admin/payment-gateways/cashfree` | `keyId` (client id) and `keySecret` (client secret) required; `environment` `sandbox` or `production`, default `sandbox`; `webhookSecret` optional and unused | 204, no body |
   | `GET /api/admin/payment-gateways` | none | Both providers with `configured`, `enabled`, `keyId` and `environment` (Cashfree only), never a secret |

   Saving again replaces the stored credentials and re-enables the provider. A missing, empty or unknown field gets 400 with a list of issues, a member without the permission gets 403, and any other provider name gets 404. Each save writes a `connector.saved` audit entry. The secrets are encrypted with `ENCRYPTION_KEY` and never returned by any API.

### 5.3 Create a payment

As a member with the `payments:create` permission, for an existing donation record:

```powershell
$body = @{
  recordId = '<donation record id>'
  amount   = '100.00'
  provider = 'razorpay'            # or 'cashfree'
  onPaid   = @{ transition = '<the donation workflow step that marks it paid>'; fields = @{ paidOn = 'paidOn'; reference = 'paymentReference' } }
} | ConvertTo-Json -Depth 5
$intent = Invoke-RestMethod "$base/api/payments" -Method Post -ContentType 'application/json' -Body $body -Headers @{ Authorization = "Bearer $token" }
$intent
```

Ask the development team for the exact transition key and field names of the shipped donations module. The response holds the provider order id and the checkout data, and no secret. A malformed body gets 400 with a list of issues.

### 5.4 Test cases

The app has no payment page yet (gap 3), so complete payments with the provider's own test tools: Razorpay's test-mode checkout or test payment for the order, and Cashfree's sandbox checkout for the payment session id.

| # | Do | Expected |
| --- | --- | --- |
| 1 | Pay the order successfully in the sandbox | The webhook gets 200. `GET /api/payments/<id>` shows the payment as paid. Within a few seconds (a background step) the donation moves to its paid status, a receipt is issued and the ledger has the posting |
| 2 | Resend the same webhook from the provider dashboard | 200, and nothing new: no second receipt, no second posting |
| 3 | Send a webhook with a wrong signature (edit one character of the signature header with a tool such as curl) | 401 `{ok:false}`; nothing changes |
| 4 | A payment that fails in the sandbox | The payment shows as failed; the donation is not marked paid |
| 5 | A webhook whose amount differs from the order (if the sandbox allows) | Not marked paid; an audit entry `payment.amount_mismatch` appears under Administration → Audit |
| 6 | A webhook for an organisation code that does not exist | 401 |

Repeat 1 to 4 for both providers.

### Done when

Both providers pass cases 1 to 4, and 5 and 6 where the sandbox allows them. Anything that differs from the provider's current documentation (field names, headers, event names) is reported to the development team; the code comments say field names follow the providers' published APIs and must be checked against their sandboxes before launch.

Record: date, provider account (test mode), the case results, and any request or response that failed (with secrets removed).

---

## 6. Summary checklist

| Block | Depends on | Done when |
| --- | --- | --- |
| O5 | GitHub repository, two workload identities, and the `stage` and `prod` environments | CI gate blocks failing pull requests; `develop` deploys stage on Cloud Run; `master` deploys production after approval |
| O3 | Notification channel chosen | Metrics, policies and dashboard applied; two test alerts received |
| O4 | RPO and RTO agreed; staging database | Restore passed the smoke tests within the agreed time; backup schedule written down |
| O1 | Staging App Engine and database; scheduler set up (section 0.4) | Memory, cold start (awake and paused) and save p95 recorded against the budgets |
| O6 | Sandbox accounts; public staging URL | Both providers pass the test cases |

## Migration numbering

Migrations in `packages/platform/migrations/` run in file-name order and the history table records the full file name, so gaps in the numbers are harmless. There is no `023` (`022` is followed by `024`). Do not renumber or rename an applied file: its name is its history row, and a renamed file would run again. `packages/platform/src/infrastructure/postgres/migrate.ts` and `packages/platform/test/migrate.test.ts` do not assume consecutive numbers.

## Client address behind a proxy (TRUST_PROXY)

Rate limits are keyed on the caller's address. `TRUST_PROXY` says how many reverse-proxy hops to trust for `X-Forwarded-For`: a number, or a list of proxy addresses. Unset trusts nothing; on App Engine it defaults to 1 hop. `true` and `*` are refused, because they let a caller choose its own address. IPv6 callers are grouped by their /64 prefix.
