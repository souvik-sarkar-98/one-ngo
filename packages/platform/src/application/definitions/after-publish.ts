import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { systemActor } from '../../domain/system-actor.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { HandlerCompletion } from '../actions/ports/action-ports.js';
import type { OutboxEvent } from '../notifications/ports/outbox-event.js';

/** The background jobs a published definition can queue. */
export interface PublishJobs {
  insert(tx: Tx, ctx: TenantContext, kind: string, input: Record<string, unknown>, options?: { unlessQueued?: boolean }): Promise<unknown>;
  started(): void;
}

/** What follows a published definition: the index build and the rebuilds its change needs, queued in one transaction with the event's completion. */
export class AfterPublish {
  constructor(
    private readonly transactions: TransactionManager,
    /** The rebuild jobs a new version of a record type needs. */
    private readonly rebuildsAfter: (tenantId: string, key: string, version: number) => Promise<{ kind: string; recordType: string }[]>,
    private readonly jobs: PublishJobs,
  ) {}

  async run(event: OutboxEvent, run: HandlerCompletion): Promise<void> {
    const p = event.payload as { kind: string; key: string; version: number };
    const ctx = { tenantId: event.tenantId, actor: systemActor('jobs') };
    const rebuilds = p.kind === 'recordType' ? await this.rebuildsAfter(event.tenantId, p.key, p.version) : [];
    await this.transactions.withTenant(event.tenantId, async (tx) => {
      if (['recordType', 'listView', 'workflow'].includes(p.kind)) await this.jobs.insert(tx, ctx, 'index.build', {}, { unlessQueued: true });
      for (const job of rebuilds) await this.jobs.insert(tx, ctx, job.kind, { recordType: job.recordType });
      await run.complete(tx);
    });
    this.jobs.started();
  }
}
