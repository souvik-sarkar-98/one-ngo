import { beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from '../../domain/ports/transaction.js';
import { ACTOR, expectRefused, gate, IN_PERIOD, ISSUER, issueReceipt, newRecord, PERIOD, setUpFinance, type World } from './support.js';

/**
 * `ReceiptStore`, and the section 11.5 receipt invariants held by the
 * database itself: gap-free numbers, no reuse, one live receipt per record and
 * series, issued receipts immutable except by voiding.
 */
export function defineReceiptContract(world: World): void {
  describe('ReceiptStore and receipt invariants', () => {
    let t: string;
    const tx = <T>(fn: (x: Tx) => Promise<T>) => world().transactions.withTenant(t, fn);
    const record = () => tx(async (x) => (await world().stores.records.insert(x, newRecord('receiptSource'))).id);

    beforeAll(async () => {
      t = await world().newTenant();
      await setUpFinance(world(), t);
    });

    it('reads the series and issues a receipt with its issuer kept beside it', async () => {
      const { receipts } = world().stores;
      expect(await tx((x) => receipts.series(x, 'donation'))).toMatchObject({ key: 'donation', prefix: 'DR-', reset: 'fiscal_year' });
      const recordId = await record();
      const r = await tx((x) => issueReceipt(world(), x, '1500.50', recordId));
      expect(r).toMatchObject({ seriesKey: 'donation', period: PERIOD.key, amount: '1500.50', date: IN_PERIOD, status: 'issued', recordId, voidReason: null });
      expect(await tx((x) => receipts.get(x, r.id))).toEqual(r);
      expect(await tx((x) => receipts.issuer(x, r.id))).toEqual(ISSUER);
      expect(await tx((x) => receipts.content(x, r.id))).toBeUndefined();
      expect(await tx((x) => receipts.forRecord(x, recordId))).toEqual([r]);
      expect(await tx((x) => receipts.exists(x, r.id))).toBe(true);
    });

    it('keeps the wording written with the receipt', async () => {
      const { receipts } = world().stores;
      const wording = {
        ruleKey: 'donation',
        title: 'Kept',
        statement: 'Hello',
        rows: [{ label: 'Amount', value: '10.00' }],
        clauses: ['80G'],
        thanks: 'Thanks',
      };
      const seq = await tx((x) => receipts.nextNumber(x, 'receipt:donation', PERIOD.key));
      const r = await tx((x) =>
        receipts.insert(x, ACTOR, {
          seriesKey: 'donation',
          period: PERIOD.key,
          seq,
          number: `WORD-${seq}`,
          recordId: null,
          amount: '10.00',
          date: IN_PERIOD,
          replacesReceiptId: null,
          issuer: ISSUER,
          content: wording,
        }),
      );
      expect(await tx((x) => receipts.content(x, r.id))).toEqual(wording);
    });

    it('numbers without gaps: a rolled-back issue gives its number back', async () => {
      const { receipts } = world().stores;
      const take = () => tx((x) => receipts.nextNumber(x, 'receipt:gapless', PERIOD.key));
      const first = await take();
      await expect(
        tx(async (x) => {
          await receipts.nextNumber(x, 'receipt:gapless', PERIOD.key);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow();
      expect(await take()).toBe(first + 1);
    });

    it('gives concurrent issues consecutive, distinct numbers', async () => {
      const { receipts } = world().stores;
      const tookFirst = gate();
      const release = gate();
      const first = tx(async (x) => {
        const n = await receipts.nextNumber(x, 'receipt:race', PERIOD.key);
        tookFirst.open();
        await release.wait;
        return n;
      });
      await tookFirst.wait;
      const second = tx((x) => receipts.nextNumber(x, 'receipt:race', PERIOD.key));
      release.open();
      const [a, b] = await Promise.all([first, second]);
      expect([a, b]).toEqual([1, 2]);
    });

    it('never reuses a receipt number or a sequence position', async () => {
      const { receipts } = world().stores;
      const r = await tx((x) => issueReceipt(world(), x, '10.00', null));
      const again = (over: { number?: string; seq?: number }) =>
        tx((x) =>
          receipts.insert(x, ACTOR, {
            seriesKey: 'donation',
            period: PERIOD.key,
            seq: over.seq ?? 9_000,
            number: over.number ?? 'DR-unused',
            recordId: null,
            amount: '10.00',
            date: IN_PERIOD,
            replacesReceiptId: null,
            issuer: ISSUER,
          }),
        );
      await expectRefused(world(), again({ number: r.number }), 'duplicate');
      await expectRefused(world(), again({ seq: Number(r.number.split('-').pop()) }), 'duplicate');
    });

    it('keeps one live receipt per record and series; a void one may be replaced once', async () => {
      const { receipts } = world().stores;
      const recordId = await record();
      const r = await tx((x) => issueReceipt(world(), x, '20.00', recordId));
      await expectRefused(world(), tx((x) => issueReceipt(world(), x, '20.00', recordId)), 'duplicate');
      const voided = await tx((x) => receipts.void(x, ACTOR, r.id, 'wrong amount'));
      expect(voided).toMatchObject({ status: 'void', voidReason: 'wrong amount' });
      expect(await tx((x) => receipts.void(x, ACTOR, r.id, 'again'))).toBeUndefined();
      const replacement = await tx((x) => issueReceipt(world(), x, '25.00', recordId, r.id));
      expect(replacement.replacesReceiptId).toBe(r.id);
      await tx((x) => receipts.void(x, ACTOR, replacement.id, 'test'));
      await expectRefused(world(), tx((x) => issueReceipt(world(), x, '25.00', recordId, r.id)), 'duplicate');
    });

    it('refuses a receipt of zero or less', async () => {
      await expectRefused(world(), tx((x) => issueReceipt(world(), x, '0.00', null)), 'rule');
    });

    it('keeps issued receipts immutable against writes that skip the application', async () => {
      const r = await tx((x) => issueReceipt(world(), x, '30.00', null));
      await expectRefused(world(), tx((x) => world().bypass.setReceiptAmount(x, r.id, '31.00')), 'rule');
      await expectRefused(world(), tx((x) => world().bypass.deleteReceipt(x, r.id)), 'rule');
      await expectRefused(world(), tx((x) => world().bypass.setReceiptStatus(x, r.id, 'void', null)), 'rule');
      await expectRefused(world(), tx((x) => world().bypass.setReceiptStatus(x, r.id, 'void', '  ')), 'rule');
      await tx((x) => world().bypass.setReceiptStatus(x, r.id, 'void', 'voided directly'));
      await expectRefused(world(), tx((x) => world().bypass.setReceiptStatus(x, r.id, 'issued', null)), 'rule');
      await expectRefused(world(), tx((x) => world().bypass.setReceiptAmount(x, r.id, '1.00')), 'rule');
      expect(await tx((x) => world().stores.receipts.get(x, r.id))).toMatchObject({ amount: '30.00', status: 'void' });
    });
  });
}
