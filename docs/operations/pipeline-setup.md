# Deployment pipeline setup

How to set up the GitHub and Google Cloud side of the stage and production pipelines, and which variables and secrets each one needs. No secret values belong in this document or in the repository.

## How it fits together

- `deploy.yml` runs on every push to `develop` and `main`. It runs the test gate (`ci.yml`), then works out the release version from `package.json`.
- On `develop`, it deploys to **stage** (Cloud Run, `deploy-cloudrun.yml`).
- On `main`, it deploys to **production** (App Engine, `deploy-gcp.yml`), after a reviewer approves the `prod` environment.
- The release tag is pushed only after the deploy succeeds. Production requires a `<version>-develop.N` tag from stage in the commit's history, so merge `develop` into `main` with a merge commit or fast-forward, not a squash.
- `rollback.yml` moves traffic back to an earlier version or revision. It does not change the database.
- `e2e-test.yml` runs browser tests by hand. It is not part of the deploy.

## 1. Google Cloud

Use **two projects**: one for stage, one for production. Stage must not share App Engine hours or data with production.

For each project:

1. Enable billing, then enable the APIs: App Engine Admin, Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Cloud Scheduler, Cloud Storage, IAM Credentials.
2. For production only, create the App Engine app once: `gcloud app create --project=<project> --region=asia-south1`. The production workflow stops if it doesn't exist.
3. Create three service accounts:
   - **Deploy** (used by GitHub): deploys the services and writes secrets.
   - **Main runtime**: the main service's identity.
   - **Console runtime**: the console's identity.
4. Give the deploy service account the roles it needs. Confirm this with a first run, since the exact set depends on the steps:
   - `roles/appengine.deployer` and `roles/appengine.appAdmin` (production)
   - `roles/iam.serviceAccountUser` on the two runtime accounts
   - `roles/cloudbuild.builds.editor` and `roles/storage.admin` (App Engine and Cloud Run builds)
   - `roles/secretmanager.admin` (production secret writes and IAM bindings)
   - `roles/run.admin` (stage)
5. Create a Workload Identity Federation pool and provider for this GitHub repository. Set its attribute condition so only this repository's workflows can use it, and map the deploy account to it. Restrict the provider's use to `refs/heads/main` for production and `refs/heads/develop` for stage, where your setup allows.

The runtime accounts never need a key file. They read their secrets with their own identity.

## 2. GitHub environments

Create two environments, **stage** and **prod**. The workflows read variables and secrets with the same names in both, so set each one **at environment level**, with that environment's own value.

- Do not set these at repository level. Stage and production would then share one value, including the Google Cloud project.
- **prod**: add required reviewers. Restrict deployments to the `main` branch. Reviewers approve every production deploy, rollback, and cleanup run.
- **stage**: restrict deployments to the `develop` branch.

Branch protection on `develop` and `main`: require exactly one status check, **CI gate**.

## 3. Variables

Set these in each environment. Values are not secret, but keep them per environment.

| Variable | Used by | What it is |
|---|---|---|
| `GCP_PROJECT_ID` | all deploys, cleanup, rollback | The project's ID |
| `GCP_REGION` | stage, rollback | Optional. Defaults to `asia-south1` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | all | The full name of the Workload Identity provider |
| `GCP_SERVICE_ACCOUNT` | all | The deploy service account's email |
| `SERVICE_ACCOUNT` | all | The main runtime service account's email |
| `CONSOLE_SERVICE_ACCOUNT` | all | The console runtime service account's email |
| `PUBLIC_BASE_URL` | all | The main app's public address, for example `https://app.example.org` |
| `CONSOLE_PUBLIC_BASE_URL` | all | The console's public address |
| `CONSOLE_OIDC_ISSUER` | all | The console's sign-in provider's issuer address |
| `CONSOLE_OIDC_CLIENT_ID` | all | The console's sign-in client ID |
| `CONSOLE_OIDC_AUDIENCE` | all | The audience the console expects in sign-in tokens |
| `CONSOLE_IAP_AUDIENCE` | all | The Identity-Aware Proxy audience for the console |

Optional, browser tests only (`e2e-test.yml`): `E2E_ORG`, `E2E_CONSOLE`, `CONSOLE_E2E_OPERATOR`.

## 4. Secrets

Set these in each environment. Never paste their values into a file, an issue, or a chat.

| Secret | Environment | Used for |
|---|---|---|
| `DATABASE_OWNER_URL` | both | Owner login for migrations (`npm run deploy:prepare`). Not used at runtime |
| `SYSTEM_DATABASE_URL` | both | Main server's database login |
| `RUNTIME_DATABASE_URL` | both | Main server's non-owner database login for tenant traffic |
| `TOKEN_SECRET` | both | Signs session tokens |
| `ENCRYPTION_KEY` | both | Encrypts stored sensitive values. Shared by both servers |
| `CONSOLE_DATABASE_URL` | both | Console's control-plane database login |
| `CONSOLE_RUNTIME_URL` | both | Console's runtime database login |
| `CONSOLE_ENCRYPTION_KEY` | both | Console's own session encryption |
| `CONSOLE_INTERNAL_TOKEN_SECRET` | both | Signs internal console tokens |
| `CONSOLE_OIDC_CLIENT_SECRET` | both | Console sign-in client secret. Needed if the identity provider client is confidential |
| `TICK_SECRET` | stage only | Bearer secret for the hourly `/internal/tick`. Production uses App Engine cron instead |
| `E2E_PASSWORD` | both, optional | Seeded test member password for `e2e-test.yml` |

Notes:
- Values that are required for production must be non-empty. The store step refuses to write an empty one and fails the run.
- Keep `ENCRYPTION_KEY` safe with its version history. Losing it makes stored sensitive values unreadable.

## 5. What the pipeline creates in Google Cloud

You do not create these by hand.

| Where | Name | Created by | Contents |
|---|---|---|---|
| Production Secret Manager | `ngo-prod-config` | `deploy-gcp.yml`, store step | JSON of the main server's settings |
| Production Secret Manager | `ngo-console-prod-config` | `deploy-gcp.yml`, store step | JSON of the console's settings |
| Stage Secret Manager | `ngo-*` secrets | `sync-stage-secrets.sh` | One secret per setting |
| Stage Cloud Scheduler | `ngo-tick` | `deploy-cloudrun.yml` | Hourly call to `/internal/tick` |

The production store step keeps the two newest versions of each secret. Older versions are destroyed.

## 6. First run checklist

1. Create the two GCP projects, service accounts, and the Workload Identity provider.
2. Create the `stage` and `prod` environments, with the protection rules above.
3. Set every variable and secret in both environments.
4. Create the App Engine app in the production project.
5. Merge to `develop`. Confirm the stage deploy succeeds and the `v...-develop.1` tag appears.
6. Merge `develop` into `main` with a merge commit. Approve the `prod` run.
7. After the production deploy, check the new version has no secret values:
   ```
   gcloud app versions describe <version> --service=default --project <project>
   ```
   Its `env_variables` must not contain database URLs, `TOKEN_SECRET`, or `ENCRYPTION_KEY`.
8. Run `e2e-test.yml` against stage with suite `selected` to confirm the sign-in pages load.

## 7. Before the first production deploy

- Delete any App Engine versions deployed before the Secret Manager change. They still hold the old plaintext values.
- Rotate the production database passwords and `TOKEN_SECRET`. Rotating `TOKEN_SECRET` signs everyone out. Rotating `ENCRYPTION_KEY` is a separate procedure, because stored values are encrypted with it.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Set <NAME> to a PostgreSQL connection string.` | The database secret is missing or empty in that environment |
| `Remove these from app.yaml; they now come from Secret Manager` | A setting is still in `app.yaml`. Remove it |
| `Secret Manager refused ngo-prod-config with status 403` | The runtime account lacks `secretAccessor` on the secret, or the store step didn't run |
| `Create the App Engine app once: gcloud app create ...` | The App Engine app doesn't exist in the production project yet. Create it |
| `Release X is already tagged on another commit` | Raise `version` in `package.json` before the next release |
| `No <version>-develop.N tag is in this commit's history` | The release has not gone through stage. Deploy it from `develop` first |
| Production instances fail to start | Check the start-up log for `Start-up failed:`. It names the setting that's wrong, never its value |

If Secret Manager is unreachable, new instances fail to start. Running instances keep working.
