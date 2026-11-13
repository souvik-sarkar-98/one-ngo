import type { DefinitionKind } from './types.js';

/** Properties whose text people read; everything else (keys, expressions, addresses) stays as published. */
const TEXT_PROPS = new Set(['label', 'pluralLabel', 'description', 'help', 'placeholder', 'guardMessage', 'patternMessage', 'message', 'confirm', 'subject', 'body']);

type Visit = (path: string, text: string, set: (value: string) => void) => void;

/**
 * Walks the readable text of a definition by its translation path, for
 * example `recordType.donation.fields.amount.label`. Array items are named by
 * their key, id or value, or by position when they have none (page widgets),
 * the same way translation paths are checked when publishing.
 */
function walk(node: unknown, path: string, visit: Visit): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      const o = item as Record<string, unknown>;
      const name = [o.key, o.id, o.value].find((x) => typeof x === 'string') ?? String(i);
      walk(item, `${path}.${name}`, visit);
    });
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') {
      if (TEXT_PROPS.has(k)) visit(`${path}.${k}`, v, (value) => (o[k] = value));
    } else if (v && typeof v === 'object') walk(v, `${path}.${k}`, visit);
  }
}

/** Every translatable text of a definition with its path, for the Builder's translations grid. */
export function translatablePaths(kind: DefinitionKind, body: { key: string }): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  walk(body, `${kind}.${body.key}`, (path, text) => out.push({ path, text }));
  return out;
}

/** A copy of the definition with its texts replaced by the entries that exist; the rest stay in English. */
export function translateBody<T extends { key: string }>(kind: DefinitionKind, body: T, entries: Record<string, string> | undefined): T {
  if (!entries || !Object.keys(entries).length) return body;
  const copy = structuredClone(body);
  walk(copy, `${kind}.${body.key}`, (path, _text, set) => {
    const t = entries[path];
    if (t) set(t);
  });
  return copy;
}
