import { TEXT_FILES, type TextArea } from './i18n-text';

/** Screen text by key, e.g. `ui.common.save`. Every key starts with `ui.`. */
export type Messages = Record<string, string>;
export type Params = Record<string, string | number>;
export type { TextArea };

/**
 * Languages the app ships screen text for: `locale/<locale>.json` for
 * the core screens and `<locale>.<area>.json` per area. English is complete;
 * the others fall back to it.
 */
export const LOCALES = ['en', 'hi', 'ta', 'te', 'bn', 'mr'] as const;

/**
 * `{ ui: { nav: { home: 'Home' } } }` and `{ 'ui.nav.home': 'Home' }` both give
 * `ui.nav.home`, as on the server. Empty strings are left out, so they fall back.
 */
export function flattenMessages(node: unknown, prefix = '', out: Messages = {}): Messages {
  if (typeof node === 'string') {
    if (prefix && node !== '') out[prefix] = node;
  } else if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) flattenMessages(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** The English text loaded so far, which every language falls back to; `loadText` adds each area's. */
export const ENGLISH: Messages = {};

/** The `Intl` locale for an app language: Indian conventions and Latin digits, e.g. `hi` → `hi-IN-u-nu-latn`. */
export function intlLocale(locale: string): string {
  const tag = /^[a-z]{2}$/.test(locale) ? `${locale}-IN` : locale;
  return `${tag}-u-nu-latn`;
}

export interface Translator {
  readonly locale: string;
  /**
   * The text for `key` with `{name}` placeholders filled from `params`; numbers
   * are written in the locale's format. With a numeric `count`, `key.one` or
   * `key.other` is chosen by the locale's plural rule. Missing text falls back
   * to English, then to the key itself.
   */
  t(key: string, params?: Params): string;
  has(key: string): boolean;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** Rupees with paise, e.g. ₹1,00,000.00. Some locales' currency patterns drop lakh grouping, so the sign is placed here. */
  money(value: number): string;
  /** A calendar date (`YYYY-MM-DD` or an ISO timestamp), e.g. 20 Oct 2026. */
  date(value: string | Date): string;
}

export function translator(locale: string, messages: Messages, fallback: Messages = ENGLISH): Translator {
  const intl = intlLocale(locale);
  const plural = new Intl.PluralRules(intl);
  const numbers = new Intl.NumberFormat(intl);
  const paise = new Intl.NumberFormat(intl, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dates = new Intl.DateTimeFormat(intl, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const own = (k: string) => (messages[k] ? messages[k] : undefined);
  const either = (k: string) => own(k) ?? (fallback[k] ? fallback[k] : undefined);

  function lookup(key: string, count: number | undefined): string | undefined {
    if (count === undefined) return either(key);
    const forms = [`${key}.${plural.select(count) === 'one' ? 'one' : 'other'}`, `${key}.other`, key];
    for (const find of [own, (k: string) => (fallback[k] ? fallback[k] : undefined)]) {
      for (const k of forms) {
        const text = find(k);
        if (text !== undefined) return text;
      }
    }
    return undefined;
  }

  return {
    locale,
    t(key, params = {}) {
      const count = typeof params['count'] === 'number' ? params['count'] : undefined;
      const text = lookup(key, count) ?? key;
      return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
        const v = params[name];
        return v === undefined ? whole : typeof v === 'number' ? numbers.format(v) : v;
      });
    },
    has: (key) => either(key) !== undefined || either(`${key}.other`) !== undefined,
    number: (value, options) => (options ? new Intl.NumberFormat(intl, options) : numbers).format(value),
    money: (value) => `${value < 0 ? '-' : ''}₹${paise.format(Math.abs(value))}`,
    date(value) {
      const d = value instanceof Date ? value : new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
      return Number.isNaN(d.getTime()) ? String(value) : dates.format(d);
    },
  };
}

let own: Messages = {};
let active = translator('en', own);

/** Switches the screen text the whole app reads, e.g. after loading the person's language. */
export function useMessages(locale: string, messages: Messages): Translator {
  own = { ...messages };
  active = translator(locale, own);
  return active;
}

/**
 * Adds shipped screen text: English to the fallback. For the language in use, a shipped
 * translation fills a gap and also replaces a value that is still the English text, which
 * is what a catalogue sends before it has that translation. Wording that differs from English is the organisation's and stays.
 */
export function addText(locale: string, messages: Messages): void {
  if (locale === 'en') Object.assign(ENGLISH, messages);
  else if (locale === active.locale) {
    for (const [k, v] of Object.entries(messages)) {
      const current = own[k];
      if (current === undefined || current === ENGLISH[k]) own[k] = v;
    }
  }
}

const files = new Map<string, Promise<Messages>>();
const areas = new Set<TextArea>();

function textFile(area: TextArea, locale: string): Promise<Messages> {
  const key = `${area}:${locale}`;
  let file = files.get(key);
  if (!file) {
    const load = TEXT_FILES[area][locale];
    file = load ? load().then((m) => flattenMessages(m.default)) : Promise.resolve({});
    file.catch(() => files.delete(key));
    files.set(key, file);
  }
  return file;
}

/** Loads an area's screen text in English and in the current language, once each; screens of the area render only after it resolves. */
export async function loadText(area: TextArea): Promise<void> {
  areas.add(area);
  const locale = active.locale;
  const [english, text] = await Promise.all([textFile(area, 'en'), locale === 'en' ? {} : textFile(area, locale)]);
  addText('en', english);
  addText(locale, text);
}

/** Loads the current language's text for every area loaded so far, e.g. after switching language. */
export async function reloadText(): Promise<void> {
  await Promise.all([...areas].map(loadText));
}

/** A label inside a sentence, e.g. "Donation" → "donation". A label that opens with capitals, such as "QA field check", keeps them. */
export function lowerLabel(label: string): string {
  const second = label.charAt(1);
  return second && second !== second.toLocaleLowerCase() ? label : label.charAt(0).toLocaleLowerCase() + label.slice(1);
}

export const currentTranslator = (): Translator => active;
export const t = (key: string, params?: Params): string => active.t(key, params);
export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string => active.number(value, options);
export const formatMoney = (value: number): string => active.money(value);
export const formatDate = (value: string | Date): string => active.date(value);
