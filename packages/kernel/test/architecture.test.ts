import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const slash = (path: string) => path.split(sep).join('/');
const files = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
const source = (path: string) => readFileSync(path, 'utf8');
const imports = (path: string) => [...source(path).matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);

describe('package boundaries', () => {
  it('keeps kernel independent of every @onengo package', () => {
    const violations = files(join(ROOT, 'packages/kernel/src')).flatMap((path) =>
      imports(path).filter((specifier) => specifier.startsWith('@onengo/')).map((specifier) => `${slash(relative(ROOT, path))} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  it('lets platform depend on kernel, but no other @onengo package', () => {
    const violations = files(join(ROOT, 'packages/platform/src')).flatMap((path) =>
      imports(path)
        .filter((specifier) => specifier.startsWith('@onengo/') && !specifier.startsWith('@onengo/kernel'))
        .map((specifier) => `${slash(relative(ROOT, path))} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  it('prevents applications importing another application source tree', () => {
    const violations = files(join(ROOT, 'apps')).flatMap((path) =>
      imports(path)
        .filter((specifier) => /(?:^|\/)apps\//.test(specifier) || /^@(?:onengo|onengo-console)\/(?:server|web)(?:\/|$)/.test(specifier))
        .map((specifier) => `${slash(relative(ROOT, path))} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });
});

describe('deployment credential boundaries', () => {
  const text = (path: string) => source(join(ROOT, path));

  it('keeps owner credentials out of both serving manifests and entry points', () => {
    const mainManifest = text('apps/onengo/server/app.yaml');
    const operatorManifest = text('apps/onengo-console/server/app.yaml');
    expect(mainManifest).toMatch(/service:\s*default/);
    expect(mainManifest).toMatch(/service_account:\s*REPLACE_WITH_MAIN_SERVICE_ACCOUNT/);
    expect(mainManifest).toContain('DATABASE_SYSTEM_URL:');
    expect(mainManifest).toContain('DATABASE_RUNTIME_URL:');
    expect(operatorManifest).toMatch(/service:\s*console/);
    expect(operatorManifest).toMatch(/service_account:\s*REPLACE_WITH_OPERATOR_SERVICE_ACCOUNT/);
    expect(operatorManifest).not.toMatch(/ingress_settings/);
    expect(operatorManifest).toContain('OPERATOR_DATABASE_URL:');
    expect(operatorManifest).toContain('OPERATOR_RUNTIME_URL:');
    for (const serving of [mainManifest, operatorManifest, text('apps/onengo/server/src/main.ts'), text('apps/onengo-console/server/src/main.ts')]) {
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

describe('kernel compatibility shim ratchet', () => {
  const allowlistPath = join(import.meta.dirname, 'shim-allowlist.json');
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as Record<string, { owner: string; reason: string; expires: string }>;
  const shims = files(join(ROOT, 'packages/platform/src'))
    .filter((path) => {
      const text = source(path);
      if (!text.includes('@onengo/kernel')) return false;
      const unit = ts.createSourceFile(path, text, ts.ScriptTarget.ES2023, true);
      const specifiers = imports(path);
      return unit.statements.every((statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && specifiers.length > 0
        && specifiers.every((specifier) => specifier.startsWith('@onengo/kernel'));
    })
    .map((path) => slash(relative(ROOT, path)))
    .sort();

  it('keeps the allowlist exact', () => {
    expect(shims).toEqual(Object.keys(allowlist).sort());
  });

  it('requires an owner, reason and unexpired ISO date', () => {
    const today = new Date().toISOString().slice(0, 10);
    const invalid = Object.entries(allowlist)
      .filter(([, entry]) => !entry.owner.trim() || entry.reason.trim().length < 20 || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || entry.expires < today)
      .map(([path]) => path);
    expect(invalid).toEqual([]);
  });
});
