import { sql } from 'kysely';
import type { LedgerStatementLine, MoneyAccount, MoneyAccountKind, MoneyAccountStore } from '../../../domain/accounts/ports/money-account-store.js';
import { writeAudit } from './audit-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { executorOf, pg } from '../tx.js';

interface AccountRow {
  id: string;
  key: string;
  name: string;
  kind: MoneyAccountKind;
  code: string;
  holder_user_id: string | null;
  custodian: string | null;
  upi_id: string | null;
  allow_negative: boolean;
  status: 'active' | 'closed';
  balance: string;
}

const TENANT = sql<string>`app_tenant()`;

const selectAccounts = (tx: Tx) =>
  pg(tx)
    .selectFrom('money_account as m')
    .innerJoin('ledger_account as a', 'a.id', 'm.ledger_account_id')
    .select([
      'm.id',
      'm.key',
      'm.name',
      'm.kind',
      'a.code',
      'm.holder_user_id',
      'm.custodian',
      'm.upi_id',
      'm.allow_negative',
      'm.status',
      sql<string>`coalesce((select sum(l.debit - l.credit) from journal_line l where l.account_id = m.ledger_account_id), 0)::numeric(14, 2)::text`.as(
        'balance',
      ),
    ])
    .where('m.tenant_id', '=', TENANT)
    .$narrowType<Pick<AccountRow, 'kind' | 'status'>>();

const toAccount = (r: AccountRow): MoneyAccount => ({
  id: r.id,
  key: r.key,
  name: r.name,
  kind: r.kind,
  ledgerCode: r.code,
  holderUserId: r.holder_user_id,
  custodian: r.custodian,
  upiId: r.upi_id,
  allowNegative: r.allow_negative,
  status: r.status,
  balance: r.balance,
});

export const pgMoneyAccountStore: MoneyAccountStore = {
  async open(tx, actorId, account, audit) {
    const k = pg(tx);
    let ledgerId = account.ledgerAccountId;
    if (!ledgerId) {
      const ledger = await k
        .insertInto('ledger_account')
        .values({ tenant_id: TENANT, code: account.ledgerCode, name: account.name, type: 'asset' })
        .onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!ledger) return false;
      ledgerId = ledger.id;
    }
    await k
      .insertInto('money_account')
      .values({
        tenant_id: TENANT,
        key: account.key,
        name: account.name,
        kind: account.kind,
        ledger_account_id: ledgerId,
        holder_user_id: account.holderUserId,
        custodian: account.custodian,
        upi_id: account.upiId,
        allow_negative: account.allowNegative,
        created_by: actorId,
      })
      .execute();
    await writeAudit(executorOf(tx), { actorId, action: 'money_account.opened', entity: 'money_account', entityId: account.key, after: audit });
    return true;
  },

  async ledgerAccount(tx, code) {
    const row = await pg(tx)
      .selectFrom('ledger_account as a')
      .leftJoin('money_account as m', 'm.ledger_account_id', 'a.id')
      .select(['a.id', 'a.type', 'a.active', 'm.id as money_id'])
      .where('a.tenant_id', '=', TENANT)
      .where('a.code', '=', code)
      .executeTakeFirst();
    return row ? { id: row.id, type: row.type, active: row.active, linked: row.money_id !== null } : undefined;
  },

  async update(tx, actorId, key, change, audit) {
    const set: Record<string, unknown> = {};
    if (change.name !== undefined) set['name'] = change.name;
    if (change.custodian !== undefined) set['custodian'] = change.custodian;
    if (change.upiId !== undefined) set['upi_id'] = change.upiId;
    if (change.allowNegative !== undefined) set['allow_negative'] = change.allowNegative;
    const row = await pg(tx)
      .updateTable('money_account')
      .set(set)
      .where('tenant_id', '=', TENANT)
      .where('key', '=', key)
      .where('status', '=', 'active')
      .returning('id')
      .executeTakeFirst();
    if (!row) return false;
    await writeAudit(executorOf(tx), { actorId, action: 'money_account.updated', entity: 'money_account', entityId: key, after: audit });
    return true;
  },

  async list(tx) {
    const rows = await selectAccounts(tx).orderBy('m.kind').orderBy('m.name').execute();
    return rows.map(toAccount);
  },

  async byKey(tx, key) {
    const row = await selectAccounts(tx).where('m.key', '=', key).executeTakeFirst();
    return row ? toAccount(row) : undefined;
  },

  async balancesAsOf(tx, asOf) {
    const rows = await pg(tx)
      .selectFrom('money_account as m')
      .innerJoin('ledger_account as a', 'a.id', 'm.ledger_account_id')
      .select([
        'm.key',
        'm.name',
        'm.kind',
        'a.code',
        sql<string>`coalesce((select sum(l.debit - l.credit) from journal_line l join journal_entry e on e.id = l.entry_id where l.account_id = m.ledger_account_id and e.entry_date <= ${asOf}::date), 0)::numeric(14, 2)::text`.as(
          'balance',
        ),
      ])
      .where('m.tenant_id', '=', TENANT)
      .where('m.status', '=', 'active')
      .orderBy('m.kind')
      .orderBy('m.name')
      .execute();
    return rows.map((r) => ({ key: r.key, name: r.name, kind: r.kind as MoneyAccountKind, ledgerCode: r.code, balance: r.balance }));
  },

  async ledgerStatement(tx, key, range, page) {
    const db = pg(tx);
    const account = sql`(select ledger_account_id from money_account where tenant_id = app_tenant() and key = ${key})`;
    const { rows: head } = await sql<{ opening: string; total_in: string; total_out: string; count: string }>`
      select
        coalesce(sum(l.debit - l.credit) filter (where e.entry_date < ${range.from}::date), 0)::numeric(14, 2)::text as opening,
        coalesce(sum(l.debit) filter (where e.entry_date between ${range.from}::date and ${range.to}::date), 0)::numeric(14, 2)::text as total_in,
        coalesce(sum(l.credit) filter (where e.entry_date between ${range.from}::date and ${range.to}::date), 0)::numeric(14, 2)::text as total_out,
        count(*) filter (where e.entry_date between ${range.from}::date and ${range.to}::date)::text as count
      from journal_line l
      join journal_entry e on e.id = l.entry_id
      where l.tenant_id = app_tenant() and l.account_id = ${account} and e.entry_date <= ${range.to}::date`.execute(db);
    const { opening, total_in, total_out, count } = head[0]!;
    const { rows } = await sql<{
      id: string;
      entry_id: string;
      date: string;
      memo: string | null;
      debit: string;
      credit: string;
      balance: string;
      status: string;
      is_reversal: boolean;
      transfer_id: string | null;
      record_id: string | null;
      record_type: string | null;
      record_number: string | null;
    }>`
      select l.id, e.id as entry_id, to_char(e.entry_date, 'YYYY-MM-DD') as date, e.memo,
             l.debit::numeric(14, 2)::text as debit, l.credit::numeric(14, 2)::text as credit,
             (${opening}::numeric + sum(l.debit - l.credit) over (order by e.entry_date, e.created_at, l.id))::numeric(14, 2)::text as balance,
             e.status, e.reverses_entry_id is not null as is_reversal, t.id as transfer_id,
             r.id as record_id, r.type_key as record_type, r.number as record_number
        from journal_line l
        join journal_entry e on e.id = l.entry_id
        left join journal_entry undone on undone.id = e.reverses_entry_id
        left join transfer t on t.journal_entry_id = coalesce(undone.id, e.id)
        left join record r on r.id = coalesce(e.source_record_id, undone.source_record_id)
       where l.tenant_id = app_tenant() and l.account_id = ${account}
         and e.entry_date between ${range.from}::date and ${range.to}::date
       order by e.entry_date, e.created_at, l.id
       limit ${page.limit} offset ${page.offset}`.execute(db);
    const lines = rows.map(
      (r): LedgerStatementLine => ({
        id: r.id,
        entryId: r.entry_id,
        date: r.date,
        memo: r.memo,
        debit: r.debit,
        credit: r.credit,
        balance: r.balance,
        kind: r.is_reversal ? 'reversal' : r.transfer_id ? 'transfer' : r.record_id ? 'record' : 'manual',
        reversed: r.status === 'reversed',
        sourceRecordId: r.record_id,
        sourceRecordType: r.record_type,
        sourceRecordNumber: r.record_number,
      }),
    );
    const closingPaise = Math.round(Number(opening) * 100) + Math.round(Number(total_in) * 100) - Math.round(Number(total_out) * 100);
    return { opening, totalIn: total_in, totalOut: total_out, closing: (closingPaise / 100).toFixed(2), count: Number(count), lines };
  },

  async ledgerAccounts(tx) {
    const rows = await pg(tx)
      .selectFrom('ledger_account as a')
      .leftJoin('money_account as m', 'm.ledger_account_id', 'a.id')
      .select(['a.code', 'a.name', 'a.type', 'a.active', 'm.key as money_key'])
      .where('a.tenant_id', '=', TENANT)
      .orderBy('a.code')
      .execute();
    return rows.map((r) => ({ code: r.code, name: r.name, type: r.type, active: r.active, moneyKey: r.money_key }));
  },

  async lock(tx, keys) {
    const locked = await pg(tx)
      .selectFrom('money_account')
      .select('key')
      .where('tenant_id', '=', TENANT)
      .where('key', '=', sql<string>`any(${keys})`)
      .orderBy('key')
      .forUpdate()
      .execute();
    return locked.length;
  },

  async transferMatrix(tx, settingKey) {
    const setting = await pg(tx)
      .selectFrom('tenant_setting')
      .select('value')
      .where('tenant_id', '=', TENANT)
      .where('key', '=', settingKey)
      .$narrowType<{ value: [string, string][] }>()
      .executeTakeFirst();
    return setting?.value;
  },

  async recordTransfer(tx, actorId, t, audit) {
    const row = await pg(tx)
      .insertInto('transfer')
      .values({
        tenant_id: TENANT,
        from_account_id: t.fromAccountId,
        to_account_id: t.toAccountId,
        amount: t.amount,
        transfer_date: t.date,
        reference: t.reference,
        journal_entry_id: t.journalEntryId,
        created_by: actorId,
      })
      .returning('id')
      .executeTakeFirst();
    await writeAudit(executorOf(tx), {
      actorId,
      action: 'money.transferred',
      entity: 'transfer',
      entityId: row!.id,
      after: { from: audit.from, to: audit.to, amount: t.amount },
    });
    return row!.id;
  },

  async close(tx, actorId, key, ledgerCode) {
    const k = pg(tx);
    await k.updateTable('money_account').set({ status: 'closed' }).where('tenant_id', '=', TENANT).where('key', '=', key).execute();
    await k.updateTable('ledger_account').set({ active: false }).where('tenant_id', '=', TENANT).where('code', '=', ledgerCode).execute();
    await writeAudit(executorOf(tx), { actorId, action: 'money_account.closed', entity: 'money_account', entityId: key });
  },
};
