import { displayValue } from '../../fields/fields';
import { asSignature, fileIds, isSigned, signedLine } from '../../fields/files';
import { formatMoney, t } from '../../i18n/i18n';
import { accuracyText, asLocation, coordinates, isLowAccuracy, mapsUrl } from '../../fields/location';
import type { FieldDef, PendingApproval, Receipt, RecordView, RuntimeRecordType, RuntimeWorkflow } from '../../models';
import { cleanRichText } from '../../fields/rich-text';
import type { Tone } from '../../rows';
import { conditionHolds, type Viewer } from './forms';
import { labelOf, type FilterSpec, type ListSpec } from '../spec';
import type { Criteria } from '../list/url';

export type { Tone } from '../../rows';

export interface RowModel {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  badge?: { label: string; tone: Tone };
  cells: { key: string; label: string; value: string }[];
  record: RecordView;
}

/** How a detail value is drawn when plain text is not enough. `value` stays the plain text for everything else. */
export type FieldDisplay =
  | { kind: 'pills'; items: string[] }
  | { kind: 'files'; ids: string[] }
  | { kind: 'location'; label?: string; coordinates: string; accuracy?: string; low: boolean; maps: string }
  | { kind: 'signature'; file: string; line: string }
  /** Already cleaned with the shared allow-list; the screen checks it again before showing it. */
  | { kind: 'richText'; html: string };

export interface DetailField {
  label: string;
  value: string;
  display?: FieldDisplay;
}

export type DetailSection =
  | { kind: 'fields'; id: string; title: string; fields: DetailField[] }
  | {
      kind: 'items';
      id: string;
      title: string;
      /** Items can be chosen, e.g. a receipt opens its print view. */
      selectable?: boolean;
      /** Shown in place of the empty message, e.g. why the items could not load. */
      note?: string;
      items: { id: string; title: string; subtitle?: string; badge?: { label: string; tone: Tone } }[];
    };

export interface FilterPill {
  id: string;
  label: string;
}

function stateOf(workflow: RuntimeWorkflow | undefined, status: string | null) {
  return workflow?.states.find((s) => s.key === status);
}

export function showValue(type: RuntimeRecordType, workflow: RuntimeWorkflow | undefined, record: RecordView, key: string): string {
  if (key === 'number') return record.number ?? '—';
  if (key === 'status') return stateOf(workflow, record.status)?.label ?? record.status ?? '—';
  if (key === 'createdAt' || key === 'updatedAt') return displayValue({ key, label: key, type: 'date' }, record[key].slice(0, 10));
  const f = type.fields.find((x) => x.key === key);
  if (f?.type === 'reference') return referenceLabel(record, key);
  return f ? displayValue(f, record.data[key]) : '—';
}

/** A reference field shows the chosen record's label, which the server sends beside the stored id. */
function referenceLabel(record: RecordView, key: string): string {
  const id = record.data[key];
  if (typeof id !== 'string' || !id) return '—';
  return record.references?.[key]?.label ?? t('ui.records.referenceUnavailable');
}

export function statusLabel(spec: ListSpec, record: RecordView): string {
  return stateOf(spec.workflow, record.status)?.label ?? '';
}

/** Whether the record's state allows no more edits. */
export function isLocked(spec: ListSpec, record: RecordView): boolean {
  const s = stateOf(spec.workflow, record.status);
  return !!s?.locked || !!s?.final;
}

export function statusTone(spec: ListSpec, record: RecordView): Tone {
  const s = stateOf(spec.workflow, record.status);
  return record.status === spec.workflow?.initial ? 'warning' : s?.final ? 'success' : 'primary';
}

export function recordTitle(spec: ListSpec, record: RecordView): string {
  const title = spec.row.title ? showValue(spec.type, spec.workflow, record, spec.row.title) : '—';
  return title !== '—' ? title : (record.number ?? spec.type.label);
}

export function rowModel(spec: ListSpec, r: RecordView): RowModel {
  const { type, workflow } = spec;
  const subtitle = spec.row.subtitle.map((k) => showValue(type, workflow, r, k)).filter((v) => v !== '—');
  const state = stateOf(workflow, r.status);
  return {
    id: r.id,
    title: recordTitle(spec, r),
    subtitle: subtitle.join(' · ') || undefined,
    meta: spec.row.meta ? showValue(type, workflow, r, spec.row.meta) : undefined,
    badge:
      spec.row.badge === 'status' && state
        ? { label: state.label, tone: statusTone(spec, r) }
        : spec.row.badge
          ? { label: showValue(type, workflow, r, spec.row.badge), tone: 'neutral' }
          : undefined,
    cells: [...new Set([...spec.columns, ...spec.compactColumns])].map((key) => ({ key, label: labelOf(type, key), value: showValue(type, workflow, r, key) })),
    record: r,
  };
}

export function detailSections(spec: ListSpec, r: RecordView, receipts: Receipt[], viewer: Viewer): DetailSection[] {
  const { type, workflow } = spec;
  const out: DetailSection[] = spec.sections.map((s) => ({
    kind: 'fields',
    id: s.id,
    title: s.label,
    fields: s.fields
      .filter((k) => {
        const f = type.fields.find((x) => x.key === k);
        return !f || conditionHolds(f.visibleWhen, r.data, r.status, viewer);
      })
      .map((k) => {
        const f = type.fields.find((x) => x.key === k);
        const display = f ? fieldDisplay(f, r.data[k]) : undefined;
        return { label: labelOf(type, k), value: showValue(type, workflow, r, k), ...(display ? { display } : {}) };
      }),
  }));
  if (receipts.length) {
    out.push({
      kind: 'items',
      id: 'receipts',
      title: t('ui.records.receipts'),
      selectable: true,
      items: receipts.map((rc) => ({
        id: rc.id,
        title: rc.number,
        subtitle: `${receiptAmount(rc.amount)} · ${rc.date}`,
        badge: { label: receiptStatus(rc), tone: rc.status === 'issued' ? 'success' : 'neutral' },
      })),
    });
  }
  return out;
}

/** The drawn form of a multiple-choice, file, location, signature or rich-text value; undefined when empty or plain. */
export function fieldDisplay(f: FieldDef, v: unknown): FieldDisplay | undefined {
  switch (f.type) {
    case 'multiChoice': {
      const items = Array.isArray(v) ? v.map((x) => f.choices?.find((c) => c.value === x)?.label ?? String(x)) : [];
      return items.length ? { kind: 'pills', items } : undefined;
    }
    case 'file': {
      const ids = fileIds(v);
      return ids.length ? { kind: 'files', ids } : undefined;
    }
    case 'location': {
      const l = asLocation(v);
      if (!l) return undefined;
      return {
        kind: 'location',
        ...(l.label ? { label: l.label } : {}),
        coordinates: coordinates(l),
        ...(l.accuracy !== undefined ? { accuracy: accuracyText(l.accuracy) } : {}),
        low: isLowAccuracy(l.accuracy),
        maps: mapsUrl(l),
      };
    }
    case 'signature': {
      const s = asSignature(v);
      return s?.file && isSigned(s) ? { kind: 'signature', file: s.file, line: signedLine(s) } : undefined;
    }
    case 'richText': {
      const html = typeof v === 'string' ? cleanRichText(v) : '';
      return html ? { kind: 'richText', html } : undefined;
    }
    default:
      return undefined;
  }
}

/** A receipt amount as the server sends it (`"1500.00"`), in rupees. */
export function receiptAmount(amount: string): string {
  const n = Number(amount);
  return Number.isFinite(n) ? formatMoney(n) : amount;
}

export function receiptStatus(rc: Receipt): string {
  return rc.status === 'issued' ? t('ui.records.issued') : t('ui.records.void');
}

/** How a pending approval is described, the same on every screen. */
export function approvalSummary(spec: ListSpec, p: PendingApproval): string {
  const step = spec.workflows.flatMap((w) => w.transitions).find((x) => x.key === p.transition)?.label ?? p.transition;
  return t('ui.records.approvalSummary', { step, by: p.requestedBy, given: p.approvalsGiven, needed: p.approvalsNeeded });
}

/** A workflow's name as people read it; workflows have no label of their own, so the key is spelled out. */
export function workflowName(w: Pick<RuntimeWorkflow, 'key'>): string {
  const words = w.key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface WorkflowLine {
  workflow: string;
  name: string;
  state: string;
  tone: Tone;
}

/** One status line per workflow the record is in, primary first; empty when it is in only one, whose state the record already shows. */
export function workflowLines(spec: ListSpec, record: RecordView): WorkflowLine[] {
  const primary = spec.workflows.find((w) => w.key === record.workflow) ?? spec.workflow;
  const lines = [
    ...(primary && record.status ? [{ w: primary, state: record.status }] : []),
    ...spec.workflows.filter((w) => w.role === 'parallel' && record.states?.[w.key] !== undefined).map((w) => ({ w, state: record.states![w.key]! })),
  ].map(({ w, state }) => {
    const s = stateOf(w, state);
    return { workflow: w.key, name: workflowName(w), state: s?.label ?? state, tone: (state === w.initial ? 'warning' : s?.final ? 'success' : 'primary') as Tone };
  });
  return lines.length > 1 ? lines : [];
}

/** Above a step's fields: the workflow it moves and the change, e.g. "Case closure: Open → Closure requested". */
export function stepSummary(spec: ListSpec, record: RecordView, step: string): { label: string; value: string }[] {
  const w = spec.workflows.find((x) => x.transitions.some((t) => t.key === step));
  const tr = w?.transitions.find((t) => t.key === step);
  if (!w || !tr) return [];
  const from = w.key === (record.workflow ?? spec.workflow?.key) || w.role !== 'parallel' ? record.status : (record.states?.[w.key] ?? null);
  const label = (key: string | null) => stateOf(w, key)?.label ?? key ?? '—';
  return [
    ...(record.number ? [{ label: t('ui.records.number'), value: record.number }] : []),
    { label: spec.workflows.length > 1 ? workflowName(w) : t('ui.records.status'), value: t('ui.records.stateChange', { from: label(from), to: label(tr.to) }) },
  ];
}

/** The open record as the last breadcrumb item: number · title. */
export function recordCrumb(spec: ListSpec, record: RecordView): string {
  const title = recordTitle(spec, record);
  return record.number && title !== record.number ? `${record.number} · ${title}` : title;
}

/** Number and status, shown above an edit form. */
export function editSummary(spec: ListSpec, r: RecordView): { label: string; value: string }[] {
  return [
    ...(r.number ? [{ label: t('ui.records.number'), value: r.number }] : []),
    ...(spec.workflow ? [{ label: t('ui.records.status'), value: showValue(spec.type, spec.workflow, r, 'status') }] : []),
  ];
}

const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

export function filterPills(specs: FilterSpec[], c: Criteria): FilterPill[] {
  const pills: FilterPill[] = [];
  for (const { field, kind } of specs) {
    const k = field.key;
    if (kind === 'list' && present(c[k])) {
      pills.push({ id: k, label: `${field.label}: ${(c[k] as string[]).map((x) => displayValue(field, x)).join(', ')}` });
    } else if (kind === 'flag' && typeof c[k] === 'boolean') pills.push({ id: k, label: `${field.label}: ${c[k] ? t('ui.common.yes') : t('ui.common.no')}` });
    else if (kind === 'text' && present(c[k])) pills.push({ id: k, label: `${field.label}: ${c[k]}` });
    else if ((kind === 'range' || kind === 'dateRange') && (present(c[`${k}From`]) || present(c[`${k}To`]))) {
      const fmt = (v: unknown) => (present(v) ? displayValue(field, kind === 'range' ? Number(v) : v) : '…');
      pills.push({ id: k, label: `${field.label}: ${fmt(c[`${k}From`])} – ${fmt(c[`${k}To`])}` });
    }
  }
  return pills;
}
