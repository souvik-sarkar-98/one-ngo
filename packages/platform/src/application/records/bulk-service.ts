import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { notFound, PlatformError, ruleViolation, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { JobItemResult, JobRunner, JobView } from '../../runtime/records/ports/job-runner.js';
import { demand } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import { findStep } from '../../runtime/definitions/workflows.js';
import type { ActionService } from '../actions/action-service.js';
import type { ExportService } from './export-service.js';
import type { RecordQuery, RecordService } from '../../runtime/records/record-service.js';
import { parseExpiry } from '../../runtime/records/shares.js';
import type { RecordSharing } from './record-sharing.js';

export const BULK_INLINE_RECORDS = 50;
export const BULK_MAX_RECORDS = 5_000;

export type BulkOperation =
  | { type: 'edit'; values: Record<string, unknown> }
  | { type: 'step'; step: string; data?: Record<string, unknown> }
  | { type: 'action'; action: string; input?: Record<string, unknown> }
  | { type: 'share'; principalKind: unknown; principal: unknown; access: unknown; expiresAt?: unknown }
  | { type: 'export' };

/** Which records: a selection of ids, or every record matching a list query. */
export type BulkSelection = { ids: string[] } | { query: RecordQuery };

export interface BulkResult {
  id: string;
  ok: boolean;
  message?: string;
  approvalRequestId?: string;
}

type RecordOperation = Exclude<BulkOperation, { type: 'export' }>;

interface BulkInput {
  recordType: string;
  ids: string[];
  operation: RecordOperation;
}

interface BulkState {
  offset?: number;
  done?: number;
  failed?: number;
}

const LABELS: Record<BulkOperation['type'], string> = { edit: 'Bulk edit', step: 'Bulk step', action: 'Bulk action', share: 'Bulk share', export: 'Bulk export' };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * One operation over many records of a type. Each record goes through the
 * normal save, step, action or share path with the person's own permissions,
 * at its version when it is reached; records that fail are reported, not
 * retried. Small selections run at once; larger ones become a `bulk` job.
 */
export class BulkService {
  constructor(
    private readonly db: TransactionManager,
    private readonly defs: DefinitionReader,
    private readonly records: RecordService,
    private readonly actions: ActionService,
    private readonly shares: RecordSharing,
    private readonly exports: ExportService,
    private readonly jobs: JobRunner,
    private readonly inlineRecords = BULK_INLINE_RECORDS,
    private readonly maxRecords = BULK_MAX_RECORDS,
  ) {
    jobs.register<BulkInput, BulkState>('bulk', {
      label: 'Bulk operation',
      exclusive: true,
      batchSize: 100,
      requires: (input) => `record:${input.recordType}:bulk`,
      run: (job) => this.runBatch(job.ctx, job.input, job.state, job.batchSize),
      notice: (job, counts) => this.notice(job, counts),
    });
  }

  async run(
    ctx: TenantContext,
    typeKey: string,
    selection: BulkSelection,
    operation: BulkOperation,
  ): Promise<
    | { results: BulkResult[]; done: number; failed: number }
    | { jobId: string; total: number }
    | Awaited<ReturnType<ExportService['start']>>
  > {
    demand(ctx.actor, `record:${typeKey}:bulk`);
    const type = await this.defs.get(ctx.tenantId, 'recordType', typeKey);
    if (!type) throw notFound(`Unknown record type '${typeKey}'.`);
    const op = await this.checked(ctx, typeKey, operation);
    const ids = await this.selected(ctx, typeKey, selection);

    if (op.type === 'export') return this.exports.start(ctx, typeKey, { ids });

    await this.db.withTenant(ctx.tenantId, (tx) =>
      this.records.stores.records.audit(tx, { actorId: ctx.actor.id, action: 'records.bulk', entity: `record:${typeKey}`, after: { operation: op.type, records: ids.length } }),
    );
    if (ids.length > this.inlineRecords) {
      const job = await this.jobs.create(ctx, 'bulk', { recordType: typeKey, ids, operation: op }, ids.length);
      return { jobId: job.id, total: ids.length };
    }
    const results: BulkResult[] = [];
    for (const id of ids) results.push(await this.one(ctx, typeKey, op, id));
    const done = results.filter((r) => r.ok).length;
    return { results, done, failed: results.length - done };
  }

  /** The operation with its input checked once, so a bad input fails the request instead of every record. */
  private async checked(ctx: TenantContext, typeKey: string, operation: BulkOperation): Promise<BulkOperation> {
    if (!isObject(operation)) throw validationFailed('operation must be an object.');
    switch (operation.type) {
      case 'edit':
        if (!isObject(operation.values) || !Object.keys(operation.values).length) {
          throw validationFailed('The values to set are missing.', [{ path: '/operation/values', message: 'must set at least one field' }]);
        }
        return { type: 'edit', values: operation.values };
      case 'step': {
        if (typeof operation.step !== 'string' || !operation.step) throw validationFailed('The step is missing.', [{ path: '/operation/step', message: 'is required' }]);
        if (operation.data !== undefined && !isObject(operation.data)) throw validationFailed('The step values must be an object.', [{ path: '/operation/data', message: 'must be an object' }]);
        const workflows = (await this.defs.workflowsFor(ctx.tenantId, typeKey)).map((w) => w.body);
        if (!findStep(workflows, operation.step)) throw notFound(`Unknown step '${operation.step}'.`);
        return { type: 'step', step: operation.step, ...(operation.data ? { data: operation.data } : {}) };
      }
      case 'action': {
        if (typeof operation.action !== 'string' || !operation.action) throw validationFailed('The action is missing.', [{ path: '/operation/action', message: 'is required' }]);
        const input = await this.actions.checkBulk(ctx, typeKey, operation.action, operation.input);
        return { type: 'action', action: operation.action, input };
      }
      case 'share': {
        const type = await this.defs.get(ctx.tenantId, 'recordType', typeKey);
        if (type?.body.visibility !== 'restricted') throw ruleViolation(`${type?.body.label ?? typeKey} records are visible to everyone who may see them, so they are not shared.`);
        const { principalKind, principal, access, expiresAt } = operation;
        const issues: FieldIssue[] = [];
        if (principalKind !== 'user' && principalKind !== 'role') issues.push({ path: '/operation/principalKind', message: 'must be user or role' });
        if (typeof principal !== 'string' || !principal.trim()) issues.push({ path: '/operation/principal', message: 'must name a person or a role' });
        if (access !== 'read' && access !== 'edit') issues.push({ path: '/operation/access', message: 'must be read or edit' });
        const until = parseExpiry(expiresAt);
        if (until === undefined || (until && until.getTime() <= Date.now())) issues.push({ path: '/operation/expiresAt', message: 'must be a date in the future' });
        if (issues.length) throw validationFailed('The share is not valid.', issues);
        return { type: 'share', principalKind, principal, access, expiresAt };
      }
      case 'export':
        return { type: 'export' };
      default:
        throw validationFailed('operation.type must be edit, step, action, share or export.', [{ path: '/operation/type', message: 'is not a bulk operation' }]);
    }
  }

  /** The ids of the selection, at most the limit; a query resolves through the list query, so only visible records are included. */
  private async selected(ctx: TenantContext, typeKey: string, selection: BulkSelection): Promise<string[]> {
    const tooMany = (n: number, what: string) =>
      validationFailed(`${n.toLocaleString('en-IN')} records ${what}; a bulk operation handles at most ${this.maxRecords.toLocaleString('en-IN')}. Narrow the list and try again.`);
    if ('ids' in selection) {
      if (!Array.isArray(selection.ids) || !selection.ids.length || selection.ids.some((id) => typeof id !== 'string')) {
        throw validationFailed('Choose at least one record.', [{ path: '/ids', message: 'must list record ids' }]);
      }
      const ids = [...new Set(selection.ids)];
      if (ids.length > this.maxRecords) throw tooMany(ids.length, 'are selected');
      return ids;
    }
    const { ids, total } = await this.records.matchingIds(ctx, typeKey, selection.query, this.maxRecords);
    if (total > this.maxRecords) throw tooMany(total, 'match');
    return ids;
  }

  /** One record through the operation's normal path, at the version it has now. */
  private async one(ctx: TenantContext, typeKey: string, op: RecordOperation, id: string): Promise<BulkResult> {
    try {
      const { record } = await this.records.stored(ctx, id, 'read');
      if (record.type !== typeKey) throw notFound('Record not found.');
      const expectedVersion = record.version;
      switch (op.type) {
        case 'edit':
          await this.records.update(ctx, id, { data: op.values, expectedVersion });
          return { id, ok: true };
        case 'step': {
          const saved = await this.records.transition(ctx, id, op.step, { data: op.data, expectedVersion });
          return saved.approvalRequestId ? { id, ok: true, message: 'Waiting for approval.', approvalRequestId: saved.approvalRequestId } : { id, ok: true };
        }
        case 'action': {
          const out = await this.actions.run(ctx, typeKey, id, op.action, { input: op.input, expectedVersion });
          return { id, ok: true, message: out.message };
        }
        case 'share':
          await this.shares.share(ctx, typeKey, id, op);
          return { id, ok: true };
      }
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      const issues = error.issues.map((i) => `${i.path.replace(/^\//, '')}: ${i.message}`).join('; ');
      return { id, ok: false, message: issues ? `${error.message} ${issues}.` : error.message };
    }
  }

  private async runBatch(ctx: TenantContext, input: BulkInput, state: BulkState, batchSize: number) {
    const offset = state.offset ?? 0;
    const slice = input.ids.slice(offset, offset + batchSize);
    const items: JobItemResult[] = [];
    for (const [i, id] of slice.entries()) {
      const r = await this.one(ctx, input.recordType, input.operation, id);
      items.push({
        seq: offset + i + 1,
        status: r.ok ? 'done' : 'failed',
        recordId: id,
        ...(r.message ? { message: r.message } : {}),
        ...(r.approvalRequestId ? { data: { approvalRequestId: r.approvalRequestId } } : {}),
      });
    }
    const ok = items.filter((x) => x.status === 'done').length;
    const next = { offset: offset + slice.length, done: (state.done ?? 0) + ok, failed: (state.failed ?? 0) + slice.length - ok };
    const done = next.offset >= input.ids.length;
    return {
      state: next,
      items,
      progress: next.offset,
      done,
      ...(done ? { result: { recordType: input.recordType, operation: input.operation.type, done: next.done, failed: next.failed } } : {}),
    };
  }

  private notice(job: JobView, counts: { done: number; failed: number }) {
    const r = (job.result ?? {}) as { recordType?: string; operation?: BulkOperation['type'] };
    const label = r.operation ? LABELS[r.operation] : 'Bulk operation';
    if (job.status === 'cancelled') return { subject: `${label} cancelled`, body: `${label} was cancelled after ${job.progress} records.` };
    if (job.status === 'failed') return { subject: `${label} failed`, body: `${label} stopped: ${job.error ?? 'something went wrong'}.` };
    const parts = [`${counts.done} done`, ...(counts.failed ? [`${counts.failed} failed`] : [])];
    return { subject: `${label} finished`, body: `${label} finished: ${parts.join(', ')}.`, link: `/records/${r.recordType}?bulk=${job.id}` };
  }
}
