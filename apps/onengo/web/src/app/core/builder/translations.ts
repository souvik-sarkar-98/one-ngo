import { flag, oneOf, text, type ParamReader, type Params } from '../address';
import type { Messages } from '../i18n/i18n';
import type { DefinitionKind } from '../models';

/** Kinds whose texts can be translated, in the order the grid lists them. */
export const TRANSLATABLE_KINDS = ['recordType', 'workflow', 'listView', 'recordGroup', 'page', 'action', 'template'] as const;
export type TranslatableKind = (typeof TRANSLATABLE_KINDS)[number];
/** What a path belongs to: a kind of definition, or the app's screen text (`ui.*`). */
export type TranslationArea = TranslatableKind | 'ui';
export const TRANSLATION_AREAS: readonly TranslationArea[] = [...TRANSLATABLE_KINDS, 'ui'];

/** Properties whose text people read, the same list the server translates. */
const TEXT_PROPS = new Set(['label', 'pluralLabel', 'description', 'help', 'placeholder', 'guardMessage', 'patternMessage', 'message', 'confirm', 'subject', 'body']);

type Body = Record<string, unknown>;

function walk(node: unknown, path: string, out: { path: string; text: string }[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      const o = item as Body;
      const name = [o['key'], o['id'], o['value']].find((x) => typeof x === 'string') ?? String(i);
      walk(item, `${path}.${name}`, out);
    });
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Body)) {
    if (typeof v === 'string') {
      if (TEXT_PROPS.has(k) && v) out.push({ path: `${path}.${k}`, text: v });
    } else if (v && typeof v === 'object') walk(v, `${path}.${k}`, out);
  }
}

/**
 * Every translatable text of a definition by its path, e.g.
 * `recordType.donation.fields.amount.label`. Array items are named by their
 * key, id or value, or by position when they have none (page widgets), as
 * the server names them when it translates and checks.
 */
export function translatablePaths(kind: DefinitionKind, body: Body): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  if (typeof body['key'] === 'string') walk(body, `${kind}.${body['key']}`, out);
  return out;
}

export const areaOf = (path: string): TranslationArea => path.slice(0, path.indexOf('.')) as TranslationArea;

/** Where the text shown in a language comes from: the organisation's own entry, the app's shipped translation, or nowhere (English shows). */
export type EntryOrigin = 'organisation' | 'app' | 'missing';

export interface TranslationRow {
  path: string;
  area: TranslationArea;
  english: string;
  translation: string;
  origin: EntryOrigin;
  /** Placeholders of the English text the translation leaves out. */
  lost: string[];
}

/** What the grid lists: published definitions, the English screen text, and the app's own translation of it. */
export interface TranslationSources {
  definitions: { kind: DefinitionKind; body: Body }[];
  english: Messages;
  /** The shipped screen text of the language being translated. */
  app: Messages;
}

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}|\{(\w+)\}/g;
const tokens = (text: string) => [...text.matchAll(TOKEN)].map((m) => (m[1] !== undefined ? `{{ ${m[1].replace(/\s+/g, ' ')} }}` : `{${m[2]}}`));

/** Placeholders such as `{{ record.donorName }}` or `{count}` that the translation must keep; none while it is empty. */
export function lostPlaceholders(english: string, translation: string): string[] {
  if (!translation) return [];
  const kept = new Set(tokens(translation));
  return [...new Set(tokens(english))].filter((x) => !kept.has(x));
}

/** One row per translatable path: the definitions' texts by kind, then the screen text in catalogue order. */
export function translationRows(sources: TranslationSources, entries: Record<string, string>): TranslationRow[] {
  const seen = new Set<string>();
  const rows: TranslationRow[] = [];
  const add = (path: string, english: string, shipped?: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const own = entries[path];
    const translation = own || shipped || '';
    rows.push({ path, area: areaOf(path), english, translation, origin: own ? 'organisation' : shipped ? 'app' : 'missing', lost: lostPlaceholders(english, translation) });
  };
  for (const kind of TRANSLATABLE_KINDS) {
    const defs = sources.definitions.filter((d) => d.kind === kind).sort((a, b) => String(a.body['key']).localeCompare(String(b.body['key'])));
    for (const d of defs) for (const p of translatablePaths(kind, d.body)) add(p.path, p.text);
  }
  for (const [key, english] of Object.entries(sources.english)) if (key.startsWith('ui.')) add(key, english, sources.app[key]);
  return rows;
}

/** Entries whose path names nothing any more (a removed field, chip or screen text). */
export function staleEntries(entries: Record<string, string>, rows: readonly TranslationRow[]): string[] {
  const known = new Set(rows.map((r) => r.path));
  return Object.keys(entries).filter((p) => !known.has(p));
}

export interface TranslationFilter {
  missing: boolean;
  q: string;
  area?: TranslationArea;
}

/** Rows for the filter: an area, only those without a translation, and a search over the path and both texts. */
export function filterTranslationRows(rows: readonly TranslationRow[], f: TranslationFilter): TranslationRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!f.area || r.area === f.area) &&
      (!f.missing || r.origin === 'missing') &&
      (!q || r.path.toLowerCase().includes(q) || r.english.toLowerCase().includes(q) || r.translation.toLowerCase().includes(q)),
  );
}

/** The grid's address: `/builder/translations?locale=hi&missing=true&q=…&area=page`. */
export interface TranslationsAddress extends TranslationFilter {
  locale?: string;
}

const LOCALE = text();
const MISSING = flag('true', null);
const Q = text({ trim: false });
const AREA = oneOf(TRANSLATION_AREAS);

export function parseTranslationsAddress(get: ParamReader): TranslationsAddress {
  const locale = LOCALE.read(get, 'locale');
  const area = AREA.read(get, 'area');
  return {
    ...(locale && /^[a-z]{2}(-[A-Z]{2})?$/.test(locale) && { locale }),
    missing: MISSING.read(get, 'missing') ?? false,
    q: Q.read(get, 'q') ?? '',
    ...(area && { area }),
  };
}

/** The parameters to write for a change; only what changes is written. */
export function translationsParams(change: Partial<TranslationsAddress>): Params {
  const out: Params = {};
  if ('locale' in change) Object.assign(out, LOCALE.write('locale', change.locale));
  if ('missing' in change) Object.assign(out, MISSING.write('missing', change.missing || undefined));
  if ('q' in change) Object.assign(out, Q.write('q', change.q || undefined));
  if ('area' in change) Object.assign(out, AREA.write('area', change.area));
  return out;
}

/** How much of the language is translated, as a whole percentage. */
export function translatedShare(rows: readonly TranslationRow[]): number {
  if (!rows.length) return 0;
  return Math.floor((rows.filter((r) => r.origin !== 'missing').length * 100) / rows.length);
}

/** The translation definition that covers a language; the server allows only one per language. */
export function translationFor(locale: string, translations: readonly { key: string; locale: string }[]): string | null {
  return translations.find((x) => x.locale === locale)?.key ?? null;
}

/** A key for a language's first translation: the language code, or a numbered one when that is taken. */
export function newTranslationKey(locale: string, taken: readonly string[]): string {
  const base = locale.replace(/[^a-zA-Z0-9]/g, '').replace(/^[^a-z]+/, '') || 'translation';
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}${n}`)) n++;
  return `${base}${n}`;
}
