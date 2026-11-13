import { richTextToPlain } from './rich-text.js';
import type { Actor } from '../../domain/ports/tenant-context.js';
import { canReadField, isReadProtected, isStoredEncrypted } from '../definitions/field-permissions.js';
import type { FieldDef, FieldFilter, RecordTypeDef } from '../definitions/types.js';
import type { RecordPredicate, RecordQueryAst, RecordSort } from './ports/record-query.js';
import { recordQueryAst, type QueriedType, type RecordQuery } from './query-ast.js';

export type { FieldFilter, QueriedType, RecordQuery };
export type { RecordRow } from './ports/record-store.js';

/** A record query for the record-query port: the validated AST, on one page. */
export type RecordIdsQuery = RecordQueryAst;

/** `q` with more conditions, on the page given (in `q`'s order unless a sort is given). */
function narrowQuery(q: RecordIdsQuery, where: RecordPredicate[], page: { sort?: RecordSort; limit: number; offset: number }): RecordIdsQuery {
  return { where: [...q.where, ...where], sort: page.sort ?? q.sort, limit: page.limit, offset: page.offset };
}

/** `q` narrowed to the records `ids`, all on one page. */
export function onlyIds(q: RecordIdsQuery, ids: string[]): RecordIdsQuery {
  return narrowQuery(q, [{ kind: 'idIn', ids }], { limit: ids.length, offset: 0 });
}

/**
 * The record of a type holding `value` in unique field `f`, other than
 * `exceptId`, whoever can see it (unique values are unique across the organisation).
 */
export function uniqueValueQuery(typeKey: string, f: FieldDef, value: string, exceptId: string | null): RecordIdsQuery {
  const where: RecordPredicate[] = [
    { kind: 'ofType', type: typeKey },
    { kind: 'matches', field: f.key, as: f.type === 'number' ? 'numeric' : 'caseless', value },
  ];
  if (exceptId) where.push({ kind: 'idIsNot', id: exceptId });
  return { where, sort: { kind: 'id' }, limit: 1, offset: 0 };
}

/** A query to run, or a unique encrypted field whose keyed hash finds the record among those `q` allows. */
export type ReferenceLookup = { query: RecordIdsQuery } | { hashed: FieldDef };

/**
 * The lookups, in the order to try them, for the record of `q`'s type that
 * some text means: its id, its number, a unique field's value the person may
 * see, or its title. Each asks for two ids so an ambiguous match shows.
 * Encrypted text fields also match values stored before they were encrypted.
 */
export function referenceQueries(q: RecordIdsQuery, type: RecordTypeDef, actor: Actor, value: string, uuid: boolean): ReferenceLookup[] {
  const tries: (RecordPredicate | FieldDef)[] = [];
  if (uuid) tries.push({ kind: 'idIs', id: value });
  if (type.numbering) tries.push({ kind: 'numberIs', number: value });
  for (const f of type.fields) {
    if (!f.unique || !canReadField(actor, type, f)) continue;
    const numeric = f.type === 'number';
    if (numeric && !/^-?\d+(\.\d+)?$/.test(value)) continue;
    if (isStoredEncrypted(f)) tries.push(f);
    if (!numeric) tries.push({ kind: 'matches', field: f.key, as: 'caseless', value });
    else if (!isStoredEncrypted(f)) tries.push({ kind: 'matches', field: f.key, as: 'numeric', value });
  }
  if (type.titleField) tries.push({ kind: 'matches', field: type.titleField, as: 'caseless', value });
  return tries.map((p) => ('kind' in p ? { query: narrowQuery(q, [p], { sort: { kind: 'id' }, limit: 2, offset: 0 }) } : { hashed: p }));
}

/**
 * The lower-cased words list search matches: the record number and every
 * searchable, required or title field that everyone who reads the record may
 * see. Rich text contributes its plain text.
 */
export function searchText(type: RecordTypeDef, number: string | null, data: Record<string, unknown>): string {
  const parts = number ? [number] : [];
  for (const f of type.fields) {
    if (isReadProtected(type, f) || f.type === 'longText') continue;
    if (!(f.searchable || f.required || f.key === type.titleField)) continue;
    const v = data[f.key];
    if (typeof v === 'string') parts.push(f.type === 'richText' ? richTextToPlain(v) : v);
    else if (typeof v === 'number') parts.push(String(v));
    else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
  }
  return parts.join(' ').toLowerCase().slice(0, 10_000);
}

/**
 * A list query for a person who may read the record type: its AST, checked
 * against the definitions, with the record type and its workflows.
 */
export function buildRecordQuery(actor: Actor, typeKey: string, loaded: QueriedType, c: RecordQuery = {}, maxLimit = 200) {
  const ast = recordQueryAst(actor, typeKey, loaded, c, maxLimit);
  return { type: loaded.type, workflows: loaded.workflows.map((w) => w.body), ast, ...ast };
}
