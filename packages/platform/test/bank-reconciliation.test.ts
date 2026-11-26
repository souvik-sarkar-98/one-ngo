import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
const onPaid = { transition: 'markPaid', fields: { paidOn: 'paidOn', reference: 'reference', method: 'method' }, methodValue: 'upi' };

beforeAll(async () => {
  w = await createWorld();
  await completeIdentity(w, w.ngoA);
  const ctx = w.as(w.ngoA);
  await w.platform.moneyAccounts.update(ctx, 'upi', { upiId: 'asha.trust@sbi' });
  await w.platform.db.withTenant(w.ngoA, (tx) =>
    tx.query(`insert into ledger_account (tenant_id, code, name, type) values (app_tenant(), 'BANK_CHARGES', 'Bank charges', 'expense')`),
  );
});
afterAll(() => w.close());

/** A donor pays 250 by UPI; the donation is confirmed, receipted and posted to BANK. */
async function donation(amount: number, reference: string): Promise<void> {
  const ctx = w.as(w.ngoA);
  const { record } = await w.platform.records.create(ctx, 'donation', { donorName: `Donor ${reference}`, amount });
  const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount, provider: 'upi_direct', onPaid, upiAccountKey: 'upi' });
  await w.platform.payments.confirmManually(ctx, intent.id, { paidOn: today(), bankReference: reference });
  await w.platform.dispatcher.runOnce();
}

describe('the bank statement against the books', () => {
  it('pairs the statement with the donations, books what the books missed, and signs off', async () => {
    const ctx = w.as(w.ngoA);
    await donation(250, 'UTR250');
    expect((await w.platform.moneyAccounts.get(ctx, 'upi')).balance).toBe('250.00');

    const statement = [
      { date: today(), amount: 250, description: 'UPI/CR/UTR250/asha', reference: 'UTR250' },
      { date: today(), amount: '-35.40', description: 'SMS charges' },
      { date: today(), amount: 1000, description: 'NEFT/CR/Well wisher' },
    ];
    expect(await w.platform.bankReconciliation.importStatement(ctx, 'upi', statement)).toEqual({ added: 3, duplicates: 0, matched: 1 });
    expect(await w.platform.bankReconciliation.importStatement(ctx, 'upi', statement)).toEqual({ added: 0, duplicates: 3, matched: 0 });

    const open = await w.platform.bankReconciliation.statement(ctx, 'upi', 'unmatched');
    expect(open.map((l) => l.amount)).toEqual(['-35.40', '1000.00']);

    // The bank says 1214.60. The books hold 250.00. The two lines the books lack explain the rest, but they must be booked.
    const before = await w.platform.bankReconciliation.report(ctx, 'upi', today(), '1214.60');
    expect(before).toMatchObject({ bookBalance: '250.00', difference: '0.00', reconciled: false });
    expect(before.unbooked.lines).toHaveLength(2);
    expect(before.unbooked.total).toBe('964.60');
    await expectCode(w.platform.bankReconciliation.signOff(ctx, 'upi', { asOf: today(), statementBalance: '1214.60' }), 'rule_violation');

    const [charge, neft] = open;
    await expectCode(w.platform.bankReconciliation.book(ctx, 'upi', charge!.id, { accountCode: 'NO_SUCH' }), 'rule_violation');
    await expectCode(w.platform.bankReconciliation.book(ctx, 'upi', charge!.id, { accountCode: 'BANK' }), 'rule_violation');
    // CASH is a money account too (the module opens it), so it is not a ledger account to book a bank line to.
    await expectCode(w.platform.bankReconciliation.book(ctx, 'upi', charge!.id, { accountCode: 'CASH' }), 'rule_violation');

    const booked = await w.platform.bankReconciliation.book(ctx, 'upi', charge!.id, { accountCode: 'BANK_CHARGES', memo: 'April' });
    expect(booked).toMatchObject({ status: 'matched', amount: '-35.40' });
    expect(booked.journalLineId).toBeTruthy();
    await w.platform.bankReconciliation.book(ctx, 'upi', neft!.id, { accountCode: 'DONATION_INCOME' });
    expect((await w.platform.moneyAccounts.get(ctx, 'upi')).balance).toBe('1214.60');
    await expectCode(w.platform.bankReconciliation.book(ctx, 'upi', neft!.id, { accountCode: 'DONATION_INCOME' }), 'rule_violation');

    const after = await w.platform.bankReconciliation.report(ctx, 'upi', today(), '1214.60');
    expect(after).toMatchObject({ bookBalance: '1214.60', difference: '0.00', reconciled: true });
    expect(after.unbooked.lines).toEqual([]);
    expect(after.outstandingBook.lines).toEqual([]);

    const wrong = await w.platform.bankReconciliation.report(ctx, 'upi', today(), '1200.00');
    expect(wrong).toMatchObject({ difference: '-14.60', reconciled: false });
    await expectCode(w.platform.bankReconciliation.signOff(ctx, 'upi', { asOf: today(), statementBalance: '1200.00' }), 'rule_violation');

    const signed = await w.platform.bankReconciliation.signOff(ctx, 'upi', { asOf: today(), statementBalance: '1214.60', note: 'April statement' });
    expect(signed).toMatchObject({ asOf: today(), statementBalance: '1214.60', bookBalance: '1214.60', outstandingBook: '0.00', note: 'April statement' });
    expect(await w.platform.bankReconciliation.signOffs(ctx, 'upi')).toHaveLength(1);
    await expectCode(w.platform.bankReconciliation.signOff(ctx, 'upi', { asOf: today(), statementBalance: '1214.60' }), 'rule_violation');

    // After sign-off the signed period is fixed: the same statement again adds nothing, but a new line in it is refused.
    expect(await w.platform.bankReconciliation.importStatement(ctx, 'upi', statement)).toEqual({ added: 0, duplicates: 3, matched: 0 });
    await expectCode(w.platform.bankReconciliation.importStatement(ctx, 'upi', [{ date: today(), amount: 5, description: 'Late arrival' }]), 'rule_violation');
    await expectCode(w.platform.bankReconciliation.reopen(ctx, 'upi', charge!.id), 'rule_violation');
    await expect(w.platform.db.asSystem((tx) => tx.query(`update bank_reconciliation set note = 'edited'`))).rejects.toThrow(/cannot be changed/);
    await expect(w.platform.db.asSystem((tx) => tx.query(`delete from bank_reconciliation`))).rejects.toThrow(/cannot be changed/);
  });

  it('leaves entries the bank has not shown as outstanding, and sets aside a line with a reason', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.moneyAccounts.open(ctx, { key: 'ops', name: 'Operations account', kind: 'bank' });
    await w.platform.moneyAccounts.transfer(ctx, { from: 'upi', to: 'ops', amount: 500, date: today(), reference: 'Top-up' });

    const result = await w.platform.bankReconciliation.importStatement(ctx, 'ops', [
      { date: today(), amount: 500, description: 'NEFT/CR/Top-up' },
      { date: today(), amount: 20, description: 'Reversed by bank' },
    ]);
    expect(result).toEqual({ added: 2, duplicates: 0, matched: 1 });

    const [stray] = await w.platform.bankReconciliation.statement(ctx, 'ops', 'unmatched');
    const [paired] = await w.platform.bankReconciliation.statement(ctx, 'ops', 'matched');
    await expectCode(w.platform.bankReconciliation.ignore(ctx, 'ops', stray!.id, '  '), 'validation_failed');
    // Amounts must agree before two lines are paired, and a ledger line pairs with only one statement line.
    await expectCode(w.platform.bankReconciliation.match(ctx, 'ops', stray!.id, paired!.journalLineId!), 'rule_violation');
    expect(await w.platform.bankReconciliation.ignore(ctx, 'ops', stray!.id, 'The bank reversed this the same day')).toMatchObject({ status: 'ignored', note: 'The bank reversed this the same day' });
    await expectCode(w.platform.bankReconciliation.ignore(ctx, 'ops', stray!.id, 'again'), 'rule_violation');
    expect(await w.platform.bankReconciliation.reopen(ctx, 'ops', stray!.id)).toMatchObject({ status: 'unmatched', note: null });
    await w.platform.bankReconciliation.ignore(ctx, 'ops', stray!.id, 'The bank reversed this the same day');

    // A second top-up is in the books but not on the statement yet, like a cheque not cleared.
    await w.platform.moneyAccounts.transfer(ctx, { from: 'upi', to: 'ops', amount: 300, date: today() });
    const report = await w.platform.bankReconciliation.report(ctx, 'ops', today(), 500);
    expect(report).toMatchObject({ bookBalance: '800.00', difference: '0.00', reconciled: true });
    expect(report.outstandingBook).toMatchObject({ total: '300.00' });
    expect(report.outstandingBook.lines.map((l) => l.amount)).toEqual(['300.00']);
    expect(report.unbooked.lines).toEqual([]);

    const signed = await w.platform.bankReconciliation.signOff(ctx, 'ops', { asOf: today(), statementBalance: 500 });
    expect(signed).toMatchObject({ bookBalance: '800.00', outstandingBook: '300.00', statementBalance: '500.00' });
  });

  it('refuses bad input and callers without the permission, and keeps one organisation out of another', async () => {
    const ctx = w.as(w.ngoA);
    await expectCode(w.platform.bankReconciliation.importStatement(ctx, 'upi', []), 'validation_failed');
    await expectCode(w.platform.bankReconciliation.importStatement(ctx, 'upi', [{ date: '30/04/2026', amount: 5, description: 'x' }]), 'validation_failed');
    await expectCode(w.platform.bankReconciliation.importStatement(ctx, 'upi', [{ date: today(), amount: 0, description: 'x' }]), 'validation_failed');
    await expectCode(w.platform.bankReconciliation.importStatement(ctx, 'upi', [{ date: today(), amount: '1.234', description: 'x' }]), 'validation_failed');
    await expectCode(w.platform.bankReconciliation.importStatement(ctx, 'upi', [{ date: today(), amount: 5, description: '   ' }]), 'validation_failed');
    await expectCode(w.platform.bankReconciliation.importStatement(ctx, 'nobody', [{ date: today(), amount: 5, description: 'x' }]), 'not_found');
    await expectCode(w.platform.bankReconciliation.report(ctx, 'upi', 'tomorrow', 5), 'validation_failed');
    await expectCode(w.platform.bankReconciliation.report(ctx, 'upi', today(), ''), 'validation_failed');
    await expectCode(w.platform.bankReconciliation.statement(ctx, 'upi', 'weird'), 'validation_failed');

    const reader: Actor = { id: 'reader-1', roles: ['viewer'], permissions: ['money:accounts:read'] };
    await expectCode(w.platform.bankReconciliation.statement(w.as(w.ngoA, reader), 'upi'), 'forbidden');
    await expectCode(w.platform.bankReconciliation.importStatement(w.as(w.ngoA, reader), 'upi', [{ date: today(), amount: 5, description: 'x' }]), 'forbidden');
    await expectCode(w.platform.bankReconciliation.signOff(w.as(w.ngoA, reader), 'upi', { asOf: today(), statementBalance: 0 }), 'forbidden');

    // The other organisation has its own 'upi' account and none of this statement.
    expect(await w.platform.bankReconciliation.statement(w.as(w.ngoB), 'upi')).toEqual([]);
    expect(await w.platform.bankReconciliation.signOffs(w.as(w.ngoB), 'upi')).toEqual([]);
  });
});
