import { compileExpression } from '../expressions/expression.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { systemActor } from '../../domain/system-actor.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import { joinTx } from '../../domain/transaction-scope.js';
import { parseCron } from '../definitions/cron.js';
import type { DefinitionReader } from '../definitions/ports/definition-reader.js';
import type { AutomationAction, AutomationDef, PublishedDefinition } from '../definitions/types.js';
import type { AutomationRecordRow as RecordRow, AutomationStateChange, AutomationStore } from './ports/automation-store.js';
import type { ActionRecords, AutomationRecords } from './ports/automation-records.js';
import type { ActionNotifier, OutboxEvent, TickTenants } from './ports/automation-collaborators.js';
import { connectorDelivery, runAutomationAction } from './run-action.js';
import { MAX_AUTOMATION_DEPTH } from './limits.js';

export { MAX_AUTOMATION_DEPTH };

/** The record engine working inside `tx`, already open for the organisation, so an action's saves commit with its run claim. */
export type RecordsInTransaction = (tenantId: string, tx: Tx) => ActionRecords;

interface RecordEventPayload {
  id: string;
  type: string;
  status: string | null;
  previousStatus: string | null;
  /** The record's primary workflow, and the states of its parallel workflows before and after. */
  workflow?: string | null;
  states?: Record<string, string>;
  previousStates?: Record<string, string>;
  depth?: number;
  causedBy?: string | null;
  quiet?: boolean;
}

export interface TickResult {
  tenants: number;
  automationsRun: number;
  recordsProcessed: number;
  /** True when the time budget ran out; the next tick resumes where this one stopped. */
  incomplete: boolean;
}

export class AutomationEngine {
  constructor(
    private readonly tm: TransactionManager,
    private readonly store: AutomationStore,
    private readonly tenants: TickTenants,
    private readonly defs: DefinitionReader,
    private readonly records: AutomationRecords,
    private readonly notifications: ActionNotifier,
    private readonly recordsIn: RecordsInTransaction,
    private readonly audit: AuditTrail,
  ) {}

  /** Outbox handler for record.created, record.updated, and record.transitioned. */
  async onRecordEvent(event: OutboxEvent): Promise<void> {
    const p = event.payload as unknown as RecordEventPayload;
    const depth = p.depth ?? 0;
    if (depth >= MAX_AUTOMATION_DEPTH || p.quiet) return;
    const automations = (await this.defs.list(event.tenantId, 'automation')).filter(
      (a) => a.body.enabled !== false && a.body.recordType === p.type && a.key !== p.causedBy && this.matches(a.body, event.type, p),
    );
    if (!automations.length) return;
    const record = await this.loadRecord(event.tenantId, p.id);
    if (!record) return;
    for (const a of automations) {
      await this.run(event.tenantId, a, record, depth, event.id, p.previousStatus);
    }
  }

  /**
   * Runs schedule-triggered automations that fell due since their last run.
   * Records are read in batches with a saved cursor, so a run that exceeds the
   * time budget resumes on the next tick. NGOs are served least-recently-ticked
   * first, so a large NGO cannot starve the others.
   */
  async tick(now = new Date(), options: { timeBudgetMs?: number; batchSize?: number } = {}): Promise<TickResult> {
    const deadline = Date.now() + (options.timeBudgetMs ?? 8 * 60_000);
    const batchSize = options.batchSize ?? 200;
    const tenants = await this.tenants.activeIdsByTickOrder();
    const result: TickResult = { tenants: 0, automationsRun: 0, recordsProcessed: 0, incomplete: false };
    for (const tenantId of tenants) {
      if (Date.now() >= deadline) {
        result.incomplete = true;
        break;
      }
      const done = await this.tickTenant(tenantId, now, deadline, batchSize, result);
      result.tenants++;
      if (!done) {
        result.incomplete = true;
        break;
      }
      await this.tenants.markTicked(tenantId, now);
    }
    return result;
  }

  private async tickTenant(tenantId: string, now: Date, deadline: number, batchSize: number, result: TickResult): Promise<boolean> {
    const scheduled = (await this.defs.list(tenantId, 'automation')).filter(
      (a) => a.body.enabled !== false && a.body.trigger.event === 'schedule',
    );
    for (const a of scheduled) {
      const trigger = a.body.trigger as { event: 'schedule'; cron: string; status?: string };
      const state = await this.tm.withTenant(tenantId, (tx) => this.store.state(tx, a.key));
      if (!state) {
        // First sighting: start the clock now rather than replaying past schedules.
        await this.saveState(tenantId, a.key, { lastRunAt: now, pendingDueAt: null, cursor: null });
        continue;
      }
      let due = state.pending_due_at ? new Date(state.pending_due_at) : null;
      let cursor = state.cursor_id && state.cursor_created_at ? { at: new Date(state.cursor_created_at).toISOString(), id: state.cursor_id } : null;
      if (!due) {
        due = parseCron(trigger.cron).lastDueBetween(new Date(state.last_run_at ?? now), now);
        if (!due) continue;
        cursor = null;
        await this.saveState(tenantId, a.key, { pendingDueAt: due, cursor: null });
      }

      for (;;) {
        if (Date.now() >= deadline) return false;
        const after = cursor;
        const rows = await this.tm.withTenant(tenantId, (tx) => this.store.recordsAfter(tx, a.body.recordType, trigger.status, after, batchSize));
        for (const row of rows) {
          const record = { ...row, data: await this.records.openData(tenantId, row.type_key, row.data) };
          await this.run(tenantId, a, record, 0, `schedule:${a.key}:${due.toISOString()}:${record.id}`, record.status);
          result.recordsProcessed++;
        }
        if (rows.length < batchSize) break;
        const last = rows[rows.length - 1]!;
        cursor = { at: new Date(last.created_at).toISOString(), id: last.id };
        await this.saveState(tenantId, a.key, { cursor });
      }
      await this.saveState(tenantId, a.key, { lastRunAt: now, pendingDueAt: null, cursor: null });
      result.automationsRun++;
    }
    return true;
  }

  private matches(def: AutomationDef, eventType: string, p: RecordEventPayload): boolean {
    const t = def.trigger;
    switch (t.event) {
      case 'created':
        return eventType === 'record.created';
      case 'updated':
        return eventType === 'record.updated';
      case 'statusChanged':
        if (t.workflow && t.workflow !== p.workflow) {
          const now = p.states?.[t.workflow];
          const before = p.previousStates?.[t.workflow];
          return now !== undefined && now !== before && (!t.to || t.to === now) && (!t.from || t.from === before);
        }
        return (
          p.status !== p.previousStatus &&
          (eventType === 'record.created' || eventType === 'record.transitioned') &&
          (!t.to || t.to === p.status) &&
          (!t.from || t.from === p.previousStatus)
        );
      case 'schedule':
        return false;
    }
  }

  private async run(
    tenantId: string,
    automation: PublishedDefinition<'automation'>,
    record: RecordRow,
    depth: number,
    eventId: string,
    previousStatus: string | null,
  ): Promise<void> {
    const def = automation.body;
    const scope = () => ({
      record: { ...record.data, id: record.id, number: record.number },
      status: record.status,
      previousStatus,
    });
    if (def.condition && !compileExpression(def.condition).test(scope())) return;

    const ctx: TenantContext = {
      tenantId,
      actor: systemActor(`automation:${automation.key}`),
      depth: depth + 1,
      causedBy: automation.key,
    };
    for (let i = 0; i < def.actions.length; i++) {
      // The run row is claimed first in the action's own transaction: a retry, or a
      // concurrent run waiting on the row, finds it taken and skips the action.
      const ran = await this.tm.withTenant(tenantId, async (tx) => {
        if (!(await this.store.claimRun(tx, eventId, automation.key, i))) return false;
        await this.runAction(tx, ctx, automation.key, def.actions[i]!, record, scope());
        return true;
      });
      if (!ran) continue;
      const fresh = await this.loadRecord(tenantId, record.id);
      if (fresh) record = fresh;
    }
  }

  private async runAction(tx: Tx, ctx: TenantContext, key: string, action: AutomationAction, record: RecordRow, scope: Record<string, unknown>) {
    const joined = joinTx(ctx.tenantId, tx);
    const type = action.type === 'connector' ? (await this.defs.get(ctx.tenantId, 'recordType', record.type_key))?.body : undefined;
    await runAutomationAction(
      {
        records: this.recordsIn(ctx.tenantId, tx),
        notify: (n) => this.notifications.within(joined).notify(ctx.tenantId, n),
        webhook: (request) => joined.withTenant(ctx.tenantId, (t) => this.audit.event(t, 'connector.webhook', request)),
        connector: (request) => joined.withTenant(ctx.tenantId, (t) => this.audit.event(t, 'connector.http', connectorDelivery(request, type))),
        event: `automation.${key}`,
      },
      ctx,
      action,
      { id: record.id, type: record.type_key, number: record.number, status: record.status, version: record.version, createdBy: record.created_by },
      scope,
    );
  }

  private async saveState(tenantId: string, key: string, s: AutomationStateChange): Promise<void> {
    await this.tm.withTenant(tenantId, (tx) => this.store.saveState(tx, key, s));
  }

  /** The record with its sensitive values decrypted: conditions and actions see them, and notifications mask them per recipient. */
  private async loadRecord(tenantId: string, id: string): Promise<RecordRow | undefined> {
    const row = await this.tm.withTenant(tenantId, (tx) => this.store.record(tx, id));
    return row && { ...row, data: await this.records.openData(tenantId, row.type_key, row.data) };
  }
}
