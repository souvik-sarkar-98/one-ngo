import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT_ROOT } from '../paths.js';

/** The shipped message catalogue, one copy for the server and the web app. */
export const LOCALE_DIR = join(PRODUCT_ROOT, 'locale');

export const readJson = (file: string) => JSON.parse(readFileSync(join(LOCALE_DIR, file), 'utf8')) as Record<string, unknown>;

/** A language's core file, then its area files (`<locale>.<area>.json`) by area name. */
export const catalogueFiles = (locale: string) => [
  `${locale}.json`,
  ...readdirSync(LOCALE_DIR)
    .filter((f) => f.startsWith(`${locale}.`) && /^[a-z]{2}\.[a-z]+\.json$/.test(f))
    .sort(),
];

/** Every shipped entry of a language, across its core and area files. */
export const catalogue = (locale: string) => Object.assign({}, ...catalogueFiles(locale).map(readJson)) as Record<string, unknown>;
