import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../support/paths.js';

/**
 * Colour rule for the three apps. It reads the toolkit baseline JSON for the pinned stylesheets, so it is kept
 * out of the hygiene project, which checks source code only.
 */
const ROOT = REPO_ROOT;
const APPS = ['apps/onengo/web', 'apps/onengo-console/web', 'apps/onengo-guide/web'];

function files(directory: string, extensions: string[]): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (['node_modules', '.angular', 'dist'].includes(name)) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return files(path, extensions);
    return extensions.some((extension) => path.endsWith(extension)) && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('design system colours', () => {
  /** Colour is chosen once, in the tokens. Fixed colours remain only where the output is not themed. */
  const FIXED_COLOUR_FILES = /\/print\/|receipt|contrast\.ts$|starters\.ts$|theme-form\.ts$|catalogue\.ts$|template-preview\.ts$|schema-node\.ts$/;
  /** The ported list toolkit's stylesheets are pinned byte for byte by `look.test.ts`, so they keep their own values. */
  const pinned = new Set<string>(
    (JSON.parse(readFileSync(join(ROOT, 'apps/onengo/web/src/app/ui/baseline/toolkit-1.0.0.json'), 'utf8')) as { components: { selector: string; styles: string[] }[] }).components
      .filter((c) => c.styles.join('').trim())
      .map((c) => `apps/onengo/web/src/app/ui/styles/${c.selector}.css`),
  );

  it('components take their colours from tokens, not hex literals', () => {
    const literals: string[] = [];
    for (const app of APPS) {
      for (const path of files(join(ROOT, app, 'src'), ['.ts', '.css'])) {
        const name = relative(ROOT, path).replace(/\\/g, '/');
        if (FIXED_COLOUR_FILES.test(name) || pinned.has(name) || name.endsWith('styles.css')) continue;
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
          const before = text.slice(Math.max(0, match.index - 160), match.index);
          const after = text.slice(match.index + match[0].length, match.index + match[0].length + 3);
          if (/var\(--[\w-]+,\s*$/.test(before)) continue; // the fallback inside var(--x, #hex)
          if (/color-mix\([^;]*,\s*$/.test(before) && /^\s*\)/.test(after)) continue; // the white a tint is mixed with
          if (/^#\d+$/.test(match[0])) continue; // an anchor or an issue number
          literals.push(`${name}:${text.slice(0, match.index).split('\n').length} ${match[0]}`);
        }
      }
    }
    expect(literals, 'use a token from packages/web-kit/src/styles/tokens.css').toEqual([]);
  });
});
