import { afterAll, describe, expect, it } from 'vitest';
import type { DefinitionBodies, DefinitionKind } from '../src/runtime/definitions/types.js';
import type { ReceiptRuleDef } from '../src/shared/definitions/types.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';
import { admin, createWorld, expectCode, today, type TestWorld } from './helpers.js';

const worlds: TestWorld[] = [];
afterAll(() => Promise.all(worlds.map((w) => w.close())));

async function publishIssues(w: TestWorld, kind: DefinitionKind, body: DefinitionBodies[DefinitionKind]): Promise<string> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, kind, body);
  const err = await expectCode(w.platform.definitions.publish(ctx, kind, body.key), 'definition_invalid');
  await w.platform.definitions.discardDraft(ctx, kind, body.key);
  return (err as unknown as { issues: { path: string; message: string }[] }).issues.map((i) => `${i.path} ${i.message}`).join(' | ');
}

const rule = (layout: ReceiptRuleDef['layout']): ReceiptRuleDef => ({
  key: 'badReceipt',
  recordType: 'donation',
  whenStatus: 'paid',
  series: 'donation-receipt',
  amount: 'record.amount',
  date: 'record.paidOn',
  layout,
});

describe('receipt layouts', () => {
  it('refuses a layout that would print a hidden field or a bad placeholder', async () => {
    const w = await createWorld();
    worlds.push(w);
    const messages = await publishIssues(
      w,
      'receiptRule',
      rule({
        statement: 'Hello {{ record. }}',
        rows: [
          { label: 'PAN', field: 'donorPan' },
          { label: 'Notes', field: 'notes' },
          { label: 'Missing', field: 'noSuch' },
          { label: 'Broken', value: 'record.amount +' },
          { label: 'Empty' },
        ],
        clauses: [{ registration: '80g', text: 'Held {{ registration.number }}.' }],
      }),
    );
    for (const part of [
      '/layout/statement',
      "/layout/rows/0/field 'donorPan' cannot be printed",
      "/layout/rows/1/field 'notes' cannot be printed",
      "/layout/rows/2/field record type 'donation' has no field 'noSuch'",
      '/layout/rows/3/value expression error',
      '/layout/rows/4 a row needs a field or a value',
    ]) {
      expect(messages).toContain(part);
    }
  });

  it('keeps the wording from issue time, including an 80G clause, on the print and the public link', async () => {
    const w = await createWorld();
    worlds.push(w);
    const ctx = w.as(w.ngoA);
    await w.platform.organisation.addRegistration(ctx, { type: '80g', number: 'AAATD1234F' });
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Asha', amount: 1500 });
    await w.platform.records.transition(ctx, record.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn: today() } });
    const [issued] = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), record.id));
    const print = await w.platform.printView.receipt(ctx, issued!.id);
    expect(print.content).toMatchObject({
      ruleKey: 'donationPaidReceipt',
      title: 'Donation acknowledgement',
      statement: expect.stringContaining('Asha'),
      thanks: 'Thank you for your generous support.',
      clauses: ['This organisation holds 80G registration AAATD1234F.'],
    });
    expect(print.content!.rows.map((row) => row.label)).toEqual(['Donor name', 'Amount', 'For Donation', 'Payment method', 'Paid on', 'Net amount']);
    expect(print.content!.rows[1]!.value).toContain('1,500');
    expect(print.content!.rows[3]!.value).toBe('Cash');

    await w.platform.definitions.setExtensionPatch(ctx, 'receiptRule', 'donationPaidReceipt', { layout: { title: 'Changed title' } });
    expect((await w.platform.printView.receipt(ctx, issued!.id)).content!.title).toBe('Donation acknowledgement');

    const later = (await w.platform.records.create(ctx, 'donation', { donorName: 'Later', amount: 20 })).record;
    await w.platform.records.transition(ctx, later.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn: today() } });
    const [next] = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), later.id));
    expect((await w.platform.printView.receipt(ctx, next!.id)).content!.title).toBe('Changed title');

    const { path } = await w.platform.http.records.receiptLinks.ensure(ctx, issued!.id);
    const view = await w.platform.http.publicReceipts.view(path.slice('/r/'.length));
    expect(view.donor).toBeNull();
    expect(view.fields).toEqual([]);
    expect(view.content?.clauses).toEqual(['This organisation holds 80G registration AAATD1234F.']);
    expect(view.content?.rows.map((row) => row.label)).toEqual(print.content!.rows.map((row) => row.label));

    const replaced = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.replace(asTx(tx), admin, issued!.id, 'Duplicate', {}));
    expect(await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.content(asTx(tx), replaced.replacement.id))).toEqual(print.content);

    await expect(w.platform.db.asSystem((tx) => tx.query(`update receipt_content set content = '{}'`))).rejects.toThrow(/cannot be changed/);
    await expect(w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`delete from receipt_content`))).rejects.toThrow(/permission denied/);
    const other = await w.platform.db.withTenant(w.ngoB, (tx) => tx.query(`select * from receipt_content`));
    expect(other).toEqual([]);
  });
});
