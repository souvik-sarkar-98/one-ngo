import { sql } from 'kysely';
import type { ClaimedEvent, OutboxStore } from '../../outbox/ports/outbox-store.js';
import type { Database, SqlExecutor } from '../db.js';
import { typed } from '../kysely.js';

const LEASE_END = sql<Date>`now() + interval '5 minutes'`;

async function recordDone(tx: SqlExecutor, eventId: string, name: string): Promise<void> {
  await typed(tx)
    .updateTable('outbox_event')
    .set({ done_handlers: sql<string[]>`array_append(done_handlers, ${name})` })
    .where('id', '=', eventId)
    .where(sql<boolean>`not (${name} = any(done_handlers))`)
    .execute();
}

/** The outbox table in PostgreSQL: the statements of the outbox dispatcher, so the dispatcher itself holds none. */
export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly db: Database) {}

  async claim(n: number): Promise<ClaimedEvent[]> {
    const rows = await this.db.asSystem((tx) =>
      typed(tx)
        .updateTable('outbox_event')
        .set((eb) => ({
          status: 'processing',
          attempts: eb('attempts', '+', eb.lit(1)),
          locked_until: LEASE_END,
        }))
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('outbox_event')
            .select('id')
            .where((w) =>
              w.or([
                w.and([w('status', '=', 'pending'), w('available_at', '<=', sql<Date>`now()`)]),
                w.and([w('status', '=', 'processing'), w('locked_until', '<', sql<Date>`now()`)]),
              ]),
            )
            .orderBy('created_at')
            .limit(n)
            .forUpdate()
            .skipLocked(),
        )
        .returning(['id', 'tenant_id', 'type', 'payload', 'attempts', 'done_handlers'])
        .execute(),
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      type: r.type,
      payload: r.payload,
      attempts: r.attempts,
      doneHandlers: r.done_handlers,
    }));
  }

  async markDone(eventId: string, attempts: number): Promise<void> {
    await this.db.asSystem((tx) =>
      typed(tx)
        .updateTable('outbox_event')
        .set({ status: 'done', processed_at: sql<Date>`now()`, locked_until: null })
        .where('id', '=', eventId)
        .where('attempts', '=', attempts)
        .execute(),
    );
  }

  async markFailed(eventId: string, attempts: number, final: boolean, message: string): Promise<void> {
    await this.db.asSystem((tx) =>
      typed(tx)
        .updateTable('outbox_event')
        .set({
          status: final ? 'failed' : 'pending',
          last_error: message,
          locked_until: null,
          available_at: sql<Date>`now() + make_interval(mins => ${2 ** attempts})`,
        })
        .where('id', '=', eventId)
        .where('attempts', '=', attempts)
        .execute(),
    );
  }

  async renew(eventId: string, attempts: number): Promise<boolean> {
    const rows = await this.db.asSystem((tx) =>
      typed(tx)
        .updateTable('outbox_event')
        .set({ locked_until: LEASE_END })
        .where('id', '=', eventId)
        .where('status', '=', 'processing')
        .where('attempts', '=', attempts)
        .returning('id')
        .execute(),
    );
    return rows.length > 0;
  }

  recordDone(tx: SqlExecutor, eventId: string, name: string): Promise<void> {
    return recordDone(tx, eventId, name);
  }

  recordDoneNow(eventId: string, name: string): Promise<void> {
    return this.db.asSystem((tx) => recordDone(tx, eventId, name));
  }
}
