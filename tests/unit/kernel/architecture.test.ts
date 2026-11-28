import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, SUPPORT_DIR } from '../../support/paths.js';

const ROOT = REPO_ROOT;
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

describe('kernel compatibility shim ratchet', () => {
  const allowlistPath = join(SUPPORT_DIR, 'kernel', 'shim-allowlist.json');
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
