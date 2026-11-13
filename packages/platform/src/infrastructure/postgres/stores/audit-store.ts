import { sql } from 'kysely';
import type { SqlExecutor } from '../db.js';
import { typed } from '../kysely.js';
import type { AuditInput } from '../../../domain/ports/audit-trail.js';

export type { AuditInput } from '../../../domain/ports/audit-trail.js';

export async function writeAudit(tx: SqlExecutor, input: AuditInput): Promise<void> {
  await typed(tx)
    .insertInto('audit_event')
    .values({
      tenant_id: sql<string>`app_tenant()`,
      actor_id: input.actorId,
      action: input.action,
      entity: input.entity,
      entity_id: input.entityId ?? null,
      before: input.before === undefined ? null : JSON.stringify(input.before),
      after: input.after === undefined ? null : JSON.stringify(input.after),
    })
    .execute();
}

export async function enqueueEvent(tx: SqlExecutor, type: string, payload: unknown): Promise<void> {
  await typed(tx)
    .insertInto('outbox_event')
    .values({ tenant_id: sql<string>`app_tenant()`, type, payload: JSON.stringify(payload) })
    .execute();
}
