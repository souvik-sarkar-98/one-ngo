import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const records = join(here, '../records');
const baseline = JSON.parse(readFileSync(join(here, 'baseline/toolkit-1.0.0.json'), 'utf8')) as {
  extractedFrom: Record<string, string>;
  components: { selector: string; template: string; styles: string[]; classes: string[] }[];
  usedTokens: string[];
};

/** Classes of toolkit features this app never used (selection, bulk edit, documents, avatars, links in subtitles). */
const UNUSED = /select|bulk|row-check|header--static|documents|upload|avatar|subtitle-link|subtitle-sep|rich-html|content$|kv-value list|item-meta|hero|back$|mat-headline|mat-title|cf-form-title|cf-form-description|cf-form-step-title|cf-form-submit|cf-phone|cf-autocomplete|cf-toggle|cf-form-stepper__(custom|actions|back|next)|app-btn-group$|list-dashboard__(upload|state|detail-menu|detail-header)|^cf-field-error$|^mat-mdc-form-field-error$|^list-detail-sheet__(form|summary|state|spinner)|^list-detail-sections__(state|spinner|empty)|^cf-field$/;

/** The ported controls, and the record list screen and record panel that compose them. */
const sources = [
  ...readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(here, f)),
  join(records, 'record-list.screen.ts'),
  join(records, 'record-panel.ts'),
]
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

describe('the cards layout keeps the list toolkit look', () => {
  it('was captured from toolkit 1.0.0', () => {
    expect(baseline.extractedFrom).toEqual({ '@ssdev-toolkit/angular-list-dashboard': '1.0.0', '@ssdev-toolkit/angular-forms': '1.0.0' });
  });

  it('uses every toolkit stylesheet unchanged', () => {
    for (const c of baseline.components) {
      const css = c.styles.join('\n');
      if (!css.trim()) continue;
      expect(readFileSync(join(here, 'styles', `${c.selector}.css`), 'utf8').replace(/\r\n/g, '\n'), c.selector).toBe(css);
      expect(sources, c.selector).toContain(`styleUrl: './styles/${c.selector}.css'`);
    }
  });

  it('keeps the toolkit markup class names', () => {
    const missing = baseline.components.flatMap((c) => c.classes.filter((k) => !UNUSED.test(k) && !sources.includes(k)).map((k) => `${c.selector}: ${k}`));
    expect(missing).toEqual([]);
  });

  it('reads only theme tokens the toolkit read', () => {
    const ported = baseline.components
      .filter((c) => c.styles.join('\n').trim())
      .map((c) => readFileSync(join(here, 'styles', `${c.selector}.css`), 'utf8'))
      .join('\n');
    const used = [...new Set([...ported.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))].sort();
    expect(used).toEqual(baseline.usedTokens);
  });
});

