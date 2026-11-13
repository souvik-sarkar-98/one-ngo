import { toKey } from '../../fields/fields';
import type { FieldDef, FieldFilter, FormColumns, ListLayout, ListViewDef, ListViewSection, RecordTypeBody, RelatedSectionDef } from '../../models';
import { moveItem } from '../../ui-logic/reorder';
import { stateKey, uniqueKey } from './workflow';

export type ChipDef = NonNullable<ListViewDef['chips']>[number];
export type CreateStepDef = NonNullable<NonNullable<ListViewDef['create']>['steps']>[number];
/** What a chip shows: every record, some statuses, states of another workflow, the person's own, those shared with them, or records matching field values. */
export type ChipShows = 'all' | 'statuses' | 'workflowState' | 'mine' | 'shared' | 'field';
export type FieldList = 'filters' | 'columns' | 'compactColumns';

/** Same as the server's list view checks. */
export const FILTERABLE_TYPES: ReadonlySet<string> = new Set(['choice', 'boolean', 'date', 'number', 'money', 'reference', 'text', 'email', 'phone', 'person']);
export const LIST_LIMITS = { chips: 8, columns: 12, compactColumns: 6 } as const;
/** Shown and sorted like fields, though every record has them. */
export const PSEUDO_KEYS = ['number', 'status', 'createdAt', 'updatedAt'] as const;

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const nonEmpty = <T>(list: T[] | undefined): T[] | undefined => (list && list.length ? list : undefined);
const without = <T extends object>(o: T, key: keyof T): T => {
  const { [key]: _gone, ...rest } = o;
  return rest as T;
};
const isComputed = (f: FieldDef) => !!f.calculated || !!f.rollup;
export const isRelated = (s: ListViewSection): s is RelatedSectionDef => 'related' in s;

// ---------------------------------------------------------------- field choices

/** Fields people may filter on: filterable types only, never sensitive. */
export function filterableFields(type: Pick<RecordTypeBody, 'fields'>): FieldDef[] {
  return type.fields.filter((f) => !f.sensitive && FILTERABLE_TYPES.has(f.type));
}

/** Fields shown as columns or on cards; sensitive fields are never columns. */
export function columnFields(type: Pick<RecordTypeBody, 'fields'>): FieldDef[] {
  return type.fields.filter((f) => !f.sensitive);
}

/** Fields a create or edit form can hold: not calculated and not rolled up. */
export function enterableFields(type: Pick<RecordTypeBody, 'fields'>): FieldDef[] {
  return type.fields.filter((f) => !isComputed(f));
}

/** Reference fields of other record types that point at `recordType`, for related sections. */
export function relatedChoices(types: readonly RecordTypeBody[], recordType: string): { recordType: string; label: string; field: string; fieldLabel: string }[] {
  return types.flatMap((t) =>
    t.fields.filter((f) => f.type === 'reference' && f.referenceType === recordType).map((f) => ({ recordType: t.key, label: t.label, field: f.key, fieldLabel: f.label })),
  );
}

/** Number and money fields a related section can add up. */
export function totalFields(type: Pick<RecordTypeBody, 'fields'> | undefined): FieldDef[] {
  return (type?.fields ?? []).filter((f) => f.type === 'number' || f.type === 'money');
}

// ---------------------------------------------------------------- general and lists of fields

export function setLabel(b: ListViewDef, label: string): ListViewDef {
  return label.trim() ? { ...b, label } : without(b, 'label');
}

export function setLayout(b: ListViewDef, layout: ListLayout | undefined): ListViewDef {
  return layout ? { ...b, layout } : without(b, 'layout');
}

/** Rows loaded at a time, between 5 and 100; empty uses the default. */
export function setPageSize(b: ListViewDef, size: number | null): ListViewDef {
  if (size === null || !Number.isFinite(size)) return without(b, 'pageSize');
  return { ...b, pageSize: Math.min(100, Math.max(5, Math.round(size))) };
}

/** Sets the filters, table columns or tablet columns; duplicates are dropped, the list's limit holds, and empty removes it. */
export function setFieldList(b: ListViewDef, list: FieldList, keys: readonly string[]): ListViewDef {
  const max = list === 'filters' ? Infinity : LIST_LIMITS[list];
  const next = [...new Set(keys)].slice(0, max);
  return next.length ? { ...b, [list]: next } : without(b, list);
}

export function addToList(b: ListViewDef, list: FieldList, key: string): ListViewDef {
  return setFieldList(b, list, [...(b[list] ?? []), key]);
}

export function removeFromList(b: ListViewDef, list: FieldList, key: string): ListViewDef {
  return setFieldList(b, list, (b[list] ?? []).filter((k) => k !== key));
}

export function moveInList(b: ListViewDef, list: FieldList, from: number, to: number): ListViewDef {
  return setFieldList(b, list, moveItem(b[list] ?? [], from, to));
}

/** The card's title, subtitle fields, meta and badge; empty parts are left out. */
export function setRow(b: ListViewDef, patch: Partial<NonNullable<ListViewDef['row']>>): ListViewDef {
  const row = clean({ ...b.row, ...patch, subtitle: nonEmpty(patch.subtitle ?? b.row?.subtitle) });
  for (const k of ['title', 'meta', 'badge'] as const) if (!row[k]) delete row[k];
  return Object.keys(row).length ? { ...b, row } : without(b, 'row');
}

// ---------------------------------------------------------------- chips

const chipsOf = (b: ListViewDef) => b.chips ?? [];

export function chipShows(c: ChipDef): ChipShows {
  if (c.shared) return 'shared';
  if (c.owner === 'me') return 'mine';
  if (c.workflowState) return 'workflowState';
  if (c.statusIn?.length) return 'statuses';
  if (c.filters) return 'field';
  return 'all';
}

function withChips(b: ListViewDef, chips: ChipDef[]): ListViewDef {
  const ids = new Set(chips.map((c) => c.id));
  const keep = (list: string[] | undefined) => nonEmpty(list?.filter((id) => ids.has(id)));
  let next: ListViewDef = chips.length ? { ...b, chips } : without(b, 'chips');
  if (next.defaultChip && !ids.has(next.defaultChip)) next = without(next, 'defaultChip');
  if (next.create) next = setCreate(next, { chips: keep(next.create.chips) });
  if (next.edit) next = setEdit(next, { chips: keep(next.edit.chips) });
  return next;
}

/** A chip id from its label, unique in the list view. */
export function chipId(label: string, taken: Iterable<string>): string {
  return uniqueKey(stateKey(label).slice(0, 31) || 'chip', taken);
}

export function addChip(b: ListViewDef, label = ''): ListViewDef {
  if (chipsOf(b).length >= LIST_LIMITS.chips) return b;
  return withChips(b, [...chipsOf(b), { id: chipId(label, chipsOf(b).map((c) => c.id)), label }]);
}

/** Sets the label; the id follows it while the chip is not published (ids are kept in shared addresses) and no other part names it. */
export function setChipLabel(b: ListViewDef, index: number, label: string, fixed: readonly string[] = []): ListViewDef {
  const c = chipsOf(b)[index];
  if (!c) return b;
  const named = b.defaultChip === c.id || !!b.create?.chips?.includes(c.id) || !!b.edit?.chips?.includes(c.id);
  const follow = !fixed.includes(c.id) && !named && (c.id === stateKey(c.label) || /^chip\d*$/.test(c.id));
  const id = follow ? chipId(label, chipsOf(b).filter((_, i) => i !== index).map((x) => x.id)) : c.id;
  return withChips(b, chipsOf(b).map((x, i) => (i === index ? { ...x, id, label } : x)));
}

/** Switches what the chip shows, clearing the other choices; statuses, states and field values are chosen next. */
export function setChipShows(b: ListViewDef, index: number, shows: ChipShows, workflow?: string): ListViewDef {
  const c = chipsOf(b)[index];
  if (!c) return b;
  const base = clean({ id: c.id, label: c.label, permission: c.permission }) as ChipDef;
  const next: ChipDef =
    shows === 'statuses'
      ? { ...base, statusIn: c.statusIn ?? [] }
      : shows === 'workflowState'
        ? { ...base, workflowState: c.workflowState ?? { workflow: workflow ?? '', in: [] } }
        : shows === 'mine'
          ? { ...base, owner: 'me' }
          : shows === 'shared'
            ? { ...base, shared: true }
            : shows === 'field'
              ? { ...base, filters: c.filters ?? {} }
              : base;
  return withChips(b, chipsOf(b).map((x, i) => (i === index ? next : x)));
}

const replaceChip = (b: ListViewDef, index: number, chip: ChipDef): ListViewDef =>
  chipsOf(b)[index] ? withChips(b, chipsOf(b).map((x, i) => (i === index ? chip : x))) : b;

/** How a field condition is entered: a choice, yes or no, a range, or one exact value. */
export function conditionKind(f: Pick<FieldDef, 'type' | 'choices'>): 'choice' | 'boolean' | 'range' | 'value' {
  if (f.type === 'boolean') return 'boolean';
  if (f.type === 'choice' && f.choices?.length) return 'choice';
  if (f.type === 'number' || f.type === 'money' || f.type === 'date') return 'range';
  return 'value';
}

/** The choice or exact values a chip condition already names. */
export function chipValues(filter: FieldFilter | undefined): string[] {
  if (filter?.in?.length) return filter.in.map(String);
  if (filter?.eq !== undefined && filter.eq !== null && filter.eq !== '') return [String(filter.eq)];
  return [];
}

function writeFilter(b: ListViewDef, index: number, field: string, filter: FieldFilter): ListViewDef {
  const c = chipsOf(b)[index];
  if (!c || !field) return b;
  return replaceChip(b, index, { ...c, filters: { ...(c.filters ?? {}), [field]: clean(filter) } });
}

/** Adds a field condition. The chip stays on "field" even before a value is chosen. */
export function addChipCondition(b: ListViewDef, index: number, field: string): ListViewDef {
  const c = chipsOf(b)[index];
  if (!c || !field || c.filters?.[field]) return b;
  return replaceChip(b, index, { ...c, filters: { ...(c.filters ?? {}), [field]: {} } });
}

/** Drops one field condition and leaves the chip showing by field. */
export function removeChipCondition(b: ListViewDef, index: number, field: string): ListViewDef {
  const c = chipsOf(b)[index];
  if (!c?.filters || !Object.hasOwn(c.filters, field)) return b;
  const filters = { ...c.filters };
  delete filters[field];
  return replaceChip(b, index, { ...c, filters });
}

/** Sets the exact value. An empty value clears it. */
export function setChipEquals(b: ListViewDef, index: number, field: string, value: string | number | boolean | null): ListViewDef {
  const current = { ...(chipsOf(b)[index]?.filters?.[field] ?? {}) };
  delete current.in;
  if (value === null || value === '') delete current.eq;
  else current.eq = value;
  return writeFilter(b, index, field, current);
}

/** Ticks or unticks one choice. A single remaining value is stored as `eq`. */
export function toggleChipValue(b: ListViewDef, index: number, field: string, value: string, on: boolean): ListViewDef {
  const selected = chipValues(chipsOf(b)[index]?.filters?.[field]).filter((v) => v !== value);
  const next = on ? [...selected, value] : selected;
  const filter: FieldFilter = next.length === 1 ? { eq: next[0] } : next.length ? { in: next } : {};
  return writeFilter(b, index, field, filter);
}

/** Sets the lower or upper bound of a number, money or date condition. An empty bound clears it. */
export function setChipBound(b: ListViewDef, index: number, field: string, side: 'from' | 'to', value: string | number | null): ListViewDef {
  const current = { ...(chipsOf(b)[index]?.filters?.[field] ?? {}) };
  if (value === null || value === '') delete current[side];
  else current[side] = value;
  return writeFilter(b, index, field, current);
}

export function toggleChipStatus(b: ListViewDef, index: number, status: string, on: boolean): ListViewDef {
  const c = chipsOf(b)[index];
  if (!c) return b;
  const rest = (c.statusIn ?? []).filter((s) => s !== status);
  return withChips(b, chipsOf(b).map((x, i) => (i === index ? { ...x, statusIn: on ? [...rest, status] : rest } : x)));
}

export function setChipWorkflow(b: ListViewDef, index: number, workflow: string): ListViewDef {
  const c = chipsOf(b)[index];
  if (!c?.workflowState || c.workflowState.workflow === workflow) return b;
  return withChips(b, chipsOf(b).map((x, i) => (i === index ? { ...x, workflowState: { workflow, in: [] } } : x)));
}

export function toggleChipState(b: ListViewDef, index: number, state: string, on: boolean): ListViewDef {
  const c = chipsOf(b)[index];
  if (!c?.workflowState) return b;
  const rest = c.workflowState.in.filter((s) => s !== state);
  return withChips(b, chipsOf(b).map((x, i) => (i === index ? { ...x, workflowState: { ...c.workflowState!, in: on ? [...rest, state] : rest } } : x)));
}

export function setChipPermission(b: ListViewDef, index: number, permission: string): ListViewDef {
  const c = chipsOf(b)[index];
  if (!c) return b;
  const p = permission.trim();
  return withChips(b, chipsOf(b).map((x, i) => (i === index ? (p ? { ...x, permission: p } : without(x, 'permission')) : x)));
}

export function setDefaultChip(b: ListViewDef, id: string | null): ListViewDef {
  return id && chipsOf(b).some((c) => c.id === id) ? { ...b, defaultChip: id } : without(b, 'defaultChip');
}

export function removeChip(b: ListViewDef, index: number): ListViewDef {
  return withChips(b, chipsOf(b).filter((_, i) => i !== index));
}

export function moveChip(b: ListViewDef, from: number, to: number): ListViewDef {
  return withChips(b, moveItem(chipsOf(b), from, to));
}

// ---------------------------------------------------------------- record panel sections

const sectionsOf = (b: ListViewDef) => b.detail?.sections ?? [];
const withSections = (b: ListViewDef, sections: ListViewSection[]): ListViewDef => (sections.length ? { ...b, detail: { sections } } : without(b, 'detail'));

/** The id a section is known by in the address; sections without one go by their place. */
export const sectionId = (s: ListViewSection, index: number): string => s.id ?? `section${index}`;

export function addSection(b: ListViewDef, kind: 'fields' | 'related', label = ''): ListViewDef {
  const id = uniqueKey(toKey(label) || 'section', sectionsOf(b).map(sectionId));
  const section: ListViewSection = kind === 'fields' ? { id, label, fields: [] } : { id, label, related: { recordType: '', field: '' } };
  return withSections(b, [...sectionsOf(b), section]);
}

/** Switches a section between fields of the record and related records, keeping its id, heading and permission. */
export function setSectionKind(b: ListViewDef, index: number, kind: 'fields' | 'related'): ListViewDef {
  const s = sectionsOf(b)[index];
  if (!s || isRelated(s) === (kind === 'related')) return b;
  const base = clean({ id: s.id, label: s.label, permission: s.permission });
  const next: ListViewSection = kind === 'fields' ? { ...base, fields: [] } : { ...base, related: { recordType: '', field: '' } };
  return withSections(b, sectionsOf(b).map((x, i) => (i === index ? next : x)));
}

export function setSectionLabel(b: ListViewDef, index: number, label: string): ListViewDef {
  return withSections(b, sectionsOf(b).map((x, i) => (i === index ? { ...x, label } : x)));
}

/** "Shown to people with": empty shows the section to everyone who can see the record. */
export function setSectionPermission(b: ListViewDef, index: number, permission: string): ListViewDef {
  const p = permission.trim();
  return withSections(b, sectionsOf(b).map((x, i) => (i === index ? (p ? { ...x, permission: p } : without(x, 'permission')) : x)));
}

export function setSectionFields(b: ListViewDef, index: number, fields: readonly string[]): ListViewDef {
  return withSections(b, sectionsOf(b).map((x, i) => (i === index && !isRelated(x) ? { ...x, fields: [...new Set(fields)] } : x)));
}

export function moveSectionField(b: ListViewDef, index: number, from: number, to: number): ListViewDef {
  const s = sectionsOf(b)[index];
  return s && !isRelated(s) ? setSectionFields(b, index, moveItem(s.fields, from, to)) : b;
}

/** The related record type and its reference field; changing the record type clears the field and the total. */
export function setRelated(b: ListViewDef, index: number, patch: Partial<RelatedSectionDef['related']>): ListViewDef {
  const s = sectionsOf(b)[index];
  if (!s || !isRelated(s)) return b;
  const typeChanged = patch.recordType !== undefined && patch.recordType !== s.related.recordType;
  const related = clean({ ...s.related, ...(typeChanged ? { field: '', total: undefined } : {}), ...patch });
  if (!related.total) delete related.total;
  return withSections(b, sectionsOf(b).map((x, i) => (i === index ? { ...s, related } : x)));
}

export function removeSection(b: ListViewDef, index: number): ListViewDef {
  return withSections(b, sectionsOf(b).filter((_, i) => i !== index));
}

export function moveSection(b: ListViewDef, from: number, to: number): ListViewDef {
  return withSections(b, moveItem(sectionsOf(b), from, to));
}

// ---------------------------------------------------------------- create and edit

export type CreateMode = 'page' | 'steps';

/** Keeps only the full-width fields still on the form; with no list of fields every field is allowed. */
function keepFullWidth(fullWidth: readonly string[] | undefined, onForm: Set<string> | undefined): string[] | undefined {
  const kept = fullWidth?.filter((k) => !onForm || onForm.has(k));
  return kept?.length ? kept : undefined;
}

function setCreate(b: ListViewDef, patch: Partial<NonNullable<ListViewDef['create']>>): ListViewDef {
  const create = clean({ ...b.create, ...patch });
  for (const k of ['presets', 'chips'] as const) if (!create[k]?.length) delete create[k];
  if (create.columns === 1) delete create.columns;
  const onForm = create.fields || create.steps ? new Set(createFields({ ...b, create })) : undefined;
  const fullWidth = keepFullWidth(create.fullWidth, onForm);
  if (fullWidth) create.fullWidth = fullWidth;
  else delete create.fullWidth;
  return Object.keys(create).length ? { ...b, create } : without(b, 'create');
}

function setEdit(b: ListViewDef, patch: Partial<NonNullable<ListViewDef['edit']>>): ListViewDef {
  const edit = clean({ ...b.edit, ...patch });
  if (!edit.chips?.length) delete edit.chips;
  if (edit.columns === 1) delete edit.columns;
  const fullWidth = keepFullWidth(edit.fullWidth, edit.fields ? new Set(edit.fields) : undefined);
  if (fullWidth) edit.fullWidth = fullWidth;
  else delete edit.fullWidth;
  return Object.keys(edit).length ? { ...b, edit } : without(b, 'edit');
}

/** Columns on wide screens for the create form (and its steps): 1, 2 or 3. */
export function setCreateColumns(b: ListViewDef, columns: FormColumns): ListViewDef {
  return setCreate(b, { columns });
}

/** The create fields that take a whole row; a field must be on the form to be listed. */
export function setCreateFullWidth(b: ListViewDef, fields: readonly string[]): ListViewDef {
  return setCreate(b, { fullWidth: [...new Set(fields)] });
}

/** Columns on wide screens for the edit form: 1, 2 or 3. */
export function setEditColumns(b: ListViewDef, columns: FormColumns): ListViewDef {
  return setEdit(b, { columns });
}

/** The edit fields that take a whole row. */
export function setEditFullWidth(b: ListViewDef, fields: readonly string[]): ListViewDef {
  return setEdit(b, { fullWidth: [...new Set(fields)] });
}

export const createMode = (b: ListViewDef): CreateMode => (b.create?.steps ? 'steps' : 'page');

/** The fields on the create form in order, from either form. */
export const createFields = (b: ListViewDef): string[] => b.create?.fields ?? b.create?.steps?.flatMap((s) => s.fields) ?? [];

/**
 * One page keeps every step's fields in order; steps start as one step
 * holding the page's fields. A form not chosen yet starts from `fallback`,
 * the fields the app offers without one.
 */
export function setCreateMode(b: ListViewDef, mode: CreateMode, firstStepLabel = '', fallback: readonly string[] = []): ListViewDef {
  if (createMode(b) === mode && (mode === 'steps' || b.create?.fields)) return b;
  const fields = b.create?.fields || b.create?.steps ? createFields(b) : [...fallback];
  if (mode === 'page') return setCreate(b, { steps: undefined, fields: fields.length ? fields : undefined });
  const key = stepKey(firstStepLabel, []);
  return setCreate(b, { fields: undefined, steps: [{ key, label: firstStepLabel, fields }] });
}

export function setCreatePageFields(b: ListViewDef, fields: readonly string[]): ListViewDef {
  return setCreate(b, { steps: undefined, fields: fields.length ? [...new Set(fields)] : undefined });
}

/** A step key from its label, as the schema allows: a letter first, then letters, digits and underscores. */
export function stepKey(label: string, taken: Iterable<string>): string {
  return uniqueKey(toKey(label).replace(/[^a-zA-Z0-9_]/g, '').replace(/^[^a-z]+/, '').slice(0, 40) || 'step', taken);
}

const stepsOf = (b: ListViewDef) => b.create?.steps ?? [];

export function addCreateStep(b: ListViewDef, label = ''): ListViewDef {
  return setCreate(b, { fields: undefined, steps: [...stepsOf(b), { key: stepKey(label, stepsOf(b).map((s) => s.key)), label, fields: [] }] });
}

/** Sets the label; the key follows it while it was made from the old label. */
export function setCreateStepLabel(b: ListViewDef, index: number, label: string): ListViewDef {
  const s = stepsOf(b)[index];
  if (!s) return b;
  const others = stepsOf(b).filter((_, i) => i !== index).map((x) => x.key);
  const follow = s.key === stepKey(s.label, others) || /^step\d*$/.test(s.key);
  const key = follow ? stepKey(label, others) : s.key;
  return setCreate(b, { steps: stepsOf(b).map((x, i) => (i === index ? { ...x, key, label } : x)) });
}

/** Removes a step; its fields go to the step before it (or after it), so none are lost. The last step turns back into one page. */
export function removeCreateStep(b: ListViewDef, index: number): ListViewDef {
  const steps = stepsOf(b);
  const gone = steps[index];
  if (!gone) return b;
  if (steps.length === 1) return setCreatePageFields(b, gone.fields);
  const into = index > 0 ? index - 1 : 1;
  const next = steps.map((s, i) => (i === into ? { ...s, fields: [...new Set([...s.fields, ...gone.fields])] } : s)).filter((_, i) => i !== index);
  return setCreate(b, { steps: next });
}

export function moveCreateStep(b: ListViewDef, from: number, to: number): ListViewDef {
  return setCreate(b, { steps: moveItem(stepsOf(b), from, to) });
}

/**
 * Puts a field on step `to` at `position` (the end when left out), taking it
 * off whichever step held it: dragging a field between steps, or adding one.
 */
export function placeCreateField(b: ListViewDef, field: string, to: number, position?: number): ListViewDef {
  const steps = stepsOf(b);
  if (!steps[to]) return b;
  const next = steps.map((s) => ({ ...s, fields: s.fields.filter((f) => f !== field) }));
  const target = next[to]!.fields;
  target.splice(Math.min(position ?? target.length, target.length), 0, field);
  return setCreate(b, { steps: next });
}

/** Sets one step's fields in order; a field can be on one step only, so the others lose it. */
export function setCreateStepFields(b: ListViewDef, index: number, fields: readonly string[]): ListViewDef {
  if (!stepsOf(b)[index]) return b;
  const on = [...new Set(fields)];
  return setCreate(b, { steps: stepsOf(b).map((s, i) => (i === index ? { ...s, fields: on } : { ...s, fields: s.fields.filter((f) => !on.includes(f)) })) });
}

export function removeCreateField(b: ListViewDef, field: string): ListViewDef {
  if (b.create?.fields) return setCreatePageFields(b, b.create.fields.filter((f) => f !== field));
  return setCreate(b, { steps: stepsOf(b).map((s) => ({ ...s, fields: s.fields.filter((f) => f !== field) })) });
}

/** Required fields that are on no create step or page, so a new record could never be saved; fields filled from a reference count once the reference is on. */
export function missingRequired(b: ListViewDef, type: Pick<RecordTypeBody, 'fields'>): FieldDef[] {
  if (!b.create) return [];
  const on = new Set(createFields(b));
  return type.fields.filter((f) => f.required && !isComputed(f) && !on.has(f.key) && !(f.copyFrom && on.has(f.copyFrom.reference)));
}

/** Create is offered only on these chips; none offers it on every chip. */
export function setCreateChips(b: ListViewDef, chips: readonly string[]): ListViewDef {
  return setCreate(b, { chips: [...chips] });
}

export function addPreset(b: ListViewDef, param: string, field: string): ListViewDef {
  const presets = (b.create?.presets ?? []).filter((p) => p.param !== param);
  return param.trim() && field ? setCreate(b, { presets: [...presets, { param: param.trim(), field }] }) : b;
}

export function removePreset(b: ListViewDef, index: number): ListViewDef {
  return setCreate(b, { presets: (b.create?.presets ?? []).filter((_, i) => i !== index) });
}

export function setEditFields(b: ListViewDef, fields: readonly string[]): ListViewDef {
  return setEdit(b, { fields: fields.length ? [...new Set(fields)] : undefined });
}

export function setEditChips(b: ListViewDef, chips: readonly string[]): ListViewDef {
  return setEdit(b, { chips: [...chips] });
}

// ---------------------------------------------------------------- index warnings

export interface IndexNotice {
  field: string;
  kind: 'pending' | 'notIndexed';
}

/** The draft's filters and columns that the server reports as still being indexed, or over the index cap. */
export function indexNotices(b: ListViewDef, warnings: { pending: readonly string[]; notIndexed: readonly string[] }): IndexNotice[] {
  const used = [...new Set([...(b.filters ?? []), ...(b.columns ?? []), ...(b.compactColumns ?? [])])];
  return used.flatMap((field): IndexNotice[] =>
    warnings.notIndexed.includes(field) ? [{ field, kind: 'notIndexed' }] : warnings.pending.includes(field) ? [{ field, kind: 'pending' }] : [],
  );
}
