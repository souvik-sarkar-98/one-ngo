import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Languages the app ships screen text for. English is complete; the others fall back to it. */
export const SHIPPED_LOCALES = ['en', 'hi', 'ta', 'te', 'bn', 'mr'] as const;
export const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

type Catalogue = Record<string, string>;

/** `{ ui: { nav: { home: 'Home' } } }` and `{ 'ui.nav.home': 'Home' }` both give `ui.nav.home`. */
function flatten(node: unknown, prefix: string, out: Catalogue): Catalogue {
  if (typeof node === 'string') {
    if (prefix) out[prefix] = node;
  } else if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** The shipped screen text (`locale/<locale>.json` and each area's `<locale>.<area>.json`), read once at start-up. */
export class MessageCatalogue {
  private readonly byLocale = new Map<string, Catalogue>();

  constructor(dir?: string, catalogues?: Record<string, unknown>) {
    if (dir && existsSync(dir)) {
      for (const file of readdirSync(dir).sort()) {
        const locale = /^([a-z]{2}(?:-[A-Z]{2})?)(?:\.[a-z]+)?\.json$/.exec(file)?.[1];
        if (!locale) continue;
        const text = flatten(JSON.parse(readFileSync(join(dir, file), 'utf8')), '', {});
        this.byLocale.set(locale, { ...this.byLocale.get(locale), ...text });
      }
    }
    for (const [locale, c] of Object.entries(catalogues ?? {})) this.byLocale.set(locale, flatten(c, '', {}));
  }

  /** English, overlaid with the locale's entries. */
  messages(locale: string): Catalogue {
    return { ...(this.byLocale.get('en') ?? {}), ...(locale === 'en' ? {} : this.byLocale.get(locale) ?? {}) };
  }
}
