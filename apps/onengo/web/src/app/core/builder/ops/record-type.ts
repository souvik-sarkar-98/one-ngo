import { formatNumber, numberingPeriod, type FieldDef, type FieldType, type FileKind, type RecordTypeDef, type RollupDef } from '../../server';
import { toKey } from '../../fields/fields';
import { t } from '../../i18n/i18n';
import type { Tone } from '../../rows';
import type { Usage } from '../http-builder';

export type { FieldDef, FieldType, FileKind, RecordTypeDef, RollupDef };

export const FIELD_TYPES: readonly FieldType[] = [
  'text', 'longText', 'richText', 'number', 'money', 'date', 'boolean', 'choice', 'multiChoice',
  'email', 'phone', 'reference', 'person', 'file', 'location', 'signature',
];
export const FILE_KINDS: readonly FileKind[] = ['image', 'pdf', 'document', 'spreadsheet'];

const UNIQUE_TYPES = new Set<FieldType>(['text', 'email', 'phone', 'number', 'person']);
const TEXTUAL = new Set<FieldType>(['text', 'longText']);
const CALCULABLE = new Set<FieldType>(['text', 'longText', 'number', 'money', 'date', 'boolean', 'choice', 'email', 'phone']);
const NUMERIC = new Set<FieldType>(['number', 'money']);
const LENGTHY = new Set<FieldType>(['text', 'longText', 'richText']);
const OLD_TYPES = new Set<FieldType>(['text', 'longText', 'number', 'money', 'date', 'boolean', 'choice', 'email', 'phone', 'reference']);

export interface Badge {
  label: string;
  tone: Tone;
}

export type PanelSection =
  | 'basics' | 'rules' | 'choices' | 'reference' | 'copyFrom' | 'conditions' | 'calculated'
  | 'rollup' | 'file' | 'location' | 'signature' | 'access';

/** Drops undefined and empty-string properties so saved definitions and patches stay small; `false` is kept. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
}

/** What a record type may have. */
export function allows(_b: Pick<RecordTypeDef, 'key'>): { numbering: boolean; workflows: boolean; remove: boolean } {
  return { numbering: true, workflows: true, remove: true };
}

/** The fields people edit here. */
export function shownFields(b: RecordTypeDef): FieldDef[] {
  return b.fields;
}

export const fieldOf = (b: RecordTypeDef, key: string): FieldDef | undefined => b.fields.find((f) => f.key === key);

/**
 * The places that still use a field, one entry per definition, with what the use is:
 * "Donors (calculation of 'Total'; condition of 'Amount'), Reports (filter)".
 * A definition that uses the field in several places is named once.
 */
export function usesSummary(usages: readonly Usage[]): string {
  const groups = new Map<string, { name: string; whats: string[] }>();
  for (const u of usages) {
    const id = `${u.kind}|${u.key}`;
    const group = groups.get(id) ?? { name: u.label || u.key, whats: [] };
    if (!group.whats.includes(u.what)) group.whats.push(u.what);
    groups.set(id, group);
  }
  return [...groups.values()].map((g) => `${g.name} (${g.whats.join('; ')})`).join(', ');
}

export function typeLabel(type: FieldType): string {
  return t(OLD_TYPES.has(type) ? `ui.builder.fieldTypes.${type}` : `ui.builder.schema.enum.${type}`);
}

// ---------------------------------------------------------------- general and numbering

type General = Partial<Pick<RecordTypeDef, 'label' | 'pluralLabel' | 'description' | 'titleField' | 'visibility'>>;

export function setGeneral(b: RecordTypeDef, patch: General): RecordTypeDef {
  const next = clean({ ...b, ...patch });
  return { ...next, label: next.label ?? '' };
}

const PUBLIC_ENTRY_TYPES = new Set<FieldType>(['text', 'longText', 'number', 'money', 'date', 'boolean', 'choice', 'multiChoice', 'email', 'phone', 'location', 'richText', 'reference']);
const PUBLIC_DISPLAY_TYPES = new Set<FieldType>(['text', 'longText', 'number', 'money', 'date', 'boolean', 'choice', 'multiChoice', 'email', 'phone', 'location', 'richText']);

/** A field a visitor may type, including one reference to a catalogue. */
export function publicEntryField(f: FieldDef): boolean {
  return PUBLIC_ENTRY_TYPES.has(f.type) && !f.sensitive && !f.readPermission && !f.editPermission && !f.calculated && !f.rollup && !f.follow;
}

/** A field a catalogue result may show. */
export function publicDisplayField(f: FieldDef): boolean {
  return (PUBLIC_DISPLAY_TYPES.has(f.type) || !!f.calculated || !!f.rollup || !!f.follow) && !f.sensitive && !f.readPermission && f.type !== 'person' && f.type !== 'file' && f.type !== 'signature' && f.type !== 'reference';
}

/** Sets or removes the public block. An empty block is removed. */
export function setPublic(b: RecordTypeDef, access: RecordTypeDef['public']): RecordTypeDef {
  if (!access) return clean({ ...b, public: undefined });
  const next = clean(access);
  const used = !!(next.create || next.view || next.edit || next.delete || next.catalogue || next.fields?.length || next.thanks);
  return clean({ ...b, public: used ? next : undefined });
}

export function defaultNumbering(b: Pick<RecordTypeDef, 'key'>): NonNullable<RecordTypeDef['numbering']> {
  const prefix = b.key.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'REC';
  return { sequence: b.key, format: `${prefix}/{fy}/{seq:5}`, reset: 'fiscal_year' };
}

/** Sets or removes numbering. */
export function setNumbering(b: RecordTypeDef, numbering: RecordTypeDef['numbering']): RecordTypeDef {
  if (!allows(b).numbering) return b;
  return clean({ ...b, numbering: numbering && clean(numbering) });
}

/** Why a number format cannot be used, or null. */
export function numberFormatProblem(format: string): string | null {
  if (!/\{seq(?::\d+)?\}/.test(format)) return t('ui.builder.recordType.needsSeq', { token: '{seq}' });
  const unknown = format.match(/\{(?!(?:seq(?::\d+)?|fy|period)\})[^}]*\}/);
  return unknown ? t('ui.builder.recordType.unknownToken', { token: unknown[0] }) : null;
}

/** The number the next record would get, formatted the way the server formats it; `fy` is the organisation's current financial year as the server labels it. */
export function numberPreview(numbering: NonNullable<RecordTypeDef['numbering']>, next: number, fy: string): string {
  return formatNumber(numbering.format, { seq: next, fy, period: numberingPeriod(numbering.reset, fy) });
}

// ---------------------------------------------------------------- fields

export function uniqueKey(b: RecordTypeDef, base: string, except?: string): string {
  const root = base || 'field';
  const taken = new Set(b.fields.map((f) => f.key).filter((k) => k !== except));
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}${n}`)) n++;
  return `${root}${n}`;
}

export function addField(b: RecordTypeDef, label: string, type: FieldType = 'text'): { body: RecordTypeDef; key: string } {
  const key = uniqueKey(b, toKey(label));
  return { body: { ...b, fields: [...b.fields, { key, label, type }] }, key };
}

export function duplicateField(b: RecordTypeDef, key: string, label: string): { body: RecordTypeDef; key: string } {
  const i = b.fields.findIndex((f) => f.key === key);
  if (i < 0) return { body: b, key };
  const copy = { ...structuredClone(b.fields[i]!), label, key: uniqueKey(b, toKey(label)) };
  const fields = [...b.fields];
  fields.splice(i + 1, 0, copy);
  return { body: { ...b, fields }, key: copy.key };
}

/** Removes a field, the title when it was that field, and the lookup inputs and values that name it. */
export function removeField(b: RecordTypeDef, key: string): RecordTypeDef {
  const lookups = b.lookups?.map((l) => ({ ...l, inputs: l.inputs.filter((i) => i !== key), map: Object.fromEntries(Object.entries(l.map).filter(([f]) => f !== key)) }));
  return clean({ ...b, fields: b.fields.filter((f) => f.key !== key), titleField: b.titleField === key ? undefined : b.titleField, lookups });
}

/** Moves a field between positions of the shown fields. */
export function moveField(b: RecordTypeDef, from: number, to: number): RecordTypeDef {
  const shown = shownFields(b);
  const moving = shown[from];
  const target = shown[to];
  if (!moving || !target || from === to) return b;
  const fields = b.fields.filter((f) => f !== moving);
  const at = fields.indexOf(target) + (to > from ? 1 : 0);
  fields.splice(at, 0, moving);
  return { ...b, fields };
}

export function setField(b: RecordTypeDef, key: string, patch: Partial<FieldDef>): RecordTypeDef {
  return { ...b, fields: b.fields.map((f) => (f.key === key ? clean({ ...f, ...patch }) : f)) };
}

/**
 * Renames a field. While its key is not fixed by a publish and still follows
 * the label, the key follows the new label, together with the title and the
 * copies that name it.
 */
export function setLabel(b: RecordTypeDef, key: string, label: string, keyFixed: boolean): { body: RecordTypeDef; key: string } {
  const f = fieldOf(b, key);
  if (!f) return { body: b, key };
  const base = toKey(f.label ?? '');
  const follows = !keyFixed && !!base && (key === base || (key.startsWith(base) && /^\d+$/.test(key.slice(base.length))));
  const next = follows ? uniqueKey(b, toKey(label), key) : key;
  const body = renameKey(setField(b, key, { label }), key, next);
  return { body, key: next };
}

/** Changes a field's key and the places in this record type that name it. */
export function renameKey(b: RecordTypeDef, from: string, to: string): RecordTypeDef {
  if (from === to || !to) return b;
  return {
    ...b,
    ...(b.titleField === from && { titleField: to }),
    fields: b.fields.map((f) => {
      const g = f.key === from ? { ...f, key: to } : f;
      return g.copyFrom?.reference === from ? { ...g, copyFrom: { ...g.copyFrom, reference: to } } : g;
    }),
    ...(b.lookups && {
      lookups: b.lookups.map((l) => ({
        ...l,
        inputs: l.inputs.map((i) => (i === from ? to : i)),
        map: Object.fromEntries(Object.entries(l.map).map(([f, v]) => [f === from ? to : f, v])),
      })),
    }),
  };
}

/** Fields that show no empty-box text; the same kinds the server refuses a placeholder on. */
const NO_PLACEHOLDER: ReadonlySet<FieldType> = new Set(['boolean', 'multiChoice', 'file', 'location', 'signature', 'richText']);
export const canHavePlaceholder = (type: FieldType): boolean => !NO_PLACEHOLDER.has(type);

/** Changes the type and drops the options the new type does not have. */
export function setFieldType(b: RecordTypeDef, key: string, type: FieldType): RecordTypeDef {
  const f = fieldOf(b, key);
  if (!f || f.type === type) return b;
  const choice = type === 'choice' || type === 'multiChoice';
  return setField(b, key, {
    type,
    choices: choice ? (f.choices?.length ? f.choices : [{ value: 'yes', label: t('ui.common.yes') }]) : undefined,
    referenceType: type === 'reference' ? f.referenceType : undefined,
    min: NUMERIC.has(type) ? f.min : undefined,
    max: NUMERIC.has(type) ? f.max : undefined,
    maxLength: LENGTHY.has(type) ? f.maxLength : undefined,
    pattern: type === 'text' ? f.pattern : undefined,
    patternMessage: type === 'text' ? f.patternMessage : undefined,
    placeholder: canHavePlaceholder(type) ? f.placeholder : undefined,
    unique: UNIQUE_TYPES.has(type) ? f.unique : undefined,
    calculated: CALCULABLE.has(type) ? f.calculated : undefined,
    rollup: NUMERIC.has(type) ? f.rollup : undefined,
    copyFrom: type === 'person' ? undefined : f.copyFrom,
    multiple: type === 'file' ? f.multiple : undefined,
    accept: type === 'file' ? f.accept : undefined,
    maxSizeMb: type === 'file' ? f.maxSizeMb : undefined,
    typedCoordinates: type === 'location' ? f.typedCoordinates : undefined,
    typedName: type === 'signature' ? f.typedName : undefined,
  });
}

/** A calculated field is read-only: it is not required, has no conditions, is not copied, and cannot be unique. */
export function setCalculated(b: RecordTypeDef, key: string, expression: string): RecordTypeDef {
  if (!expression.trim()) return setField(b, key, { calculated: undefined });
  return setField(b, key, {
    calculated: expression,
    required: undefined,
    visibleWhen: undefined,
    editableWhen: undefined,
    editPermission: undefined,
    copyFrom: undefined,
    rollup: undefined,
    unique: undefined,
  });
}

/** A roll-up is kept by the server: it is not entered, calculated, copied or unique. */
export function setRollup(b: RecordTypeDef, key: string, rollup: RollupDef | undefined): RecordTypeDef {
  if (!rollup) return setField(b, key, { rollup: undefined });
  const r: RollupDef = {
    recordType: rollup.recordType,
    reference: rollup.reference,
    measure: rollup.measure,
    ...(rollup.measure === 'sum' && { field: rollup.field ?? '' }),
    ...(rollup.where && { where: rollup.where }),
  };
  return setField(b, key, {
    rollup: r,
    required: undefined,
    editableWhen: undefined,
    editPermission: undefined,
    calculated: undefined,
    copyFrom: undefined,
    unique: undefined,
  });
}

export function setCopyFrom(b: RecordTypeDef, key: string, copyFrom: FieldDef['copyFrom']): RecordTypeDef {
  const f = fieldOf(b, key);
  if (!f || (copyFrom && (f.type === 'person' || f.calculated || f.rollup))) return b;
  return setField(b, key, { copyFrom: copyFrom?.reference ? copyFrom : undefined });
}

/** Sensitive means "record:<type>:sensitive to see it", so it replaces any other read permission. */
export function setSensitive(b: RecordTypeDef, key: string, on: boolean): RecordTypeDef {
  return setField(b, key, on ? { sensitive: true, readPermission: undefined } : { sensitive: undefined });
}

/** The read permission a field needs, given or implied by Sensitive. */
export function readPermissionOf(b: Pick<RecordTypeDef, 'key'>, f: FieldDef): string | undefined {
  return f.sensitive ? `record:${b.key}:sensitive` : f.readPermission;
}

export function toggleAccept(b: RecordTypeDef, key: string, kind: FileKind): RecordTypeDef {
  const f = fieldOf(b, key);
  if (!f) return b;
  const has = f.accept?.includes(kind);
  const accept = has ? f.accept!.filter((k) => k !== kind) : FILE_KINDS.filter((k) => k === kind || f.accept?.includes(k));
  return setField(b, key, { accept: accept.length ? accept : undefined });
}

export const canBeUnique = (f: FieldDef) => UNIQUE_TYPES.has(f.type) && !f.calculated && !f.rollup;
export const hasRange = (f: FieldDef) => NUMERIC.has(f.type);
export const hasMaxLength = (f: FieldDef) => LENGTHY.has(f.type);
export const hasPattern = (f: FieldDef) => f.type === 'text';
export const canChangePermission = (f: FieldDef) => !f.calculated && !f.rollup;
export const derived = (f: FieldDef) => !!(f.calculated || f.rollup);

/** The reference fields of this record type a field can be copied through. */
export const referenceFields = (b: RecordTypeDef, except?: string) => b.fields.filter((f) => f.type === 'reference' && f.key !== except);

/** Fields of the chosen record that can fill `target`: the same type, or text into text. */
export function copyCandidates(target: FieldDef, source: readonly FieldDef[]): FieldDef[] {
  return source.filter((s) => s.type === target.type || (TEXTUAL.has(s.type) && TEXTUAL.has(target.type)));
}

/** The panel's sections that apply to a field. */
export function panelSections(b: RecordTypeDef, f: FieldDef): PanelSection[] {
  const out: PanelSection[] = ['basics', 'rules'];
  if (f.type === 'choice' || f.type === 'multiChoice') out.push('choices');
  if (f.type === 'reference') out.push('reference');
  if (f.type !== 'person' && !derived(f) && (f.copyFrom || referenceFields(b, f.key).length)) out.push('copyFrom');
  if (!f.calculated) out.push('conditions');
  if (CALCULABLE.has(f.type) && !f.rollup && !f.copyFrom) out.push('calculated');
  if (NUMERIC.has(f.type) && !f.calculated && !f.copyFrom) out.push('rollup');
  if (f.type === 'file') out.push('file');
  if (f.type === 'location') out.push('location');
  if (f.type === 'signature') out.push('signature');
  out.push('access');
  return out;
}

// ---------------------------------------------------------------- table summaries

export function typeSummary(f: FieldDef): string {
  const name = typeLabel(f.type);
  if (f.type === 'reference' && f.referenceType) return `${name} → ${f.referenceType}`;
  if ((f.type === 'choice' || f.type === 'multiChoice') && f.choices?.length) return `${name} · ${f.choices.length}`;
  return name;
}

/** Short badges for a field's rules, in the order people read them. */
export function ruleBadges(b: RecordTypeDef, f: FieldDef): Badge[] {
  const out: Badge[] = [];
  const add = (key: string, tone: Tone, params?: Record<string, string>) => out.push({ label: t(`ui.builder.recordType.badge.${key}`, params), tone });
  if (f.calculated) add('calculated', 'primary');
  if (f.rollup) add('rollup', 'primary');
  if (f.copyFrom) add('copied', 'neutral', { field: fieldOf(b, f.copyFrom.reference)?.label || f.copyFrom.reference });
  if (f.visibleWhen) add('shownWhen', 'neutral');
  if (f.editableWhen) add('editableWhen', 'neutral');
  if (f.unique) add('unique', 'neutral');
  if (f.pattern) add('pattern', 'neutral');
  if (f.sensitive) add('sensitive', 'danger');
  else if (f.readPermission) add('readPermission', 'warning');
  if (f.editPermission) add('editPermission', 'warning');
  return out;
}

// ---------------------------------------------------------------- rules

type Rule = NonNullable<RecordTypeDef['rules']>[number];

export function addRule(b: RecordTypeDef): { body: RecordTypeDef; key: string } {
  const taken = new Set((b.rules ?? []).map((r) => r.key));
  let n = (b.rules?.length ?? 0) + 1;
  while (taken.has(`rule${n}`)) n++;
  const key = `rule${n}`;
  return { body: { ...b, rules: [...(b.rules ?? []), { key, expression: '', message: '' }] }, key };
}

export function setRule(b: RecordTypeDef, key: string, patch: Partial<Rule>): RecordTypeDef {
  return { ...b, rules: (b.rules ?? []).map((r) => (r.key === key ? { ...clean({ ...r, ...patch }), expression: patch.expression ?? r.expression, message: patch.message ?? r.message } : r)) };
}

export function removeRule(b: RecordTypeDef, key: string): RecordTypeDef {
  const rules = (b.rules ?? []).filter((r) => r.key !== key);
  return clean({ ...b, rules: rules.length ? rules : undefined });
}

export function moveRule(b: RecordTypeDef, from: number, to: number): RecordTypeDef {
  const rules = [...(b.rules ?? [])];
  const [r] = rules.splice(from, 1);
  if (!r) return b;
  rules.splice(to, 0, r);
  return { ...b, rules };
}

// -------------------------------------------------------------- lookups

export type Lookup = NonNullable<RecordTypeDef['lookups']>[number];

export function addLookup(b: RecordTypeDef): { body: RecordTypeDef; key: string } {
  const taken = new Set((b.lookups ?? []).map((l) => l.key));
  let n = (b.lookups?.length ?? 0) + 1;
  while (taken.has(`lookup${n}`)) n++;
  const key = `lookup${n}`;
  return { body: { ...b, lookups: [...(b.lookups ?? []), { key, connector: '', inputs: [], map: {} }] }, key };
}

export function setLookup(b: RecordTypeDef, key: string, patch: Partial<Lookup>): RecordTypeDef {
  return { ...b, lookups: (b.lookups ?? []).map((l) => (l.key === key ? { ...l, ...patch } : l)) };
}

export function removeLookup(b: RecordTypeDef, key: string): RecordTypeDef {
  const lookups = (b.lookups ?? []).filter((l) => l.key !== key);
  return clean({ ...b, lookups: lookups.length ? lookups : undefined });
}

export function moveLookup(b: RecordTypeDef, from: number, to: number): RecordTypeDef {
  const lookups = [...(b.lookups ?? [])];
  const [l] = lookups.splice(from, 1);
  if (!l) return b;
  lookups.splice(to, 0, l);
  return { ...b, lookups };
}

/** Sends a field to the lookup, or stops sending it, keeping the type's field order. */
export function toggleLookupInput(b: RecordTypeDef, key: string, field: string, on: boolean): RecordTypeDef {
  const l = b.lookups?.find((x) => x.key === key);
  if (!l) return b;
  const chosen = new Set(l.inputs.filter((i) => i !== field));
  if (on) chosen.add(field);
  return setLookup(b, key, { inputs: [...b.fields.map((f) => f.key).filter((f) => chosen.has(f)), ...l.inputs.filter((i) => chosen.has(i) && !fieldOf(b, i))] });
}

/** Fills the next field that is neither sent nor filled yet from a value of the same name. */
export function addLookupValue(b: RecordTypeDef, key: string): RecordTypeDef {
  const l = b.lookups?.find((x) => x.key === key);
  const field = l && b.fields.find((f) => !(f.key in l.map) && !l.inputs.includes(f.key) && !derived(f));
  return l && field ? setLookup(b, key, { map: { ...l.map, [field.key]: field.key } }) : b;
}

/** Changes which field a lookup value fills and the name of the value in the connector's answer. */
export function setLookupValue(b: RecordTypeDef, key: string, field: string, next: { field: string; value: string }): RecordTypeDef {
  const l = b.lookups?.find((x) => x.key === key);
  if (!l || (next.field !== field && next.field in l.map)) return b;
  return setLookup(b, key, { map: Object.fromEntries(Object.entries(l.map).map(([f, v]) => (f === field ? [next.field, next.value] : [f, v]))) });
}

export function removeLookupValue(b: RecordTypeDef, key: string, field: string): RecordTypeDef {
  const l = b.lookups?.find((x) => x.key === key);
  return l ? setLookup(b, key, { map: Object.fromEntries(Object.entries(l.map).filter(([f]) => f !== field)) }) : b;
}
