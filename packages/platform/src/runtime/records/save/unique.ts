import { validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { Tx } from '../../../domain/ports/transaction.js';
import { isStoredEncrypted } from '../../definitions/field-permissions.js';
import type { FieldDef, RecordTypeDef } from '../../definitions/types.js';
import { matchesPattern } from '../../definitions/field-pattern.js';
import type { RecordQueries } from '../ports/record-query.js';
import type { RecordStore } from '../ports/record-store.js';
import { uniqueValueQuery } from '../query.js';
import type { SensitiveFields } from '../sensitive.js';
import type { SaveContext } from './context.js';
import { sameFieldValue } from './scope.js';

/** Where a unique value is looked up: keyed hashes in the record store, plain values through record queries. */
export interface UniqueLookup {
  store: RecordStore;
  queries: RecordQueries;
  sensitive: SensitiveFields;
}

export async function unique(tx: Tx, s: SaveContext): Promise<void> {
  const issues = await s.services.checkUniqueAndPatterns(tx, s.type, s.data, s.previous, s.current?.id ?? null);
  if (issues.length) throw validationFailed('Some fields are not valid.', issues);
}

/**
 * Unique values and format rules, checked only when a value changes so
 * records saved before a rule was added stay editable.
 */
export async function uniqueAndPatternIssues(
  lookup: UniqueLookup,
  tx: Tx,
  type: RecordTypeDef,
  data: Record<string, unknown>,
  previous: Record<string, unknown> | null,
  recordId: string | null,
): Promise<FieldIssue[]> {
  const issues: FieldIssue[] = [];
  for (const f of type.fields) {
    const v = data[f.key];
    if (v === undefined || v === null || v === '' || (previous && sameFieldValue(previous[f.key], v))) continue;
    if (f.pattern && typeof v === 'string' && !matchesPattern(f.pattern, v)) {
      issues.push({ path: `/${f.key}`, message: f.patternMessage ?? 'is not in the expected format' });
      continue;
    }
    if (!f.unique) continue;
    const dup = await uniqueHolder(lookup, tx, type, f, String(v), recordId);
    if (dup) issues.push({ path: `/${f.key}`, message: `Another ${type.label.toLowerCase()} already has this ${f.label}.` });
  }
  return issues;
}

/**
 * The record of the type, other than `exceptId`, holding `value` in unique
 * field `f`, whoever can see it. Encrypted values are found by their keyed
 * hash; encrypted text fields also match values still stored in plain text,
 * from before the field was encrypted.
 */
export async function uniqueHolder(
  { store, queries, sensitive }: UniqueLookup,
  tx: Tx,
  type: RecordTypeDef,
  f: FieldDef,
  value: string,
  exceptId: string | null,
): Promise<string | undefined> {
  if (isStoredEncrypted(f)) {
    const [hit] = await store.idsByHash(tx, type.key, f.key, sensitive.lookups(type, f, value), exceptId, 1);
    if (hit || f.type === 'number') return hit;
  }
  const [dup] = await queries.ids(tx, uniqueValueQuery(type.key, f, value, exceptId));
  return dup;
}
