import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the three apps looking like one product. They share `@onengo/web-kit`'s tokens, base
 * stylesheet and `Btn` directive; these tests fail the moment one of them starts drifting.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const APPS = ['apps/onengo/web', 'apps/onengo-console/web', 'apps/onengo-guide/web'];

function files(directory: string, extensions: string[]): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (['node_modules', '.angular', 'dist'].includes(name)) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return files(path, extensions);
    return extensions.some((extension) => path.endsWith(extension)) && !path.endsWith('.test.ts') ? [path] : [];
  });
}

const sources = APPS.flatMap((app) => files(join(ROOT, app, 'src'), ['.ts']).map((path) => ({ path: relative(ROOT, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') })));

/** The end of the open tag that starts at `start`; `>` can appear inside an attribute value. */
function tagEnd(text: string, start: number): number {
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i + 1;
  }
  return text.length;
}

describe('buttons', () => {
  it('every <button> uses the Btn directive or names its own control class', () => {
    const bare: string[] = [];
    for (const { path, text } of sources) {
      for (const match of text.matchAll(/<button\b/g)) {
        const tag = text.slice(match.index, tagEnd(text, match.index));
        if (/\sappBtn\b|\s\[appBtn\]|\sclass="|\s\[class\]=|\sngClass|\smat-/.test(tag)) continue;
        bare.push(`${path}:${text.slice(0, match.index).split('\n').length}`);
      }
    }
    expect(bare, 'use <button appBtn> or give the button a class of its own').toEqual([]);
  });

  it('nobody writes the app-btn classes by hand', () => {
    // A <label> or <span> styled as a button (a file picker) may use the class; a <button> or <a> may not.
    const handwritten = sources
      .filter(({ text }) => [...text.matchAll(/<(?:button|a)\b/g)].some((m) => /\sclass="[^"]*\bapp-btn(?![\w-])/.test(text.slice(m.index, tagEnd(text, m.index)))))
      .map(({ path }) => path);
    expect(handwritten, 'use the appBtn directive instead of the class').toEqual([]);
  });

  it('every component that uses appBtn imports Btn', () => {
    const missing: string[] = [];
    for (const { path, text } of sources) {
      for (const component of text.split(/@Component\(/).slice(1)) {
        const body = component.split(/\nexport class /)[0];
        if (/\sappBtn\b|\s\[appBtn\]/.test(body) && !/imports:\s*\[[^\]]*\bBtn\b/.test(body)) missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('styles', () => {
  it('each app builds on the shared base stylesheet', () => {
    for (const app of APPS) {
      const css = readFileSync(join(ROOT, app, 'src/styles.css'), 'utf8');
      expect(css, app).toContain("@import '@onengo/web-kit/styles/base.css'");
    }
  });

  it('no app redeclares the shared design tokens', () => {
    const shared = [...readFileSync(join(ROOT, 'packages/web-kit/src/styles/tokens.css'), 'utf8').matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]);
    const redeclared: string[] = [];
    for (const app of APPS) {
      const css = readFileSync(join(ROOT, app, 'src/styles.css'), 'utf8');
      for (const token of ['--brand', '--brand-fg', '--bg', '--fg', '--muted', '--line', '--card', '--ok', '--warn', '--bad', '--radius', '--button-radius', '--field-border']) {
        if (shared.includes(token) && new RegExp(`^\\s*${token}\\s*:`, 'm').test(css)) redeclared.push(`${app} ${token}`);
      }
    }
    expect(redeclared, 'change the token in packages/web-kit/src/styles/tokens.css').toEqual([]);
  });

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
