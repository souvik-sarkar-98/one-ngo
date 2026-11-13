// Keeps the screen text in packages/product/locale/ split by area, so each area's text
// loads with its screens instead of in the first download:
//   node apps/onengo/web/scripts/locale-areas.mjs                 moves keys and rewrites the loader
//   node apps/onengo/web/scripts/locale-areas.mjs --check         reports stale generated output
//   node apps/onengo/web/scripts/locale-areas.mjs --merge <rev>   settles the text of a merge commit
// <locale>.json is the core text (shell, Home, Records, Inbox, More, sign-in);
// <locale>.<area>.json holds an area's text. AREAS below decides where each key
// lives: the longest matching prefix wins, anything unmatched is core. A key
// added to en.json, or both sides of a merge conflict in a catalogue, are
// moved to the right file; untranslated.json is rebuilt from the catalogues.
// While a merge is in progress (or for --merge <rev>), both sides are compared
// with their merge base: a key either side removed is dropped, and a text only
// one side changed takes that side's wording, whichever file it now sits in.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Key prefix → area. Breadcrumb and More labels for an area stay core, as they show before it loads. */
const AREAS = {
  'ui.builder': 'builder',
  'ui.builder.title': 'core',
  'ui.builder.kinds': 'core',
  'ui.expression': 'builder',
  'ui.permissionField': 'builder',
  'ui.livePreview': 'builder',
  'ui.diagram': 'builder',
  'ui.admin': 'admin',
  'ui.people': 'admin',
  'ui.imports': 'import',
};

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const localeDir = join(web, '..', '..', '..', 'packages', 'product', 'locale');
const loaderFile = join(web, 'src/app/core/i18n/i18n-text.ts');
const check = process.argv.includes('--check');

const areas = [...new Set(Object.values(AREAS))].filter((a) => a !== 'core').sort();

function areaOf(key) {
  let best = '';
  for (const p of Object.keys(AREAS)) if ((key === p || key.startsWith(`${p}.`)) && p.length > best.length) best = p;
  return best ? AREAS[best] : 'core';
}

const fileOf = (locale, area) => join(localeDir, area === 'core' ? `${locale}.json` : `${locale}.${area}.json`);
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const ENTRY = /^\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/;

/**
 * A flat catalogue, one entry per line, as a list of entries and blank lines.
 * Inside merge-conflict markers both sides are kept (the merge base is
 * dropped); a key listed twice keeps its first place and its last text.
 */
function parse(text, file) {
  const items = [];
  const at = new Map();
  let inBase = false;
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (/^\|{7}/.test(line)) inBase = true;
    else if (/^={7}/.test(line)) inBase = false;
    if (/^(<{7}|\|{7}|={7}|>{7})/.test(line) || inBase) continue;
    const m = ENTRY.exec(line);
    if (m) {
      const key = JSON.parse(m[1]);
      JSON.parse(m[2]);
      if (at.has(key)) at.get(key).value = m[2];
      else {
        const entry = { key, value: m[2] };
        at.set(key, entry);
        items.push(entry);
      }
    } else if (!line.trim()) items.push(null);
    else if (!/^\s*(\{\s*\}|[{}])\s*$/.test(line)) throw new Error(`${relative(join(web, '..'), file)}: expected one "key": "text" entry per line, found ${line.trim()}`);
  }
  return items;
}

const segments = (a, b) => {
  const x = a.split('.');
  const y = b.split('.');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
};

/** Puts the entry after the last one sharing most of its dotted prefix (at least `ui.<group>`), else at the end; an existing key takes the new text. */
function place(items, entry) {
  const same = items.find((i) => i && i.key === entry.key);
  if (same) {
    same.value = entry.value;
    return;
  }
  let best = -1;
  let shared = 2;
  items.forEach((i, n) => {
    if (!i) return;
    const s = segments(i.key, entry.key);
    if (s >= shared) {
      shared = s;
      best = n;
    }
  });
  items.splice(best < 0 ? items.length : best + 1, 0, entry);
}

const group = (key) => {
  const s = key.split('.');
  return s.slice(0, s.length > 3 ? 3 : 2).join('.');
};

/** Core files keep their own blank lines; area files are written with a blank line between groups of keys. */
function format(items, grouped) {
  let entries = items;
  if (grouped) {
    entries = [];
    for (const i of items.filter(Boolean)) {
      const last = entries[entries.length - 1];
      if (last && group(last.key) !== group(i.key)) entries.push(null);
      entries.push(i);
    }
  }
  const lines = [];
  for (const i of entries) {
    if (!i) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    } else lines.push(`  ${JSON.stringify(i.key)}: ${i.value}`);
  }
  while (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return '{}\n';
  const last = lines.length - 1;
  return `{\n${lines.map((l, n) => (l === '' || n === last ? l : `${l},`)).join('\n')}\n}\n`;
}

const declared = /export const LOCALES = \[([^\]]*)\]/.exec(read(join(web, 'src/app/core/i18n/i18n.ts')) ?? '');
const order = declared ? [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const found = readdirSync(localeDir)
  .map((f) => /^([a-z]{2}(?:-[A-Z]{2})?)(?:\.[a-z]+)?\.json$/.exec(f)?.[1])
  .filter(Boolean);
const locales = [...new Set([...order.filter((l) => found.includes(l)), ...[...new Set(found)].filter((l) => !order.includes(l)).sort()])];
if (!locales.includes('en')) throw new Error('locale/en.json is missing');

const repo = join(web, '..');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });

/** Every shipped text per locale at a commit, across its core and area files. */
function textAt(rev) {
  const out = {};
  for (const path of git('ls-tree', '--name-only', rev, 'packages/product/locale/').split('\n')) {
    const locale = /^product\/locale\/([a-z]{2}(?:-[A-Z]{2})?)(?:\.[a-z]+)?\.json$/.exec(path)?.[1];
    if (locale) Object.assign((out[locale] ??= {}), JSON.parse(git('show', `${rev}:${path}`)));
  }
  return out;
}

/** The two sides of the merge in progress, or of the merge commit given with --merge; null outside a merge. */
function mergeSides() {
  const at = process.argv.indexOf('--merge');
  if (at > 0) {
    const rev = process.argv[at + 1];
    if (!rev) throw new Error('--merge needs a merge commit, e.g. --merge HEAD');
    return [`${rev}^1`, `${rev}^2`];
  }
  try {
    git('rev-parse', '-q', '--verify', 'MERGE_HEAD');
    return ['HEAD', 'MERGE_HEAD'];
  } catch {
    return null;
  }
}

const sides = mergeSides();
const upstream = sides && { base: textAt(git('merge-base', ...sides).trim()), a: textAt(sides[0]), b: textAt(sides[1]) };
const settled = [];

/** Drops what one side removed (and the other left alone) and keeps the wording of the side that changed it. */
function settle(locale, files) {
  const base = upstream.base[locale] ?? {};
  const a = upstream.a[locale] ?? {};
  const b = upstream.b[locale] ?? {};
  for (const items of Object.values(files)) {
    for (const entry of items.filter(Boolean)) {
      const k = entry.key;
      const was = base[k];
      if (was !== undefined && ((!(k in a) && (!(k in b) || b[k] === was)) || (!(k in b) && a[k] === was))) {
        items.splice(items.indexOf(entry), 1);
        settled.push(`${k}: removed (${locale})`);
        continue;
      }
      if (!(k in a) || !(k in b) || a[k] === b[k]) continue;
      const now = JSON.parse(entry.value);
      const wanted = a[k] === was ? b[k] : b[k] === was ? a[k] : now;
      if ((now === a[k] || now === b[k]) && now !== wanted) {
        entry.value = JSON.stringify(wanted);
        settled.push(`${k}: changed wording kept (${locale})`);
      } else if (a[k] !== was && b[k] !== was && now === wanted) settled.push(`${k}: both sides changed it, kept ${JSON.stringify(now)} (${locale})`);
    }
  }
}

const outputs = new Map();
const moved = [];
const catalogues = {};
for (const locale of locales) {
  const files = { core: parse(read(fileOf(locale, 'core')), fileOf(locale, 'core')) };
  for (const area of areas) files[area] = parse(read(fileOf(locale, area)), fileOf(locale, area));
  for (const [from, items] of Object.entries(files)) {
    for (const entry of items.filter((i) => i && areaOf(i.key) !== from)) {
      items.splice(items.indexOf(entry), 1);
      place(files[areaOf(entry.key)], entry);
      moved.push(`${entry.key}: ${locale}${from === 'core' ? '' : `.${from}`} → ${locale}${areaOf(entry.key) === 'core' ? '' : `.${areaOf(entry.key)}`}`);
    }
  }
  if (upstream) settle(locale, files);
  catalogues[locale] = files;
  for (const [area, items] of Object.entries(files)) {
    const file = fileOf(locale, area);
    if (area !== 'core' && locale !== 'en' && !items.some(Boolean) && !existsSync(file)) continue;
    outputs.set(file, format(items, area !== 'core'));
  }
}

const englishKeys = ['core', ...areas].flatMap((a) => catalogues.en[a].filter(Boolean).map((i) => i.key));
const untranslated = {};
for (const locale of locales.filter((l) => l !== 'en')) {
  const own = new Set(Object.values(catalogues[locale]).flatMap((items) => items.filter(Boolean).map((i) => i.key)));
  untranslated[locale] = englishKeys.filter((k) => !own.has(k));
}
outputs.set(join(localeDir, 'untranslated.json'), `${JSON.stringify(untranslated, null, 2)}\n`);

const importOf = (file) => `() => import('@onengo/product/locale/${relative(localeDir, file).split('\\').join('/')}')`;
const table = ['core', ...areas]
  .map((area) => {
    const rows = locales.filter((l) => outputs.has(fileOf(l, area))).map((l) => `    ${/^[a-z]+$/.test(l) ? l : `'${l}'`}: ${importOf(fileOf(l, area))},`);
    return `  ${/^[a-z]+$/.test(area) ? area : `'${area}'`}: {\n${rows.join('\n')}\n  },`;
  })
  .join('\n');
outputs.set(
  loaderFile,
  `// Written by apps/onengo/web/scripts/locale-areas.mjs from the shared product locale files.

/** Screen text that loads with its screens: \`core\` with the shell and sign-in, each other area with its routes. */
export type TextArea = ${['core', ...areas].map((a) => `'${a}'`).join(' | ')};

export const TEXT_FILES: Record<TextArea, Partial<Record<string, () => Promise<{ default: unknown }>>>> = {
${table}
};
`,
);

const eol = (read(fileOf('en', 'core')) ?? '').includes('\r\n') ? '\r\n' : '\n';
const changed = [];
for (const [file, text] of outputs) {
  const before = read(file);
  if (before !== null && before.replace(/\r\n/g, '\n') === text) continue;
  changed.push(relative(join(web, '..'), file).split('\\').join('/'));
  if (!check) writeFileSync(file, (before ?? eol).includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
}

if (check) {
  if (changed.length) {
    console.error(`Screen text is not split by area; run node apps/onengo/web/scripts/locale-areas.mjs. Would change:\n  ${changed.join('\n  ')}`);
    if (moved.length) console.error(`Keys in the wrong file:\n  ${moved.slice(0, 20).join('\n  ')}${moved.length > 20 ? `\n  …and ${moved.length - 20} more` : ''}`);
    process.exit(1);
  }
  console.log('Screen text is split by area.');
} else {
  if (settled.length) console.log(`Merge of ${sides.join(' and ')}:\n  ${settled.join('\n  ')}`);
  console.log(`${moved.length} keys moved; ${changed.length ? `wrote ${changed.join(', ')}` : 'nothing to change'}.`);
}
