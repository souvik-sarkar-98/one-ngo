import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../../support/paths.js';
import { catalogue, catalogueFiles, readJson } from '../../support/platform/locale-files.js';

const LOCALES = ['en', 'hi', 'ta', 'te', 'bn', 'mr'];
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** The shipped catalogue files and the locale-areas script, checked against the files on disk rather than the screens. */
const webApp = repoPath('apps', 'onengo', 'web', 'src', 'app');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const all = files(webApp).map((p) => ({ path: relative(webApp, p).split(sep).join('/'), src: readFileSync(p, 'utf8') }));
const app = all.filter((f) => !f.path.endsWith('.test.ts'));
const imports = (src: string) => [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

describe('shipped screen text files', () => {
  it('ships six flat catalogues of ui.* keys, English complete', () => {
    const en = catalogue('en');
    for (const locale of LOCALES) {
      for (const file of catalogueFiles(locale)) {
        const c = readJson(file);
        const keys = Object.keys(c);
        if (file === `${locale}.json`) expect(keys.length, file).toBeGreaterThan(0);
        expect(keys.filter((k) => !k.startsWith('ui.') || typeof c[k] !== 'string' || c[k] === ''), file).toEqual([]);
        expect(keys.filter((k) => !(k in en)), file).toEqual([]);
        expect(keys.filter((k) => placeholders(String(c[k])).join() !== placeholders(String(en[k])).join()), file).toEqual([]);
      }
    }
    expect(en).toMatchObject({ 'ui.records.otherGroup': 'Other', 'ui.records.sharedWithMe': 'Shared with me' });
  });

  it('keeps untranslated entries out of the language files and lists them for review', () => {
    // An entry with no reviewed translation is left out of <locale>.json and <locale>.<area>.json, so English shows
    // (here and on the server), and is listed in untranslated.json; adding a translation means adding it to the file
    // its key's area names and removing it from the list.
    const en = catalogueFiles('en').flatMap((f) => Object.keys(readJson(f)));
    const review = readJson('untranslated.json') as Record<string, string[]>;
    expect(Object.keys(review).sort()).toEqual(LOCALES.filter((l) => l !== 'en').sort());
    for (const [locale, keys] of Object.entries(review)) {
      const own = catalogue(locale);
      expect(keys, locale).toEqual(en.filter((k) => !(k in own)));
    }
  });

  it('keeps each key in the file of its area, as web/scripts/locale-areas.mjs splits them', () => {
    const run = spawnSync(process.execPath, [repoPath('apps', 'onengo', 'web', 'scripts', 'locale-areas.mjs'), '--check'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(catalogueFiles('en')).toEqual(expect.arrayContaining(['en.json', 'en.admin.json', 'en.builder.json', 'en.import.json']));
    const core = Object.keys(readJson('en.json'));
    expect(core.filter((k) => /^ui\.(builder|expression|imports|admin|people)\./.test(k) && k !== 'ui.builder.title' && !k.startsWith('ui.builder.kinds.'))).toEqual([]);
    expect(core).toContain('ui.builder.kinds.translation');
    expect(Object.keys(readJson('en.builder.json')).length).toBeGreaterThan(500);
  });

  it('every key the app uses is in the English catalogue', () => {
    const en = catalogue('en');
    const used = new Set(app.flatMap((f) => [...f.src.matchAll(/'(ui\.[\w.]+)'/g)].map((m) => m[1]!)));
    const missing = [...used].filter((k) => (k.endsWith('.') ? !Object.keys(en).some((x) => x.startsWith(k)) : !(k in en) && !(`${k}.other` in en)));
    expect(used.size).toBeGreaterThan(200);
    expect(missing).toEqual([]);
  });

  it('loads each area of screen text with the routes that show it', () => {
    const routes = app.filter((f) => /(^|\/)(\w+\.)?routes\.ts$/.test(f.path)).map((f) => f.src).join('\n');
    const loaded = new Set([...routes.matchAll(/withText\('(\w+)'\)/g)].map((m) => m[1]));
    const areas = catalogueFiles('en')
      .filter((f) => f !== 'en.json' && Object.keys(readJson(f)).length)
      .map((f) => f.split('.')[1]!);
    expect(areas).toEqual(expect.arrayContaining(['builder', 'import']));
    expect(['core', ...areas].filter((a) => !loaded.has(a))).toEqual([]);
    expect(all.filter((f) => !f.path.endsWith('.test.ts') && imports(f.src).some((i) => /\/locale\/[\w.]+\.json$/.test(i))).map((f) => f.path)).toEqual(['core/i18n/languages.ts']);
  });
});
