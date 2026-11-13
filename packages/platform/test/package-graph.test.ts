import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const DECLARED_PLATFORM_EXPORTS = new Set([
  '@onengo/platform/main',
  '@onengo/platform/operator',
  '@onengo/platform/contracts',
  '@onengo/platform/browser',
  '@onengo/platform/deployment',
  '@onengo/platform/testing',
  '@onengo/platform/icons',
]);

function sourceFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(name) ? [path] : [];
  });
}

const importsOf = (source: string) =>
  [...source.matchAll(/(?:from\s+|import\()(['"])([^'"]+)\1/g)].map((match) => match[2]!);

const production = sourceFiles(join(ROOT, 'apps')).filter((path) => path.includes(`${sep}src${sep}`));
const rows = production.map((path) => ({
  path: relative(ROOT, path).split(sep).join('/'),
  imports: importsOf(readFileSync(path, 'utf8')),
}));

describe('workspace package graph', () => {
  it('uses only declared @onengo/platform export paths', () => {
    const bad = rows.flatMap((file) =>
      file.imports
        .filter((spec) => spec === '@onengo/platform' || (spec.startsWith('@onengo/platform/') && !DECLARED_PLATFORM_EXPORTS.has(spec)))
        .map((spec) => `${file.path}: ${spec}`),
    );
    expect(bad).toEqual([]);
  });

  it('keeps the main app independent of operator', () => {
    expect(rows.filter((file) => file.path.startsWith('apps/onengo/') && file.imports.some((spec) => spec === '@onengo/platform/operator' || spec.includes('onengo-console'))).map((file) => file.path)).toEqual([]);
  });

  it('keeps a future operator app independent of main', () => {
    expect(rows.filter((file) => file.path.startsWith('apps/onengo-console/') && file.imports.some((spec) => spec === '@onengo/platform/main' || spec.includes('apps/onengo/'))).map((file) => file.path)).toEqual([]);
  });

  it('keeps web apps free of server entry points and server source', () => {
    const serverEntries = new Set(['@onengo/platform/main', '@onengo/platform/operator', '@onengo/platform/deployment', '@onengo/platform/testing']);
    expect(
      rows
        .filter((file) => /^apps\/(?:onengo|onengo-console)\/web\//.test(file.path))
        .filter((file) => file.imports.some((spec) => serverEntries.has(spec) || spec.includes('/server/src')))
        .map((file) => file.path),
    ).toEqual([]);
  });
});
