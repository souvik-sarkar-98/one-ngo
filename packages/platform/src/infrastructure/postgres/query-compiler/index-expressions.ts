/**
 * SQL expressions over record data, shared by the list query and the managed
 * index manager. PostgreSQL only uses an expression index when the query
 * repeats the same expression with the same literals, so both sides build
 * them here: this is the one place that writes them. Keys are definition keys,
 * checked against their pattern before they are written into SQL.
 */
import type { IndexCast } from '../../../runtime/definitions/ports/managed-indexes.js';

export type { IndexCast };

const KEY = /^[a-z][a-zA-Z0-9_-]{0,62}$/;

export function sqlKey(key: string): string {
  if (!KEY.test(key)) throw new TypeError(`'${key}' is not a valid key`);
  return `'${key}'`;
}

export function fieldExpr(key: string, cast: IndexCast): string {
  const k = sqlKey(key);
  switch (cast) {
    case 'text':
      return `(data->>${k})`;
    case 'numeric':
      return `((data->>${k})::numeric)`;
    case 'lower':
      return `lower(data->>${k})`;
    case 'lat':
      return `((data->${k}->>'lat')::numeric)`;
    case 'lng':
      return `((data->${k}->>'lng')::numeric)`;
    case 'state':
      return `(workflow_state->>${k})`;
    case 'hash':
      return `(blind_index->>${k})`;
  }
}

/** The partial-index predicate every managed index on a record type shares. */
export const typePredicate = (typeKey: string) => `type_key = ${sqlKey(typeKey)} and deleted_at is null`;
