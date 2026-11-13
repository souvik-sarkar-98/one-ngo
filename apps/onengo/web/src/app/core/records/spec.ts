import { listColumns } from '../fields/fields';
import { t } from '../i18n/i18n';
import type { FieldDef, FieldFilter, FormLayout, ListLayout, ListViewDef, RelatedSectionDef, RuntimeAction, RuntimeRecordType, RuntimeWorkflow } from '../models';

export type FilterKind = 'list' | 'flag' | 'range' | 'dateRange' | 'text';

export interface FilterSpec {
  field: FieldDef;
  kind: FilterKind;
}

export interface ChipSpec {
  id: string;
  label: string;
  statusIn?: string[];
  owner?: 'me';
  sharedWithMe?: true;
  /** Field condition fixed on the chip. The list query always includes it. */
  filters?: Record<string, FieldFilter>;
}

export interface CreateStepSpec {
  key: string;
  label: string;
  fields: string[];
}

/** A detail section listing the records of another type that point at the open record. */
export interface RelatedSpec {
  id: string;
  label: string;
  recordType: string;
  field: string;
  total?: string;
}

/** Everything a list needs to know about a record type, resolved once from its published definitions. */
export interface ListSpec {
  type: RuntimeRecordType;
  /** The primary workflow, which holds the record's status. */
  workflow?: RuntimeWorkflow;
  /** Every workflow of the record type, primary first. */
  workflows: RuntimeWorkflow[];
  /** Configured record actions. */
  actions: RuntimeAction[];
  title: string;
  pageSize: number;
  layout: ListLayout;
  chips: ChipSpec[];
  defaultChip: string;
  filters: FilterSpec[];
  columns: string[];
  /** Table columns between the phone and desktop sizes. */
  compactColumns: string[];
  sortable: string[];
  row: { title?: string; subtitle: string[]; meta?: string; badge?: string };
  sections: { id: string; label: string; fields: string[] }[];
  related: RelatedSpec[];
  createKeys: string[];
  createSteps: CreateStepSpec[];
  presets: { param: string; field: string }[];
  createChips?: string[];
  /** Columns and full-width fields of the create form (and its steps). */
  createLayout: FormLayout;
  editKeys: string[];
  editChips?: string[];
  /** Columns and full-width fields of the edit form. */
  editLayout: FormLayout;
  searchPlaceholder: string;
  filterSheetTitle: string;
  emptyMessage: string;
  /**
   * Whether the person holds `record:<type>:import`. `false` makes the address ignore `?import=`,
   * as `?create=` is ignored without `canCreate`. Left out, the address is not limited.
   */
  canImport?: boolean;
}

export const PSEUDO_FIELDS = ['number', 'status', 'createdAt', 'updatedAt'] as const;
const PSEUDO_LABELS: Record<string, string> = { number: 'ui.records.number', status: 'ui.records.status', createdAt: 'ui.records.created', updatedAt: 'ui.records.lastChanged' };
const ALL = 'all';
export const MAX_ROWS = 500;

export function labelOf(type: RuntimeRecordType, key: string): string {
  const pseudo = PSEUDO_LABELS[key];
  return pseudo ? t(pseudo) : type.fields.find((f) => f.key === key)?.label ?? key;
}

function filterKind(field: FieldDef): FilterKind {
  if (field.type === 'choice' || field.type === 'multiChoice' || field.type === 'person') return 'list';
  if (field.type === 'boolean') return 'flag';
  if (field.type === 'date') return 'dateRange';
  if (field.type === 'number' || field.type === 'money') return 'range';
  return 'text';
}

export function filterSpecs(type: RuntimeRecordType, keys: string[]): FilterSpec[] {
  return keys
    .map((k) => type.fields.find((f) => f.key === k))
    .filter((f): f is FieldDef => !!f && !f.sensitive)
    .map((f) => (f.type === 'person' ? { ...f, choices: [{ value: 'me', label: t('ui.records.assignedToMe') }] } : f))
    .map((field) => ({ field, kind: filterKind(field) }));
}

const isRelated = (s: object): s is RelatedSectionDef => 'related' in s;

/** The primary workflow first, then the others in the order given. */
function orderWorkflows(primary: RuntimeWorkflow | undefined, all: RuntimeWorkflow[]): RuntimeWorkflow[] {
  const others = all.filter((w) => w.key !== primary?.key);
  return primary ? [primary, ...others] : others;
}

const SHARED_CHIP = 'shared';

/** Restricted record types get a "Shared with me" chip unless their list view already has one. */
export function withSharedChip(type: Pick<RuntimeRecordType, 'visibility'>, chips: ChipSpec[]): ChipSpec[] {
  if (type.visibility !== 'restricted' || chips.some((c) => c.sharedWithMe || c.id === SHARED_CHIP)) return chips;
  return [...chips, { id: SHARED_CHIP, label: t('ui.records.sharedWithMe'), sharedWithMe: true }];
}

/** Fills in a sensible list for record types that have no published list view. */
export function resolveListSpec(
  type: RuntimeRecordType,
  workflow?: RuntimeWorkflow,
  view?: ListViewDef,
  more: { workflows?: RuntimeWorkflow[]; actions?: RuntimeAction[]; startingLayout?: ListLayout; canImport?: boolean } = {},
): ListSpec {
  const chips: ChipSpec[] = withSharedChip(
    type,
    view?.chips?.length
      ? view.chips.map((c) => ({
          id: c.id,
          label: c.label,
          statusIn: c.statusIn,
          owner: c.owner,
          ...(c.shared ? { sharedWithMe: true as const } : {}),
          ...(c.filters && Object.keys(c.filters).length ? { filters: c.filters } : {}),
        }))
      : [{ id: ALL, label: t('ui.records.all') }, ...(workflow?.states ?? []).map((s) => ({ id: s.key, label: s.label, statusIn: [s.key] }))],
  );
  const titleKey = type.titleField ?? type.fields.find((f) => f.required && f.type === 'text')?.key;
  const row = view?.row
    ? { ...view.row, subtitle: view.row.subtitle ?? [] }
    : {
        title: titleKey,
        subtitle: listColumns(type)
          .filter((f) => f.key !== titleKey)
          .slice(0, 2)
          .map((f) => f.key),
        meta: type.numbering ? 'number' : undefined,
        badge: workflow ? 'status' : undefined,
      };
  const sensitive = new Set(type.fields.filter((f) => f.sensitive).map((f) => f.key));
  const columns = [
    ...new Set(
      view?.columns?.length
        ? view.columns
        : [...(type.numbering ? ['number'] : []), ...(row.title ? [row.title] : []), ...row.subtitle, ...(workflow ? ['status'] : [])],
    ),
  ].filter((k) => !sensitive.has(k));
  const compactColumns = [
    ...new Set(
      view?.compactColumns?.length
        ? view.compactColumns
        : [...(row.title ? [row.title] : []), ...row.subtitle.slice(0, 1), ...(workflow ? ['status'] : [])],
    ),
  ].filter((k) => !sensitive.has(k));
  const isField = (k: string) => (PSEUDO_FIELDS as readonly string[]).includes(k) || type.fields.some((f) => f.key === k);
  const editable = type.fields.filter((f) => !f.calculated && !f.rollup).map((f) => f.key);
  const plural = type.pluralLabel ?? type.label;
  const title = view?.label ?? plural;
  const viewSections = view?.detail?.sections;
  return {
    type,
    workflow,
    workflows: orderWorkflows(workflow, more.workflows ?? []),
    actions: more.actions ?? [],
    title,
    pageSize: view?.pageSize ?? 20,
    layout: view?.layout === 'cards' || view?.layout === 'table' ? view.layout : more.startingLayout === 'cards' ? 'cards' : 'table',
    chips,
    defaultChip: view?.defaultChip && chips.some((c) => c.id === view.defaultChip) ? view.defaultChip : chips[0]!.id,
    filters: filterSpecs(
      type,
      view?.filters ??
        type.fields
          .filter((f) => !f.sensitive && ['choice', 'boolean', 'date'].includes(f.type))
          .slice(0, 5)
          .map((f) => f.key),
    ),
    columns,
    compactColumns,
    sortable: [...new Set([...columns, ...(view?.compactColumns?.length ? compactColumns : [])])].filter(isField),
    row,
    sections: (
      viewSections ?? [
        { id: 'details', label: type.label, fields: [...(type.numbering ? ['number'] : []), ...(workflow ? ['status'] : []), ...type.fields.map((f) => f.key)] },
      ]
    ).flatMap((s, i) => (isRelated(s) ? [] : [{ id: s.id ?? `section${i}`, label: s.label, fields: s.fields }])),
    related: (viewSections ?? []).flatMap((s, i) =>
      isRelated(s) ? [{ id: s.id ?? `section${i}`, label: s.label, recordType: s.related.recordType, field: s.related.field, total: s.related.total }] : [],
    ),
    createKeys: view?.create?.fields ?? view?.create?.steps?.flatMap((s) => s.fields) ?? editable,
    createSteps: view?.create?.steps ?? [],
    presets: view?.create?.presets ?? [],
    createChips: view?.create?.chips,
    editKeys: view?.edit?.fields ?? editable,
    editChips: view?.edit?.chips,
    createLayout: { columns: view?.create?.columns ?? 1, fullWidth: view?.create?.fullWidth ?? [] },
    editLayout: { columns: view?.edit?.columns ?? 1, fullWidth: view?.edit?.fullWidth ?? [] },
    searchPlaceholder: t('ui.records.searchPlaceholder', { items: plural.toLowerCase() }),
    filterSheetTitle: t('ui.records.filterTitle', { items: plural.toLowerCase() }),
    emptyMessage: t('ui.records.empty'),
    ...(more.canImport !== undefined && { canImport: more.canImport }),
  };
}

/** Whether new records may be created while this chip is active. */
export function canCreateOn(spec: ListSpec, chip: string): boolean {
  return spec.type.canCreate && (!spec.createChips || spec.createChips.includes(chip));
}
