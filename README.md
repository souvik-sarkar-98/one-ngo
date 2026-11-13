# one-ngo

NGO platform, relocated from `legacy/ngo-platform`: the server in the five-layer layout
(`http -> application -> runtime -> domain`, `infrastructure` behind ports) and the Angular web app in `apps/onengo/web/`.

- This is one npm workspace with one root `package-lock.json`; install every package and app with `npm ci` at the repository root.
- The file moves into this layout are recorded in `docs/architecture/relocation-map.md` (history; the move script is gone).
- Layer rules: `packages/platform/test/layer-architecture.test.ts` with the exact baseline `packages/platform/test/layer-allowlist.json` (empty).
- Conformance rules (runtime/application siblings, re-exports, port files, composition wiring, SQL types) allow no violations and no pending list; see `docs/architecture/guardrail-violations.md`.
- Commands: `npm run typecheck`, `npm run build:server`, `npm run operator:server:build`, `npm run web:build`, `npm run operator:web:build`, and `npm test` (tests need local PostgreSQL; see `packages/platform/test/test-database.ts`).

## Web app

`apps/onengo/web/` is the Angular app from `legacy/ngo-platform/web`. It is a workspace in the root lockfile. The main-server build copies its browser output into the deploy artifact.

- Server contract types reach the app only through `apps/onengo/web/src/app/core/contracts.ts` (type-only, from `packages/platform/src/http/contracts`).
- Browser-safe platform rules are exposed only through `@onengo/platform/browser`; reusable Angular controls and navigation helpers are consumed directly from `@onengo/web-kit`, with no main-web compatibility aliases.
- `npm start` serves the main API and copied main web build. The operator API and copied operator web build are a separate deployable.

## Locale

Shared product assets live in the `@onengo/product` workspace: message catalogues in `packages/product/locale/`, definition schemas in `packages/product/schemas/`, and installable modules in `packages/product/modules/`. The platform resolves these directories through `PATHS`, while the web app imports locale JSON through `@onengo/product`. `apps/onengo/web/scripts/locale-areas.mjs` keeps each locale key in its area's file and writes `apps/onengo/web/src/app/core/i18n/i18n-text.ts`.

Platform-private deployment data stays in `packages/platform`: SQL migrations are under `migrations/`, and the built-in baseline module files are at the package root. Server builds assemble both owners into the internal `dist/product/` artifact layout.

## Composition

`packages/platform/src/platform.ts` is the composition root and only calls the per-capability wiring in `packages/platform/src/composition/`. Only `platform.ts` and the exported API entry points may import `packages/platform/src/composition/`; composition may import every layer. The transitional organisation CLI has been removed: organisation lifecycle operations are available only through the authenticated operator app.

Deployment is split between `apps/onengo/server` (`service: default`) and `apps/onengo-console/server` (`service: console`, public App Engine address). The one-shot deploy command is the only process that accepts `DATABASE_OWNER_URL`. Main serving requires `DATABASE_SYSTEM_URL` and `DATABASE_RUNTIME_URL`; console serving requires `OPERATOR_DATABASE_URL` and `OPERATOR_RUNTIME_URL`. No serving login owns schema objects or can migrate. Console sign-in requires two-factor authentication and an enabled console account.

The checked-in App Engine manifests contain placeholders, not secrets. `.github/workflows/ci.yml` runs the test gate on every pull request and every push to `develop` and `master`. `.github/workflows/cd.yml` deploys `master` to production only after that gate passes: it fills the placeholders from GitHub secrets (the filled files are not committed), deploys without traffic, smoke-tests, then promotes. Full plan: `docs/operations/deployment-plan.html` and `docs/operations/devops-handover.md`.

