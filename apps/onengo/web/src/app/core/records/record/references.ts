import { t } from '../../i18n/i18n';
import type { FieldDef, RecordView, RuntimeRecordType } from '../../models';
import type { Suggestion, SuggestionSource } from '../../ui-logic/autocomplete';
import { personId, toFormValue, type FormValues } from './forms';
import type { RecordsGateway } from '../gateway/gateway';
import { recordTitle, showValue } from './present';
import type { ListSpec } from '../spec';

export const PICK_LIMIT = 8;

/** A picker suggestion: a found record, or making one from the typed text. */
export interface PickOption extends Suggestion {
  record?: RecordView;
  /** The typed text to create a record with. */
  create?: string;
}

/** The fields filled from the record chosen in `reference`. */
export function copyTargets(type: RuntimeRecordType, reference: string): FieldDef[] {
  return type.fields.filter((f) => f.copyFrom?.reference === reference);
}

/**
 * Form values after choosing `picked` in the reference field `key`, as the
 * server will save them: a new choice copies each `copyFrom` field (blank
 * when the chosen record has no value). Clearing the choice, or choosing the
 * same record again, leaves the copied values as they are.
 */
export function pickReference(type: RuntimeRecordType, values: FormValues, key: string, picked: RecordView | null): FormValues {
  const next: FormValues = { ...values, [key]: picked?.id ?? '' };
  return !picked || picked.id === values[key] ? next : copyPicked(type, next, key, picked);
}

/** Form values with each `copyFrom` field of reference `key` filled from `picked`. */
export function copyPicked(type: RuntimeRecordType, values: FormValues, key: string, picked: RecordView): FormValues {
  const next: FormValues = { ...values };
  for (const f of copyTargets(type, key)) next[f.key] = toFormValue(f, picked.data[f.copyFrom!.field]);
  return next;
}

/** Whether "New <type> “text”" is offered: the person may create the type and it has a title field to fill. */
export function createsFromText(spec: ListSpec): boolean {
  return spec.type.canCreate && !!spec.type.titleField;
}

/** The second line of a picker suggestion: the referenced list view's first subtitle field. */
export function pickHint(spec: ListSpec, r: RecordView): string | undefined {
  const key = spec.row.subtitle[0];
  const v = key ? showValue(spec.type, spec.workflow, r, key) : '—';
  return v === '—' ? undefined : v;
}

/** Records of the referenced type matching the typed text, then "New <type> “text”" when allowed. */
export function recordSource(gateway: RecordsGateway, spec: ListSpec): SuggestionSource {
  return {
    search: async (text) => {
      const typed = text.trim();
      const res = await gateway.query(spec.type.key, { search: typed, limit: PICK_LIMIT });
      const options: PickOption[] = res.items.map((r) => ({ id: r.id, label: recordTitle(spec, r), hint: pickHint(spec, r), record: r }));
      if (typed && createsFromText(spec)) options.push({ id: '', label: t('ui.records.pickNew', { type: spec.type.label.toLowerCase(), text: typed }), create: typed });
      return options;
    },
  };
}

/** Names of the people in a record's person fields, which the server sends as `{ id, name }`. */
export function personTitles(fields: FieldDef[], data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = data[f.key];
    if (f.type === 'person' && v && typeof v === 'object' && 'name' in v) out[String(personId(v))] = String(v.name);
  }
  return out;
}

/**
 * Titles for the chosen references among `values` that are not `known`
 * (asked once per id), loaded with `gateway.get`, with the records read. A
 * record that cannot be read shows as not available rather than by its id.
 */
export async function referenceTitles(
  gateway: RecordsGateway,
  fields: FieldDef[],
  values: FormValues,
  known: (id: string) => boolean,
  specOf: (type: string) => ListSpec | null,
): Promise<{ titles: Record<string, string>; records: RecordView[] }> {
  const wanted = new Map<string, string>();
  for (const f of fields) {
    const id = values[f.key];
    if (f.type === 'reference' && f.referenceType && typeof id === 'string' && id && !wanted.has(id) && !known(id)) wanted.set(id, f.referenceType);
  }
  const titles: Record<string, string> = {};
  const records: RecordView[] = [];
  await Promise.all(
    [...wanted].map(async ([id, type]) => {
      try {
        const r = await gateway.get(type, id);
        const spec = specOf(type);
        titles[id] = spec ? recordTitle(spec, r) : (r.number ?? r.id);
        records.push(r);
      } catch {
        titles[id] = t('ui.records.referenceUnavailable');
      }
    }),
  );
  return { titles, records };
}
