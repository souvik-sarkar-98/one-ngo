import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import { NOW } from '../../sql-fragments.js';
import { MAX_ATTEMPTS } from '../../../outbox/outbox-dispatcher.js';
import type { ConnectorOutbox } from '../../../../application/connectors/ports/connector-runtime.js';

/** The owner-level outbox capability. */
export function pgOutboxRequeue(db: Database): ConnectorOutbox {
  return {
    async requeue(tenantId, eventId) {
      await db.asSystem((tx) =>
        typed(tx)
          .updateTable('outbox_event')
          .set({ status: 'pending', available_at: NOW, attempts: sql<number>`least(attempts, ${MAX_ATTEMPTS - 1})`, done_handlers: sql<string[]>`'{}'` })
          .where('id', '=', eventId)
          .where('tenant_id', '=', tenantId)
          .execute(),
      );
    },
  };
}
