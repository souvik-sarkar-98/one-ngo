import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPersonal } from '../src/application/privacy/privacy-service.js';
import { isSealed } from '@onengo/kernel/crypto';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';
import { applyRetention, FINANCIAL_RETENTION_YEARS_DEFAULT, FINANCIAL_TABLES, financialRetentionYears } from '../src/infrastructure/postgres/retention.js';
import { financialRetainedUntil } from '../src/domain/privacy/retention-period.js';
import { TENANT_TABLES } from '../src/infrastructure/postgres/tenant-export.js';
import type { DefinitionKind, FieldDef } from '../src/runtime/definitions/types.js';
import { admin, clerk, completeIdentity, createWorld, currentFiscalYear, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
const PSEUDONYM = /^Erased person [0-9A-F]{8}$/;
const eraser: Actor = { id: 'dpo-1', roles: ['privacy'], permissions: ['privacy:erase', 'privacy:consent:read', 'privacy:consent:record'] };

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
async function stored(id: string) {
  const [row] = await w.platform.db.asSystem((tx) =>
    tx.query<{ data: Record<string, unknown>; blind_index: Record<string, string>; search_text: string | null; version: number }>(
      `select data, blind_index, search_text, version from record where id = $1`,
      [id],
    ),
  );
  return row!;
}
const auditText = async (tenantId: string) =>
  (await w.platform.db.asSystem((tx) => tx.query<{ t: string }>(`select coalesce(string_agg(coalesce(before::text, '') || coalesce(after::text, ''), ' '), '') as t from audit_event where tenant_id = $1`, [tenantId])))[0]!.t;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await completeIdentity(w, w.ngoA);
  await publish('recordType', {
    key: 'beneficiary',
    label: 'Beneficiary',
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, sensitive: true, maxLength: 200 },
      { key: 'aadhaarLast4', label: 'Aadhaar (last 4)', type: 'text', sensitive: true, unique: true },
      { key: 'income', label: 'Income', type: 'money', sensitive: true },
      { key: 'born', label: 'Date of birth', type: 'date', personal: true },
      { key: 'district', label: 'District', type: 'choice', choices: [{ value: 'pune', label: 'Pune' }] },
      { key: 'programme', label: 'Programme', type: 'text', personal: false },
    ],
  });
  await publish('recordType', {
    key: 'visit',
    label: 'Visit',
    fields: [
      { key: 'beneficiary', label: 'Beneficiary', type: 'reference', referenceType: 'beneficiary' },
      { key: 'beneficiaryName', label: 'Name', type: 'text', required: true, sensitive: true, copyFrom: { reference: 'beneficiary', field: 'name' } },
      { key: 'observation', label: 'Observation', type: 'longText', sensitive: true },
      { key: 'visitedOn', label: 'Visited on', type: 'date' },
    ],
  });
});
afterAll(() => w.close());

describe('which fields erasure treats as personal', () => {
  const f = (x: Partial<FieldDef>): FieldDef => ({ key: 'k', label: 'K', type: 'text', ...x });
  it('clears text, contact, location, signature, file and sensitive fields, and keeps amounts, dates, choices, links and totals', () => {
    for (const type of ['text', 'longText', 'richText', 'email', 'phone', 'location', 'signature', 'file'] as const) expect(isPersonal(f({ type })), type).toBe(true);
    for (const type of ['money', 'number', 'date', 'boolean', 'choice', 'multiChoice', 'reference', 'person'] as const) expect(isPersonal(f({ type })), type).toBe(false);
    expect(isPersonal(f({ type: 'money', sensitive: true }))).toBe(true);
    expect(isPersonal(f({ type: 'date', personal: true }))).toBe(true);
    expect(isPersonal(f({ type: 'text', personal: false }))).toBe(false);
    expect(isPersonal(f({ type: 'money', rollup: { recordType: 'donation', reference: 'donor', measure: 'sum', field: 'amount' } }))).toBe(false);
  });
});

describe('erasing a donor', () => {
  let donorId: string;
  let donationId: string;
  let otherId: string;
  let receiptNumber: string;

  beforeAll(async () => {
    const ctx = w.as(w.ngoA);
    const donor = await w.platform.records.create(ctx, 'donor', {
      name: 'Priya Sengupta',
      email: 'priya.sengupta@example.org',
      phone: '+919800000001',
      pan: 'ABCDE1234F',
      address: '12 Lake Road',
      city: 'Kolkata',
      notes: 'Prefers calls after six',
    });
    donorId = donor.record.id;
    const raised = await w.platform.records.create(ctx, 'donation', { donor: donorId, amount: 1000 });
    donationId = raised.record.id;
    expect(raised.record.data).toMatchObject({ donorName: 'Priya Sengupta', donorEmail: 'priya.sengupta@example.org', donorPan: 'ABCDE1234F' });
    const paid = await w.platform.records.transition(ctx, donationId, 'markPaid', { expectedVersion: 1, data: { method: 'upi', paidOn: today(), reference: 'UPI-9' } });
    receiptNumber = paid.receipts[0]!.number;
    otherId = (await w.platform.records.create(ctx, 'donation', { donorName: 'Arun Kumar', amount: 50 })).record.id;
    await w.platform.privacy.recordConsent(w.as(w.ngoA, eraser), { subjectKind: 'record', subjectId: donorId, purpose: 'newsletter', state: 'granted', source: 'form' });
    expect(await auditText(w.ngoA)).toContain('Priya Sengupta');
  });

  it('is refused without privacy:erase and from another organisation', async () => {
    await expectCode(w.platform.privacy.erase(w.as(w.ngoA, clerk), { subjectKind: 'record', subjectId: donorId }), 'forbidden');
    await expectCode(w.platform.privacy.erase(w.as(w.ngoB, eraser), { subjectKind: 'record', subjectId: donorId }), 'not_found');
    await expectCode(w.platform.privacy.erase(w.as(w.ngoA, eraser), { subjectKind: 'record', subjectId: 'nope' }), 'validation_failed');
  });

  it('pseudonymises the donor and the values copied into their donations, and keeps amounts, numbers, receipts and the books', async () => {
    const before = await stored(donorId);
    const result = await w.platform.privacy.erase(w.as(w.ngoA, eraser), { subjectKind: 'record', subjectId: donorId });
    expect(result).toMatchObject({ subjectKind: 'record', subjectId: donorId, reason: 'subject_request', alreadyErased: false, requestedBy: eraser.id });
    expect(result.summary.records).toEqual([
      { id: donorId, type: 'donor', fields: ['name', 'email', 'phone', 'pan', 'address', 'city', 'notes'] },
      { id: donationId, type: 'donation', fields: ['donorName', 'donorEmail', 'donorPhone', 'donorPan'] },
    ]);
    expect(result.summary.kept).toMatchObject({
      receipts: 1,
      journalEntries: 1,
      retentionYears: FINANCIAL_RETENTION_YEARS_DEFAULT,
      retainedUntil: financialRetainedUntil(today(), 8),
      retentionPeriod: 'pending counsel confirmation',
    });
    expect(result.summary.consentsWithdrawn).toEqual(['newsletter']);

    const donor = await w.platform.records.get(w.as(w.ngoA), donorId);
    expect(donor.data.name).toMatch(PSEUDONYM);
    for (const k of ['email', 'phone', 'pan', 'address', 'city', 'notes']) expect(donor.data[k], k).toBeUndefined();
    expect(donor.data).toMatchObject({ totalGiven: 1000, donationCount: 1 });
    expect(donor.number).toBe(`DNR/00001`);
    expect(donor.version).toBe(before.version + 1);

    const donation = await w.platform.records.get(w.as(w.ngoA), donationId);
    expect(donation.data.donorName).toBe(donor.data.name);
    for (const k of ['donorEmail', 'donorPhone', 'donorPan']) expect(donation.data[k], k).toBeUndefined();
    expect(donation).toMatchObject({ status: 'paid', number: `DON/${currentFiscalYear()}/00001`, data: { donor: donorId, amount: 1000, method: 'upi', reference: 'UPI-9' } });

    const other = await w.platform.records.get(w.as(w.ngoA), otherId);
    expect(other.data.donorName).toBe('Arun Kumar');

    for (const id of [donorId, donationId]) {
      const row = await stored(id);
      expect(JSON.stringify(row.data)).not.toMatch(/Priya|Sengupta|ABCDE1234F|Kolkata/);
      expect(row.search_text ?? '').not.toContain('priya');
      expect(row.blind_index).toEqual({});
    }
    const audit = await auditText(w.ngoA);
    expect(audit).not.toMatch(/Priya|Sengupta|priya\.sengupta|Kolkata|Lake Road/);
    expect(audit).toContain('[erased]');

    const receipts = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), donationId));
    expect(receipts).toMatchObject([{ number: receiptNumber, amount: '1000.00', status: 'issued', recordId: donationId }]);
    const tb = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.trialBalance(asTx(tx), currentFiscalYear()));
    expect(tb.find((r) => r.code === 'BANK')?.debit).toBe('1000.00');
    expect(tb.find((r) => r.code === 'DONATION_INCOME')?.credit).toBe('1000.00');
    const sum = (k: 'debit' | 'credit') => tb.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    expect(sum('debit')).toBe(sum('credit'));
    const [lines] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from journal_entry e join journal_line l on l.entry_id = e.id where e.source_record_id = $1`, [donationId]),
    );
    expect(lines!.n).toBe(2);
  });

  it('leaves the name in the posted journal memo, which the database never lets change', async () => {
    const [entry] = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ memo: string }>(`select memo from journal_entry where source_record_id = $1`, [donationId]));
    expect(entry!.memo).toContain('Priya Sengupta');
    await expect(
      w.platform.db.asSystem((tx) => tx.query(`update journal_entry set memo = 'x' where source_record_id = $1`, [donationId])),
    ).rejects.toThrow(/posted journal entries cannot be changed/);
  });

  it('audits the erasure without the erased values', async () => {
    const rows = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ action: string; entity_id: string; after: Record<string, unknown> }>(
        `select action, entity_id, after from audit_event where action in ('privacy.erased', 'record.pseudonymised') order by id`,
      ),
    );
    expect(rows.map((r) => [r.action, r.entity_id])).toEqual([
      ['record.pseudonymised', donorId],
      ['record.pseudonymised', donationId],
      ['privacy.erased', `record:${donorId}`],
    ]);
    expect(rows[0]!.after).toMatchObject({ fields: ['name', 'email', 'phone', 'pan', 'address', 'city', 'notes'] });
    expect(JSON.stringify(rows)).not.toMatch(/Priya|Erased person/);
  });

  it('is idempotent: asking again returns the first result and changes nothing', async () => {
    const first = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ id: string }>(`select id from erasure_request`));
    const version = (await stored(donorId)).version;
    const again = await w.platform.privacy.erase(w.as(w.ngoA, eraser), { subjectKind: 'record', subjectId: donorId, reason: 'other' });
    expect(again).toMatchObject({ id: first[0]!.id, alreadyErased: true, reason: 'subject_request' });
    expect((await stored(donorId)).version).toBe(version);
  });

  it('withdraws consent and refuses new consent for the erased person', async () => {
    const consent = await w.platform.privacy.consent(w.as(w.ngoA, eraser), { subjectKind: 'record', subjectId: donorId });
    expect(consent.erased).toBe(true);
    expect(consent.current).toMatchObject([{ purpose: 'newsletter', state: 'withdrawn', source: 'erasure', recordedBy: eraser.id }]);
    expect(consent.history.map((e) => e.state)).toEqual(['granted', 'withdrawn']);
    await expectCode(
      w.platform.privacy.recordConsent(w.as(w.ngoA, eraser), { subjectKind: 'record', subjectId: donorId, purpose: 'newsletter', state: 'granted', source: 'form' }),
      'rule_violation',
    );
  });

  it('keeps financial rows through retention, and the erasure history cannot be changed', async () => {
    await applyRetention(w.platform.db, { financialRetentionYears: 1 });
    const [counts] = await w.platform.db.asSystem((tx) =>
      tx.query<{ r: number; j: number }>(`select (select count(*)::int from receipt where record_id = $1) as r, (select count(*)::int from journal_entry where source_record_id = $1) as j`, [donationId]),
    );
    expect(counts).toEqual({ r: 1, j: 1 });
    await expect(w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`delete from receipt where record_id = $1`, [donationId]))).rejects.toThrow();
    await expect(w.platform.db.asSystem((tx) => tx.query(`delete from erasure_request`))).rejects.toThrow(/cannot be changed or deleted/);
    await expect(w.platform.db.asSystem((tx) => tx.query(`update consent_event set state = 'granted'`))).rejects.toThrow(/cannot be changed or deleted/);
  });
});

describe('erasing a record with encrypted values', () => {
  it('seals the pseudonym under the current key, clears other sensitive values and keyed hashes, and keeps what is not personal', async () => {
    const ctx = w.as(w.ngoA);
    const b = await w.platform.records.create(ctx, 'beneficiary', { name: 'Meena Das', aadhaarLast4: '4321', income: 12000, born: '1990-01-02', district: 'pune', programme: 'Nutrition' });
    const v = await w.platform.records.create(ctx, 'visit', { beneficiary: b.record.id, observation: 'Garden thriving', visitedOn: '2026-01-05' });
    expect(v.record.data.beneficiaryName).toBe('Meena Das');
    expect(Object.keys((await stored(b.record.id)).blind_index)).toEqual(['aadhaarLast4']);

    const result = await w.platform.privacy.erase(w.as(w.ngoA, eraser), { subjectKind: 'record', subjectId: b.record.id, reason: 'consent_withdrawn' });
    expect(result.summary.records.map((r) => r.fields)).toEqual([['name', 'aadhaarLast4', 'income', 'born'], ['beneficiaryName']]);

    const raw = await stored(b.record.id);
    expect(isSealed(raw.data.name)).toBe(true);
    expect(raw.blind_index).toEqual({});
    expect(raw.data).not.toHaveProperty('income');
    const after = await w.platform.records.get(ctx, b.record.id);
    expect(after.data.name).toMatch(PSEUDONYM);
    expect(after.data).toMatchObject({ district: 'pune', programme: 'Nutrition' });
    expect(after.data).not.toHaveProperty('born');

    const visit = await w.platform.records.get(ctx, v.record.id);
    expect(visit.data).toMatchObject({ beneficiaryName: after.data.name, observation: 'Garden thriving', visitedOn: '2026-01-05' });
    const rawVisit = await stored(v.record.id);
    expect(isSealed(rawVisit.data.beneficiaryName)).toBe(true);
    expect(isSealed(rawVisit.data.observation)).toBe(true);

    const again = await w.platform.records.create(ctx, 'beneficiary', { name: 'Someone else', aadhaarLast4: '4321' });
    expect(again.record.data.aadhaarLast4).toBe('4321');
  });
});

describe('erasing a member', () => {
  it('needs the person suspended, then pseudonymises their profile and, when they belong nowhere else, their account', async () => {
    const ctx = w.as(w.ngoA);
    const { userId } = await w.platform.people.add(ctx, { email: 'ravi.member@example.org', displayName: 'Ravi Menon', roles: [] });
    await expectCode(w.platform.privacy.erase(w.as(w.ngoA, eraser), { subjectKind: 'member', subjectId: userId }), 'rule_violation');
    await w.platform.people.suspend(ctx, userId);
    const result = await w.platform.privacy.erase(w.as(w.ngoA, eraser), { subjectKind: 'member', subjectId: userId });
    expect(result.summary.account).toBe('erased');
    expect(result.summary.records).toEqual([]);

    const [account] = await w.platform.db.asSystem((tx) =>
      tx.query<{ display_name: string; email: string; status: string; password_hash: string | null }>(`select display_name, email, status, password_hash from app_user where id = $1`, [userId]),
    );
    expect(account).toMatchObject({ status: 'disabled', password_hash: null });
    expect(account!.display_name).toMatch(PSEUDONYM);
    expect(account!.email).toMatch(/^erased-[0-9a-f]{8}@erased\.invalid$/);
  });

  it('leaves an account shared with another organisation as it is', async () => {
    const { userId } = await w.platform.people.add(w.as(w.ngoA), { email: 'shared.member@example.org', displayName: 'Shared Person', roles: [] });
    await w.platform.people.add(w.as(w.ngoB), { email: 'shared.member@example.org', displayName: 'Shared Person', roles: [] });
    await w.platform.people.suspend(w.as(w.ngoA), userId);
    const result = await w.platform.privacy.erase(w.as(w.ngoA, eraser), { subjectKind: 'member', subjectId: userId });
    expect(result.summary.account).toBe('shared');
    const [account] = await w.platform.db.asSystem((tx) => tx.query<{ display_name: string }>(`select display_name from app_user where id = $1`, [userId]));
    expect(account!.display_name).toBe('Shared Person');
  });
});

describe('financial retention', () => {
  it('defaults to eight years, pending counsel confirmation, and is configurable', () => {
    expect(FINANCIAL_RETENTION_YEARS_DEFAULT).toBe(8);
    expect(financialRetentionYears()).toBe(8);
    expect(financialRetentionYears({ financialRetentionYears: 10 })).toBe(10);
    expect(financialRetentionYears({ financialRetentionYears: 0 })).toBe(8);
    expect(financialRetainedUntil('2026-03-31', 8)).toBe('2034-03-31');
  });

  it('names the financial tables, and exports the consent and erasure tables', () => {
    expect(FINANCIAL_TABLES).toEqual(expect.arrayContaining(['journal_entry', 'journal_line', 'receipt', 'payment_intent', 'payment_event', 'transfer']));
    expect(TENANT_TABLES).toEqual(expect.arrayContaining(['consent_event', 'erasure_request']));
  });

  it('runs with the admin defaults untouched', async () => {
    await expect(applyRetention(w.platform.db)).resolves.toMatchObject({ auditArchived: 0 });
    expect(admin.permissions).toEqual(['*']);
  });
});
