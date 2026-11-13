import type { TenantContext } from '../../domain/ports/tenant-context.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';

/** The whole-NGO export as the route sees it: the audit line the request leaves, then the JSON lines. */
export class TenantExportUseCase {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly trail: AuditTrail,
    /** Streams one organisation's data as JSON lines. */
    private readonly streamLines: (tenantId: string, writeLine: (line: string) => void | Promise<void>) => Promise<unknown>,
  ) {}

  /** Records, in its own transaction, that the person exported the organisation's data. */
  audit(ctx: TenantContext): Promise<void> {
    return this.transactions.withTenant(ctx.tenantId, (tx) =>
      this.trail.audit(tx, { actorId: ctx.actor.id, action: 'data.exported', entity: 'tenant', entityId: ctx.tenantId }),
    );
  }

  stream(tenantId: string, writeLine: (line: string) => void | Promise<void>): Promise<unknown> {
    return this.streamLines(tenantId, writeLine);
  }
}
