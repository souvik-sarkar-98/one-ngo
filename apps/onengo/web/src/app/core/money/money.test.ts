import { describe, expect, it } from 'vitest';
import { formatMoney } from '../i18n/i18n';
import { editAccountValues, moneyRow, validateEditAccount, validateOpenAccount, type MoneyAccount } from './money';

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

  it('offers Edit on an active account only', () => {
    expect(moneyRow(account()).actions.map((a) => a.id)).toEqual(['edit']);
    expect(moneyRow(account({ status: 'closed' })).actions).toEqual([]);
  });
});
