import type { RecordTypeDef } from '../definitions/types.js';

export interface RecordRef {
  id: string;
  label: string;
}

/** What each of `ids` of a record type is called, for the ones the person can read. */
export type ReferenceLabels = (typeKey: string, ids: string[]) => Promise<Map<string, string>>;

export const referenceFields = (type: RecordTypeDef) => type.fields.filter((f) => f.type === 'reference' && !!f.referenceType);

/**
 * `{ id, label }` for each reference field holding a record, by field key, so
 * lists and records can show the chosen record rather than its id. A record
 * the person cannot read is left out; the id stays in `data` either way.
 */
export async function attachReferences<V extends { data: Record<string, unknown>; references?: Record<string, RecordRef> }>(
  labels: ReferenceLabels,
  type: RecordTypeDef,
  views: V[],
): Promise<V[]> {
  const fields = referenceFields(type);
  if (!fields.length || !views.length) return views;
  const names = new Map<string, Map<string, string>>();
  for (const referenceType of new Set(fields.map((f) => f.referenceType!))) {
    const ids = fields
      .filter((f) => f.referenceType === referenceType)
      .flatMap((f) => views.map((v) => v.data[f.key]))
      .filter((v): v is string => typeof v === 'string' && v !== '');
    names.set(referenceType, ids.length ? await labels(referenceType, ids) : new Map());
  }
  for (const v of views) {
    const refs: Record<string, RecordRef> = {};
    for (const f of fields) {
      const id = v.data[f.key];
      const label = typeof id === 'string' ? names.get(f.referenceType!)?.get(id) : undefined;
      if (typeof id === 'string' && label !== undefined) refs[f.key] = { id, label };
    }
    v.references = refs;
  }
  return views;
}
