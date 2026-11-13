import { sql } from 'kysely';
import type { IdempotencyClaim, IdempotencyKeyStore } from '../../http/ports/idempotency-store.js';
import { IDEMPOTENCY_RUNNING as RUNNING } from '../../http/idempotency-status.js';
import type { Database, TenantContext } from '../db.js';
import { typed } from '../kysely.js';

/** The `idempotency_key` table in PostgreSQL: the statements behind `Idempotency-Key` support. */
export class PostgresIdempotencyKeyStore implements IdempotencyKeyStore {
  constructor(private readonly db: Database) {}

  claim(ctx: TenantContext, key: string, requestHash: string): Promise<IdempotencyClaim | null> {
    return this.db.withTenant(ctx.tenantId, async (tx) => {
      const k = typed(tx);
      // A stale claim is one left by a request that never finished (the process stopped).
      const mine = await k
        .insertInto('idempotency_key')
        .values({
          tenant_id: sql<string>`app_tenant()`,
          actor_id: ctx.actor.id,
          key,
          request_hash: requestHash,
          status_code: RUNNING,
          response: 'null',
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'actor_id', 'key'])
            .doUpdateSet((eb) => ({
              request_hash: eb.ref('excluded.request_hash'),
              status_code: RUNNING,
              response: 'null',
              created_at: sql<Date>`now()`,
            }))
            .where((eb) =>
              eb.or([
                eb('idempotency_key.created_at', '<', sql<Date>`now() - interval '24 hours'`),
                eb.and([
                  eb('idempotency_key.status_code', '=', RUNNING),
                  eb('idempotency_key.created_at', '<', sql<Date>`now() - interval '5 minutes'`),
                ]),
              ]),
            ),
        )
        .returning(sql<number>`1`.as('claimed'))
        .executeTakeFirst();
      if (mine) return null;
      const row = await k
        .selectFrom('idempotency_key')
        .select(['request_hash', 'status_code', 'response'])
        .where('tenant_id', '=', sql<string>`app_tenant()`)
        .where('actor_id', '=', ctx.actor.id)
        .where('key', '=', key)
        .executeTakeFirst();
      return row ?? null;
    });
  }

  async complete(ctx: TenantContext, key: string, status: number, body: unknown): Promise<void> {
    await this.db.withTenant(ctx.tenantId, (tx) =>
      typed(tx)
        .updateTable('idempotency_key')
        .set({ status_code: status, response: JSON.stringify(body ?? null) })
        .where('tenant_id', '=', sql<string>`app_tenant()`)
        .where('actor_id', '=', ctx.actor.id)
        .where('key', '=', key)
        .where('status_code', '=', RUNNING)
        .execute(),
    );
  }

  async release(ctx: TenantContext, key: string): Promise<void> {
    // The runtime role may not delete these rows; only an unfinished claim is removed.
    await this.db.asSystem((tx) =>
      typed(tx)
        .deleteFrom('idempotency_key')
        .where('tenant_id', '=', ctx.tenantId)
        .where('actor_id', '=', ctx.actor.id)
        .where('key', '=', key)
        .where('status_code', '=', RUNNING)
        .execute(),
    );
  }
}
