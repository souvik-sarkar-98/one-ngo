import { sql } from 'kysely';
import type {
  ConnectorListRow,
  ConnectorRow,
  ConnectorStore,
  DeliveryAttempt,
  DeliveryRow,
  DeliveryStatus,
  SaveConnector,
} from '../../../application/connectors/ports/connector-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;
const NOW = sql<Date>`now()`;

export class PgConnectorStore implements ConnectorStore {
  connector(tx: Tx, key: string): Promise<ConnectorRow | undefined> {
    return pg(tx)
      .selectFrom('connector')
      .select(['key', 'type', 'config', 'secret_enc', 'enabled', 'updated_by', 'updated_at'])
      .where('tenant_id', '=', APP_TENANT)
      .where('key', '=', key)
      .$castTo<ConnectorRow>()
      .executeTakeFirst();
  }

  lockConnector(tx: Tx, key: string): Promise<ConnectorRow | undefined> {
    return pg(tx)
      .selectFrom('connector')
      .select(['key', 'type', 'config', 'secret_enc', 'enabled', 'updated_by', 'updated_at'])
      .where('tenant_id', '=', APP_TENANT)
      .where('key', '=', key)
      .forUpdate()
      .$castTo<ConnectorRow>()
      .executeTakeFirst();
  }

  async updateSecrets(tx: Tx, key: string, secretEnc: string | null): Promise<void> {
    await pg(tx).updateTable('connector').set({ secret_enc: secretEnc }).where('tenant_id', '=', APP_TENANT).where('key', '=', key).execute();
  }

  emailSender(tx: Tx): Promise<ConnectorRow | undefined> {
    return pg(tx)
      .selectFrom('connector')
      .select(['key', 'type', 'config', 'secret_enc', 'enabled', 'updated_by', 'updated_at'])
      .where('tenant_id', '=', APP_TENANT)
      .where('type', '=', 'http')
      .where('enabled', '=', true)
      .where(sql<string>`config->>'emailSender'`, '=', 'true')
      .orderBy('key')
      .limit(1)
      .$castTo<ConnectorRow>()
      .executeTakeFirst();
  }

  list(tx: Tx, kinds: readonly string[]): Promise<ConnectorListRow[]> {
    return pg(tx)
      .selectFrom('connector as c')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('connector_delivery as cd')
            .select(['cd.status', 'cd.created_at'])
            .whereRef('cd.tenant_id', '=', 'c.tenant_id')
            .whereRef('cd.connector_key', '=', 'c.key')
            .orderBy('cd.created_at', 'desc')
            .orderBy('cd.id')
            .limit(1)
            .as('d'),
        (j) => j.onTrue(),
      )
      .select(['c.key', 'c.type', 'c.secret_enc', 'c.enabled', 'd.status as last_status', 'd.created_at as last_at'])
      .where('c.tenant_id', '=', APP_TENANT)
      .where('c.type', '=', sql<string>`any(${[...kinds]})`)
      .orderBy('c.key')
      .$narrowType<{ last_status: DeliveryStatus | null }>()
      .execute();
  }

  async enabledKeys(tx: Tx, kind: string): Promise<string[]> {
    const rows = await pg(tx).selectFrom('connector').select('key').where('tenant_id', '=', APP_TENANT).where('type', '=', kind).where('enabled', '=', true).orderBy('key').execute();
    return rows.map((r) => r.key);
  }

  async save(tx: Tx, c: SaveConnector): Promise<void> {
    await pg(tx)
      .insertInto('connector')
      .values({
        tenant_id: APP_TENANT,
        key: c.key,
        type: c.type,
        config: JSON.stringify(c.config),
        secret_enc: c.secretEnc,
        enabled: c.enabled,
        updated_by: c.actorId,
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'key']).doUpdateSet({
          config: (eb) => eb.ref('excluded.config'),
          secret_enc: (eb) => eb.ref('excluded.secret_enc'),
          enabled: (eb) => eb.ref('excluded.enabled'),
          updated_by: (eb) => eb.ref('excluded.updated_by'),
          updated_at: NOW,
        }),
      )
      .execute();
  }

  delivery(tx: Tx, connectorKey: string, deliveryId: string) {
    return pg(tx)
      .selectFrom('connector_delivery')
      .select(['status', 'outbox_event_id'])
      .where('tenant_id', '=', APP_TENANT)
      .where('connector_key', '=', connectorKey)
      .where('id', '=', deliveryId)
      .$narrowType<{ status: DeliveryStatus }>()
      .executeTakeFirst();
  }

  async markDeliveryPending(tx: Tx, deliveryId: string): Promise<void> {
    await pg(tx).updateTable('connector_delivery').set({ status: 'pending' }).where('tenant_id', '=', APP_TENANT).where('id', '=', deliveryId).execute();
  }

  deliveries(tx: Tx, connectorKey: string, limit: number, offset: number): Promise<DeliveryRow[]> {
    return pg(tx)
      .selectFrom('connector_delivery')
      .select(['id', 'event', 'record_id', 'status', 'attempts', 'response_status', 'error', 'created_at', 'last_attempt_at'])
      .where('tenant_id', '=', APP_TENANT)
      .where('connector_key', '=', connectorKey)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(limit)
      .offset(offset)
      .$narrowType<{ status: DeliveryStatus }>()
      .execute();
  }

  async sentFor(tx: Tx, eventId: string): Promise<boolean> {
    const sent = await pg(tx)
      .selectFrom('connector_delivery')
      .select('id')
      .where('tenant_id', '=', APP_TENANT)
      .where('outbox_event_id', '=', eventId)
      .where('status', '=', 'sent')
      .executeTakeFirst();
    return !!sent;
  }

  async recordNotSent(tx: Tx, d: { connectorKey: string; event: string; recordId: string | null; error: string | null; eventId: string }): Promise<void> {
    await pg(tx)
      .insertInto('connector_delivery')
      .values({
        tenant_id: APP_TENANT,
        connector_key: d.connectorKey,
        event: d.event,
        record_id: d.recordId,
        status: 'failed',
        error: d.error,
        outbox_event_id: d.eventId,
      })
      .onConflict((oc) => oc.column('outbox_event_id').doNothing())
      .execute();
  }

  async recordAttempt(tx: Tx, d: DeliveryAttempt): Promise<void> {
    await pg(tx)
      .insertInto('connector_delivery')
      .values({
        tenant_id: APP_TENANT,
        connector_key: d.connectorKey,
        event: d.event,
        record_id: d.recordId,
        status: d.status,
        attempts: 1,
        response_status: d.responseStatus,
        error: d.error,
        last_attempt_at: NOW,
        outbox_event_id: d.eventId,
      })
      .onConflict((oc) =>
        oc.column('outbox_event_id').doUpdateSet({
          status: (eb) => eb.ref('excluded.status'),
          attempts: (eb) => eb('connector_delivery.attempts', '+', 1),
          response_status: (eb) => eb.ref('excluded.response_status'),
          error: (eb) => eb.ref('excluded.error'),
          last_attempt_at: NOW,
        }),
      )
      .execute();
  }

  organisation(tx: Tx) {
    return pg(tx).selectFrom('tenant').select(['id', 'key', 'name']).where('id', '=', APP_TENANT).executeTakeFirst();
  }
}
