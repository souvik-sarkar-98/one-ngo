import { sql } from 'kysely';
import type { Receipt, ReceiptContent, ReceiptStore } from '../../../domain/receipts/ports/receipt-store.js';
import { writeAudit } from './audit-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { PostgresSequenceStore } from './sequence-store.js';
import { executorOf, pg } from '../tx.js';
import { pgFiscalYearSettings } from './ledger-store.js';

interface ReceiptRow {
  id: string;
  number: string;
  series_key: string;
  period: string;
  amount: string;
  receipt_date: string;
  status: 'issued' | 'void';
  void_reason: string | null;
  replaces_receipt_id: string | null;
  record_id: string | null;
}

const TENANT = sql<string>`app_tenant()`;

const COLUMNS = [
  'id',
  'number',
  'series_key',
  'period',
  sql<string>`amount::text`.as('amount'),
  sql<string>`receipt_date::text`.as('receipt_date'),
  'status',
  'void_reason',
  'replaces_receipt_id',
  'record_id',
] as const;

const selectReceipts = (tx: Tx) =>
  pg(tx).selectFrom('receipt').select(COLUMNS).where('tenant_id', '=', TENANT).$narrowType<Pick<ReceiptRow, 'status'>>();

const toReceipt = (r: ReceiptRow): Receipt => ({
  id: r.id,
  number: r.number,
  seriesKey: r.series_key,
  period: r.period,
  amount: r.amount,
  date: r.receipt_date,
  status: r.status,
  voidReason: r.void_reason,
  replacesReceiptId: r.replaces_receipt_id,
  recordId: r.record_id,
});

export const pgReceiptStore = (sequences: PostgresSequenceStore): ReceiptStore => ({
  ...pgFiscalYearSettings(sequences),

  series(tx, key) {
    return pg(tx).selectFrom('receipt_series').select(['key', 'label', 'prefix', 'reset']).where('tenant_id', '=', TENANT).where('key', '=', key).executeTakeFirst();
  },

  nextNumber: (tx, counter, period) => sequences.nextSequenceValue(executorOf(tx), counter, period),
  raiseNumber: (tx, counter, period, next) => sequences.raiseSequenceValue(executorOf(tx), counter, period, next),

  async insert(tx, actorId, r) {
    const k = pg(tx);
    const row = await k
      .insertInto('receipt')
      .values({
        tenant_id: TENANT,
        series_key: r.seriesKey,
        period: r.period,
        seq: r.seq,
        number: r.number,
        record_id: r.recordId,
        amount: r.amount,
        receipt_date: r.date,
        replaces_receipt_id: r.replacesReceiptId,
        issued_by: actorId,
      })
      .returning(COLUMNS)
      .$narrowType<Pick<ReceiptRow, 'status'>>()
      .executeTakeFirst();
    await k
      .insertInto('receipt_issuer')
      .values({
        receipt_id: row!.id,
        tenant_id: TENANT,
        issuer: JSON.stringify(r.issuer),
        logo_file_id: r.issuer.logo?.fileId ?? null,
        signatory_file_id: r.issuer.signatory?.file?.fileId ?? null,
      })
      .execute();
    if (r.content) {
      await k
        .insertInto('receipt_content')
        .values({ receipt_id: row!.id, tenant_id: TENANT, content: JSON.stringify(r.content) })
        .execute();
    }
    await writeAudit(executorOf(tx), {
      actorId,
      action: 'receipt.issued',
      entity: 'receipt',
      entityId: row!.id,
      after: { number: r.number, amount: row!.amount, replaces: r.replacesReceiptId },
    });
    return toReceipt(row!);
  },

  async void(tx, actorId, receiptId, reason) {
    const row = await pg(tx)
      .updateTable('receipt')
      .set({ status: 'void', void_reason: reason, voided_at: sql<Date>`now()` })
      .where('tenant_id', '=', TENANT)
      .where('id', '=', receiptId)
      .where('status', '=', 'issued')
      .returning(COLUMNS)
      .$narrowType<Pick<ReceiptRow, 'status'>>()
      .executeTakeFirst();
    if (!row) return undefined;
    await writeAudit(executorOf(tx), {
      actorId,
      action: 'receipt.voided',
      entity: 'receipt',
      entityId: receiptId,
      after: { number: row.number, reason },
    });
    return toReceipt(row);
  },

  async exists(tx, receiptId) {
    const row = await pg(tx).selectFrom('receipt').select(sql<number>`1`.as('one')).where('tenant_id', '=', TENANT).where('id', '=', receiptId).executeTakeFirst();
    return !!row;
  },

  async get(tx, receiptId) {
    const row = await selectReceipts(tx).where('id', '=', receiptId).executeTakeFirst();
    return row ? toReceipt(row) : undefined;
  },

  async issuer(tx, receiptId) {
    const row = await pg(tx).selectFrom('receipt_issuer').select('issuer').where('tenant_id', '=', TENANT).where('receipt_id', '=', receiptId).executeTakeFirst();
    return row?.issuer as Awaited<ReturnType<ReceiptStore['issuer']>>;
  },

  async content(tx, receiptId) {
    const row = await pg(tx).selectFrom('receipt_content').select('content').where('tenant_id', '=', TENANT).where('receipt_id', '=', receiptId).executeTakeFirst();
    const value = row?.content;
    if (!value) return undefined;
    return (typeof value === 'string' ? JSON.parse(value) : value) as ReceiptContent;
  },

  async forRecord(tx, recordId) {
    const rows = await selectReceipts(tx).where('record_id', '=', recordId).orderBy('issued_at').execute();
    return rows.map(toReceipt);
  },
});
