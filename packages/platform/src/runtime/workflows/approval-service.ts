import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, notFound, PlatformError, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../definitions/ports/definition-reader.js';
import { canReadField } from '../definitions/field-permissions.js';
import type { WorkflowDef } from '../definitions/types.js';
import { approvableSteps, findStep, isPrimary } from '../definitions/workflows.js';
import type { SaveResult } from '../records/ports/record-result.js';
import type { ApprovalRecords } from './ports/approval-records.js';
import type { ApprovalSortField, ApprovalStore, RequestRow } from './ports/approval-store.js';
import { APPROVAL_SORT_FIELDS } from './approval-sort.js';

export { APPROVAL_SORT_FIELDS } from './approval-sort.js';
export type { ApprovalSortField } from './ports/approval-store.js';

export interface ApprovalItem {
  id: string;
  recordId: string;
  recordType: string;
  recordNumber: string | null;
  transition: string;
  transitionLabel: string;
  requestedBy: string;
  requestedByName: string | null;
  approvalsNeeded: number;
  approvalsGiven: number;
  createdAt: string;
}

export type DecisionOutcome =
  | { status: 'pending'; approvalsGiven: number; approvalsNeeded: number }
  | { status: 'approved'; result: SaveResult }
  | { status: 'rejected' }
  | { status: 'stale'; message: string };

/** The common workflow fields shown for every record type in the approvals list. */
export interface ApprovalRow {
  id: string;
  recordId: string;
  recordType: string;
  recordTypeLabel: string;
  recordNumber: string | null;
  recordTitle: string;
  step: string;
  stepLabel: string;
  fromStatusLabel: string;
  toStatusLabel: string;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  approvalsGiven: number;
  approvalsNeeded: number;
}

export interface ApprovalQuery {
  search?: string;
  filters?: { type?: string[]; step?: string[]; requestedBy?: string[] };
  /** `waiting` orders by time waited: `desc` (the default) puts the longest waiting first. */
  sort?: { field: ApprovalSortField; dir: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

interface EligiblePair {
  type: string;
  typeLabel: string;
  titleField: string | null;
  /** The title as shown, decrypted when the title field is sensitive. */
  titleOf: (stored: string | null) => string | null;
  workflow: WorkflowDef;
  step: WorkflowDef['transitions'][number];
}

const storePairs = (pairs: EligiblePair[]) =>
  pairs.map((p) => ({ type: p.type, step: p.step.key, typeLabel: p.typeLabel, stepLabel: p.step.label, titleField: p.titleField }));

export class ApprovalService {
  constructor(
    private readonly tm: TransactionManager,
    private readonly store: ApprovalStore,
    private readonly defs: DefinitionReader,
    private readonly records: ApprovalRecords,
    private readonly audit: AuditTrail,
  ) {}

  /** Requests the signed-in person can decide: eligible, not their own, not already decided by them. */
  async inbox(ctx: TenantContext): Promise<ApprovalItem[]> {
    const rows = await this.load(ctx, null);
    const items: ApprovalItem[] = [];
    for (const r of rows) {
      const t = await this.transitionDef(ctx.tenantId, r.type_key, r.transition_key);
      if (!t || (await this.refusal(ctx, r))) continue;
      items.push({
        id: r.id,
        recordId: r.record_id,
        recordType: r.type_key,
        recordNumber: r.number,
        transition: r.transition_key,
        transitionLabel: t.label,
        requestedBy: r.requested_by,
        requestedByName: r.requester_name,
        approvalsNeeded: r.required_approvals,
        approvalsGiven: r.approvals,
        createdAt: new Date(r.created_at).toISOString(),
      });
    }
    return items;
  }

  async decide(ctx: TenantContext, requestId: string, decision: 'approve' | 'reject', comment?: string): Promise<DecisionOutcome> {
    const [req] = await this.load(ctx, requestId);
    if (!req) throw notFound('Approval request not found.');
    const refusal = await this.refusal(ctx, req);
    if (refusal) throw refusal;

    const approvals = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const inserted = await this.store.addDecision(tx, requestId, ctx.actor.id, decision, comment?.slice(0, 1000) ?? null);
      if (!inserted) throw ruleViolation('You have already decided this request.');
      await this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: `approval.${decision === 'approve' ? 'approved' : 'rejected'}`,
        entity: `record:${req.type_key}`,
        entityId: req.record_id,
        after: { requestId, comment: comment ?? null },
      });
      if (decision === 'reject') {
        await this.store.setStatus(tx, requestId, 'rejected', true);
        await this.audit.event(tx, 'approval.decided', {
          requestId,
          id: req.record_id,
          type: req.type_key,
          outcome: 'rejected',
          requestedBy: req.requested_by,
        });
        return -1;
      }
      return this.store.approvalsGiven(tx, requestId);
    });

    if (approvals < 0) return { status: 'rejected' };
    if (approvals < req.required_approvals) {
      return { status: 'pending', approvalsGiven: approvals, approvalsNeeded: req.required_approvals };
    }
    if (req.current_version !== req.record_version) {
      return this.markStale(ctx, req, 'The record changed after the request was made. Ask the requester to submit it again.');
    }
    try {
      const result = await this.records.transition(
        ctx,
        req.record_id,
        req.transition_key,
        { data: await this.records.openData(ctx.tenantId, req.type_key, req.data), expectedVersion: req.record_version },
        { approvedRequestId: requestId },
      );
      await this.tm.withTenant(ctx.tenantId, async (tx) => {
        await this.store.setStatus(tx, requestId, 'approved');
        await this.audit.event(tx, 'approval.decided', {
          requestId,
          id: req.record_id,
          type: req.type_key,
          outcome: 'approved',
          requestedBy: req.requested_by,
        });
      });
      return { status: 'approved', result };
    } catch (error) {
      if (error instanceof PlatformError) return this.markStale(ctx, req, error.message);
      throw error;
    }
  }

  /** The step waiting for approval on a record, if any, for the record page. */
  async pendingForRecord(
    ctx: TenantContext,
    recordId: string,
  ): Promise<{ id: string; transition: string; requestedBy: string; approvalsGiven: number; approvalsNeeded: number; canDecide: boolean } | null> {
    const rows = await this.load(ctx, null);
    const r = rows.find((x) => x.record_id === recordId);
    if (!r) return null;
    return {
      id: r.id,
      transition: r.transition_key,
      requestedBy: r.requester_name ?? r.requested_by,
      approvalsGiven: r.approvals,
      approvalsNeeded: r.required_approvals,
      canDecide: !(await this.refusal(ctx, r)),
    };
  }

  /**
   * The approvals list: pending requests for steps the person may approve,
   * neither their own nor already decided by them, filtered and paged in SQL.
   */
  async query(ctx: TenantContext, q: ApprovalQuery = {}): Promise<{ items: ApprovalRow[]; total: number }> {
    const sort = q.sort ?? { field: 'waiting', dir: 'desc' };
    if (!APPROVAL_SORT_FIELDS.includes(sort.field)) throw validationFailed(`Approvals cannot be sorted by '${String(sort.field)}'.`);
    const dir = sort.dir === 'asc' ? 'asc' : 'desc';
    const limit = Math.min(Math.max(Math.trunc(Number(q.limit)) || 50, 1), 200);
    const offset = Math.max(Math.trunc(Number(q.offset)) || 0, 0);

    const pairs = await this.eligiblePairs(ctx);
    if (!pairs.length) return { items: [], total: 0 };
    const f = q.filters ?? {};
    const search = q.search?.trim();

    const { rows, total } = await this.tm.withTenant(ctx.tenantId, (tx) =>
      this.store.eligible(tx, ctx.actor.id, storePairs(pairs), {
        types: f.type,
        steps: f.step,
        requestedBy: f.requestedBy,
        search: search || undefined,
        sort: { field: sort.field, dir },
        limit,
        offset,
      }),
    );

    const byPair = new Map(pairs.map((p) => [`${p.type}\u0000${p.step.key}`, p]));
    const items = rows.map((r): ApprovalRow => {
      const p = byPair.get(`${r.type_key}\u0000${r.transition_key}`)!;
      const state = isPrimary(p.workflow) ? r.status : r.workflow_state?.[p.workflow.key];
      const label = (key: string | undefined) => p.workflow.states.find((s) => s.key === key)?.label ?? key ?? '';
      return {
        id: r.id,
        recordId: r.record_id,
        recordType: r.type_key,
        recordTypeLabel: p.typeLabel,
        recordNumber: r.number,
        recordTitle: p.titleOf(r.title) ?? r.number ?? '',
        step: p.step.key,
        stepLabel: p.step.label,
        fromStatusLabel: label(state),
        toStatusLabel: label(p.step.to),
        requestedBy: r.requested_by,
        requestedByName: r.requester_name,
        requestedAt: new Date(r.created_at).toISOString(),
        approvalsGiven: r.approvals,
        approvalsNeeded: r.required_approvals,
      };
    });
    return { items, total };
  }

  /** How many approvals are waiting for the person, for the Inbox badge. */
  async count(ctx: TenantContext): Promise<{ waiting: number }> {
    const pairs = await this.eligiblePairs(ctx);
    if (!pairs.length) return { waiting: 0 };
    const waiting = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.eligibleCount(tx, ctx.actor.id, storePairs(pairs)));
    return { waiting };
  }

  /** Every (record type, step) the person may approve, across all published workflows, primary and parallel. */
  private async eligiblePairs(ctx: TenantContext): Promise<EligiblePair[]> {
    const [workflows, types] = await Promise.all([
      this.defs.list(ctx.tenantId, 'workflow'),
      this.defs.list(ctx.tenantId, 'recordType'),
    ]);
    const typeDefs = new Map(types.map((t) => [t.key, t.body]));
    return approvableSteps(ctx.actor, workflows.map((w) => w.body)).map(({ workflow, step }) => {
      const type = typeDefs.get(workflow.recordType);
      const title = type?.titleField ? type.fields.find((x) => x.key === type.titleField) : undefined;
      return {
        type: workflow.recordType,
        typeLabel: type?.label ?? workflow.recordType,
        titleField: title && type && canReadField(ctx.actor, type, title) ? title.key : null,
        titleOf: (stored) => (stored === null || !title || !type ? stored : String(this.records.sensitive.openValue(type, title, stored))),
        workflow,
        step,
      };
    });
  }

  /** Why the person cannot decide this request now, or null when they can. */
  private async refusal(ctx: TenantContext, req: RequestRow): Promise<PlatformError | null> {
    if (req.status !== 'pending') return ruleViolation('This request has already been decided.');
    const workflows = (await this.defs.workflowsFor(ctx.tenantId, req.type_key)).map((w) => w.body);
    if (!findStep(workflows, req.transition_key)?.step.approval) {
      return ruleViolation('This step no longer needs approval. Ask the requester to try again.');
    }
    if (req.requested_by === ctx.actor.id) return forbidden('You cannot approve your own request.');
    if (!approvableSteps(ctx.actor, workflows).some((s) => s.step.key === req.transition_key)) {
      return forbidden('You are not an approver for this step.');
    }
    if (req.decided_by_me) return ruleViolation('You have already decided this request.');
    return null;
  }

  async withdraw(ctx: TenantContext, requestId: string): Promise<void> {
    const [req] = await this.load(ctx, requestId);
    if (!req) throw notFound('Approval request not found.');
    if (req.requested_by !== ctx.actor.id) throw forbidden('Only the requester can withdraw this request.');
    if (req.status !== 'pending') throw ruleViolation('This request has already been decided.');
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      await this.store.setStatus(tx, requestId, 'withdrawn');
      await this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: 'approval.withdrawn',
        entity: `record:${req.type_key}`,
        entityId: req.record_id,
        after: { requestId },
      });
    });
  }

  private async markStale(ctx: TenantContext, req: RequestRow, message: string): Promise<DecisionOutcome> {
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      await this.store.setStatus(tx, req.id, 'stale');
      await this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: 'approval.stale',
        entity: `record:${req.type_key}`,
        entityId: req.record_id,
        after: { requestId: req.id, message },
      });
    });
    return { status: 'stale', message };
  }

  private async transitionDef(tenantId: string, recordType: string, key: string) {
    return findStep((await this.defs.workflowsFor(tenantId, recordType)).map((w) => w.body), key)?.step;
  }

  private load(ctx: TenantContext, requestId: string | null): Promise<RequestRow[]> {
    return this.tm.withTenant(ctx.tenantId, (tx) => this.store.requests(tx, ctx.actor.id, requestId));
  }
}
