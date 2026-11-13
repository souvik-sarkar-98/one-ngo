import { t } from '../i18n/i18n';
import type { FieldFilter, ListViewDef, RecordTypeBody, WorkflowBody } from '../models';
import { labelOf } from '../records/spec';
import type { RowView } from '../rows';
import { chipShows, createFields, isRelated, sectionId } from './ops/list-view';

type Type = Pick<RecordTypeBody, 'key' | 'fields'> & Partial<Pick<RecordTypeBody, 'label'>>;

/** A field or the number, status and dates, by label. */
export const fieldLabel = (type: Type, key: string): string => labelOf({ ...type, label: type.label ?? type.key, version: 0, canCreate: false, canUpdate: false }, key);
const labels = (type: Type, keys: readonly string[]) => keys.map((k) => fieldLabel(type, k)).join(', ');
const stateLabel = (w: Pick<WorkflowBody, 'states'> | undefined, key: string) => w?.states.find((s) => s.key === key)?.label ?? key;

const named = (type: Type | undefined, key: string, value: string | number | boolean): string => {
  const field = type?.fields.find((f) => f.key === key);
  if (typeof value === 'boolean') return t(value ? 'ui.common.yes' : 'ui.common.no');
  return field?.choices?.find((o) => o.value === String(value))?.label ?? String(value);
};

/** One field condition in words: "Donor type = Guest", "Amount 1000–…". */
function conditionText(type: Type | undefined, key: string, filter: FieldFilter): string {
  const name = type?.fields.find((f) => f.key === key)?.label ?? key;
  if (filter.in?.length) return `${name}: ${filter.in.map((v) => named(type, key, v)).join(', ')}`;
  if (filter.eq !== undefined && filter.eq !== null && filter.eq !== '') return `${name} = ${named(type, key, filter.eq)}`;
  const bound = (v: string | number | null | undefined) => (v === undefined || v === null || v === '' ? '' : String(v));
  const from = bound(filter.from);
  const to = bound(filter.to);
  if (from || to) return `${name} ${from || '…'}–${to || '…'}`;
  return name;
}

/** What a chip shows, in words: "Raised, Paid", "Created by me"… */
export function chipSummary(c: NonNullable<ListViewDef['chips']>[number], workflows: readonly Pick<WorkflowBody, 'key' | 'states'>[], type?: Type): string {
  switch (chipShows(c)) {
    case 'statuses':
      return (c.statusIn ?? []).map((s) => stateLabel(workflows[0], s)).join(', ') || '—';
    case 'workflowState': {
      const w = workflows.find((x) => x.key === c.workflowState!.workflow);
      return `${c.workflowState!.workflow}: ${c.workflowState!.in.map((s) => stateLabel(w, s)).join(', ') || '—'}`;
    }
    case 'mine':
      return t('ui.builder.schema.enum.me');
    case 'shared':
      return t('ui.builder.schema.prop.shared');
    case 'field':
      return Object.entries(c.filters ?? {}).map(([key, filter]) => conditionText(type, key, filter)).join(', ') || '—';
    default:
      return t('ui.records.all');
  }
}

export function chipRows(b: ListViewDef, workflows: readonly Pick<WorkflowBody, 'key' | 'states'>[], type?: Type): RowView[] {
  const first = b.chips?.[0]?.id;
  return (b.chips ?? []).map((c) => ({
    id: c.id,
    title: c.label || c.id,
    cells: [
      { key: 'title', label: t('ui.builder.label'), value: c.label || c.id },
      { key: 'shows', label: t('ui.builder.listView.shows'), value: chipSummary(c, workflows, type) },
      { key: 'only', label: t('ui.builder.listView.onlyFor'), value: c.permission ?? '—' },
      { key: 'default', label: t('ui.builder.schema.prop.defaultChip'), value: (b.defaultChip ?? first) === c.id ? '●' : '' },
    ],
    actions: [],
  }));
}

/** Sections of the record panel; related ones read "Donation · Donor · total Amount". */
export function sectionRows(b: ListViewDef, type: Type, others: readonly Type[]): RowView[] {
  return (b.detail?.sections ?? []).map((s, i) => {
    let shows: string;
    if (isRelated(s)) {
      const other = others.find((o) => o.key === s.related.recordType);
      const parts = [other?.label ?? s.related.recordType, s.related.field && other ? fieldLabel(other, s.related.field) : s.related.field];
      if (s.related.total) parts.push(`Σ ${other ? fieldLabel(other, s.related.total) : s.related.total}`);
      shows = parts.filter(Boolean).join(' · ') || '—';
    } else {
      shows = labels(type, s.fields) || '—';
    }
    return {
      id: sectionId(s, i),
      title: s.label || sectionId(s, i),
      badge: isRelated(s) ? { label: t('ui.builder.schema.prop.related'), tone: 'primary' as const } : undefined,
      cells: [
        { key: 'title', label: t('ui.builder.label'), value: s.label || sectionId(s, i) },
        { key: 'shows', label: t('ui.builder.listView.shows'), value: shows },
        { key: 'kind', label: t('ui.builder.kindLabel'), value: '' },
        { key: 'permission', label: t('ui.builder.listView.shownTo'), value: s.permission ?? '—' },
      ],
      actions: [],
    };
  });
}

/** "Steps: Donor (5) · Details (3)", or "One page · 6 fields"; `defaults` is how many fields the app offers without a form. */
export function createSummary(b: ListViewDef, defaults: number): string {
  if (b.create?.steps) return `${t('ui.builder.schema.prop.steps')}: ${b.create.steps.map((s) => `${s.label || s.key} (${s.fields.length})`).join(' · ')}`;
  return t('ui.builder.listView.onePageCount', { count: b.create?.fields ? createFields(b).length : defaults });
}
