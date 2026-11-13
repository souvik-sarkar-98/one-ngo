import { t } from '../i18n/i18n';

export interface LocalChange {
  op: 'add' | 'remove' | 'change';
  /** Where, as `fields › amount › label`: list items are named by their key or id. */
  path: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const idOf = (v: unknown): string | undefined => (isObject(v) ? (typeof v['key'] === 'string' ? v['key'] : typeof v['id'] === 'string' ? v['id'] : undefined) : undefined);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const join = (path: string, part: string) => (path ? `${path} › ${part}` : part);

/** The differences between two bodies, item by item in keyed lists and property by property in objects. */
export function localChanges(before: unknown, after: unknown, path = ''): LocalChange[] {
  if (same(before, after)) return [];
  if (before === undefined) return [{ op: 'add', path }];
  if (after === undefined) return [{ op: 'remove', path }];
  if (isObject(before) && isObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((k) => localChanges(before[k], after[k], join(path, k)));
  }
  if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every((i) => idOf(i) !== undefined)) {
    const out: LocalChange[] = [];
    for (const b of before) {
      const a = after.find((x) => idOf(x) === idOf(b));
      out.push(...localChanges(b, a, join(path, idOf(b)!)));
    }
    for (const a of after) if (!before.some((b) => idOf(b) === idOf(a))) out.push({ op: 'add', path: join(path, idOf(a)!) });
    const order = (list: unknown[]) => list.map(idOf).filter((id) => before.some((b) => idOf(b) === id) && after.some((x) => idOf(x) === id));
    if (!out.length && !same(order(before), order(after))) out.push({ op: 'change', path });
    return out;
  }
  return [{ op: 'change', path }];
}

/** One line per difference, for changes not yet saved on the server. */
export function localChangeLines(before: unknown, after: unknown): string[] {
  return localChanges(before, after).map((c) => t(`ui.builder.changes.local.${c.op}`, { path: c.path || '—' }));
}
