import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const webApp = join(import.meta.dirname, '../../../apps/onengo/web/src/app');
/** One catalogue for the server and the web app. */
const localeDir = join(import.meta.dirname, '../../product/locale');
const repoRoot = join(import.meta.dirname, '..');
const sharedDir = join(repoRoot, 'src', 'shared');

/** Pure rules core/server.ts may re-export. The server reaches the same files through re-exports left at the old paths. */
const SHARED_MODULES = [
  'actor',
  'definitions/merge',
  'definitions/types',
  'expressions/expression',
  'finance/fiscal-year',
  'finance/number-format',
  'permissions/permission-usage',
  'permissions/permissions',
  'records/email-html',
  'records/rich-text',
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const all = files(webApp).map((p) => ({ path: relative(webApp, p).split(sep).join('/'), src: readFileSync(p, 'utf8') }));
const app = all.filter((f) => !f.path.endsWith('.test.ts'));
const imports = (src: string) => [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

describe('web app boundaries', () => {
  it('keeps the core free of Angular and rxjs', () => {
    const bad = all.filter((f) => f.path.startsWith('core/')).flatMap((f) => imports(f.src).filter((i) => i.startsWith('@angular/') || i === 'rxjs').map((i) => `${f.path}: ${i}`));
    expect(bad).toEqual([]);
  });

  it('does not use the list toolkit anywhere', () => {
    expect(all.filter((f) => imports(f.src).some((i) => i.startsWith('@ssdev-toolkit/'))).map((f) => f.path)).toEqual([]);
  });

  it('uses Angular Material only in the ui controls', () => {
    expect(app.filter((f) => !f.path.startsWith('ui/') && imports(f.src).some((i) => i.startsWith('@angular/material'))).map((f) => f.path)).toEqual([]);
  });

  it('takes contract types only through the platform contract entry', () => {
    const serverHttp = join(import.meta.dirname, '../src/http');
    const bridge = app.find((f) => f.path === 'core/contracts.ts')!.src;
    expect(bridge).toContain("export type * from '@onengo/platform/contracts'");
    expect(all.filter((f) => f.path !== 'core/contracts.ts' && f.src.includes('@onengo/platform/contracts')).map((f) => f.path)).toEqual([]);
    const entry = readFileSync(join(serverHttp, 'contracts/types.ts'), 'utf8');
    expect([...entry.matchAll(/^(import|export)\b(?! type\b)[^;]*;/gm)].map((m) => m[0])).toEqual([]);
  });

  it('reaches outside web/ only through core/contracts.ts, core/server.ts and the locale catalogue', () => {
    const outside = all.flatMap((f) =>
      [...f.src.matchAll(/(?:from\s+|import\()'(\.[^']+)'/g)]
        .map((m) => join(webApp, f.path, '..', m[1]!))
        .filter((target) => !target.startsWith(join(webApp, '..', '..')) && !(target.startsWith(localeDir) && target.endsWith('.json')))
        .map(() => f.path),
    );
    expect([...new Set(outside)].sort()).toEqual([]);
  });

  it('re-exports browser rules only through the platform browser entry', () => {
    const bridge = app.find((f) => f.path === 'core/server.ts')!.src;
    expect(bridge).toContain("export * from '@onengo/platform/browser'");
    expect([...bridge.matchAll(/^import\b/gm)], 'core/server.ts only re-exports').toEqual([]);
    const entry = readFileSync(join(repoRoot, 'src/api/browser.ts'), 'utf8');
    const targets = [...entry.matchAll(/^export\b[^;]*?from\s+'..\/shared\/([^']+)\.js'/gm)].map((m) => m[1]!).sort();
    expect(targets).toEqual([...SHARED_MODULES].sort());
  });

  it('keeps shared/ free of Node, packages except the browser-safe kernel contracts, and the server', () => {
    const seen = new Set<string>();
    const queue = SHARED_MODULES.map((m) => join(sharedDir, `${m}.ts`));
    const bad: string[] = [];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const rel = relative(sharedDir, file).split(sep).join('/');
      if (!file.startsWith(sharedDir)) bad.push(`${rel}: outside shared/`);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^(import|export)(\s+type)?\b[^;]*?from\s+'([^']+)'/gm)) {
        const spec = m[3]!;
        if (!spec.startsWith('.')) {
          if (spec !== '@onengo/kernel/errors' && spec !== '@onengo/kernel/ports') bad.push(`${rel}: ${spec}`);
        } else {
          const next = join(file, '..', spec.replace(/\.js$/, '.ts'));
          if (!next.startsWith(sharedDir)) bad.push(`${rel}: ${spec}`);
          else queue.push(next);
        }
      }
    }
    const onDisk = files(sharedDir).map((p) => relative(sharedDir, p).split(sep).join('/'));
    expect(onDisk.filter((p) => !seen.has(join(sharedDir, p))).sort()).toEqual([]);
    expect(bad).toEqual([]);
  });

  it('keeps every records API address in the HTTP gateway', () => {
    expect(app.filter((f) => f.src.includes('/api/records') && f.path !== 'core/records/gateway/http-gateway.ts').map((f) => f.path)).toEqual([]);
  });

  it('lets only the list store talk to the router and the gateway', () => {
    const skins = app.filter((f) => /^((records|print|inbox|people)\/[\w-]+\.screen\.ts$|admin\/([\w-]+\/)?[\w-]+\.screen\.ts$|records\/record-panel\.ts$|ui\/)/.test(f.path));
    expect(skins.length).toBeGreaterThan(5);
    expect(skins.map((f) => f.path)).toEqual(
      expect.arrayContaining(['records/record-list.screen.ts', 'records/record-panel.ts', 'print/receipt.screen.ts', 'inbox/inbox.screen.ts', 'people/people.screen.ts', 'admin/api-keys/api-keys.screen.ts']),
    );
    const bad = skins.filter((f) => imports(f.src).some((i) => i === '@angular/router' || i.endsWith('gateway')) || /\.navigate\(/.test(f.src));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  it('draws one breadcrumb, in the shell, from the trail core computes', () => {
    const drawsCrumbs = app.filter((f) => imports(f.src).some((i) => /\/ui\/breadcrumb$/.test(i)) || f.src.includes('<app-breadcrumb'));
    expect(drawsCrumbs.map((f) => f.path)).toEqual(['shell/shell.screen.ts']);
    const computesCrumbs = app.filter((f) => /import\s*\{[^}]*\btrail\b[^}]*\}\s*from\s*'[^']*\/breadcrumbs'/.test(f.src) && !f.path.startsWith('core/'));
    expect(computesCrumbs.map((f) => f.path)).toEqual(['shell/shell-store.ts']);
  });

  it('keeps the shell and More screens off the router and the gateways', () => {
    const screens = app.filter((f) => /^(shell|more)\/[\w-]+\.(screen|panel)\.ts$/.test(f.path));
    expect(screens.map((f) => f.path)).toEqual(expect.arrayContaining(['shell/shell.screen.ts', 'more/settings.screen.ts']));
    const named = (src: string) => [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@angular\/router'/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()));
    const bad = screens.filter((f) => named(f.src).some((n) => n !== 'RouterOutlet') || imports(f.src).some((i) => /(gateway|http-[\w-]+)$/.test(i)) || /\.navigate(ByUrl)?\(/.test(f.src));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  it('routes every record list to the one record list screen', () => {
    const routes = app.find((f) => f.path === 'records/records.routes.ts')!.src;
    expect(routes).toContain('component: RecordListScreen');
    const gone = ['records/cards/cards.view.ts', 'records/table/table.view.ts', 'records/record.page.ts', 'records/records.page.ts'];
    expect(app.filter((f) => gone.includes(f.path)).map((f) => f.path)).toEqual([]);
    const stale = app.filter((f) => imports(f.src).some((i) => /\/(cards\.view|table\.view|record\.page|records\.page)$/.test(i)));
    expect(stale.map((f) => f.path)).toEqual([]);
  });

  it('gives cards and table the same list features on the one screen', () => {
    const src = app.find((f) => f.path === 'records/record-list.screen.ts')!.src;
    const intents = new Set([...src.matchAll(/store\.intents\.(\w+)/g)].map((m) => m[1]));
    for (const i of ['selectChip', 'openFilters', 'applyFilters', 'removeFilter', 'clearFilters', 'loadMore', 'retry', 'open', 'openCreate', 'toggleSort', 'setView']) {
      expect(intents.has(i), i).toBe(true);
    }
    for (const fragment of ['store.search.', 'store.runRowAction(', 'lastOpened()', '[layout]="store.view()"', '[layoutSwitch]="!store.narrow()"', '[columns]="store.columns()"']) {
      expect(src).toContain(fragment);
    }
    const list = app.find((f) => f.path === 'ui/filtered-infinite-list.ts')!.src;
    expect(list).toContain('<app-table-rows');
    expect(list).toContain('<app-infinite-list-row');
  });

  it('opens, edits, steps, creates, and approves records only through the record session', () => {
    const screens = ['records/record-list.screen.ts', 'records/record-panel.ts'];
    for (const path of screens) {
      const src = app.find((f) => f.path === path)!.src;
      expect(src, path).toContain('RecordStore');
      const imported = [...src.matchAll(/import\s*\{([^}]*)\}\s*from/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()));
      const own = ['saveEdit', 'runStep', 'createRecord', 'decide', 'recordExtras', 'availableActions', 'fieldModels', 'toFormValues', 'fromFormValues', 'asGatewayError'];
      expect(imported.filter((n) => own.includes(n)), path).toEqual([]);
    }
  });
});

/** Names, codes and formats that read the same in every language. */
const ALLOWED_WORDS = new Set(['UPI', 'PAN', 'JSON', 'INR']);

const isCode = (literal: string) => literal.startsWith('ui.') || /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(literal);
const isEnglish = (literal: string) => !isCode(literal) && (/[A-Z][a-z]/.test(literal) || /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(literal));
/** Quoted strings in an expression, except field-key suffixes such as `f.key + 'From'`. */
const quoted = (expr: string) =>
  [...expr.replace(/\.key\s*\+\s*'\w+'/g, '').matchAll(/'([^']*)'/g)].map((m) => m[1]!).filter(isEnglish);

/** Drops `@if (...)`, `@else if (...)`, `@for (...)`, `@let x = ...;` and the like, keeping what they wrap. */
function withoutControlFlow(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const m = /^@(let\b[^;]*;|else\s+if\b|\w+)/.exec(s.slice(i));
    if (!m) {
      out += s[i++];
      continue;
    }
    i += m[0].length;
    while (/\s/.test(s[i] ?? '')) i++;
    if (s[i] === '(' && !m[0].startsWith('@let')) {
      for (let depth = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth === 0) {
          i++;
          break;
        }
      }
    }
    out += ' ';
  }
  return out;
}

/**
 * Literal English in a template: words in text, in static text attributes, and
 * in quoted strings inside bindings and interpolations. Code samples and icon
 * names are not text.
 */
function literalText(template: string): string[] {
  const found: string[] = [];
  let s = template.replace(/<(code|mat-icon)\b[^>]*>[\s\S]*?<\/\1>/g, ' ');
  s = s.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) => {
    found.push(...quoted(expr));
    return ' ';
  });
  s = s.replace(/<(?:[^>"]|"[^"]*")*>/g, (tag) => {
    for (const m of tag.matchAll(/\s(?:placeholder|title|alt|label|aria-label)="([^"]*)"/g)) if (/[A-Za-z]{2,}/.test(m[1]!)) found.push(m[1]!);
    for (const m of tag.matchAll(/\s([[(][^\s=]+[\])])="([^"]*)"/g)) if (!/^\[class[\].]/.test(m[1]!)) found.push(...quoted(m[2]!));
    return ' ';
  });
  s = withoutControlFlow(s).replace(/&#?\w+;/g, ' ');
  found.push(...(s.match(/[A-Za-z][A-Za-z'’]+/g) ?? []).filter((w) => !ALLOWED_WORDS.has(w)));
  return found;
}

const templates = (src: string) => [...src.matchAll(/template:\s*`([\s\S]*?)`/g)].map((m) => m[1]!);
const readJson = (file: string) => JSON.parse(readFileSync(join(localeDir, file), 'utf8')) as Record<string, unknown>;
const LOCALES = ['en', 'hi', 'ta', 'te', 'bn', 'mr'];
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** A language's core file, then its area files (`<locale>.<area>.json`) by area name. */
const catalogueFiles = (locale: string) => [
  `${locale}.json`,
  ...readdirSync(localeDir)
    .filter((f) => f.startsWith(`${locale}.`) && /^[a-z]{2}\.[a-z]+\.json$/.test(f))
    .sort(),
];
/** Every shipped entry of a language, across its core and area files. */
const catalogue = (locale: string) => Object.assign({}, ...catalogueFiles(locale).map(readJson)) as Record<string, unknown>;

describe('screen text comes from the locale catalogues', () => {
  it('the literal-text check catches English in text, attributes, and bound strings', () => {
    expect(literalText(`<h1>Sign in</h1>`)).toEqual(['Sign', 'in']);
    expect(literalText(`<input aria-label="Search list" placeholder="Name" />`)).toEqual(['Search list', 'Name']);
    expect(literalText(`<span>{{ saving() ? 'Saving…' : label() }}</span><a [attr.aria-label]="'Remove ' + p.label">✕</a>`)).toEqual(['Saving…', 'Remove ']);
    expect(literalText(`@if (mode() === 'edit') { <b>{{ 'ui.common.save' | t }}</b> } @else if (x) { UPI · ₹ } <code>record.amount</code> <mat-icon>add</mat-icon>`)).toEqual([]);
    expect(literalText(`@for (s of steps(); track s.key) { <button (click)="go('step:' + s.key)">{{ s.label }}</button> } @let v = a.b();`)).toEqual([]);
    expect(literalText(`<input [value]="draft.text(f.key + 'From')" (input)="set('pluralLabel', v)" [title]="f.key + ' From now'" />`)).toEqual([' From now']);
    expect(literalText(`<li [attr.x]="i >= 0 ? 'a' : null" [class]="'badge badge--' + tone" [title]="i > 0 ? 'Go back' : ''">{{ n }}</li>`)).toEqual(['Go back']);
  });

  it('templates outside locale/ contain no literal English words', () => {
    const offending = app.flatMap((f) => templates(f.src).flatMap((tpl) => literalText(tpl).map((w) => `${f.path}: ${w}`)));
    expect(app.filter((f) => templates(f.src).length).length).toBeGreaterThan(15);
    expect(offending).toEqual([]);
  });

  it('controls take their default labels from the catalogue', () => {
    const defaults = app.filter((f) => f.path.startsWith('ui/')).flatMap((f) => [...f.src.matchAll(/const LABELS = ([^;]*);/g)].map((m) => ({ path: f.path, src: m[1]! })));
    expect(defaults.length).toBeGreaterThan(5);
    expect(defaults.filter((d) => !d.src.startsWith('() =>')).map((d) => d.path)).toEqual([]);
    expect(defaults.flatMap((d) => [...d.src.matchAll(/'([^']*)'/g)].filter((m) => !m[1]!.startsWith('ui.')).map((m) => `${d.path}: ${m[1]}`))).toEqual([]);
  });

  it('every key the app uses is in the English catalogue', () => {
    const en = catalogue('en');
    const used = new Set(app.flatMap((f) => [...f.src.matchAll(/'(ui\.[\w.]+)'/g)].map((m) => m[1]!)));
    const missing = [...used].filter((k) => (k.endsWith('.') ? !Object.keys(en).some((x) => x.startsWith(k)) : !(k in en) && !(`${k}.other` in en)));
    expect(used.size).toBeGreaterThan(200);
    expect(missing).toEqual([]);
  });

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
    const run = spawnSync(process.execPath, [join(import.meta.dirname, '../../../apps/onengo/web/scripts/locale-areas.mjs'), '--check'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(catalogueFiles('en')).toEqual(expect.arrayContaining(['en.json', 'en.admin.json', 'en.builder.json', 'en.import.json']));
    const core = Object.keys(readJson('en.json'));
    expect(core.filter((k) => /^ui\.(builder|expression|imports|admin|people)\./.test(k) && k !== 'ui.builder.title' && !k.startsWith('ui.builder.kinds.'))).toEqual([]);
    expect(core).toContain('ui.builder.kinds.translation');
    expect(Object.keys(readJson('en.builder.json')).length).toBeGreaterThan(500);
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
