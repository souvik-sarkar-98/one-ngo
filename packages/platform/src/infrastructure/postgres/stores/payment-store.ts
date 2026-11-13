import { sql } from 'kysely';
import type { GatewayName, IntentStatus, OnPaid, PaymentStore, ProviderName, StoredGateway, StoredIntent } from '../../../domain/payments/ports/payment-store.js';
import { enqueueEvent, writeAudit } from './audit-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { executorOf, pg } from '../tx.js';

interface IntentRow {
  id: string;
  record_id: string;
  provider: ProviderName;
  amount: string;
  reference: string;
  status: IntentStatus;
  upi_link: string | null;
  on_paid: OnPaid;
  provider_order_id: string | null;
}

const TENANT = sql<string>`app_tenant()`;

const COLUMNS = [
  'id',
  'record_id',
  'provider',
  sql<string>`amount::text`.as('amount'),
  'reference',
  'status',
  'upi_link',
  'on_paid',
  'provider_order_id',
] as const;

const selectIntents = (tx: Tx) => pg(tx).selectFrom('payment_intent').select(COLUMNS).where('tenant_id', '=', TENANT).$castTo<IntentRow>();

const toIntent = (r: IntentRow): StoredIntent => ({
  id: r.id,
  recordId: r.record_id,
  provider: r.provider,
  amount: r.amount,
  reference: r.reference,
  status: r.status,
  upiLink: r.upi_link,
  onPaid: r.on_paid,
  providerOrderId: r.provider_order_id,
});

export const pgPaymentStore: PaymentStore = {
  async saveGateway(tx, actorId, provider, config, secretEnc) {
    await pg(tx)
      .insertInto('connector')
      .values({
        tenant_id: TENANT,
        key: provider,
        type: provider,
        config: JSON.stringify(config),
        secret_enc: secretEnc,
        updated_by: actorId,
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'key']).doUpdateSet({
          config: (eb) => eb.ref('excluded.config'),
          secret_enc: (eb) => eb.ref('excluded.secret_enc'),
          updated_by: (eb) => eb.ref('excluded.updated_by'),
          updated_at: sql<Date>`now()`,
          enabled: true,
        }),
      )
      .execute();
    await writeAudit(executorOf(tx), { actorId, action: 'connector.saved', entity: 'connector', entityId: provider });
  },

  async gateways(tx, providers) {
    const rows = await pg(tx)
      .selectFrom('connector')
      .select(['key', 'config', 'enabled', 'secret_enc'])
      .where('tenant_id', '=', TENANT)
      .where('key', 'in', providers)
      .whereRef('type', '=', 'key')
      .$castTo<{ key: GatewayName; config: StoredGateway['config']; enabled: boolean; secret_enc: string | null }>()
      .execute();
    return rows.map((r) => ({ key: r.key, config: r.config, enabled: r.enabled, secretEnc: r.secret_enc }));
  },

  async enabledGateway(tx, provider) {
    const row = await pg(tx)
      .selectFrom('connector')
      .select(['config', 'secret_enc'])
      .where('tenant_id', '=', TENANT)
      .where('key', '=', provider)
      .where((eb) => eb.ref('enabled'))
      .$castTo<{ config: { keyId: string; environment?: 'sandbox' | 'production' }; secret_enc: string | null }>()
      .executeTakeFirst();
    return row ? { config: row.config, secretEnc: row.secret_enc } : undefined;
  },

  async upiPayee(tx, accountKey) {
    const row = await pg(tx)
      .selectFrom('money_account as m')
      .innerJoin('tenant as t', 't.id', 'm.tenant_id')
      .select(['m.upi_id', 't.name'])
      .where('m.tenant_id', '=', TENANT)
      .where('m.key', '=', accountKey)
      .where('m.status', '=', 'active')
      .executeTakeFirst();
    return row ? { upiId: row.upi_id, payeeName: row.name } : undefined;
  },

  async createIntent(tx, actorId, intent) {
    let open = false;
    const rows = await pg(tx)
      .insertInto('payment_intent')
      .values({
        tenant_id: TENANT,
        record_id: intent.recordId,
        provider: intent.provider,
        amount: intent.amount,
        reference: intent.reference,
        on_paid: JSON.stringify(intent.onPaid),
        upi_link: intent.upiLink,
        provider_order_id: intent.providerOrderId,
        created_by: actorId,
      })
      .returning(COLUMNS)
      .$castTo<IntentRow>()
      .execute()
      .catch((e: Error) => {
        if (!/payment_intent_one_open/.test(e.message)) throw e;
        open = true;
        return [];
      });
    if (open) return undefined;
    await writeAudit(executorOf(tx), {
      actorId,
      action: 'payment.requested',
      entity: 'payment_intent',
      entityId: rows[0]!.id,
      after: { provider: intent.provider, amount: intent.amount, reference: intent.reference },
    });
    return toIntent(rows[0]!);
  },

  async intent(tx, intentId) {
    const row = await selectIntents(tx).where('id', '=', intentId).executeTakeFirst();
    return row ? toIntent(row) : undefined;
  },

  async awaitingIntents(tx) {
    const rows = await selectIntents(tx).where('status', '=', 'awaiting_payment').execute();
    return rows.map(toIntent);
  },

  async intentByOrder(tx, provider, orderId) {
    const row = await selectIntents(tx).where('provider', '=', provider).where('provider_order_id', '=', orderId).executeTakeFirst();
    return row ? toIntent(row) : undefined;
  },

  async paidIntent(tx, intentId) {
    const row = await pg(tx)
      .selectFrom('payment_intent as i')
      .innerJoin('record as r', 'r.id', 'i.record_id')
      .select([
        'i.id',
        'i.record_id',
        'i.provider',
        sql<string>`i.amount::text`.as('amount'),
        'i.reference',
        'i.status',
        'i.upi_link',
        'i.on_paid',
        'i.provider_order_id',
        sql<string>`i.paid_on::text`.as('paid_on'),
        'i.provider_payment_id',
        'r.type_key as record_type',
        'r.version as record_version',
        'r.status as record_status',
      ])
      .where('i.tenant_id', '=', TENANT)
      .where('i.id', '=', intentId)
      .$castTo<IntentRow & { paid_on: string; provider_payment_id: string | null; record_type: string; record_version: number; record_status: string }>()
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      ...toIntent(row),
      paidOn: row.paid_on,
      providerPaymentId: row.provider_payment_id,
      recordType: row.record_type,
      recordVersion: row.record_version,
      recordStatus: row.record_status,
    };
  },

  async recordEvent(tx, provider, eventId, payload) {
    const inserted = await pg(tx)
      .insertInto('payment_event')
      .values({ tenant_id: TENANT, provider, provider_event_id: eventId, payload })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .execute();
    return inserted.length > 0;
  },

  async markFailed(tx, intentId) {
    await pg(tx).updateTable('payment_intent').set({ status: 'failed' }).where('id', '=', intentId).execute();
  },

  noteAmountMismatch: (tx, actorId, intentId, details) =>
    writeAudit(executorOf(tx), { actorId, action: 'payment.amount_mismatch', entity: 'payment_intent', entityId: intentId, after: details }),

  notePaidStepRefused: (tx, actorId, intentId, details) =>
    writeAudit(executorOf(tx), { actorId, action: 'payment.paid_step_refused', entity: 'payment_intent', entityId: intentId, after: details }),

  async markPaid(tx, actorId, input) {
    const rows = await pg(tx)
      .updateTable('payment_intent')
      .set((eb) => ({
        status: 'paid',
        paid_on: input.paidOn,
        provider_payment_id: eb.fn.coalesce(eb.val(input.providerPaymentId), eb.ref('provider_payment_id')),
        confirmed_by: actorId,
        paid_at: sql<Date>`now()`,
      }))
      .where('tenant_id', '=', TENANT)
      .where('id', '=', input.intentId)
      .where('status', '=', 'awaiting_payment')
      .returning('id')
      .execute();
    if (!rows.length) return false;
    await writeAudit(executorOf(tx), {
      actorId,
      action: 'payment.confirmed',
      entity: 'payment_intent',
      entityId: input.intentId,
      after: { paidOn: input.paidOn, providerPaymentId: input.providerPaymentId },
    });
    await enqueueEvent(executorOf(tx), 'payment.confirmed', { intentId: input.intentId });
    return true;
  },

  async recordStatus(tx, recordId) {
    const row = await pg(tx).selectFrom('record').select('status').where('tenant_id', '=', TENANT).where('id', '=', recordId).executeTakeFirst();
    return row?.status ?? undefined;
  },
};
