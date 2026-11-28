import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../support/paths.js';

const ROOT = REPO_ROOT;
const source = (path: string) => readFileSync(path, 'utf8');

/** Deploy manifests and entry-point text: owner credentials and the console access model, checked in the YAML and bootstrap files. Not source-code boundaries. */
describe('deployment credential boundaries', () => {
  const text = (path: string) => source(join(ROOT, path));

  it('keeps owner credentials out of both serving manifests and entry points', () => {
    const mainManifest = text('apps/onengo/server/app.yaml');
    const operatorManifest = text('apps/onengo-console/server/app.yaml');
    expect(mainManifest).toMatch(/service:\s*default/);
    expect(mainManifest).toMatch(/service_account:\s*REPLACE_WITH_SERVICE_ACCOUNT/);
    expect(operatorManifest).toMatch(/service:\s*console/);
    expect(operatorManifest).toMatch(/service_account:\s*REPLACE_WITH_CONSOLE_SERVICE_ACCOUNT/);
    expect(operatorManifest).not.toMatch(/ingress_settings/);
    // Secret values live in Secret Manager. The bootstrap reads them at start-up, so the manifests carry no secret names.
    const secretNames = /DATABASE_(SYSTEM|RUNTIME|OWNER)_URL|OPERATOR_(DATABASE|RUNTIME)_URL|TOKEN_SECRET|ENCRYPTION_KEY|CLIENT_SECRET/;
    for (const manifest of [mainManifest, operatorManifest]) {
      expect(manifest).toMatch(/entrypoint:\s*node --enable-source-maps dist\/bootstrap\.js/);
      expect(manifest).not.toMatch(secretNames);
    }
    expect(text('.github/workflows/deploy-gcp.yml')).not.toMatch(/REPLACE_WITH_(?:CONSOLE_)?(?:SYSTEM|RUNTIME|ENCRYPTION|TOKEN|INTERNAL|OIDC_CLIENT_SECRET)/);
    for (const serving of [mainManifest, operatorManifest, text('apps/onengo/server/src/main.ts'), text('apps/onengo-console/server/src/main.ts'), text('apps/onengo/server/src/bootstrap.ts'), text('apps/onengo-console/server/src/bootstrap.ts')]) {
      expect(serving).not.toContain('DATABASE_OWNER_URL');
      expect(serving).not.toMatch(/(?:^|\s)DATABASE_URL\s*[:=]/);
    }
    expect(text('apps/onengo/server/src/deploy.ts')).toContain('openDeployDatabase(process.env)');
    expect(text('packages/platform/src/composition/entry.ts')).toContain("requiredDatabaseUrl(env, 'DATABASE_OWNER_URL')");
  });

  it('checks in the main cron and the public console service', () => {
    expect(text('apps/onengo/server/cron.yaml')).toMatch(/target:\s*default/);
    expect(text('apps/onengo-console/server/app.yaml')).toMatch(/service:\s*console/);
  });

  it('requires the console IAP audience as a deploy placeholder', () => {
    expect(text('apps/onengo-console/server/app.yaml')).toContain('OPERATOR_IAP_AUDIENCE: REPLACE_WITH_CONSOLE_IAP_AUDIENCE');
  });
});
