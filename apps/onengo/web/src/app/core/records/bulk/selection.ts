import { t } from '../../i18n/i18n';
import type { FieldDef, RecordQueryBody, RecordView } from '../../models';
import { recordActions } from '../record/actions';
import { fromFormValues, type FormValues, type Viewer } from '../record/forms';
import { permits, type JobView } from '../import/import-session';
import type { ListSpec } from '../spec';

/** The most records one bulk operation handles; the server refuses more. */
export const MAX_SELECTED = 5_000;

/**
 * Which rows are chosen. `all` covers every record that matches the list,
 * loaded or not. `selecting` is the cards' selection mode; tables always
 * show their checkboxes. Not kept in the address.
 */
export interface Selection {
  selecting: boolean;
  ids: readonly string[];
  all: boolean;
}

export const NO_SELECTION: Selection = { selecting: false, ids: [], all: false };

/** Selecting, bulk operations and the bulk bar need the record type's bulk permission. */
export const canSelect = (permissions: readonly string[], type: string) => permits(permissions, `record:${type}:bulk`);

export const startSelecting = (s: Selection): Selection => ({ ...s, selecting: true });

export const isTicked = (s: Selection, id: string) => s.all || s.ids.includes(id);

/** Ticks or unticks one row; unticking a row of "all that match" leaves the other loaded rows ticked. */
export function toggled(s: Selection, id: string, loaded: readonly string[]): Selection {
  const ids = s.all ? [...loaded] : [...s.ids];
  const at = ids.indexOf(id);
  if (at >= 0) ids.splice(at, 1);
  else ids.push(id);
  return { selecting: true, ids, all: false };
}

/** How the header box shows: none, some or every loaded row ticked. */
export function pageTicked(s: Selection, loaded: readonly string[]): 'none' | 'some' | 'all' {
  if (s.all || (loaded.length && loaded.every((id) => s.ids.includes(id)))) return 'all';
  return loaded.some((id) => s.ids.includes(id)) ? 'some' : 'none';
}

/** The header box (phones: Select all): ticks every loaded row, or clears them when they all are. */
export function toggledPage(s: Selection, loaded: readonly string[]): Selection {
  return pageTicked(s, loaded) === 'all' ? { ...NO_SELECTION, selecting: s.selecting } : { selecting: true, ids: [...loaded], all: false };
}

/**
 * Whether to offer "Select all N that match": once every loaded row is
 * ticked and more match. Above the limit it says so instead.
 */
export function allMatchingOffer(s: Selection, loaded: readonly string[], total: number): 'offer' | 'tooMany' | null {
  if (s.all || total <= loaded.length || pageTicked(s, loaded) !== 'all') return null;
  return total > MAX_SELECTED ? 'tooMany' : 'offer';
}

export function selectAllMatching(s: Selection, loaded: readonly string[], total: number): Selection {
  return allMatchingOffer(s, loaded, total) === 'offer' ? { selecting: true, ids: [], all: true } : s;
}

export function selectedCount(s: Selection, total: number): number {
  return s.all ? Math.min(total, MAX_SELECTED) : s.ids.length;
}

/** The loaded records the selection covers; for "all that match" every loaded row stands for the rest. */
export function selectedRecords(s: Selection, rows: readonly RecordView[]): RecordView[] {
  return s.all ? [...rows] : rows.filter((r) => s.ids.includes(r.id));
}

export type BulkTarget = { ids: string[] } | { query: RecordQueryBody };

/** What the server runs over: the ticked ids, or the list's query for "all that match". */
export function bulkTarget(s: Selection, query: RecordQueryBody): BulkTarget {
  return s.all ? { query } : { ids: [...s.ids] };
}

// ------------------------------------------------------------- operations

export type BulkOperationKind = 'step' | 'action' | 'edit' | 'share' | 'export';

/** An entry of the bulk bar. Everything but Export asks in the panel first. */
export interface BulkOperation {
  id: string;
  kind: BulkOperationKind;
  key?: string;
  label: string;
}

const common = <T>(lists: T[][], key: (x: T) => string): T[] =>
  lists.length ? lists[0]!.filter((x) => lists.every((l) => l.some((y) => key(y) === key(x)))) : [];

/**
 * The operations allowed for every selected record: workflow steps and
 * bulk actions offered on each of them, Edit fields when each can be
 * edited, Share for shared record types, and Export. The server checks
 * every record again when it runs.
 */
export function bulkOperations(spec: ListSpec, records: readonly RecordView[], permissions: readonly string[], viewer: Viewer, chip?: string): BulkOperation[] {
  const type = spec.type.key;
  if (!records.length || !canSelect(permissions, type)) return [];
  const per = records.map((r) => recordActions(spec, r, viewer, chip));
  const steps = common(
    per.map((a) => a.workflows.flatMap((w) => w.steps)),
    (s) => s.key,
  );
  const actions = common(
    per.map((a) => a.actions.filter((x) => x.placement.includes('bulk'))),
    (x) => x.key,
  );
  return [
    ...steps.map((s): BulkOperation => ({ id: `step:${s.key}`, kind: 'step', key: s.key, label: s.label })),
    ...actions.map((x): BulkOperation => ({ id: `action:${x.key}`, kind: 'action', key: x.key, label: x.label })),
    ...(spec.editKeys.length && per.every((a) => a.edit) ? [{ id: 'edit', kind: 'edit' as const, label: t('ui.bulk.editFields') }] : []),
    ...(spec.type.visibility === 'restricted' && permits(permissions, `record:${type}:share`) ? [{ id: 'share', kind: 'share' as const, label: t('ui.bulk.share') }] : []),
    ...(permits(permissions, `record:${type}:export`) ? [{ id: 'export', kind: 'export' as const, label: t('ui.imports.export') }] : []),
  ];
}

const SHARE_WITH = ['user', 'role'] as const;

/** The fields an operation asks for once, for every record. */
export function operationFields(spec: ListSpec, op: BulkOperation, values: FormValues): FieldDef[] {
  const byKey = (keys: readonly string[], required: boolean) =>
    keys.flatMap((k) => spec.type.fields.filter((f) => f.key === k && !f.calculated).map((f) => ({ ...f, required: required || undefined })));
  switch (op.kind) {
    case 'step': {
      const step = spec.workflows.flatMap((w) => w.transitions).find((x) => x.key === op.key);
      return byKey(step?.requiredFields ?? [], true);
    }
    case 'action':
      return spec.actions.find((a) => a.key === op.key)?.form?.fields ?? [];
    case 'edit':
      return byKey(spec.editKeys, false);
    case 'share':
      return [
        { key: 'shareWith', label: t('ui.bulk.shareWith'), type: 'choice', required: true, choices: SHARE_WITH.map((v) => ({ value: v, label: t(`ui.bulk.${v}`) })) },
        values['shareWith'] === 'role'
          ? { key: 'role', label: t('ui.bulk.role'), type: 'text', required: true }
          : { key: 'person', label: t('ui.bulk.user'), type: 'person', required: true },
        { key: 'access', label: t('ui.bulk.access'), type: 'choice', required: true, choices: (['read', 'edit'] as const).map((v) => ({ value: v, label: t(`ui.bulk.${v}`) })) },
        { key: 'expiresAt', label: t('ui.bulk.until'), type: 'date' },
      ];
    case 'export':
      return [];
  }
}

/** The starting values of an operation's form. */
export function operationValues(op: BulkOperation): FormValues {
  return op.kind === 'share' ? { shareWith: 'user', access: 'read' } : {};
}

export type BulkOperationBody =
  | { type: 'edit'; values: Record<string, unknown> }
  | { type: 'step'; step: string; data?: Record<string, unknown> }
  | { type: 'action'; action: string; input?: Record<string, unknown> }
  | { type: 'share'; principalKind: 'user' | 'role'; principal: string; access: 'read' | 'edit'; expiresAt?: string };

const blank = (v: unknown) => v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length);

/** The operation as the server takes it, or what is missing. Edit fields sends only the fields filled in. */
export function operationBody(
  spec: ListSpec,
  op: BulkOperation,
  values: FormValues,
): { body: BulkOperationBody } | { errors: Record<string, string>; general: string[] } {
  const fields = operationFields(spec, op, values);
  const errors: Record<string, string> = {};
  for (const f of fields) if (f.required && f.type !== 'boolean' && blank(values[f.key])) errors[f.key] = t('ui.records.required', { field: f.label });
  if (Object.keys(errors).length) return { errors, general: [] };
  const data = fromFormValues({ fields }, values);
  switch (op.kind) {
    case 'step':
      return { body: { type: 'step', step: op.key!, ...(fields.length ? { data } : {}) } };
    case 'action':
      return { body: { type: 'action', action: op.key!, ...(fields.length ? { input: data } : {}) } };
    case 'edit': {
      const set = Object.fromEntries(Object.entries(data).filter(([, v]) => !blank(v)));
      return Object.keys(set).length ? { body: { type: 'edit', values: set } } : { errors: {}, general: [t('ui.bulk.nothingToSet')] };
    }
    case 'share': {
      const role = data['shareWith'] === 'role';
      return {
        body: {
          type: 'share',
          principalKind: role ? 'role' : 'user',
          principal: String(role ? data['role'] : data['person']),
          access: data['access'] === 'edit' ? 'edit' : 'read',
          ...(data['expiresAt'] ? { expiresAt: String(data['expiresAt']) } : {}),
        },
      };
    }
    case 'export':
      throw new Error('Export has no form.');
  }
}

// ---------------------------------------------------------------- results

export interface BulkRecordResult {
  id: string;
  ok: boolean;
  message?: string;
  approvalRequestId?: string;
}

/** The server's answer: results at once for small selections, else the job that runs it. */
export type BulkAnswer = { results: BulkRecordResult[]; done: number; failed: number } | { jobId: string; total: number };

/** A bulk job, with the counts the server keeps once it has finished. */
export type BulkJob = JobView & { result?: { done?: number; failed?: number } | null };

export interface BulkJobItem {
  seq: number;
  status: 'done' | 'failed' | 'skipped';
  recordId?: string;
  message?: string;
}

export interface BulkProblem {
  id: string;
  record: string;
  message: string;
}

/** "200 done, 12 waiting for approval, 2 failed", with the failed records. */
export interface BulkSummary {
  done: number;
  waiting: number;
  failed: number;
  problems: BulkProblem[];
  /** The job stopped (cancelled or failed) before the end. */
  stopped?: boolean;
}

export function summarise(results: readonly BulkRecordResult[], name: (id: string) => string): BulkSummary {
  const waiting = results.filter((r) => r.ok && r.approvalRequestId).length;
  const failed = results.filter((r) => !r.ok);
  return {
    done: results.filter((r) => r.ok).length - waiting,
    waiting,
    failed: failed.length,
    problems: failed.map((r) => ({ id: r.id, record: name(r.id), message: r.message ?? '' })),
  };
}

export function jobSummary(job: BulkJob, failedItems: readonly BulkJobItem[], name: (id: string) => string): BulkSummary {
  const failed = job.result?.failed ?? failedItems.length;
  return {
    done: job.result?.done ?? Math.max(0, job.progress - failed),
    waiting: 0,
    failed,
    problems: failedItems.map((i) => ({ id: i.recordId ?? String(i.seq), record: i.recordId ? name(i.recordId) : String(i.seq), message: i.message ?? '' })),
    ...(job.status !== 'done' ? { stopped: true } : {}),
  };
}

export function summaryLine(s: BulkSummary): string {
  return [
    t('ui.bulk.done', { count: s.done }),
    ...(s.waiting ? [t('ui.bulk.waiting', { count: s.waiting })] : []),
    ...(s.failed ? [t('ui.bulk.failed', { count: s.failed })] : []),
  ].join(', ');
}

/** What the bulk screens need from the server. The only implementation that talks HTTP is in http-gateway.ts. */
export interface BulkGateway {
  run(type: string, target: BulkTarget, operation: BulkOperationBody): Promise<BulkAnswer>;
  job(id: string): Promise<BulkJob>;
  failedItems(id: string): Promise<BulkJobItem[]>;
  cancelJob(id: string): Promise<BulkJob>;
}
