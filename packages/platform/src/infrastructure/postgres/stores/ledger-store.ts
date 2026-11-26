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

  async lockMoneyBalances(tx, accountIds) {
    // Locked in id order, so two postings that touch the same accounts wait for each other without deadlocking.
    await pg(tx)
      .selectFrom('money_account')
      .select('id')
      .where('tenant_id', '=', TENANT)
      .where('ledger_account_id', '=', sql<string>`any(${accountIds}::uuid[])`)
      .orderBy('id')
      .forUpdate()
      .execute();
    const rows = await pg(tx)
      .selectFrom('money_account as m')
      .innerJoin('ledger_account as a', 'a.id', 'm.ledger_account_id')
      .select([
        'a.id as accountId',
        'a.code',
        'm.name',
        'm.allow_negative as allowNegative',
        sql<string>`coalesce((select sum(l.debit - l.credit) from journal_line l where l.account_id = a.id), 0)::numeric(20,2)::text`.as('balance'),
      ])
      .where('m.tenant_id', '=', TENANT)
      .where('m.ledger_account_id', '=', sql<string>`any(${accountIds}::uuid[])`)
      .execute();
    return rows.map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, balance: r.balance, allowNegative: r.allowNegative }));
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
    if (entry.overdraft) {
      await writeAudit(executorOf(tx), {
        actorId,
        action: 'ledger.overdraft_override',
        entity: 'journal_entry',
        entityId: row!.id,
        after: { reason: entry.overdraft.reason, accounts: entry.overdraft.accounts },
      });
    }
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

  async balancesAsOn(tx, { asOf, yearStart }) {
    const { rows } = await sql<{ code: string; name: string; type: string; active: boolean; money_key: string | null; debit: string; credit: string; prior_debit: string; prior_credit: string }>`
      select a.code, a.name, a.type, a.active, m.key as money_key,
             coalesce(sum(x.debit) filter (where a.type in ('asset', 'liability', 'equity') or x.entry_date >= ${yearStart}::date), 0)::numeric(20, 2)::text as debit,
             coalesce(sum(x.credit) filter (where a.type in ('asset', 'liability', 'equity') or x.entry_date >= ${yearStart}::date), 0)::numeric(20, 2)::text as credit,
             coalesce(sum(x.debit) filter (where a.type not in ('asset', 'liability', 'equity') and x.entry_date < ${yearStart}::date), 0)::numeric(20, 2)::text as prior_debit,
             coalesce(sum(x.credit) filter (where a.type not in ('asset', 'liability', 'equity') and x.entry_date < ${yearStart}::date), 0)::numeric(20, 2)::text as prior_credit
        from ledger_account a
        left join money_account m on m.ledger_account_id = a.id and m.tenant_id = a.tenant_id
        left join (
          select l.account_id, l.debit, l.credit, e.entry_date
            from journal_line l join journal_entry e on e.id = l.entry_id
           where e.entry_date <= ${asOf}::date
        ) x on x.account_id = a.id
       where a.tenant_id = app_tenant()
       group by a.code, a.name, a.type, a.active, m.key
       order by a.code`.execute(pg(tx));
    return rows.map((r) => ({ code: r.code, name: r.name, type: r.type, active: r.active, moneyKey: r.money_key, debit: r.debit, credit: r.credit, priorDebit: r.prior_debit, priorCredit: r.prior_credit }));
  },});
