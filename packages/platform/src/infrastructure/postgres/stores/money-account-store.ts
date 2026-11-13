import { sql } from 'kysely';
import type { MoneyAccount, MoneyAccountKind, MoneyAccountStore } from '../../../domain/accounts/ports/money-account-store.js';
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
    const ledger = await k
      .insertInto('ledger_account')
      .values({ tenant_id: TENANT, code: account.ledgerCode, name: account.name, type: 'asset' })
      .onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!ledger) return false;
    await k
      .insertInto('money_account')
      .values({
        tenant_id: TENANT,
        key: account.key,
        name: account.name,
        kind: account.kind,
        ledger_account_id: ledger.id,
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

  async list(tx) {
    const rows = await selectAccounts(tx).orderBy('m.kind').orderBy('m.name').execute();
    return rows.map(toAccount);
  },

  async byKey(tx, key) {
    const row = await selectAccounts(tx).where('m.key', '=', key).executeTakeFirst();
    return row ? toAccount(row) : undefined;
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
