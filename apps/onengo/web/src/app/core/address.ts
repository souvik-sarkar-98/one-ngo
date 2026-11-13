/** Reads one address-bar parameter; null when it is absent. */
export type ParamReader = (name: string) => string | null;

/** Address-bar parameters to write; null removes one. */
export type Params = Record<string, string | null>;

/**
 * One typed value kept in the address bar under a key. Reading drops anything
 * invalid, so a bad link still opens; writing gives every parameter the value
 * owns, with null for the ones to remove.
 */
export interface Codec<T> {
  names(key: string): string[];
  read(get: ParamReader, key: string): T | undefined;
  write(key: string, value: T | undefined): Params;
}

export interface Sort {
  field: string;
  dir: 'asc' | 'desc';
}

export interface Range {
  from?: string;
  to?: string;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

/** The written form of any value: empty values are removed and lists are comma-separated. */
export const encode = (v: unknown): string | null => (!present(v) ? null : Array.isArray(v) ? v.join(',') : String(v));

function single<T>(read: (raw: string | null) => T | undefined, write: (value: T) => string | null = encode): Codec<T> {
  return {
    names: (key) => [key],
    read: (get, key) => read(get(key)),
    write: (key, value) => ({ [key]: value === undefined ? null : write(value) }),
  };
}

/** Free text. Trimmed unless `trim` is false; empty is absent. */
export function text(opts: { trim?: boolean } = {}): Codec<string> {
  const trim = opts.trim ?? true;
  return single((raw) => {
    const v = trim ? raw?.trim() : raw;
    return v ? v : undefined;
  });
}

/** One of a fixed set of values. */
export function oneOf<T extends string>(values: readonly T[]): Codec<T> {
  return single((raw) => (raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : undefined));
}

/** Comma-separated values, limited to `allowed` when it is not empty. */
export function list(allowed: readonly string[] = []): Codec<string[]> {
  const ok = new Set(allowed);
  return single((raw) => {
    if (!raw) return undefined;
    const values = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && (!ok.size || ok.has(s)));
    return values.length ? values : undefined;
  });
}

/** True when the parameter is `on`; false when it is `off` (only when `off` is given). */
export function flag(on = 'true', off: string | null = 'false'): Codec<boolean> {
  return single(
    (raw) => (raw === on ? true : off !== null && raw === off ? false : undefined),
    (v) => (v ? on : off),
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Two ends kept as `<key>From` and `<key>To`; each end is checked on its own. */
export function range(kind: 'number' | 'date'): Codec<Range> {
  const valid = (raw: string) => (kind === 'number' ? Number.isFinite(Number(raw)) : DATE.test(raw));
  const end = (get: ParamReader, name: string) => {
    const raw = get(name)?.trim();
    return raw && valid(raw) ? raw : undefined;
  };
  return {
    names: (key) => [`${key}From`, `${key}To`],
    read: (get, key) => {
      const from = end(get, `${key}From`);
      const to = end(get, `${key}To`);
      return from === undefined && to === undefined ? undefined : { ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
    },
    write: (key, value) => ({ [`${key}From`]: encode(value?.from), [`${key}To`]: encode(value?.to) }),
  };
}

/** `field` ascending or `-field` descending, limited to the sortable fields. */
export function sort(sortable: readonly string[]): Codec<Sort> {
  return single(
    (raw) => {
      if (!raw) return undefined;
      const field = raw.replace(/^-/, '');
      return sortable.includes(field) ? { field, dir: raw.startsWith('-') ? 'desc' : 'asc' } : undefined;
    },
    (s) => (s.dir === 'desc' ? '-' : '') + s.field,
  );
}

/** A row count rounded up to whole pages, at least one page and at most `max` rows' worth. */
export function roundDepth(n: number, pageSize: number, max: number): number {
  const pages = Math.max(1, Math.ceil(n / pageSize));
  return Math.min(pages * pageSize, Math.max(pageSize, Math.floor(max / pageSize) * pageSize));
}

/** How far down a paged list reaches. One page is the default and is not written. */
export function depth(pageSize: number, max: number): Codec<number> {
  return single(
    (raw) => {
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? roundDepth(n, pageSize, max) : undefined;
    },
    (n) => (n > pageSize ? String(n) : null),
  );
}
