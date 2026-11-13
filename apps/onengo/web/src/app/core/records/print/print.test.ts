import { describe, expect, it } from 'vitest';
import { memoryGateway } from '../../testing/memory-gateway';
import { canPublishReceiptLink, publicReceiptPage, receiptPage } from './print';
import { donationType, fakeGateway, record } from '../gateway/testing';

describe('receipt print view', () => {
  it('offers a public link only to someone who may print the receipt', () => {
    const print = { key: 'printReceipt', recordType: 'donation', label: 'Print receipt', placement: ['panel' as const], steps: [{ type: 'openReceipt' }], allowed: true };
    expect(canPublishReceiptLink([print])).toBe(true);
    expect(canPublishReceiptLink([{ ...print, allowed: false }])).toBe(false);
    expect(canPublishReceiptLink([{ ...print, steps: [{ type: 'notify' }] }])).toBe(false);
    expect(canPublishReceiptLink(undefined)).toBe(false);
  });

  it('lays out who gave, how much and for which record, then the other filled-in fields', async () => {
    const p = await fakeGateway().gateway.printReceipt('rc');
    const page = receiptPage({ ...p, record: record({ data: { donorName: 'Asha', amount: 1500, method: 'upi', anonymous: false } }) }, donationType);
    expect(page).toMatchObject({ organisation: 'Demo Foundation', number: 'RCPT/1', title: 'Donation receipt', voided: null, record: { type: 'donation', id: 'r1' } });
    expect(page.rows.map((r) => r.label)).toEqual(['Donor name', 'Amount', 'For Donation', 'Method', 'Anonymous']);
    expect(page.rows[0]!.value).toBe('Asha');
    expect(page.rows[1]!.value).toContain('1,500');
    expect(page.rows[2]!.value).toBe('DON/2026-27/00001');
    expect(page.rows[3]!.value).toBe('UPI');
    expect(page.statement).toBe('Received with thanks from Asha the sum of ₹1,500.00 towards Donation.');
    expect(page.thanks).toBe('Thank you for your generous support.');
    expect(page.clauses).toEqual([]);
  });

  it('prints the wording kept when the receipt was issued', async () => {
    const p = await fakeGateway().gateway.printReceipt('rc');
    const page = receiptPage({
      ...p,
      content: {
        title: '80G receipt',
        statement: 'Received from Asha.',
        rows: [{ label: 'Donor name', value: 'Asha' }],
        clauses: ['80G AAATD1234F'],
        thanks: 'With thanks.',
      },
    }, donationType);
    expect(page.title).toBe('80G receipt');
    expect(page.statement).toBe('Received from Asha.');
    expect(page.rows).toEqual([{ label: 'Donor name', value: 'Asha' }]);
    expect(page.clauses).toEqual(['80G AAATD1234F']);
    expect(page.thanks).toBe('With thanks.');
  });

  it('marks a cancelled receipt and works without the record type', async () => {
    const p = await fakeGateway().gateway.printReceipt('rc');
    const page = receiptPage({ ...p, receipt: { ...p.receipt, status: 'void', voidReason: 'Duplicate' } });
    expect(page.voided).toBe('Void: Duplicate');
    expect(page.rows.map((r) => r.label)).toEqual(['Received with thanks from', 'Amount', 'For Donation']);
  });

  it('heads the receipt with the issuer kept when it was issued, not the current organisation', async () => {
    const p = await fakeGateway().gateway.printReceipt('rc');
    const page = receiptPage({
      ...p,
      organisation: { name: 'Renamed Foundation' },
      issuer: {
        displayName: 'Demo Foundation',
        legalName: 'Demo Foundation Trust',
        contact: { email: 'office@demo.test', phone: '+91 20 1234 5678', website: null },
        address: { line1: '12 MG Road', line2: null, city: 'Pune', state: 'MH', postalCode: '411001', country: 'IN' },
        registrations: [{ type: '80g', number: 'AAATD1234F', issuingAuthority: 'Income Tax Department' }, { type: '12a', number: 'X1', issuingAuthority: null }],
        logoUrl: '/api/organisation/logos/00000000-0000-4000-8000-000000000001',
      },
      issuerSource: 'issued',
    });
    expect(page.issuer).toEqual({
      name: 'Demo Foundation Trust',
      alsoKnownAs: 'Demo Foundation',
      addressLines: ['12 MG Road', 'Pune, MH, 411001', 'IN'],
      contactLine: 'office@demo.test · +91 20 1234 5678',
      registrations: ['80G · AAATD1234F · Income Tax Department', '12A · X1'],
      logoUrl: '/api/organisation/logos/00000000-0000-4000-8000-000000000001',
      note: null,
    });
  });

  it('says when a receipt predates kept issuers, never loads a remote logo, and falls back to the name alone', async () => {
    const p = await fakeGateway().gateway.printReceipt('rc');
    const issuer = { displayName: 'Demo', legalName: null, contact: { email: null, phone: null, website: null }, address: null, registrations: [], logoUrl: 'https://evil.test/logo.png' };
    const current = receiptPage({ ...p, issuer, issuerSource: 'current' });
    expect(current.issuer).toMatchObject({ name: 'Demo', alsoKnownAs: null, logoUrl: null, addressLines: [], registrations: [] });
    expect(current.issuer.note).toContain('current details');
    expect(receiptPage(p).issuer).toMatchObject({ name: 'Demo Foundation', logoUrl: null, note: null });
  });

  it('prints the signatory kept with the receipt, and the public page shows only that receipt', async () => {
    const p = await fakeGateway().gateway.printReceipt('rc');
    const issuer = {
      displayName: 'Demo Foundation',
      legalName: 'Demo Foundation Trust',
      contact: { email: 'office@demo.test', phone: null, website: null },
      address: null,
      registrations: [],
      logoUrl: null,
      signatory: { name: 'Meera Shah', designation: 'Treasurer' },
      signatoryImageUrl: '/api/organisation/signatories/file',
    };
    const named = receiptPage({ ...p, issuer });
    expect(named.signatory).toEqual({ name: 'Meera Shah', designation: 'Treasurer' });
    expect(receiptPage(p).signatory).toBeNull();

    const page = publicReceiptPage({
      number: 'RCPT/9',
      date: '2026-04-01',
      amount: '500',
      title: 'Donation receipt',
      status: 'void',
      voidReason: 'Duplicate',
      donor: { label: 'Donor name', value: 'Asha' },
      recordTypeLabel: 'Donation',
      recordNumber: 'DON/2026-27/00001',
      fields: [
        { label: 'Payment method', value: 'upi', kind: 'text' },
        { label: 'Paid on', value: '2026-04-01', kind: 'date' },
      ],
      issuerSource: 'issued',
      issuer: {
        displayName: 'Demo Foundation',
        legalName: 'Demo Foundation Trust',
        contact: { email: 'office@demo.test', phone: null, website: null },
        address: { line1: '12 MG Road', line2: null, city: 'Pune', state: 'MH', postalCode: '411001', country: 'IN' },
        registrations: [{ type: '80g', number: 'AAATD1234F', issuingAuthority: null }],
      },
      signatory: { name: 'Meera Shah', designation: 'Treasurer' },
      hasLogo: true,
      hasSignature: true,
    });
    expect(page.rows.map((r) => r.label)).toEqual(['Donor name', 'Amount', 'For Donation', 'Payment method', 'Paid on']);
    expect(page.rows[0]!.value).toBe('Asha');
    expect(page.rows[2]!.value).toBe('DON/2026-27/00001');
    expect(page.record).toEqual({ type: '', id: '' });
    expect(page.signatory).toEqual({ name: 'Meera Shah', designation: 'Treasurer' });
    expect(page.voided).toContain('Duplicate');
    expect(page.issuer.logoUrl).toBeNull();
    expect(page.clauses).toEqual([]);
  });

  it('prints kept wording on the public page and leaves the record fields out', () => {
    const page = publicReceiptPage({
      number: 'RCPT/9',
      date: '2026-04-01',
      amount: '500',
      title: 'Series label',
      status: 'issued',
      voidReason: null,
      donor: { label: 'Donor name', value: 'Ignored' },
      recordTypeLabel: 'Donation',
      recordNumber: 'DON/1',
      fields: [{ label: 'Payment method', value: 'upi', kind: 'text' }],
      issuerSource: 'issued',
      issuer: {
        displayName: 'Demo Foundation',
        legalName: null,
        contact: { email: null, phone: null, website: null },
        address: null,
        registrations: [],
      },
      signatory: null,
      hasLogo: false,
      hasSignature: false,
      content: {
        title: 'Kept',
        statement: 'Received from Asha.',
        rows: [{ label: 'Amount', value: '₹500.00' }],
        clauses: ['80G AAATD1234F'],
        thanks: 'With thanks.',
      },
    });
    expect(page.title).toBe('Kept');
    expect(page.rows).toEqual([{ label: 'Amount', value: '₹500.00' }]);
    expect(page.clauses).toEqual(['80G AAATD1234F']);
    expect(page.statement).toBe('Received from Asha.');
  });

  it('is served by the in-memory gateway for issued receipts', async () => {
    const m = memoryGateway();
    const { items } = await m.records.query('donation', { limit: 100 });
    const withReceipt = (await Promise.all(items.map(async (r) => ({ r, rc: await m.records.receipts('donation', r.id) })))).find((x) => x.rc.length);
    expect(withReceipt).toBeDefined();
    const p = await m.records.printReceipt(withReceipt!.rc[0]!.id);
    expect(p.record.id).toBe(withReceipt!.r.id);
    expect(p).toMatchObject({ issuerSource: 'issued', issuer: { legalName: p.organisation.name, registrations: [{ type: '80g' }] } });
    await expect(m.records.printReceipt('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
