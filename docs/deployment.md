# Deployment and operations

One document for how OneNGO is deployed, run and checked. The workflow files in `.github/workflows/` and the scripts in `.github/scripts/` are the source of truth for each step. The full earlier text (more commands and rationale) is in `docs/archive/deployment-plan.html` and `docs/archive/devops-handover.md`.

Never paste a secret into a document, a commit, a pipeline file or a ticket.

## 1. Shape

| Question | Decision |
| --- | --- |
| Production | App Engine standard, F1, `asia-south1`. Two services: `default` (organisation app, `apps/onengo/server`) and `console` (operator console, `apps/onengo-console/server`). Max 1 instance each, min 0 |
| Stage | Cloud Run (`ngo`, `ngo-console`) in its own Google Cloud project, deployed from `develop` |
| Pipeline | GitHub Actions. `main` deploys production. `develop` runs the gate and deploys stage |
| Credentials | Workload identity federation. Production trusts only `refs/heads/main`, stage only `develop`. No key files |
| Console access | Anyone can load it; nobody gets in without an enabled console account and a fresh two-factor sign-in (also required for suspend, reactivate, close). No IAP (it needs a load balancer, about $18 a month) |
| Database | One PostgreSQL 15+ database outside Google Cloud. Five connection strings with different logins (below). Row-level security separates organisations |
| Secrets | GitHub environment secrets written into `app.yaml` on the runner at deploy time, never committed. App Engine stores them with each version, so keep project membership small |
| Release safety | Deploy with no traffic, curl `/health`, move traffic, curl the public address, move traffic back on failure |

Hosts: `https://<project>.<region>.r.appspot.com` and `https://console-dot-<project>.<region>.r.appspot.com`. A custom domain changes `PUBLIC_BASE_URL` and the redirect addresses registered with the identity provider and each connector.

**One database, four serving logins.** `DATABASE_OWNER_URL` (migrations, deploy job only), `SYSTEM_DATABASE_URL` and `RUNTIME_DATABASE_URL` (main), `CONSOLE_DATABASE_URL` and `CONSOLE_RUNTIME_URL` (console). Pointing two of them at one login defeats the separation.

**Cost.** App Engine gives 28 F1 hours a day per project. `max_instances: 1` matters because a candidate version runs beside the live one during every deploy. Watch the quota page in the first week. Cleanup (section 5) keeps stored versions small.

## 2. Server settings

The server reads environment variables (commented in `.env.example`) and never reads `.env` in production.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL 15 or later only. Another scheme, MySQL, or an older server logs `Start-up failed` and exits 1 before migrating. Use the provider's pooled TLS string |
| `INSTALLATION_MODE` | no | `one-ngo` (default) or `shared`. Anything else stops start-up |
| `DATABASE_POOL_SIZE` | no | Default 3 |
| `TOKEN_SECRET` | yes | 32+ characters. Changing it signs everyone out |
| `ENCRYPTION_KEY` | yes | 32 random bytes, base64. Encrypts two-step secrets, connector and gateway credentials, sensitive record values. **Losing it makes them unreadable** unless the old key is in `ENCRYPTION_KEY_PREVIOUS` |
| `ENCRYPTION_KEY_PREVIOUS` | no | Earlier keys, comma separated. After a rotation run `npm run fields:reencrypt`, and drop the old key once its jobs are done |
| `PUBLIC_BASE_URL` | yes | Address people use. Used in emailed links, redirects and webhook URLs |
| `SHIPPED_MODULES` | no | Default `donations` |
| `TICK_SECRET` | no | Only for a scheduler other than App Engine cron (`POST /internal/tick`, bearer) |
| `MEMORY_ALERT_MB` | no | Default 300. Threshold for the `memory.high` alert |
| `AUDIT_ARCHIVE_BUCKET` | no | Bucket for the operator audit archive |
| `SMTP_*` | no | Without them, sign-in codes and invitations are not sent |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ISSUER`, `OIDC_ALLOWED_DOMAINS`, `OIDC_PROVIDER_ID`, `OIDC_PROVIDER_LABEL` | no | Shared OpenID Connect provider each NGO may opt into. Empty issuer means Google. Redirect URI `<PUBLIC_BASE_URL>/api/auth/oidc/callback`. Keep `OIDC_PROVIDER_ID` stable once NGOs opt in. Old `GOOGLE_*` names are deprecated |
| `CONNECTOR_ALLOWED_HOSTS` | no | Hosts connectors may call even if non-public. Empty allows none. Connectors use `https://` only and never follow redirects |
| `BREACHED_PASSWORD_CHECK` | no | `online` (default) or `off` |
| `TRUST_PROXY` | no | Reverse-proxy hops to trust for `X-Forwarded-For`: a number or list of addresses. Unset trusts none; App Engine defaults to 1. `true` and `*` are refused. IPv6 callers group by /64 |

**Console and sign-in.** Operators with the `sign_in` grant set each organisation's sign-in policy, shared-provider opt-in and own OpenID providers, with a fresh step-up and a reason, audited without secrets. Provider secrets live in `connector.secret_enc` under `ENCRYPTION_KEY`, so the console gets the main `ENCRYPTION_KEY` (and `_PREVIOUS` during rotation) beside its own `OPERATOR_ENCRYPTION_KEY`. It reads the non-secret `OIDC_*` values and never `OIDC_CLIENT_SECRET`. The first operator is inserted in SQL (local development: `utilities/seed/console-operator.sql`). **Open gap:** there is no documented production procedure for the first console account; get one from the development team before go-live.

**OAuth connectors.** An organisation's administrator registers the redirect `<PUBLIC_BASE_URL>/api/connectors/oauth/callback` with the provider, so `PUBLIC_BASE_URL` must be exact. Losing the key means reconnecting every oauth connector.

**Variables on `prod`** (environment level, not repository): `GCP_PROJECT_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `SERVICE_ACCOUNT`, `CONSOLE_SERVICE_ACCOUNT` (different from the main one), `PUBLIC_BASE_URL`, `CONSOLE_PUBLIC_BASE_URL`, `CONSOLE_OIDC_ISSUER`, `CONSOLE_OIDC_CLIENT_ID`, `CONSOLE_OIDC_AUDIENCE`.

**Secrets on `prod`:** `DATABASE_OWNER_URL`, `SYSTEM_DATABASE_URL`, `RUNTIME_DATABASE_URL`, `CONSOLE_DATABASE_URL`, `CONSOLE_RUNTIME_URL`, `TOKEN_SECRET` (`openssl rand -hex 32`), `ENCRYPTION_KEY` (back it up apart from GitHub), `CONSOLE_ENCRYPTION_KEY` (a different key), `CONSOLE_INTERNAL_TOKEN_SECRET`, `CONSOLE_OIDC_CLIENT_SECRET`. Do not reuse a value between main and console. `stage` uses the same names plus `TICK_SECRET`. SMTP, gateway and connector credentials are optional; organisations set their own gateway and mail in the app.

## 3. Releasing

On the build machine or in CI:

```powershell
npm ci
npm --prefix web ci
npm run build:server        # dist/server.js and dist/deploy.js
npm run web:build           # web/dist/web/browser
$env:DATABASE_URL = '<target database>'
npm run deploy:prepare      # migrations, platform package, organisation re-sync, profiles, shipped modules
gcloud app deploy           # only if deploy:prepare succeeded
```

- The deploy step runs once per release from one place, before the new version starts. Running it again is harmless.
- The server never migrates. If the deploy step did not run, the new version refuses to start and the old one keeps serving.
- Every migration must work with the release before it, because moving traffic back cannot undo one. Drop or rename a column only in a later release than the one that stopped using it.
- Migrations are the seven files `001_core.sql` to `007_bank_reconciliation.sql` in `packages/platform/migrations/`. Do not rename or renumber an applied file; its name is its history row. New changes go in new files after `007`.
- `npm run fields:reencrypt` re-encrypts stored secrets and queues one `fields.reencrypt` job per record type. Run it once after the first deploy that includes field encryption and once after every key rotation. A secret no configured key opens fails the run and changes nothing.

**Scheduler.** App Engine cron calls `GET /internal/tick` (accepted only with the `X-Appengine-Cron` header on App Engine), from `cron.yaml`: every 60 minutes for a one-NGO installation, every 5 for a shared one. Deploy it with `gcloud app deploy cron.yaml`. Elsewhere, Cloud Scheduler calls `POST /internal/tick` with `Authorization: Bearer <TICK_SECRET>`; keep the secret in Secret Manager and restrict who can read the job.

## 4. Pipeline

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | Every pull request | Two parallel jobs and a **CI gate** that fails unless both pass: typecheck, build and every vitest test against a throwaway `postgres:16` (including the artifact test that starts the real bundle and checks two clean builds match); and `npm run ci:audit` (high-severity production dependency findings). Deploys nothing |
| `deploy.yml` | Push to `develop` or `main` | Runs the gate again, tags the merged commit, then calls the deploy workflow below |
| `deploy-cloudrun.yml` | After the gate on `develop` | Builds both servers, migrates the stage database, syncs the stage secrets to Secret Manager, deploys `ngo` and `ngo-console` (512 MiB, 1 CPU, min 0, max 1), tags the revision `candidate`, moves traffic once `/health` answers, checks the public addresses, returns traffic on failure. Cloud Scheduler posts `/internal/tick` hourly |
| `deploy-gcp.yml` | After the gate on `main`, or a manual run on `main` | Required reviewer on `prod`; build from the exact commit; fill the `REPLACE_WITH_` placeholders (a missing secret stops here, before anything changes); record the serving versions; `deploy:prepare` with the owner URL; deploy both services `--no-promote` as `v<tag>-r<run>`; `.github/scripts/smoke-test.mjs` curls `/health` (waits up to 2 minutes, expects `{"status":"ok"}`); move traffic; curl the public addresses; roll back on failure; deploy `cron.yaml` |
| `e2e-test.yml` | Manual run only | Browser (Playwright) tests against a deployed environment. Choose the target (`stage` or `prod`) and the suite (`full` or `selected`), and optionally a title filter or an address. See below |
| `cleanup.yml` | See section 5 | |

**Tags.** Every deploy is of a tag from `version` in the root `package.json`: `develop` gets `<version>-develop.<n>`, `main` gets `<version>`. Raise `version` before the next merge; a merge that repeats a tagged version stops at the tag job. A re-run on a tagged commit reuses its tag. There is no rollback workflow: revert on the branch and merge. The first-ever deploy has no earlier version, so there is nothing to roll back to.

**Gates that block a merge or deploy:** typecheck; all builds (both servers, both web apps, the guide); unit, PostgreSQL and row-level-security tests; the bundle test; the console manifest test (the console stays `service: console` with no IAP, so nobody quietly reverts the access model); the dependency audit; the `prod` approval; the placeholder check.

**Browser tests (`e2e-test.yml`).** No deploy starts them; run the workflow from the Actions tab when you want them. The tests come from the branch or tag chosen in "Use workflow from". Addresses come from the target environment's `PUBLIC_BASE_URL` and `CONSOLE_PUBLIC_BASE_URL` unless you type one in.

| Suite | What it runs | Where |
| --- | --- | --- |
| `selected` | `tests/e2e/post-deploy`: opens the app and console sign-in pages, signs in nothing, writes nothing | `stage` or `prod` |
| `full` | Everything in `tests/e2e/specs`: signs in as the seeded Riverbank members and creates donors, donations and API keys | `stage` only; the workflow refuses it on `prod`. The stage database needs the Riverbank seed (`utilities/data/dev-seed.sql`) |

Specs that need something stage lacks (a mailbox, the payment fixture) skip themselves with a reason. Optional settings on the stage environment: variable `E2E_ORG` and secret `E2E_PASSWORD` (the seeded organisation and member password; defaults `riverbank` and `Password@01`), and variable `E2E_CONSOLE=true` with `CONSOLE_E2E_OPERATOR` to include the operator console journeys. A `prod` run waits for the `prod` reviewers like a deploy does. The report is kept as an artifact for seven days.

## 5. Cleanup

`cleanup.yml` is separate from releases. Mon, Wed, Fri 17:00 UTC it runs as a **dry run** and reports what it would delete. To delete, run it from Actions with dry run unticked. Both need a `prod` reviewer. It keeps every App Engine version that has traffic plus the newest five per service (a version whose traffic split cannot be read is kept), deletes staging-bucket files older than three days, and deletes untagged Artifact Registry images. The schedule only fires once the file is on the default branch.

## 6. One-time setup

**Database** (PostgreSQL 15+ with `pg_trgm`). The serving logins can only be granted group roles that the first `deploy:prepare` creates, so do this once by hand:

```powershell
npm ci
npm run build:server
$env:DATABASE_OWNER_URL = "postgres://owner:...@host/db?sslmode=require"
npm run deploy:prepare
```

```sql
create role ngo_main_system_login      login password '<generated>';  grant ngo_main_system      to ngo_main_system_login;
create role ngo_main_runtime_login     login password '<generated>';  grant ngo_main_runtime     to ngo_main_runtime_login;
create role ngo_operator_login         login password '<generated>';  grant ngo_operator         to ngo_operator_login;
create role ngo_operator_runtime_login login password '<generated>';  grant ngo_operator_runtime to ngo_operator_runtime_login;
```

Build the four connection strings from these logins (add `?sslmode=require` if needed) and store them as the four database secrets.

**Google Cloud (production)**

```powershell
$PROJECT = "your-project-id"
gcloud config set project $PROJECT
gcloud services enable appengine.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com iamcredentials.googleapis.com iam.googleapis.com cloudresourcemanager.googleapis.com logging.googleapis.com
gcloud app create --region=asia-south1        # permanent
gcloud iam service-accounts create ngo-main    --display-name "NGO main runtime"
gcloud iam service-accounts create ngo-console --display-name "NGO console runtime"
# each runtime account needs only roles/logging.logWriter

$REPO = "OWNER/REPO"
$NUMBER = gcloud projects describe $PROJECT --format="value(projectNumber)"
gcloud iam service-accounts create gha-deploy --display-name "GitHub Actions deploy"
gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github-repo `
  --location=global --workload-identity-pool=github `
  --issuer-uri="https://token.actions.githubusercontent.com" `
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" `
  --attribute-condition="assertion.repository=='$REPO' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "gha-deploy@$PROJECT.iam.gserviceaccount.com" `
  --role roles/iam.workloadIdentityUser `
  --member "principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"
```

Deploy account roles (a starting set; tighten after the first run, since a permission error names the missing role): `appengine.deployer`, `appengine.serviceAdmin`, `appengine.appViewer`, `cloudbuild.builds.editor`, `storage.objectAdmin` on the App Engine staging buckets, `cloudscheduler.admin`, `iam.serviceAccountUser` on both runtime accounts, and `artifactregistry.repoAdmin` only if a dry run reports images. Do not give `appengine.appCreator`.

**Stage.** A second project (so stage does not use production's App Engine hours) with Cloud Run, Cloud Build, Secret Manager, Cloud Scheduler and IAM Credentials enabled, two runtime accounts and a deploy account whose identity trusts only `develop`. Its own database and four logins, never production's. Leave `PUBLIC_BASE_URL` and `CONSOLE_PUBLIC_BASE_URL` empty on the first run (the health check uses the Cloud Run addresses), then copy the URLs from the deploy summary into them and run again **before anyone signs in**, because the first revision advertises `https://pending.invalid`.

**GitHub.** Add the remote and push. Create environment `prod` with a required reviewer, deployment branches limited to `main`, and the variables and secrets above. Create `stage` with no reviewer, limited to `develop`. Protect `main` and `develop`: require a pull request and the single **CI gate** check (not the individual jobs, so later jobs join the gate without changing the rule). Set workflow permissions to read-only by default. Consider pinning actions to commit hashes with Dependabot.

**Staging for O1 and O6** needs a staging service in `asia-south1` and a staging PostgreSQL (Mumbai where offered), loaded with test data only.

## 7. Go-live checklist

1. Merge the branch into `develop`, then `develop` into `main` once the gate is green on a pull request.
2. Create the Google Cloud project, App Engine app, service accounts and workload identity.
3. Create the database, run the first `deploy:prepare`, create the four logins.
4. Create `prod` and add the variables and secrets.
5. Protect `main` and `develop` with the CI gate.
6. Register the public addresses with the identity provider (console redirect `/op/auth/callback`), Google sign-in (`/api/auth/oidc/callback`) if used, and connectors (`/api/connectors/oauth/callback`).
7. Create the first console account (section 2, open gap).
8. Push to `main`, approve, read the deploy summary and write down the release name.
9. Rehearse a failed release once, before real data is in: deploy a build whose `/health` does not answer and watch traffic return.
10. Run Cleanup (production) once as a dry run and read the report before deleting anything.
11. Complete alerts (section 8) and the backup and restore drill (section 9).

Not yet verified (the first runs will show): Playwright against a live address, `npm run ci` on a GitHub runner, the gcloud flags and deploy account roles against a live project, automatic rollback in practice, and the stage Cloud Run deploy.

## 8. Alerts and dashboard

The server writes one JSON log line per event to stdout (Cloud Logging). Alerts watch a fixed `alert` field.

| `alert` | Severity | When | First response |
| --- | --- | --- | --- |
| `outbox.failed_permanently` | ERROR | A background event (email, SMS, webhook, automation, payment step) failed its fifth attempt | Read `eventType`, `tenantId` and the error; usually a connector setting. To retry, set that `outbox_event` row to `pending` with `attempts` 0 |
| `job.failed` | ERROR | A background job stopped with an error | Read `kind`, `jobId` and the error. The person who started it can retry once fixed |
| `http.unhandled_error` | ERROR | A 500 from an unexpected error. The policy fires above 5 in 5 minutes | Search the request id in the entry's trace. A burst after a deploy points at the release: route traffic back |
| `memory.high` | WARNING | Resident memory above `MEMORY_ALERT_MB` (default 300 of the F1's 384 MB) | Look for a large import or export, or growth since a deploy; steady load needs a larger instance class |

The definitions and exact gcloud commands are in `docs/monitoring/README.md`: one log-based metric per alert in `docs/monitoring/metrics/`, one policy per metric in `docs/monitoring/policies/`, and `docs/monitoring/dashboard.json`. Apply metrics first, then policies, then the dashboard; do not run `create` twice (it makes duplicates; use `update`). It needs Logging Admin and Monitoring Editor and the gcloud alpha and beta components. Choose the notification channel with the product owner.

Check that an alert fires by writing a test entry (Bash, not PowerShell, which mangles the JSON):

```bash
gcloud logging write ngo-alert-check '{"alert":"job.failed","kind":"alert-check","message":"Alert check"}' \
  --project=<project id> --payload-type=json --severity=ERROR \
  --monitored-resource-type=gae_app --monitored-resource-labels=module_id=default,version_id=alert-check
```

An incident should open within minutes and close itself 30 minutes after the last entry. Repeat with `memory.high` at WARNING. Tune the error-rate threshold after a week of real traffic. The policies and dashboard filter on `resource.type="gae_app"`; on another host each needs that changed. The files were checked only as valid JSON; send any gcloud rejection to the development team rather than editing in place.

## 9. Backup and restore drill

Goal: prove the hosted database restores into a fresh one, the platform runs on the copy, and how long it takes.

**Targets (agree with the product owner).** One-NGO proposal: recovery point 24 hours, recovery time 4 hours. A shared installation needs tighter targets and a database with point-in-time recovery.

**A backup must hold:** the database (provider backups plus your own `pg_dump`); uploaded files (provider versioning or a scheduled copy; the database holds only references); `ENCRYPTION_KEY` with its version history (without it restored secrets are unreadable); `TOKEN_SECRET` is not needed for data. If a free tier cannot meet the recovery point, schedule `pg_dump` to an encrypted bucket in the same region with limited access.

**Drill, on a staging database with test data, timing each step:**

1. `pg_dump --format=custom --no-owner --file=ngo-backup.dump "<source DATABASE_URL>"` (keep the default, which includes grants and row-level-security policies; the platform depends on both).
2. Create a fresh, empty database on PostgreSQL 15+.
3. On the target server create the role first (`pg_dump` does not copy roles): `create role app_runtime nologin` if missing, `grant app_runtime to <server user>`, and `create extension if not exists pg_trgm` if allowed.
4. `pg_restore --no-owner --role=<target owner> --dbname="<target DATABASE_URL>" ngo-backup.dump`. Errors about `app_runtime` or grants mean step 3 was missed.
5. Run `npm run deploy:prepare` against the copy; it should apply no migrations.
6. Start the server with the original `ENCRYPTION_KEY` and check: `/health` 200; `/ready` 200; a known member signs in (two-step too, which proves the key); a record list shows the same counts; an attachment downloads; a new receipt number continues with no gap or reuse; recent audit events are present.
7. Record the time from step 2 to the last passing check and the age of the newest data against the agreed targets.
8. Drop the target database and delete the local dump. Never leave a dump of personal data on a workstation.

Record the targets, measured restore time, data age, provider and tier, warnings, and the backup schedule now in place.

## 10. Footprint on the target environment

Measure memory, cold start and save latency on the F1 instance against the hosted database, with the database awake and after it has paused. Budgets (`docs/architecture.md` section 13):

| Measure | Budget | Local result 2026-10-25 |
| --- | --- | --- |
| Resident memory, peak with two concurrent script saves | under 250 MB | 144 MB |
| Cold start to the first signed-in API response | under 4 s | 4.7 s median, 3.0 to 9.9 s (missed; machine loaded) |
| Save latency, 95th percentile | under 500 ms | 18 ms create, 38 ms pay |

A missed budget is reported, not fixed by the operator. Steps: deploy to staging with `instance_class: F1`, `min_instances: 0`; wait for no running instance, then time the first `/health` and first signed-in response (repeat five times, report median and range); repeat after the hosted database reaches its idle pause; read peak memory from the dashboard or `appengine.googleapis.com/system/memory/usage`; with the instance warm, create 200 donations and mark each paid from two clients and take the 95th percentile. `npm run measure:bundle` refuses a non-local database on purpose.

## 11. Payment gateway sandboxes

Goal, for each of Razorpay and Cashfree in test mode only: an order is created, a signed webhook marks the payment paid, a duplicate changes nothing, a forged webhook is refused.

| | Razorpay | Cashfree |
| --- | --- | --- |
| Create order | `POST https://api.razorpay.com/v1/orders`, Basic auth (key id, key secret) | `POST https://sandbox.cashfree.com/pg/orders` (`production` uses `https://api.cashfree.com`); headers `x-client-id`, `x-client-secret`, `x-api-version: 2023-08-01` |
| Webhook URL | `<PUBLIC_BASE_URL>/webhooks/payments/razorpay/<organisation code>` | `<PUBLIC_BASE_URL>/webhooks/payments/cashfree/<organisation code>` |
| Signature checked | `X-Razorpay-Signature`: HMAC-SHA256 of the raw body with the webhook secret | `x-webhook-signature`: base64 HMAC-SHA256 of `x-webhook-timestamp` + raw body with the client secret |
| Acts on | `payment.captured` (paid), `payment.failed` (failed) | `SUCCESS` (paid), `FAILED` (failed) |
| Duplicate key | `X-Razorpay-Event-Id`, else event plus payment id | Event type plus payment id |

A valid webhook gets 200 `{ok:true}`; an invalid one 401 `{ok:false}`. The staging host must be reachable over HTTPS and allow outbound calls to the provider hosts. The app has no gateway setup screen or payment page yet, so credentials go through the admin route and payments are completed with the providers' own test tools.

Store credentials as a member with `payments:configure`:

- `PUT /api/admin/payment-gateways/razorpay` with `keyId`, `keySecret`, `webhookSecret` (all required), 204.
- `PUT /api/admin/payment-gateways/cashfree` with `keyId` (client id), `keySecret` (client secret), `environment` (`sandbox` or `production`, default `sandbox`), 204.
- `GET /api/admin/payment-gateways` lists `configured`, `enabled`, `keyId`, `environment`, never a secret.

Secrets are encrypted under `ENCRYPTION_KEY` and never returned. Create a payment as a member with `payments:create`: `POST /api/payments` with `recordId`, `amount`, `provider`, and `onPaid` (the donation workflow step and field names; ask the development team for the shipped module's keys).

| # | Do | Expected |
| --- | --- | --- |
| 1 | Pay the order in the sandbox | Webhook 200; payment paid; within seconds the donation is paid, a receipt is issued and the ledger posts |
| 2 | Resend the same webhook | 200, nothing new: no second receipt or posting |
| 3 | Send a webhook with a wrong signature | 401; nothing changes |
| 4 | A payment that fails | Payment failed; donation not paid |
| 5 | A webhook whose amount differs from the order (if the sandbox allows) | Not marked paid; audit entry `payment.amount_mismatch` |
| 6 | A webhook for an unknown organisation code | 401 |

Repeat 1 to 4 for both providers. Report anything that differs from the providers' current documentation.

## 12. Operations status

| Block | Task | Done when |
| --- | --- | --- |
| O5 | CI and CD | CI gate blocks failing pull requests; `develop` deploys stage; `main` deploys production after approval |
| O3 | Alerts and dashboard | Metrics, policies and dashboard applied; two test alerts received |
| O4 | Backup and restore drill | Restore passed within the agreed time; schedule written down |
| O1 | Footprint | Memory, cold start (awake and paused) and save p95 recorded against budgets |
| O6 | Gateway sandboxes | Both providers pass cases 1 to 4 |

When a block is done, update its row in section 5.1 of `docs/plans/ngo-backend-enhancement-plan.md` with the date and results, and report every failure to the development team.
