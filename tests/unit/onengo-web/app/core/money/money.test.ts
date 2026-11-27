import { describe, expect, it } from 'vitest';
import { formatMoney } from '../../../../../../apps/onengo/web/src/app/core/i18n/i18n';
import { csvOf } from '../../../../../../apps/onengo/web/src/app/core/money/csv';
import {
  decimalOf,
  editAccountValues,
  isDay,
  moneyActions,
  moneyRow,
  openAccountDefaults,
  paise,
  todayLocal,
  transferAfter,
  transferDefaults,
  validateEditAccount,
  validateOpenAccount,
  validateTransfer,
  wouldOverdraw,
  type MoneyAccount,
} from '../../../../../../apps/onengo/web/src/app/core/money/money';

const account = (c: Partial<MoneyAccount> = {}): MoneyAccount => ({
  id: 'a1',
  key: 'main',
  name: 'State Bank, Pune',
  kind: 'bank',
  ledgerCode: 'BANK_MAIN',
  holderUserId: null,
  custodian: null,
  upiId: 'pune@sbi',
  allowNegative: true,
  status: 'active',
  balance: '1250.00',
  ...c,
});

describe('opening a money account', () => {
  it('sends only the fields that were filled in', () => {
    expect(validateOpenAccount({ key: 'main', name: 'State Bank, Pune', kind: 'bank', upiId: 'pune@sbi', custodian: '', allowNegative: true })).toEqual({
      ok: true,
      body: { key: 'main', name: 'State Bank, Pune', kind: 'bank', upiId: 'pune@sbi', allowNegative: true },
    });
  });

  it('reports each bad field, not just the first', () => {
    const out = validateOpenAccount({ key: '1main', name: '', kind: 'bank', upiId: 'nope' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.issues).sort()).toEqual(['key', 'name', 'upiId']);
  });

  it('refuses a kind the server does not know', () => {
    const out = validateOpenAccount({ key: 'loan', name: 'Loan', kind: 'loan', allowNegative: false });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.issues)).toEqual(['kind']);
  });

  it('starts with the overdraft off', () => {
    expect(openAccountDefaults()['allowNegative']).toBe(false);
  });

  it('treats a UPI ID as optional', () => {
    expect(validateOpenAccount({ key: 'cash-box', name: 'Cash box', kind: 'cash', upiId: '', allowNegative: false })).toEqual({
      ok: true,
      body: { key: 'cash-box', name: 'Cash box', kind: 'cash', allowNegative: false },
    });
  });
});

describe('a money account on the page', () => {
  it('shows the balance as money and the UPI ID, and mutes a closed account', () => {
    const row = moneyRow(account({ status: 'closed', balance: '1250.5' }));
    expect(row.cells.find((c) => c.key === 'upi')?.value).toBe('pune@sbi');
    expect(row.cells.find((c) => c.key === 'balance')?.value).toBe(formatMoney(1250.5));
    expect(row.muted).toBe(true);
    expect(row.badge?.label).toBe('Closed');
  });

  it('shows a dash where there is no UPI ID', () => {
    expect(moneyRow(account({ upiId: null })).cells.find((c) => c.key === 'upi')?.value).toBe('—');
  });

  it('names the ledger account under the title', () => {
    expect(moneyRow(account()).subtitle).toBe('Bank · BANK_MAIN');
  });
});

describe('editing a money account', () => {
  it('starts from what the account holds and names what cannot change', () => {
    expect(editAccountValues(account({ custodian: 'Treasurer' }))).toEqual({
      key: 'main',
      name: 'State Bank, Pune',
      kind: 'Bank',
      ledgerCode: 'BANK_MAIN',
      upiId: 'pune@sbi',
      custodian: 'Treasurer',
      allowNegative: true,
    });
    expect(editAccountValues(account({ upiId: null }))['upiId']).toBe('');
  });

  it('sends the four fields that can change, empty ones to clear them', () => {
    expect(validateEditAccount({ name: ' State Bank ', upiId: '', custodian: '', allowNegative: false })).toEqual({
      ok: true,
      body: { name: 'State Bank', upiId: '', custodian: '', allowNegative: false },
    });
  });

  it('refuses an empty name and a bad UPI ID', () => {
    const out = validateEditAccount({ name: ' ', upiId: 'nope' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.issues).sort()).toEqual(['name', 'upiId']);
  });

  it('offers Edit on an active account only, to a person who may manage accounts', () => {
    expect(moneyRow(account(), { manage: true }).actions.map((a) => a.id)).toEqual(['statement', 'edit']);
    expect(moneyRow(account({ status: 'closed' }), { manage: true }).actions.map((a) => a.id)).toEqual(['statement']);
  });
});

describe('what a person may do with an account', () => {
  const all = { manage: true, reconcile: true, transfer: true };

  it('gives everyone who can read accounts the Statement, and the rest by what they may do', () => {
    expect(moneyActions(account(), {}).map((a) => a.id)).toEqual(['statement']);
    expect(moneyActions(account(), all).map((a) => a.id)).toEqual(['statement', 'reconcile', 'transfer', 'edit']);
    expect(moneyActions(account(), { transfer: true }).map((a) => a.id)).toEqual(['statement', 'transfer']);
  });

  it('has no Reconcile for cash, which has no bank statement', () => {
    expect(moneyActions(account({ kind: 'cash' }), all).map((a) => a.id)).toEqual(['statement', 'transfer', 'edit']);
  });

  it('keeps only the Statement of a closed account', () => {
    expect(moneyActions(account({ status: 'closed' }), all).map((a) => a.id)).toEqual(['statement']);
  });

  it('says whether an account may go below zero', () => {
    expect(moneyRow(account({ allowNegative: false })).cells.find((c) => c.key === 'overdraft')?.value).toBe('Not allowed');
    expect(moneyRow(account({ allowNegative: true })).cells.find((c) => c.key === 'overdraft')?.value).toBe('Allowed');
  });
});

describe('money text', () => {
  it('reads and writes whole paise without rounding errors', () => {
    expect(paise('1250.50')).toBe(125050);
    expect(paise('-3')).toBe(-300);
    expect(paise('0.1')).toBe(10);
    expect(paise('1.005')).toBeNaN();
    expect(paise('abc')).toBeNaN();
    expect(decimalOf(125050)).toBe('1250.50');
    expect(decimalOf(-39600)).toBe('-396.00');
    expect(decimalOf(5)).toBe('0.05');
  });

  it('knows a real day from a made-up one, and writes today as the local day', () => {
    expect(isDay('2026-11-26')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('26-11-2026')).toBe(false);
    expect(todayLocal(new Date(2026, 10, 6, 23, 59))).toBe('2026-11-06');
  });
});

describe('a transfer', () => {
  const main = account({ key: 'main', name: 'Main bank', balance: '210400.00', allowNegative: false });
  const cash = account({ key: 'cash', name: 'Cash in hand', kind: 'cash', balance: '30000.00', allowNegative: false });
  const accounts = [main, cash];
  const form = (c: Record<string, string> = {}) => ({ from: 'main', to: 'cash', amount: '25000', date: '2026-11-26', reference: '', overrideReason: '', ...c });

  it('starts from the account chosen, with the next one as the receiver and today as the date', () => {
    expect(transferDefaults(accounts, 'cash')).toMatchObject({ from: 'cash', to: 'main', amount: '', date: todayLocal() });
    expect(transferDefaults(accounts, 'nobody')).toMatchObject({ from: 'main', to: 'cash' });
  });

  it('shows what the two accounts would hold after it', () => {
    expect(transferAfter(form(), accounts)).toEqual({ from: 'Main bank', to: 'Cash in hand', fromBalance: '185400.00', toBalance: '55000.00' });
    expect(transferAfter(form({ amount: '' }), accounts)).toBeNull();
    expect(transferAfter(form({ to: 'main' }), accounts)).toBeNull();
  });

  it('sends a clean body, and the reference only when there is one', () => {
    expect(validateTransfer(form({ amount: ' 25000.5 ', reference: ' UTR1 ' }), accounts, false)).toEqual({
      ok: true,
      body: { from: 'main', to: 'cash', amount: '25000.50', date: '2026-11-26', reference: 'UTR1' },
    });
  });

  it('refuses the same account twice, a bad amount and a made-up date', () => {
    const out = validateTransfer(form({ to: 'main', amount: '0', date: '2026-02-30' }), accounts, false);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.issues).sort()).toEqual(['amount', 'date', 'to']);
  });

  it('asks for a reason when the amount takes an account below zero that does not allow it', () => {
    expect(wouldOverdraw(form({ amount: '250000' }), accounts)).toBe(true);
    expect(wouldOverdraw(form({ amount: '210400' }), accounts)).toBe(false);
    expect(wouldOverdraw(form({ amount: '250000' }), [{ ...main, allowNegative: true }, cash])).toBe(false);
    const missing = validateTransfer(form({ amount: '250000' }), accounts, false);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(Object.keys(missing.issues)).toEqual(['overrideReason']);
    expect(validateTransfer(form({ amount: '250000', overrideReason: ' Cheque clears tomorrow ' }), accounts, false)).toMatchObject({
      ok: true,
      body: { overrideReason: 'Cheque clears tomorrow' },
    });
  });

  it('does not send a reason that was not needed', () => {
    expect(validateTransfer(form({ overrideReason: 'Just in case' }), accounts, false)).toEqual({
      ok: true,
      body: { from: 'main', to: 'cash', amount: '25000.00', date: '2026-11-26' },
    });
  });

  it('asks for the reason after the server has said the account is short', () => {
    const out = validateTransfer(form(), accounts, true);
    expect(out.ok).toBe(false);
  });
});

describe('a CSV the person opens in a spreadsheet', () => {
  it('quotes what needs it, keeps negative amounts as numbers and defuses formulas', () => {
    expect(csvOf([['Name', 'Amount'], ['Asha, Trust', '-35.40'], ['=SUM(A1)', 5], ['say "hi"', null]])).toBe(
      '\uFEFFName,Amount\r\n"Asha, Trust",-35.40\r\n\'=SUM(A1),5\r\n"say ""hi""",\r\n',
    );
  });
});
