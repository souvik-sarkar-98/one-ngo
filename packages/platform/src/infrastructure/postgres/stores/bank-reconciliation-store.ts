import { sql } from 'kysely';
import type {
  BankReconciliationStore,
  BookLine,
  SignOff,
  StatementLine,
  StatementLineStatus,
} from '../../../domain/accounts/ports/bank-reconciliation-store.js';
import { writeAudit } from './audit-store.js';
import { executorOf, pg } from '../tx.js';

const TENANT = sql<string>`app_tenant()`;
const day = (column: string) => sql<string>`to_char(${sql.ref(column)}, 'YYYY-MM-DD')`;
const money = (column: string) => sql<string>`${sql.ref(column)}::numeric(14, 2)::text`;

interface LineRow {
  id: string;
  date: string;
  amount: string;
  description: string;
  reference: string | null;
  status: string;
  journal_line_id: string | null;
  note: string | null;
}

const toLine = (r: LineRow): StatementLine => ({
  id: r.id,
  date: r.date,
  amount: r.amount,
  description: r.description,
  reference: r.reference,
  status: r.status as StatementLineStatus,
  journalLineId: r.journal_line_id,
  note: r.note,
});

const lineColumns = [
  's.id',
  day('s.line_date').as('date'),
  money('s.amount').as('amount'),
  's.description',
  's.reference',
  's.status',
  's.journal_line_id',
  's.note',
] as const;

const signOffQuery = (tx: Parameters<typeof pg>[0]) =>
  pg(tx)
    .selectFrom('bank_reconciliation as r')
    .select([
      'r.id',
      day('r.as_of').as('as_of'),
      money('r.statement_balance').as('statement_balance'),
      money('r.book_balance').as('book_balance'),
      money('r.outstanding_book').as('outstanding_book'),
      'r.note',
      'r.signed_off_by',
      sql<string>`to_char(r.signed_off_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as('signed_off_at'),
    ])
    .where('r.tenant_id', '=', TENANT);

const toSignOff = (r: {
  id: string;
  as_of: string;
  statement_balance: string;
  book_balance: string;
  outstanding_book: string;
  note: string | null;
  signed_off_by: string;
  signed_off_at: string;
}): SignOff => ({
  id: r.id,
  asOf: r.as_of,
  statementBalance: r.statement_balance,
  bookBalance: r.book_balance,
  outstandingBook: r.outstanding_book,
  note: r.note,
  signedOffBy: r.signed_off_by,
  signedOffAt: r.signed_off_at,
});

export const pgBankReconciliationStore: BankReconciliationStore = {
  async account(tx, key) {
    const row = await pg(tx)
      .selectFrom('money_account as m')
      .innerJoin('ledger_account as a', 'a.id', 'm.ledger_account_id')
      .select(['m.id', 'm.key', 'm.name', 'm.ledger_account_id', 'a.code', 'm.status'])
      .where('m.tenant_id', '=', TENANT)
      .where('m.key', '=', key)
      .executeTakeFirst();
    return row
      ? { id: row.id, key: row.key, name: row.name, ledgerAccountId: row.ledger_account_id, ledgerCode: row.code, status: row.status as 'active' | 'closed' }
      : undefined;
  },

  async addLines(tx, actorId, accountId, lines) {
    if (!lines.length) return 0;
    const added = await pg(tx)
      .insertInto('bank_statement_line')
      .values(
        lines.map((l) => ({
          tenant_id: TENANT,
          money_account_id: accountId,
          line_date: l.date,
          amount: l.amount,
          description: l.description,
          reference: l.reference,
          fingerprint: l.fingerprint,
          imported_by: actorId,
        })),
      )
      .onConflict((oc) => oc.columns(['tenant_id', 'money_account_id', 'fingerprint']).doNothing())
      .returning('id')
      .execute();
    if (added.length) {
      await writeAudit(executorOf(tx), {
        actorId,
        action: 'bank_statement.imported',
        entity: 'money_account',
        entityId: accountId,
        after: { added: added.length, offered: lines.length },
      });
    }
    return added.length;
  },

  async existingFingerprints(tx, accountId, fingerprints) {
    if (!fingerprints.length) return new Set();
    const rows = await pg(tx)
      .selectFrom('bank_statement_line')
      .select('fingerprint')
      .where('tenant_id', '=', TENANT)
      .where('money_account_id', '=', accountId)
      .where('fingerprint', '=', sql<string>`any(${fingerprints})`)
      .execute();
    return new Set(rows.map((r) => r.fingerprint));
  },

  async lines(tx, accountId, filter) {
    let q = pg(tx)
      .selectFrom('bank_statement_line as s')
      .select(lineColumns)
      .where('s.tenant_id', '=', TENANT)
      .where('s.money_account_id', '=', accountId);
    if (filter.status) q = q.where('s.status', '=', filter.status);
    const rows = await q.orderBy('s.line_date').orderBy('s.seq').limit(filter.limit).execute();
    return rows.map(toLine);
  },

  async lockLine(tx, accountId, lineId) {
    const row = await pg(tx)
      .selectFrom('bank_statement_line as s')
      .select(lineColumns)
      .where('s.tenant_id', '=', TENANT)
      .where('s.money_account_id', '=', accountId)
      .where('s.id', '=', lineId)
      .forUpdate()
      .executeTakeFirst();
    return row ? toLine(row) : undefined;
  },

  async setLine(tx, actorId, lineId, change) {
    await pg(tx)
      .updateTable('bank_statement_line')
      .set({
        status: change.status,
        journal_line_id: change.journalLineId,
        note: change.note,
        resolved_by: change.status === 'unmatched' ? null : actorId,
        resolved_at: change.status === 'unmatched' ? null : sql<Date>`now()`,
      })
      .where('tenant_id', '=', TENANT)
      .where('id', '=', lineId)
      .execute();
    await writeAudit(executorOf(tx), {
      actorId,
      action: `bank_statement.${change.status}`,
      entity: 'bank_statement_line',
      entityId: lineId,
      after: { journalLineId: change.journalLineId, note: change.note },
    });
  },

  async openBookLines(tx, ledgerAccountId, range) {
    let q = pg(tx)
      .selectFrom('journal_line as l')
      .innerJoin('journal_entry as e', 'e.id', 'l.entry_id')
      .leftJoin('bank_statement_line as s', 's.journal_line_id', 'l.id')
      .select([
        'l.id',
        'l.entry_id',
        day('e.entry_date').as('date'),
        'e.memo',
        sql<string>`(l.debit - l.credit)::numeric(14, 2)::text`.as('amount'),
      ])
      .where('l.tenant_id', '=', TENANT)
      .where('l.account_id', '=', ledgerAccountId)
      .where('s.id', 'is', null);
    if (range.from) q = q.where('e.entry_date', '>=', sql<Date>`${range.from}::date`);
    if (range.to) q = q.where('e.entry_date', '<=', sql<Date>`${range.to}::date`);
    const rows = await q.orderBy('e.entry_date').orderBy('l.id').execute();
    return rows.map((r): BookLine => ({ id: r.id, entryId: r.entry_id, date: r.date, memo: r.memo, amount: r.amount }));
  },

  async bookLine(tx, ledgerAccountId, journalLineId) {
    const row = await pg(tx)
      .selectFrom('journal_line as l')
      .innerJoin('journal_entry as e', 'e.id', 'l.entry_id')
      .leftJoin('bank_statement_line as s', 's.journal_line_id', 'l.id')
      .select([
        'l.id',
        'l.entry_id',
        day('e.entry_date').as('date'),
        'e.memo',
        sql<string>`(l.debit - l.credit)::numeric(14, 2)::text`.as('amount'),
        's.id as taken_by',
      ])
      .where('l.tenant_id', '=', TENANT)
      .where('l.account_id', '=', ledgerAccountId)
      .where('l.id', '=', journalLineId)
      .executeTakeFirst();
    return row ? { id: row.id, entryId: row.entry_id, date: row.date, memo: row.memo, amount: row.amount, taken: row.taken_by !== null } : undefined;
  },

  async entryLineOn(tx, entryId, ledgerAccountId) {
    const row = await pg(tx)
      .selectFrom('journal_line')
      .select('id')
      .where('tenant_id', '=', TENANT)
      .where('entry_id', '=', entryId)
      .where('account_id', '=', ledgerAccountId)
      .orderBy('id')
      .executeTakeFirst();
    return row?.id;
  },

  async bookBalance(tx, ledgerAccountId, asOf) {
    const row = await pg(tx)
      .selectFrom('journal_line as l')
      .innerJoin('journal_entry as e', 'e.id', 'l.entry_id')
      .select(sql<string>`coalesce(sum(l.debit - l.credit), 0)::numeric(14, 2)::text`.as('balance'))
      .where('l.tenant_id', '=', TENANT)
      .where('l.account_id', '=', ledgerAccountId)
      .where('e.entry_date', '<=', sql<Date>`${asOf}::date`)
      .executeTakeFirst();
    return row?.balance ?? '0.00';
  },

  async lastSignOff(tx, accountId) {
    const row = await signOffQuery(tx).where('r.money_account_id', '=', accountId).orderBy('r.as_of', 'desc').executeTakeFirst();
    return row ? toSignOff(row) : undefined;
  },

  async signOffs(tx, accountId) {
    const rows = await signOffQuery(tx).where('r.money_account_id', '=', accountId).orderBy('r.as_of', 'desc').execute();
    return rows.map(toSignOff);
  },

  async addSignOff(tx, actorId, accountId, s) {
    const added = await pg(tx)
      .insertInto('bank_reconciliation')
      .values({
        tenant_id: TENANT,
        money_account_id: accountId,
        as_of: s.asOf,
        statement_balance: s.statementBalance,
        book_balance: s.bookBalance,
        outstanding_book: s.outstandingBook,
        note: s.note,
        signed_off_by: actorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeAudit(executorOf(tx), {
      actorId,
      action: 'bank_reconciliation.signed_off',
      entity: 'money_account',
      entityId: accountId,
      after: { asOf: s.asOf, statementBalance: s.statementBalance, bookBalance: s.bookBalance },
    });
    const row = await signOffQuery(tx).where('r.id', '=', added.id).executeTakeFirstOrThrow();
    return toSignOff(row);
  },
};
