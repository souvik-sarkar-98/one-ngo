import { validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { Tx } from '../../domain/ports/transaction.js';
import type { FieldFilter, RecordTypeDef } from '../definitions/types.js';
import type { PersonDirectory } from './ports/person-directory.js';

/** In a person field's filter values: the signed-in person. */
export const ME = 'me';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PersonRef {
  id: string;
  name: string;
}

export const personFields = (type: RecordTypeDef) => type.fields.filter((f) => f.type === 'person');

/** A person field's filter with `me` replaced by the signed-in person's id. */
export function meResolved(f: FieldFilter, actorId: string): FieldFilter {
  const me = <T>(v: T) => (v === ME ? actorId : v);
  return { ...f, ...(f.in ? { in: f.in.map(me) } : {}), ...(f.eq !== undefined ? { eq: me(f.eq) } : {}) };
}

const userIds = (ids: string[]) => [...new Set(ids.filter((id) => UUID.test(id)))];

/** Active members of the organisation among `ids`. */
export async function activeMembers(people: PersonDirectory, tx: Tx, ids: string[]): Promise<Set<string>> {
  const wanted = userIds(ids);
  return wanted.length ? people.activeMembers(tx, wanted) : new Set();
}

/** Display names of members, whatever their status, so suspended people keep their names on records. */
export async function personNames(people: PersonDirectory, tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const wanted = userIds(ids);
  return wanted.length ? people.names(tx, wanted) : new Map();
}

/** A person field's value must be an active member when it is set or changed; an unchanged value stays valid. */
export async function personFieldIssues(
  people: PersonDirectory,
  tx: Tx,
  type: RecordTypeDef,
  data: Record<string, unknown>,
  previous: Record<string, unknown> | null,
): Promise<FieldIssue[]> {
  const changed = personFields(type).filter((f) => typeof data[f.key] === 'string' && data[f.key] !== previous?.[f.key]);
  if (!changed.length) return [];
  const active = await activeMembers(people, tx, changed.map((f) => data[f.key] as string));
  return changed.filter((f) => !active.has(data[f.key] as string)).map((f) => ({ path: `/${f.key}`, message: 'must be an active member of the organisation' }));
}

/** `{ id, name }` for each person field holding a member, by field key; masked values are left out. */
export async function attachPeople<V extends { data: Record<string, unknown>; people?: Record<string, PersonRef> }>(
  people: PersonDirectory,
  tx: Tx,
  type: RecordTypeDef,
  views: V[],
): Promise<V[]> {
  const fields = personFields(type);
  if (!fields.length || !views.length) return views;
  const ids = views.flatMap((v) => fields.map((f) => v.data[f.key])).filter((x): x is string => typeof x === 'string');
  const names = await personNames(people, tx, ids);
  for (const v of views) {
    const refs: Record<string, PersonRef> = {};
    for (const f of fields) {
      const id = v.data[f.key];
      if (typeof id === 'string' && names.has(id)) refs[f.key] = { id, name: names.get(id)! };
    }
    v.people = refs;
  }
  return views;
}

/** The member an import cell means: their email or user id. Unknown or suspended people are row problems. */
export async function resolvePerson(people: PersonDirectory, tx: Tx, text: string): Promise<string> {
  const value = text.trim();
  const row = await people.find(tx, UUID.test(value) ? { userId: value } : { email: value });
  if (!row) throw validationFailed('does not match any member of the organisation');
  if (!row.active) throw validationFailed('is not an active member of the organisation');
  return row.userId;
}

/** Empty values (missing, null, blank text, no items) count as the same; other values compare by JSON. */
export function same(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && !v.length);
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  return JSON.stringify(typeof a === 'string' ? a.trim() : a) === JSON.stringify(typeof b === 'string' ? b.trim() : b);
}
