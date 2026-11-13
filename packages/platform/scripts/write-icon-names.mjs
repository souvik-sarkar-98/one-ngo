import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(join(root, 'node_modules/material-icons/index.d.ts'), 'utf8');
const names = [...src.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
const extra = ['records', 'more', 'back', 'bell', 'drag', 'up', 'down', 'next'];
const all = [...new Set([...extra, ...names])].sort((a, b) => a.localeCompare(b));
const body = all.map((name) => `  ${JSON.stringify(name)}`).join(',\n');
const out = `/** Every icon a navigation destination can use. Material names draw from the icon font; the extra names are the shell marks. */
export const ICON_NAMES: readonly string[] = [
${body},
];

const ICON_NAME_SET = new Set<string>(ICON_NAMES);

export const isIconName = (value: string): boolean => ICON_NAME_SET.has(value);

/** A readable label for an icon name, such as account_balance to Account balance. */
export const iconLabel = (name: string): string => name.replace(/_/g, ' ').replace(/\\b[a-z]/g, (letter) => letter.toUpperCase());
`;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/runtime/definitions/icon-names.ts'), out);
console.log(`icons ${all.length}`);
