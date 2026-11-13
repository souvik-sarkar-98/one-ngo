import { describe, expect, it } from 'vitest';
import type { IssuerSnapshot } from '../src/domain/organisations/organisation.js';
import type { FieldDef } from '../src/runtime/definitions/types.js';
import { resolveReceiptContent, type ReceiptWording } from '../src/runtime/records/receipt-content.js';

const issuer = (registrations: IssuerSnapshot['registrations'] = []): IssuerSnapshot => ({
  displayName: 'Demo Foundation',
  legalName: 'Demo Foundation Trust',
  contact: { email: null, phone: null, website: null },
  address: null,
  registrations,
  logo: null,
});

const fields: FieldDef[] = [
  { key: 'donorName', label: 'Donor name', type: 'text' },
  { key: 'amount', label: 'Amount', type: 'money' },
  { key: 'method', label: 'Payment method', type: 'choice', choices: [{ value: 'upi', label: 'UPI' }] },
  { key: 'notes', label: 'Notes', type: 'longText' },
  { key: 'pan', label: 'PAN', type: 'text', sensitive: true },
  { key: 'donor', label: 'Donor', type: 'reference' },
];

function wording(over: Partial<ReceiptWording> = {}): ReceiptWording {
  return {
    ruleKey: 'donationPaidReceipt',
    record: { donorName: 'Asha', amount: 1500, method: 'upi', notes: 'Secret note', pan: 'ABCDE1234F', number: 'DON/1' },
    recordType: { label: 'Donation', titleField: 'donorName', fields },
    receipt: { number: 'RCPT/1', amount: '1500.00', date: '2026-04-01' },
    seriesLabel: 'Donation acknowledgement',
    issuer: issuer([{ type: '80g', number: 'AAATD1234F', issuingAuthority: null }]),
    ...over,
  };
}

describe('receipt wording', () => {
  it('uses the print view wording when a rule has no layout', () => {
    const content = resolveReceiptContent(wording());
    expect(content.title).toBe('Donation acknowledgement');
    expect(content.statement).toBe('Received with thanks from Asha the sum of ₹1,500.00 towards Donation.');
    expect(content.thanks).toBe('Thank you for your generous support.');
    expect(content.rows.map((row) => row.label)).toEqual(['Donor name', 'Amount', 'For Donation', 'Payment method']);
    expect(content.rows[1]!.value).toContain('1,500.00');
    expect(content.rows[3]!.value).toBe('UPI');
    expect(content.clauses).toEqual([]);
  });

  it('keeps a clause only when the issuer holds that registration', () => {
    const layout = {
      statement: 'Received from {{ record.donorName }}.',
      rows: [{ label: 'Donor name', field: 'donorName' }],
      clauses: [{ registration: '80g', text: 'Registration {{ registration.number }}.' }],
    };
    const held = resolveReceiptContent(wording({ layout }));
    expect(held.statement).toBe('Received from Asha.');
    expect(held.clauses).toEqual(['Registration AAATD1234F.']);
    expect(held.rows).toEqual([{ label: 'Donor name', value: 'Asha' }]);
    expect(resolveReceiptContent(wording({ layout, issuer: issuer() })).clauses).toEqual([]);
  });

  it('leaves out an empty field row', () => {
    const content = resolveReceiptContent(
      wording({
        record: { donorName: 'Asha', number: 'DON/1' },
        layout: { rows: [{ label: 'Email', field: 'donorEmail' }, { label: 'Name', field: 'donorName' }] },
      }),
    );
    expect(content.rows).toEqual([{ label: 'Name', value: 'Asha' }]);
  });
});
