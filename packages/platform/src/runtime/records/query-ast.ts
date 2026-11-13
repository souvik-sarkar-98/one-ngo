import { meResolved } from './person-fields.js';
import { sharedWithMePredicate, visibilityPredicate } from './visibility.js';
import type { Actor } from '../../domain/ports/tenant-context.js';
import { forbidden, validationFailed } from '@onengo/kernel/errors';
import { canReadField } from '../definitions/field-permissions.js';
import type { FieldDef, FieldFilter, PublishedDefinition } from '../definitions/types.js';
import { isPrimary } from '../definitions/workflows.js';
import type { RecordPredicate, RecordQueryAst, RecordSort, SortDir } from './ports/record-query.js';

export type { Period, RecordAggregateAst, RecordGroup, RecordMeasure, RecordPredicate, RecordQueryAst, RecordSort, SortDir } from './ports/record-query.js';

/** A list query as a request asks for it. */
export interface RecordQuery {
  /** Only these records (a selection), still subject to visibility and the other conditions. */
  ids?: string[];
  statusIn?: string[];
  /** States of any workflow of the record type, by workflow key. */
  states?: Record<string, string[]>;
  /** Only records the signed-in person owns. */
  owner?: 'me';
  /** Only records shared with the signed-in person or one of their roles, not their own. */
  sharedWithMe?: true;
  /** Matches the record number and searchable, required, or title fields. */
  search?: string;
  filters?: Record<string, FieldFilter>;
  equals?: Record<string, string | number | boolean>;
  /**
   * A field key, or number, status, createdAt, updatedAt. Newest first when
   * absent. For a location field, `from` sorts nearest first from that point.
   */
  sort?: { field: string; dir?: 'asc' | 'desc'; from?: { lat: number; lng: number } };
  /** Number or money fields to total over every matching record (not just the page). */
  sum?: string[];
  limit?: number;
  offset?: number;
  /** Skip the count query when the caller does not need a total. */
  withTotal?: boolean;
}

/** The record type a list query reads, with its workflows (default primary first). */
export interface QueriedType {
  type: PublishedDefinition<'recordType'>;
  /** The default primary workflow. */
  workflow: PublishedDefinition<'workflow'> | undefined;
  workflows: PublishedDefinition<'workflow'>[];
}

const SORT_COLUMNS: Record<string, 'number' | 'status' | 'createdAt' | 'updatedAt'> = {
  number: 'number',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

const asText = (f: Pick<FieldDef, 'type'>): 'text' | 'numeric' => (f.type === 'number' || f.type === 'money' ? 'numeric' : 'text');

const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

function nearPoint(key: string, p: { lat?: unknown; lng?: unknown } | undefined): { lat: number; lng: number } {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw validationFailed(`'${key}' needs a point with a valid latitude and longitude.`);
  return { lat, lng };
}

/**
 * The AST of a list query, for a person who may read the record type: every
 * field exists, may be read by them and is not sensitive, every operator fits
 * the field's type, and the visibility of a restricted type is added.
 */
export function recordQueryAst(actor: Actor, typeKey: string, loaded: QueriedType, c: RecordQuery = {}, maxLimit = 200): RecordQueryAst {
  const { type } = loaded;
  const fields = new Map(type.body.fields.map((f) => [f.key, f]));
  const field = (key: string, use = 'filtered') => {
    const f = fields.get(key);
    if (!f) throw validationFailed(`Unknown field '${key}'.`);
    if (f.sensitive) throw forbidden('Sensitive fields cannot be filtered.');
    if (!canReadField(actor, type.body, f)) throw forbidden(`'${f.label}' cannot be ${use}: you cannot see it.`);
    return f;
  };

  const where: RecordPredicate[] = [{ kind: 'ofType', type: typeKey }];
  const visible = visibilityPredicate(type.body, loaded.workflows.map((w) => w.body), actor);
  if (visible) where.push(visible);
  if (c.ids) where.push({ kind: 'idIn', ids: c.ids.map(String) });
  if (c.statusIn?.length) where.push({ kind: 'statusIn', values: c.statusIn.map(String) });
  if (c.owner === 'me') where.push({ kind: 'ownedBy', person: actor.id });
  if (c.sharedWithMe) where.push(sharedWithMePredicate(actor));

  for (const [key, states] of Object.entries(c.states ?? {})) {
    const wf = loaded.workflows.find((w) => w.key === key)?.body;
    if (!wf) throw validationFailed(`Unknown workflow '${key}'.`);
    if (!Array.isArray(states) || !states.length) continue;
    const primary = isPrimary(wf);
    where.push({ kind: 'workflowIn', workflow: key, primary, orNone: primary && wf === loaded.workflow?.body, states: states.map(String) });
  }

  const search = c.search?.trim();
  if (search) where.push({ kind: 'search', text: search });

  for (const [k, v] of Object.entries(c.equals ?? {})) {
    field(k);
    if (!scalar(v)) throw validationFailed(`'${k}' needs a single text, number or yes/no value.`);
    where.push({ kind: 'equals', field: k, value: v });
  }

  for (const [k, given] of Object.entries(c.filters ?? {})) {
    const def = field(k);
    const f = def.type === 'person' ? meResolved(given, actor.id) : given;
    if (f.near !== undefined) {
      if (def.type !== 'location') throw validationFailed(`'${k}' is not a location field.`);
      const p = nearPoint(k, f.near);
      const km = Number(f.near.km);
      if (!(km > 0 && km <= 1000)) throw validationFailed(`'${k}' distance must be more than 0 and at most 1000 km.`);
      where.push({ kind: 'near', field: k, lat: p.lat, lng: p.lng, km });
      continue;
    }
    if (f.in?.length) {
      if (def.type === 'multiChoice') where.push({ kind: 'oneOf', field: k, as: 'multi', values: f.in.map(String) });
      else if (asText(def) === 'numeric') where.push({ kind: 'oneOf', field: k, as: 'numeric', values: f.in.map(Number) });
      else where.push({ kind: 'oneOf', field: k, as: 'text', values: f.in.map(String) });
    }
    if (f.eq !== undefined && f.eq !== null) {
      if (!scalar(f.eq)) throw validationFailed(`'${k}' needs a single text, number or yes/no value.`);
      where.push({ kind: 'equals', field: k, value: f.eq });
    }
    const bounds: { from?: string | number; to?: string | number } = {};
    for (const side of ['from', 'to'] as const) {
      const value = f[side];
      if (value === undefined || value === null || value === '') continue;
      if (asText(def) === 'numeric') {
        const n = Number(value);
        if (!Number.isFinite(n)) throw validationFailed(`'${k}' range needs numbers.`);
        bounds[side] = n;
      } else if (def.type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw validationFailed(`'${k}' range needs dates.`);
        bounds[side] = String(value);
      } else throw validationFailed(`'${k}' cannot be filtered by range.`);
    }
    if (bounds.from !== undefined || bounds.to !== undefined) where.push({ kind: 'range', field: k, as: asText(def) === 'numeric' ? 'numeric' : 'date', ...bounds });
  }

  let sort: RecordSort = { kind: 'newest' };
  if (c.sort?.field) {
    const dir: SortDir = c.sort.dir === 'asc' ? 'asc' : 'desc';
    const column = Object.hasOwn(SORT_COLUMNS, c.sort.field) ? SORT_COLUMNS[c.sort.field] : undefined;
    if (column) sort = { kind: 'column', column, dir };
    else {
      const def = field(c.sort.field, 'sorted');
      if (def.type === 'location') {
        if (!c.sort.from) throw validationFailed(`Sorting by '${def.key}' needs a point to measure from.`);
        sort = { kind: 'distance', field: def.key, ...nearPoint(def.key, c.sort.from), dir };
      } else sort = { kind: 'field', field: def.key, as: asText(def), dir };
    }
  }
  return { where, sort, limit: Math.min(Math.max(c.limit ?? 50, 1), maxLimit), offset: Math.max(c.offset ?? 0, 0) };
}
