import { formatDate, intlLocale, currentTranslator, t } from '../i18n/i18n';
import type { ApprovalRow, ApprovalSortField, InboxNotification, RuntimeDefinitions, RuntimeWorkflow } from '../models';
import type { ChipSpec } from '../records/spec';
import type { RowView } from '../rows';
import { APPROVAL_FILTERS, APPROVAL_SORTS, type ApprovalFilter, type InboxAddress, type InboxTab } from './address';
import { isServerAddress } from './http-inbox';

/** The common workflow fields (Design §7), the same for every record type, in both layouts. */
export const APPROVAL_FIELDS = ['record', 'type', 'step', 'change', 'requestedBy', 'waiting', 'approvals'] as const;
export type ApprovalField = (typeof APPROVAL_FIELDS)[number];

const LABELS: Record<ApprovalField, string> = {
  record: 'ui.inbox.record',
  type: 'ui.inbox.type',
  step: 'ui.inbox.step',
  change: 'ui.inbox.statusChange',
  requestedBy: 'ui.inbox.requestedBy',
  waiting: 'ui.inbox.waitingSince',
  approvals: 'ui.inbox.approvals',
};

const SORTABLE = new Set<string>(APPROVAL_SORTS);

/** The table's columns: exactly the common workflow fields; the Approve and Reject buttons follow. */
export function approvalColumns(): { key: ApprovalField; label: string; sortable: boolean }[] {
  return APPROVAL_FIELDS.map((key) => ({ key, label: t(LABELS[key]), sortable: SORTABLE.has(key) }));
}

/** The Sort menu: Waiting since, Record, Type, Step, Requested by. */
export function approvalSortOptions(): { key: ApprovalSortField; label: string }[] {
  return APPROVAL_SORTS.map((key) => ({ key, label: t(LABELS[key]) }));
}

/** How long a request has waited, in whole minutes, hours or days. */
export function waitedFor(since: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 60_000));
  if (minutes < 60) return t('ui.inbox.waitedMinutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('ui.inbox.waitedHours', { count: hours });
  return t('ui.inbox.waitedDays', { count: Math.floor(hours / 24) });
}

/** Each common field's text for one request. */
export function approvalValues(a: ApprovalRow, now: Date): Record<ApprovalField, string> {
  const title = a.recordTitle && a.recordTitle !== a.recordNumber ? a.recordTitle : '';
  return {
    record: [a.recordNumber ?? '', title].filter(Boolean).join(' · ') || a.recordTitle,
    type: a.recordTypeLabel,
    step: a.stepLabel,
    change: `${a.fromStatusLabel} → ${a.toStatusLabel}`,
    requestedBy: a.requestedByName ?? a.requestedBy,
    waiting: waitedFor(a.requestedAt, now),
    approvals: `${a.approvalsGiven} / ${a.approvalsNeeded}`,
  };
}

/**
 * One request as both layouts draw it. The table shows the cells; the card
 * shows the same values: the number (or title) with the approvals badge, the
 * title, type and step, the status change, and who asked and how long ago.
 */
export function approvalRow(a: ApprovalRow, now: Date): RowView {
  const v = approvalValues(a, now);
  const title = a.recordTitle && a.recordTitle !== a.recordNumber ? a.recordTitle : '';
  return {
    id: a.id,
    title: a.recordNumber ?? a.recordTitle,
    ...(a.recordNumber && title && { subtitle: title }),
    lines: [`${v.type} · ${v.step}`, v.change],
    meta: t('ui.inbox.requestedLine', { name: v.requestedBy, waited: v.waiting }),
    badge: { label: v.approvals, tone: 'primary' },
    cells: APPROVAL_FIELDS.map((key) => ({ key, label: t(LABELS[key]), value: v[key] })),
    actions: [
      { id: 'approve', label: t('ui.common.approve'), tone: 'primary' },
      { id: 'reject', label: t('ui.common.reject'), tone: 'danger' },
    ],
  };
}

/** Today's notifications show the time, older ones the date. */
export function noticeTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (d.toDateString() !== now.toDateString()) return formatDate(d);
  return new Intl.DateTimeFormat(intlLocale(currentTranslator().locale), { hour: '2-digit', minute: '2-digit' }).format(d);
}

export function notificationRow(n: InboxNotification, now: Date): RowView {
  return {
    id: n.id,
    title: n.subject,
    subtitle: n.body,
    meta: noticeTime(n.createdAt, now),
    ...(n.readAt ? { muted: true } : { badge: { label: t('ui.inbox.new'), tone: 'primary' as const } }),
    cells: [],
    actions: [],
  };
}

/** A count on a chip; large unread counts are capped. */
export function countLabel(n: number, cap = 99): string {
  return n > cap ? `${cap}+` : String(n);
}

export function inboxChips(waiting: number | null, unread: number | null): ChipSpec[] {
  return [
    { id: 'approvals', label: waiting ? t('ui.inbox.approvalsChip', { count: countLabel(waiting) }) : t('ui.inbox.approvals') },
    { id: 'notifications', label: unread ? t('ui.inbox.notificationsChip', { count: countLabel(unread) }) : t('ui.inbox.notifications') },
  ];
}

export function tabLabel(tab: InboxTab): string {
  return t(tab === 'approvals' ? 'ui.inbox.approvals' : 'ui.inbox.notifications');
}

export interface FilterOption {
  key: string;
  label: string;
}

export interface ApprovalFilterSpec {
  key: ApprovalFilter;
  label: string;
  options: FilterOption[];
}

const FILTER_LABELS: Record<ApprovalFilter, string> = { type: 'ui.inbox.type', step: 'ui.inbox.step', requestedBy: 'ui.inbox.requestedBy' };

/**
 * Filters Type, Step and Requested by. Types and steps come from the
 * workflows that ask for approval; people from the requests seen so far,
 * plus any already chosen.
 */
export function approvalFilters(defs: RuntimeDefinitions | null, requesters: ReadonlyMap<string, string>, chosen: InboxAddress): ApprovalFilterSpec[] {
  const types = new Map<string, string>();
  const steps = new Map<string, string>();
  for (const type of defs?.recordTypes ?? []) {
    const flows: RuntimeWorkflow[] = defs?.workflowSets?.[type.key] ?? (defs?.workflows[type.key] ? [defs.workflows[type.key]!] : []);
    for (const step of flows.flatMap((w) => w.transitions).filter((x) => x.approval)) {
      types.set(type.key, type.label);
      if (!steps.has(step.key)) steps.set(step.key, step.label);
    }
  }
  const people = new Map(requesters);
  const options = (m: Map<string, string>, extra: string[]): FilterOption[] => {
    for (const k of extra) if (!m.has(k)) m.set(k, k);
    return [...m].map(([key, label]) => ({ key, label }));
  };
  return [
    { key: 'type', label: t(FILTER_LABELS.type), options: options(types, chosen.type) },
    { key: 'step', label: t(FILTER_LABELS.step), options: options(steps, chosen.step) },
    { key: 'requestedBy', label: t(FILTER_LABELS.requestedBy), options: options(people, chosen.requestedBy) },
  ];
}

/** One removable pill per applied filter, e.g. "Type: Donation". */
export function approvalPills(a: InboxAddress, filters: ApprovalFilterSpec[]): { id: ApprovalFilter; label: string }[] {
  return APPROVAL_FILTERS.filter((k) => a[k].length).map((k) => {
    const f = filters.find((x) => x.key === k);
    const names = a[k].map((v) => f?.options.find((o) => o.key === v)?.label ?? v);
    return { id: k, label: `${f?.label ?? t(FILTER_LABELS[k])}: ${names.join(', ')}` };
  });
}

/** Where a request's record opens: its list with the record panel. */
export function recordAddress(type: string, id: string): string {
  return `/records/${encodeURIComponent(type)}?id=${encodeURIComponent(id)}`;
}

/** Where a notification opens: its own link inside the app, else its record when the record type is known. */
export function notificationAddress(n: InboxNotification, typeOf: (recordId: string) => string | undefined): string | null {
  if (n.link && n.link.startsWith('/') && !n.link.startsWith('//') && !isServerAddress(n.link)) return n.link;
  const type = n.recordId ? typeOf(n.recordId) : undefined;
  return type && n.recordId ? recordAddress(type, n.recordId) : null;
}
