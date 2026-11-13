import { PlatformError } from '@onengo/kernel/errors';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import type { FieldDef, RecordTypeDef } from '../../runtime/definitions/types.js';
import type { RecordService } from '../../runtime/records/record-service.js';

/** A problem with one row of a file; `row` counts the heading row as 1. */
export interface CellProblem {
  row: number;
  column?: string;
  field?: string;
  message: string;
}

/** A data row of a file: its line in the file (the heading row is 1) and its cells. */
export interface CsvRow {
  row: number;
  cells: string[];
}

/**
 * A parsed CSV as a heading and data rows. The heading is the first row with any text; blank
 * headings become "Column n" and repeated ones get " (2)", " (3)" so every column has its own
 * name. Blank rows are dropped.
 */
export function csvTable(all: string[][]): { header: string[]; rows: CsvRow[] } {
  const first = all.findIndex((r) => r.some((c) => c.trim() !== ''));
  const header: string[] = [];
  for (const [i, raw] of (first < 0 ? [] : all[first]!).entries()) {
    const base = raw.trim() || `Column ${i + 1}`;
    let name = base;
    for (let n = 2; header.includes(name); n++) name = `${base} (${n})`;
    header.push(name);
  }
  const rows: CsvRow[] = [];
  if (first >= 0) for (let i = first + 1; i < all.length; i++) if (all[i]!.some((c) => c.trim() !== '')) rows.push({ row: i + 1, cells: all[i]! });
  return { header, rows };
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Fields a column can fill: not calculated, not kept from other records, not files. */
export function importable(f: FieldDef): boolean {
  return !f.calculated && !f.rollup && f.type !== 'file' && f.type !== 'signature';
}

/** Each column matched to an unused importable field with the same label or key, ignoring case, spaces and punctuation. */
export function suggestMapping(type: RecordTypeDef, columns: string[]): Record<string, string | null> {
  const used = new Set<string>();
  const out: Record<string, string | null> = {};
  for (const name of columns) {
    const s = squash(name);
    const f = type.fields.find((x) => importable(x) && !used.has(x.key) && s !== '' && (squash(x.label) === s || squash(x.key) === s));
    out[name] = f?.key ?? null;
    if (f) used.add(f.key);
  }
  return out;
}

const NUMBER = /^-?(\d+|\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})*,\d{3})(\.\d+)?$/;

/** A number as written in the sheet: plain, 1,000,000 or Indian 10,00,000 grouping, with an optional ₹ or Rs. */
export function parseNumber(raw: string): number | null {
  const s = raw.replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/\s+/g, '');
  if (!NUMBER.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** A date written dd/mm/yyyy (or with - or .) or as an ISO date, as yyyy-mm-dd. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

/**
 * The value a cell holds for a field, or why it cannot be read. References
 * are resolved separately; the text is returned for them.
 */
export function parseCell(f: FieldDef, raw: string): { value: unknown } | { error: string } {
  const s = raw.trim();
  const choice = (t: string) => {
    const cs = f.choices ?? [];
    return (cs.find((c) => c.value === t) ?? cs.find((c) => c.label.toLowerCase() === t.toLowerCase()) ?? cs.find((c) => c.value.toLowerCase() === t.toLowerCase()))?.value;
  };
  switch (f.type) {
    case 'number':
    case 'money': {
      const n = parseNumber(s);
      return n === null ? { error: 'is not a number' } : { value: n };
    }
    case 'date': {
      const d = parseDate(s);
      return d === null ? { error: 'is not a date (use dd/mm/yyyy or yyyy-mm-dd)' } : { value: d };
    }
    case 'boolean': {
      const t = s.toLowerCase();
      return YES.has(t) ? { value: true } : NO.has(t) ? { value: false } : { error: 'must be yes or no' };
    }
    case 'choice': {
      const v = choice(s);
      return v === undefined ? { error: `is not one of the choices (${(f.choices ?? []).map((c) => c.label).join(', ')})` } : { value: v };
    }
    case 'multiChoice': {
      const parts = s.split(s.includes(';') ? ';' : ',').map((p) => p.trim()).filter(Boolean);
      const values = parts.map(choice);
      const bad = parts.filter((_, i) => values[i] === undefined);
      if (bad.length) return { error: `has values that are not choices: ${bad.join(', ')}` };
      return { value: [...new Set(values)] };
    }
    case 'location': {
      const m = /^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/.exec(s);
      return m ? { value: { lat: Number(m[1]), lng: Number(m[2]) } } : { error: 'must be a latitude and longitude, for example 12.97, 77.59' };
    }
    default:
      return { value: s };
  }
}

/**
 * One non-blank cell as the value of a field. A reference is found by the text a person would
 * type (number, unique value or title) and a person by email or user id; `refs` caches both
 * across the rows of a batch.
 */
export async function readCell(
  ctx: TenantContext,
  records: Pick<RecordService, 'resolveReference' | 'resolvePerson'>,
  f: FieldDef,
  raw: string,
  refs: Map<string, Promise<string>>,
): Promise<{ value: unknown } | { error: string }> {
  if (f.type === 'reference') {
    const ref = f.referenceType!;
    const cacheKey = `${ref}\u0000${raw.toLowerCase()}`;
    if (!refs.has(cacheKey)) refs.set(cacheKey, records.resolveReference(ctx, ref, raw));
    try {
      return { value: await refs.get(cacheKey)! };
    } catch (e) {
      if (!(e instanceof PlatformError)) throw e;
      return { error: e.code === 'forbidden' ? 'cannot be chosen: you cannot see these records' : e.message };
    }
  }
  if (f.type === 'person') {
    const cacheKey = `\u0000person\u0000${raw.toLowerCase()}`;
    if (!refs.has(cacheKey)) refs.set(cacheKey, records.resolvePerson(ctx, raw));
    try {
      return { value: await refs.get(cacheKey)! };
    } catch (e) {
      if (!(e instanceof PlatformError)) throw e;
      return { error: e.message };
    }
  }
  return parseCell(f, raw);
}

/** A failed save as problems on the row's columns. */
export function problemsOf(e: PlatformError, row: number, type: RecordTypeDef, columnOf: ReadonlyMap<string, string>): CellProblem[] {
  if (!e.issues.length) return [{ row, message: e.message }];
  return e.issues.map((i) => {
    const key = i.path.replace(/^\//, '').split('/')[0] ?? '';
    const f = type.fields.find((x) => x.key === key);
    if (!f) return { row, message: i.path === '/' ? i.message : `${i.path.slice(1)} ${i.message}` };
    const message = /^[a-z]/.test(i.message) ? `${f.label} ${i.message}` : i.message;
    return { row, ...(columnOf.has(key) ? { column: columnOf.get(key) } : {}), field: key, message };
  });
}
