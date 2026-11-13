import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, completeIdentity, createWorld, currentFiscalYear, expectCode, today, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
  await completeIdentity(w, w.ngoA);
});
afterAll(() => w.close());

const inA = <T>(fn: Parameters<TestWorld['platform']['db']['withTenant']>[1]) =>
  w.platform.db.withTenant(w.ngoA, fn) as Promise<T>;

describe('ledger rules', () => {
  it('posts balanced entries and reports them in the trial balance', async () => {
    await inA((tx) =>
      w.platform.ledger.post(asTx(tx), admin, {
        date: today(),
        lines: [
          { accountCode: 'BANK', debit: 1000.5 },
          { accountCode: 'DONATION_INCOME', credit: '1000.50' },
        ],
      }),
    );
    const tb = await inA<{ code: string; debit: string; credit: string }[]>((tx) =>
      w.platform.ledger.trialBalance(asTx(tx), currentFiscalYear()),
    );
    expect(tb.find((r) => r.code === 'BANK')).toMatchObject({ debit: '1000.50', credit: '0.00' });
    expect(tb.find((r) => r.code === 'DONATION_INCOME')).toMatchObject({ credit: '1000.50' });
  });

  it('rejects unbalanced entries in the engine', async () => {
    await expectCode(
      inA((tx) =>
        w.platform.ledger.post(asTx(tx), admin, {
          date: today(),
          lines: [
            { accountCode: 'BANK', debit: 100 },
            { accountCode: 'DONATION_INCOME', credit: 99.99 },
          ],
        }),
      ),
      'rule_violation',
    );
    await expectCode(
      inA((tx) =>
        w.platform.ledger.post(asTx(tx), admin, {
          date: today(),
          lines: [
            { accountCode: 'BANK', debit: 0.001 },
            { accountCode: 'DONATION_INCOME', credit: 0.001 },
          ],
        }),
      ),
      'validation_failed',
    );
  });

  it('rejects unbalanced entries in the database even when the engine is bypassed', async () => {
    await expect(
      inA(async (tx) => {
        const [p] = await tx.query<{ id: string }>(`select id from fiscal_period limit 1`);
        const [a] = await tx.query<{ id: string }>(`select id from ledger_account where code = 'BANK'`);
        const [e] = await tx.query<{ id: string }>(
          `insert into journal_entry (tenant_id, period_id, entry_date) values (app_tenant(), $1, $2) returning id`,
          [p!.id, today()],
        );
        await tx.query(
          `insert into journal_line (tenant_id, entry_id, account_id, debit) values (app_tenant(), $1, $2, 50)`,
          [e!.id, a!.id],
        );
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('makes posted entries immutable and supports reversal', async () => {
    const id = await inA<string>((tx) =>
      w.platform.ledger.post(asTx(tx), admin, {
        date: today(),
        lines: [
          { accountCode: 'CASH', debit: 20 },
          { accountCode: 'DONATION_INCOME', credit: 20 },
        ],
      }),
    );
    await expect(inA((tx) => tx.query(`update journal_line set debit = 25 where entry_id = $1 and debit > 0`, [id]))).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(inA((tx) => tx.query(`update journal_entry set memo = 'x' where id = $1`, [id]))).rejects.toThrow(
      /cannot be changed/,
    );
    const reversal = await inA<string>((tx) => w.platform.ledger.reverse(asTx(tx), admin, id, today(), 'Entered twice'));
    expect(reversal).not.toBe(id);
    await expectCode(inA((tx) => w.platform.ledger.reverse(asTx(tx), admin, id, today(), 'Again')), 'rule_violation');
  });

  it('blocks posting into a closed year until it is reopened with a reason', async () => {
    const fy = currentFiscalYear();
    const post = () =>
      inA((tx) =>
        w.platform.ledger.post(asTx(tx), admin, {
          date: today(),
          lines: [
            { accountCode: 'BANK', debit: 5 },
            { accountCode: 'DONATION_INCOME', credit: 5 },
          ],
        }),
      );
    await inA((tx) => w.platform.ledger.closePeriod(asTx(tx), admin, fy));
    await expectCode(post(), 'rule_violation');
    await expectCode(inA((tx) => w.platform.ledger.reopenPeriod(asTx(tx), admin, fy, '  ')), 'validation_failed');
    await inA((tx) => w.platform.ledger.reopenPeriod(asTx(tx), admin, fy, 'Auditor adjustment'));
    await post();
  });
});

describe('receipt rules', () => {
  it('numbers receipts in sequence, keeps voided numbers, and links replacements', async () => {
    const r1 = await inA<{ id: string; number: string }>((tx) =>
      w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 100 }),
    );
    const r2 = await inA<{ number: string }>((tx) =>
      w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 200 }),
    );
    expect(r1.number).toBe(`RCPT/${currentFiscalYear()}/00001`);
    expect(r2.number).toBe(`RCPT/${currentFiscalYear()}/00002`);

    await expectCode(inA((tx) => w.platform.receipts.void(asTx(tx), admin, r1.id, '')), 'validation_failed');
    const { voided, replacement } = await inA<{
      voided: { number: string; status: string };
      replacement: { number: string; replacesReceiptId: string; amount: string };
    }>((tx) => w.platform.receipts.replace(asTx(tx), admin, r1.id, 'Wrong amount', { amount: 150 }));
    expect(voided).toMatchObject({ number: r1.number, status: 'void' });
    expect(replacement).toMatchObject({ number: `RCPT/${currentFiscalYear()}/00003`, replacesReceiptId: r1.id, amount: '150.00' });
  });

  it('never reuses a number when the transaction rolls back', async () => {
    await expect(
      inA(async (tx) => {
        await w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 1 });
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');
    const r = await inA<{ number: string }>((tx) =>
      w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 1 }),
    );
    expect(r.number).toMatch(/00004$/);
  });

  it('refuses to issue a receipt until the organisation has a legal name and a registered address', async () => {
    const issue = () =>
      w.platform.db.withTenant(w.ngoB, (tx) =>
        w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 100 }),
      );
    const refused = await expectCode(issue(), 'rule_violation');
    expect(refused.message).toContain('Organisation identity');
    expect((refused as { textKey?: string }).textKey).toBe('ui.records.receiptIdentityIncomplete');

    await completeIdentity(w, w.ngoB, 'Bodhi Society Trust');
    const r = (await issue()) as { number: string };
    expect(r.number).toBe(`RCPT/${currentFiscalYear()}/00001`);
  });

  it('blocks deleting or editing receipts in the database', async () => {
    await expect(inA((tx) => tx.query(`delete from receipt`))).rejects.toThrow(/permission denied|cannot be deleted/);
    await expect(inA((tx) => tx.query(`update receipt set amount = 1 where status = 'issued'`))).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(
      inA((tx) => tx.query(`update receipt set status = 'void', void_reason = 'x', number = 'NEW' where status = 'issued'`)),
    ).rejects.toThrow(/cannot be changed/);
  });
});
