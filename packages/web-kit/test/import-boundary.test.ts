import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const KIT = join(ROOT, 'packages/web-kit/src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : extname(path) === '.ts' ? [path] : [];
  });
}

describe('@onengo/web-kit import boundary', () => {
  it('depends only on Angular core and its own modules', () => {
    for (const file of sourceFiles(KIT)) {
      const source = readFileSync(file, 'utf8');
      expect(source, relative(ROOT, file)).not.toMatch(/from ['"](?:@angular\/(?:material|cdk)|@onengo\/(?:platform|kernel)|.*apps\/)/);
      for (const specifier of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
        expect(specifier[1], relative(ROOT, file)).toMatch(/^(?:\.|@angular\/core$)/);
      }
    }
  });

  it('is consumed through the package API and never across app boundaries', () => {
    const apps = ['apps/onengo/web/src', 'apps/onengo-console/web/src', 'apps/onengo-guide/web/src'];
    for (const app of apps) {
      const source = sourceFiles(join(ROOT, app)).map((file) => readFileSync(file, 'utf8')).join('\n');
      expect(source, app).toContain(`from '@onengo/web-kit'`);
      expect(source, app).not.toMatch(/from ['"].*(?:apps\/onengo(?:-console|-guide)?\/web|packages\/web-kit\/src)/);
    }
  });
});
