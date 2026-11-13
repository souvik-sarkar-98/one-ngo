import { sql } from 'kysely';
import { writeAudit } from './audit-store.js';
import type { FiscalYearSettings, LedgerStore } from '../../../domain/ledger/ports/ledger-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { PostgresSequenceStore } from './sequence-store.js';
import { executorOf, pg } from '../tx.js';

const TENANT = sql<string>`app_tenant()`;

export const pgFiscalYearSettings = (sequences: PostgresSequenceStore): FiscalYearSettings => ({
  holdFiscalYearStart: (tx: Tx) => sequences.holdFiscalYearStart(executorOf(tx), 'shared'),
  fiscalYearStartMonth: (tx: Tx) => sequences.fiscalYearStartMonth(executorOf(tx)),
});

export const pgLedgerStore = (sequences: PostgresSequenceStore): LedgerStore => ({
  ...pgFiscalYearSettings(sequences),

  async openPeriod(tx, actorId, { key, startsOn, endsOn }) {
    await pg(tx)
      .insertInto('fiscal_period')
      .values({ tenant_id: TENANT, key, starts_on: startsOn, ends_on: endsOn })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
      .execute();
    await writeAudit(executorOf(tx), { actorId, action: 'period.opened', entity: 'fiscal_period', entityId: key });
  },

  async closePeriod(tx, actorId, key) {
    const rows = await pg(tx)
      .updateTable('fiscal_period')
      .set({ status: 'closed', closed_at: sql<Date>`now()` })
      .where('tenant_id', '=', TENANT)
      .where('key', '=', key)
      .where('status', '=', 'open')
      .returning('id')
      .execute();
    if (!rows.length) return false;
    await writeAudit(executorOf(tx), { actorId, action: 'period.closed', entity: 'fiscal_period', entityId: key });
    return true;
  },

  async reopenPeriod(tx, actorId, key, reason) {
    const rows = await pg(tx)
      .updateTable('fiscal_period')
      .set({ status: 'open', reopen_reason: reason })
      .where('tenant_id', '=', TENANT)
      .where('key', '=', key)
      .where('status', '=', 'closed')
      .returning('id')
      .execute();
    if (!rows.length) return false;
    await writeAudit(executorOf(tx), { actorId, action: 'period.reopened', entity: 'fiscal_period', entityId: key, after: { reason } });
    return true;
  },

  accounts(tx, codes) {
    return pg(tx)
      .selectFrom('ledger_account')
      .select(['id', 'code', 'active'])
      .where('tenant_id', '=', TENANT)
      .where('code', '=', sql<string>`any(${codes})`)
      .execute();
  },

  period(tx, key) {
    return pg(tx).selectFrom('fiscal_period').select(['id', 'status']).where('tenant_id', '=', TENANT).where('key', '=', key).executeTakeFirst();
  },

  async insertEntry(tx, actorId, entry) {
    const k = pg(tx);
    const row = await k
      .insertInto('journal_entry')
      .values({
        tenant_id: TENANT,
        period_id: entry.periodId,
        entry_date: entry.date,
        memo: entry.memo,
        source_record_id: entry.sourceRecordId,
        source_rule: entry.sourceRule,
        reverses_entry_id: entry.reversesEntryId,
        created_by: actorId,
      })
      .returning('id')
      .executeTakeFirst();
    for (const l of entry.lines) {
      await k
        .insertInto('journal_line')
        .values({ tenant_id: TENANT, entry_id: row!.id, account_id: l.accountId, debit: l.debit, credit: l.credit, fund: l.fund })
        .execute();
    }
    await writeAudit(executorOf(tx), {
      actorId,
      action: 'journal.posted',
      entity: 'journal_entry',
      entityId: row!.id,
      after: { date: entry.date, total: entry.total, source: entry.sourceRule },
    });
    return row!.id;
  },

  async entryStatus(tx, entryId) {
    const row = await pg(tx).selectFrom('journal_entry').select('status').where('tenant_id', '=', TENANT).where('id', '=', entryId).executeTakeFirst();
    return row?.status;
  },

  entryLines(tx, entryId) {
    return pg(tx)
      .selectFrom('journal_line as l')
      .innerJoin('ledger_account as a', 'a.id', 'l.account_id')
      .select(['a.code', sql<string>`l.debit::text`.as('debit'), sql<string>`l.credit::text`.as('credit'), 'l.fund'])
      .where('l.entry_id', '=', entryId)
      .execute();
  },

  async markReversed(tx, entryId) {
    await pg(tx).updateTable('journal_entry').set({ status: 'reversed' }).where('id', '=', entryId).execute();
  },

  trialBalance(tx, fiscalYear) {
    return pg(tx)
      .selectFrom('ledger_account as a')
      .leftJoin(
        (eb) =>
          eb
            .selectFrom('journal_line as l')
            .innerJoin('journal_entry as e', 'e.id', 'l.entry_id')
            .innerJoin('fiscal_period as p', 'p.id', 'e.period_id')
            .select(['l.account_id', 'l.debit', 'l.credit'])
            .where('p.key', '=', fiscalYear)
            .as('y'),
        (join) => join.onRef('y.account_id', '=', 'a.id'),
      )
      .select([
        'a.code',
        'a.name',
        'a.type',
        sql<string>`coalesce(sum(y.debit), 0)::numeric(14, 2)::text`.as('debit'),
        sql<string>`coalesce(sum(y.credit), 0)::numeric(14, 2)::text`.as('credit'),
      ])
      .where('a.tenant_id', '=', TENANT)
      .groupBy(['a.code', 'a.name', 'a.type'])
      .orderBy('a.code')
      .execute();
  },
});
