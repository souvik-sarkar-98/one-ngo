import { describe, expect, it } from 'vitest';
import { displayValue, issuesByField, listColumns, toKey } from './fields';
import type { FieldDef, RecordTypeBody } from '../models';

const money: FieldDef = { key: 'amount', label: 'Amount', type: 'money', required: true };
const choice: FieldDef = { key: 'method', label: 'Method', type: 'choice', choices: [{ value: 'upi', label: 'UPI' }] };
const flag: FieldDef = { key: 'anon', label: 'Anonymous', type: 'boolean' };
const date: FieldDef = { key: 'paidOn', label: 'Paid on', type: 'date' };
const name: FieldDef = { key: 'donorName', label: 'Donor', type: 'text', required: true };

describe('field helpers', () => {
  it('formats values for display in Indian conventions', () => {
    expect(displayValue(money, 125000)).toBe('₹1,25,000.00');
    expect(displayValue(choice, 'upi')).toBe('UPI');
    expect(displayValue(flag, true)).toBe('Yes');
    expect(displayValue(date, '2026-10-18')).toBe('18 Oct 2026');
    expect(displayValue(name, null)).toBe('—');
  });

  it('chooses list columns: title first, sensitive and long text excluded', () => {
    const type: RecordTypeBody = {
      key: 'd',
      label: 'D',
      titleField: 'donorName',
      fields: [
        { key: 'pan', label: 'PAN', type: 'text', required: true, sensitive: true },
        { key: 'notes', label: 'Notes', type: 'longText', required: true },
        money,
        name,
      ],
    };
    expect(listColumns(type).map((f) => f.key)).toEqual(['donorName', 'amount']);
  });

  it('derives keys from labels and maps issues to fields', () => {
    expect(toKey('Donor PAN no.')).toBe('donorPanNo');
    expect(toKey('2nd phone')).toBe('f2ndPhone');
    expect(toKey('  ')).toBe('');
    expect(issuesByField([{ path: '/amount', message: 'too small' }, { path: '/', message: 'general' }])).toEqual({ amount: 'too small' });
  });
});
