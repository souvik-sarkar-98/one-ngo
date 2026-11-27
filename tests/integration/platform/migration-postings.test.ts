import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../../../packages/platform/src/application/migration/migration-service.js';
import type { Actor } from '../../../packages/platform/src/infrastructure/postgres/db.js';
import { asTx } from '../../../packages/platform/src/infrastructure/postgres/tx.js';
import type { DefinitionKind } from '../../../packages/platform/src/runtime/definitions/types.js';
import { createWorld, today, type TestWorld } from '../../support/platform/helpers.js';

/**
 * A migration's rows post the entries their posting rules make, at the rows' dates, and issue no receipt.
 * The opening balances (the books) apply before the rows, and Check predicts each row's entries against
 * the balances the rows before it leave, so a refused entry shows in the check and fails that row at the run.
 */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;

type Books = { cutoverDate: string; lines: { accountCode: string; debit?: string; credit?: string }[] };

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const call = (actor: Actor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(actor), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const q = <T extends object>(sql: string, args: unknown[] = []) => w.platform.db.asSystem((tx) => tx.query<T>(sql, args));
const countOf = async (sql: string, args: unknown[]) => Number((await q<{ n: number }>(sql, args))[0]!.n);

/**
 * A profile with one file, mapped as given. Its opening balances, if any, are set before the check, as the
 * screens order them (Map, Books, Check). The check job runs now.
 */
async function checked(name: string, csv: string, mapping: unknown, opening?: Books): Promise<ProfileView> {
  const created = await ok(await call(migrator, 'POST', '/api/migrations', { name }), 201);
  const added = await app.inject({
    method: 'POST',
    url: `/api/migrations/${created.id}/sources`,
    headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': encodeURIComponent(`${name}.csv`) },
    payload: Buffer.from(csv),
  });
  const view = await ok(added, 201);
  await ok(await call(migrator, 'PUT', `/api/migrations/${created.id}/sources/${view.sources[0]!.id}/mapping`, mapping));
  if (opening) await ok(await call(migrator, 'PUT', `/api/migrations/${created.id}/books`, opening));
  await ok(await call(migrator, 'POST', `/api/migrations/${created.id}/check`), 202);
  await w.platform.jobs.runOnce();
  return ok(await call(migrator, 'GET', `/api/migrations/${created.id}`));
}

/** Runs a checked profile to the end and returns it. */
async function run(profile: ProfileView): Promise<ProfileView> {
  await ok(await call(migrator, 'POST', `/api/migrations/${profile.id}/run`), 202);
  await w.platform.jobs.runOnce();
  return ok(await call(migrator, 'GET', `/api/migrations/${profile.id}`));
}

/** The first day of the financial year holding today, and the day `n` days before a date. */
const yearStart = async () => (await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.fiscalYearOf(asTx(tx), today()))).startsOn;
const daysBefore = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Each ledger account's balance on today: its debit or credit net, as the trial balance shows it. */
async function balances(): Promise<Record<string, { debit: string; credit: string }>> {
  const tb = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.trialBalanceAsOn(asTx(tx), today(), { includeZero: true }));
  return Object.fromEntries(tb.rows.map((r) => [r.code, { debit: r.debit, credit: r.credit }]));
}

const PAYOUT_MAP = {
  targets: [{ key: 'p', type: 'payout', oldId: 'Code', fields: { name: 'Name', amount: 'Amount', paidOn: 'Paid on' }, state: { column: 'Status', map: { Paid: 'paid' } } }],
};

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  // OPENING_FUNDS (the equity account the opening balances are credited to) comes with the donations module's chart.
  // An expense account for the payouts of the overdraft tests is not in any chart, so the test adds it.
  await q(`insert into ledger_account (tenant_id, code, name, type) values ($1, 'TEST_EXP', 'Test expenses', 'expense')`, [w.ngoA]);

  const [u] = await w.platform.db.asSystem((tx) => tx.query<{ id: string }>(`insert into app_user (email, display_name) values ('postings-migrator@example.org', 'postings') returning id`));
  const permissions = ['data:migrate', 'data:migrate:books', 'data:migrate:state', 'record:donation:*', 'record:payout:*'];
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, 'held-postings', 'held-postings', $2::text[])`, [w.ngoA, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, 'held-postings')`, [w.ngoA, u!.id]);
  });
  migrator = { id: u!.id, roles: [], permissions };

  // A record type whose Paid status pays an amount out of cash, so a balance can run out.
  await publish('recordType', {
    key: 'payout',
    label: 'Payout',
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'money', required: true, min: 1 },
      { key: 'paidOn', label: 'Paid on', type: 'date' },
    ],
  });
  await publish('workflow', {
    key: 'payoutFlow',
    recordType: 'payout',
    initial: 'open',
    states: [
      { key: 'open', label: 'Open' },
      { key: 'paid', label: 'Paid', final: true },
    ],
    transitions: [{ key: 'pay', label: 'Pay', from: ['open'], to: 'paid' }],
  });
  await publish('postingRule', {
    key: 'payoutPaid',
    recordType: 'payout',
    whenStatus: 'paid',
    date: 'record.paidOn',
    lines: [
      { side: 'debit', account: 'TEST_EXP', amount: 'record.amount' },
      { side: 'credit', account: 'CASH', amount: 'record.amount' },
    ],
  });
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('migrated rows post their entries, and issue no receipt', () => {
  let start: string;

  it('checks the donations, runs them, and posts only the paid ones at their paid dates', async () => {
    start = await yearStart();
    const csv = [
      'Code,Donor,Amount,Mode,Paid on,Ref,Status',
      `DN-1,Asha Rao,1000,UPI,${start},UPI-1,Paid`,
      `DN-2,Ravi Kumar,500,Cash,${start},,Paid`,
      'DN-3,Meena,700,,,,Raised',
    ].join('\n');
    const mapping = {
      targets: [
        {
          key: 'donation',
          type: 'donation',
          oldId: 'Code',
          fields: { donorName: 'Donor', amount: 'Amount', method: 'Mode', paidOn: 'Paid on', reference: 'Ref' },
          state: { column: 'Status', map: { Paid: 'paid', Raised: 'raised' } },
        },
      ],
    };
    // The opening balances: BANK 2,000 and CASH 100 against the opening funds, all at the start of the year.
    const profile = await checked('Donations', csv, mapping, {
      cutoverDate: start,
      lines: [
        { accountCode: 'BANK', debit: '2000' },
        { accountCode: 'CASH', debit: '100' },
        { accountCode: 'OPENING_FUNDS', credit: '2100' },
      ],
    });
    expect(profile.check).toMatchObject({ rows: 3, ready: 3, invalid: 0, creates: 3, problems: [] });

    const done = await run(profile);
    expect(done.status).toBe('done');
    expect(done.sources[0]!.counts).toEqual({ created: 3, updated: 0, failed: 0 });
    expect(done.booksAppliedAt).not.toBeNull();

    const posted = await q<{ d: string; memo: string }>(`select entry_date::text as d, memo from journal_entry where tenant_id = $1 and source_rule = 'donationPaid' order by memo`, [w.ngoA]);
    expect(posted.map((r) => r.d)).toEqual([start, start]);
    expect(posted.map((r) => r.memo)).toEqual([
      expect.stringMatching(/^Donation DON\/.* from Asha Rao$/),
      expect.stringMatching(/^Donation DON\/.* from Ravi Kumar$/),
    ]);

    const bal = await balances();
    expect(bal.BANK).toEqual({ debit: '3000.00', credit: '0.00' });
    expect(bal.CASH).toEqual({ debit: '600.00', credit: '0.00' });
    // The income is the migrated paid donations only: the opening balances sit in opening funds, not income.
    expect(bal.DONATION_INCOME).toEqual({ debit: '0.00', credit: '1500.00' });
    expect(bal.OPENING_FUNDS).toEqual({ debit: '0.00', credit: '2100.00' });
  });

  it('issues no receipt for a migrated paid donation', async () => {
    expect(await countOf(`select count(*)::int as n from receipt where tenant_id = $1`, [w.ngoA])).toBe(0);
    const rows = await q<{ status: string }>(`select status from record where tenant_id = $1 and type_key = 'donation' and deleted_at is null order by number`, [w.ngoA]);
    expect(rows.map((r) => r.status)).toEqual(['paid', 'paid', 'raised']);
  });

  it('a second migration posts nothing again: a paid donation is final, and a raised one posts only when it is paid', async () => {
    // DN-1 is paid and final, so a later file cannot change it, and its entry is not posted a second time.
    // DN-3 is raised: a donor name on it updates, and posts nothing.
    const csv = ['Code,Donor', 'DN-1,Asha R. Rao', 'DN-3,Meena Rao'].join('\n');
    const again = await checked('Donor names', csv, { targets: [{ key: 'donation', type: 'donation', oldId: 'Code', fields: { donorName: 'Donor' } }] });
    expect(again.check).toMatchObject({ rows: 2, ready: 1, invalid: 1, creates: 0, updates: 1 });
    expect(again.check!.problems).toEqual([expect.objectContaining({ row: 2, message: 'Records that are Paid cannot be edited.' })]);
    const done = await run(again);
    expect(done.sources[0]!.counts).toEqual({ created: 0, updated: 1, failed: 1 });
    expect(await countOf(`select count(*)::int as n from journal_entry where tenant_id = $1 and source_rule = 'donationPaid'`, [w.ngoA])).toBe(2);
  });

  it('refuses a row dated in a financial year that is not open, at the check', async () => {
    const before = daysBefore(start, 5);
    const csv = ['Code,Name,Amount,Paid on,Status', `E-1,Earlier payout,100,${before},Paid`].join('\n');
    const profile = await checked('Earlier year', csv, PAYOUT_MAP);
    expect(profile.check).toMatchObject({ ready: 0, invalid: 1 });
    expect(profile.check!.problems[0]!.message).toContain('is not open');
  });
});

describe('the books come first, and a refused entry fails its row', () => {
  it('refuses a payout that would take cash below zero, and posts the ones it can cover', async () => {
    const start = await yearStart();
    // Cash is 600 after the donations: 400 goes out, then 300 would take it to -100.
    const csv = ['Code,Name,Amount,Paid on,Status', `Q-1,Supplies,400,${start},Paid`, `Q-2,Printing,300,${start},Paid`].join('\n');
    const profile = await checked('Payouts', csv, PAYOUT_MAP);
    expect(profile.check).toMatchObject({ ready: 1, invalid: 1 });
    expect(profile.check!.problems).toEqual([expect.objectContaining({ row: 3, fileName: 'Payouts.csv', message: expect.stringContaining('Cash in hand has only 200.00 available') })]);

    const done = await run(profile);
    expect(done.sources[0]!.counts).toEqual({ created: 1, updated: 0, failed: 1 });
    expect((await balances()).CASH).toEqual({ debit: '200.00', credit: '0.00' });
  });

  it('applies the opening balances before the rows, so a payout the opening covers is posted', async () => {
    const start = await yearStart();
    // Cash is 200 now. The opening balance of this migration adds 1,000, so 1,200 is available for the 1,200 payout.
    const csv = ['Code,Name,Amount,Paid on,Status', `R-1,Big payout,1200,${start},Paid`].join('\n');
    const profile = await checked('Opening covers payout', csv, PAYOUT_MAP, {
      cutoverDate: start,
      lines: [
        { accountCode: 'CASH', debit: '1000' },
        { accountCode: 'OPENING_FUNDS', credit: '1000' },
      ],
    });
    expect(profile.check).toMatchObject({ ready: 1, invalid: 0 });
    const done = await run(profile);
    expect(done.sources[0]!.counts).toEqual({ created: 1, updated: 0, failed: 0 });
    expect(done.booksAppliedAt).not.toBeNull();
    expect((await balances()).CASH).toEqual({ debit: '0.00', credit: '0.00' });
  });
});
