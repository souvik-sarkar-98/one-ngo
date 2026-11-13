import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localeDir = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/product/locale');

const catalogue = Object.assign(
  {},
  JSON.parse(readFileSync(join(localeDir, 'en.json'), 'utf8')) as Record<string, string>,
  JSON.parse(readFileSync(join(localeDir, 'en.admin.json'), 'utf8')) as Record<string, string>,
  JSON.parse(readFileSync(join(localeDir, 'en.builder.json'), 'utf8')) as Record<string, string>,
  JSON.parse(readFileSync(join(localeDir, 'en.import.json'), 'utf8')) as Record<string, string>,
);

/** The English string the app shows for a catalogue key. */
export function label(key: string, vars: Record<string, string | number> = {}): string {
  const raw = catalogue[key];
  if (raw === undefined) throw new Error(`Missing catalogue key ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => (vars[name] === undefined ? `{${name}}` : String(vars[name])));
}
