import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../support/paths.js';

/**
 * Keeps the three apps looking like one product. They share `@onengo/web-kit`'s tokens, base
 * stylesheet and `Btn` directive; these tests fail the moment one of them starts drifting.
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
        const body = component.split(/\nexport class /)[0] ?? '';
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
});
