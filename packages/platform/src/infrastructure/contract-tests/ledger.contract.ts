import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseCapabilities } from '../../domain/ports/database-capabilities.js';
import type { Tx } from '../../domain/ports/transaction.js';
import { ACTOR, balanced, expectRefused, IN_PERIOD, newRecord, PERIOD, setUpFinance, type World } from './support.js';

/**
 * `LedgerStore`, and the section 11.5 ledger invariants held by the database
 * itself (ADR-13 criterion 3): a write that skips the application is refused.
 */
export function defineLedgerContract(world: World, capabilities: DatabaseCapabilities): void {
  describe('LedgerStore and ledger invariants', () => {
    let t: string;
    let bank: string;
    let income: string;
    let periodId: string;
    const tx = <T>(fn: (x: Tx) => Promise<T>) => world().transactions.withTenant(t, fn);

    beforeAll(async () => {
      t = await world().newTenant();
      ({ bank, income, periodId } = await setUpFinance(world(), t));
    });

    it('posts a balanced entry and reports it in the trial balance with exact decimals', async () => {
      const { ledger } = world().stores;
      const id = await tx((x) => ledger.insertEntry(x, ACTOR, balanced(periodId, bank, income, '0.10')));
      await tx((x) => ledger.insertEntry(x, ACTOR, balanced(periodId, bank, income, '0.20')));
      expect(await tx((x) => ledger.entryStatus(x, id))).toBe('posted');
      expect(await tx((x) => ledger.entryLines(x, id))).toEqual(
        expect.arrayContaining([
          { code: '1000', debit: '0.10', credit: '0.00', fund: null },
          { code: '4000', debit: '0.00', credit: '0.10', fund: null },
        ]),
      );
      const tb = await tx((x) => ledger.trialBalance(x, PERIOD.key));
      expect(tb.find((r) => r.code === '1000')).toMatchObject({ debit: '0.30', credit: '0.00' });
      expect(tb.find((r) => r.code === '4000')).toMatchObject({ debit: '0.00', credit: '0.30' });
    });

    it('refuses an unbalanced journal, even through the store with no domain check', async () => {
      const { ledger } = world().stores;
      const entry = balanced(periodId, bank, income, '10.00');
      entry.lines[1]!.credit = '9.99';
      await expectRefused(world(), tx((x) => ledger.insertEntry(x, ACTOR, entry)), 'rule');
    });

    it('refuses an unbalanced journal written directly', async () => {
      await expectRefused(
        world(),
        tx((x) => world().bypass.insertJournal(x, { periodId, date: IN_PERIOD, lines: [{ accountId: bank, debit: '5.00', credit: '0' }] })),
        'rule',
      );
      await expectRefused(
        world(),
        tx((x) =>
          world().bypass.insertJournal(x, {
            periodId,
            date: IN_PERIOD,
            lines: [
              { accountId: bank, debit: '5.00', credit: '0' },
              { accountId: income, debit: '0', credit: '4.00' },
            ],
          }),
        ),
        'rule',
      );
    });

    it(capabilities.deferrableFinancialConstraints ? 'checks balance at commit, so lines may be written one by one' : 'checks balance per entry write', async () => {
      const id = await tx((x) =>
        world().bypass.insertJournal(x, {
          periodId,
          date: IN_PERIOD,
          lines: [
            { accountId: bank, debit: '7.00', credit: '0' },
            { accountId: income, debit: '0', credit: '7.00' },
          ],
        }),
      );
      expect(await tx((x) => world().stores.ledger.entryStatus(x, id))).toBe('posted');
    });

    it('refuses a line that is both or neither debit and credit, or negative', async () => {
      const bad = (debit: string, credit: string) =>
        tx((x) =>
          world().bypass.insertJournal(x, {
            periodId,
            date: IN_PERIOD,
            lines: [
              { accountId: bank, debit, credit },
              { accountId: income, debit: credit, credit: debit },
            ],
          }),
        );
      await expectRefused(world(), bad('1.00', '1.00'), 'rule');
      await expectRefused(world(), bad('0', '0'), 'rule');
      await expectRefused(world(), bad('-1.00', '0'), 'rule');
    });

    it('refuses posting to a closed period, and accepts it again once reopened', async () => {
      const { ledger } = world().stores;
      expect(await tx((x) => ledger.closePeriod(x, ACTOR, PERIOD.key))).toBe(true);
      expect(await tx((x) => ledger.closePeriod(x, ACTOR, PERIOD.key))).toBe(false);
      await expectRefused(world(), tx((x) => ledger.insertEntry(x, ACTOR, balanced(periodId, bank, income, '1.00'))), 'rule');
      expect(await tx((x) => ledger.reopenPeriod(x, ACTOR, PERIOD.key, 'late gift'))).toBe(true);
      await tx((x) => ledger.insertEntry(x, ACTOR, balanced(periodId, bank, income, '1.00')));
    });

    it('refuses an entry dated outside its period', async () => {
      const entry = { ...balanced(periodId, bank, income, '1.00'), date: '2031-04-01' };
      await expectRefused(world(), tx((x) => world().stores.ledger.insertEntry(x, ACTOR, entry)), 'rule');
    });

    it('keeps posted entries immutable: no changed amount, memo or deletion', async () => {
      const id = await tx((x) => world().stores.ledger.insertEntry(x, ACTOR, balanced(periodId, bank, income, '3.00')));
      await expectRefused(world(), tx((x) => world().bypass.setJournalLineAmount(x, id, '4.00')), 'rule');
      await expectRefused(world(), tx((x) => world().bypass.setJournalMemo(x, id, 'edited')), 'rule');
      await expectRefused(world(), tx((x) => world().bypass.deleteJournal(x, id)), 'rule');
      expect(await tx((x) => world().stores.ledger.entryLines(x, id))).toEqual(expect.arrayContaining([{ code: '1000', debit: '3.00', credit: '0.00', fund: null }]));
    });

    it('refuses new lines on a posted entry, even a balanced pair', async () => {
      const id = await tx((x) => world().stores.ledger.insertEntry(x, ACTOR, balanced(periodId, bank, income, '5.00')));
      const pair = [
        { accountId: bank, debit: '9.00', credit: '0' },
        { accountId: income, debit: '0', credit: '9.00' },
      ];
      await expectRefused(world(), tx((x) => world().bypass.addJournalLines(x, id, pair)), 'rule');
      expect(await tx((x) => world().stores.ledger.entryLines(x, id))).toHaveLength(2);
    });

    it('reverses an entry once, and a reversed entry never returns to posted', async () => {
      const { ledger } = world().stores;
      const id = await tx((x) => ledger.insertEntry(x, ACTOR, balanced(periodId, bank, income, '2.00')));
      await tx(async (x) => {
        await ledger.insertEntry(x, ACTOR, { ...balanced(periodId, income, bank, '2.00'), reversesEntryId: id });
        await ledger.markReversed(x, id);
      });
      expect(await tx((x) => ledger.entryStatus(x, id))).toBe('reversed');
      await expectRefused(world(), tx((x) => ledger.insertEntry(x, ACTOR, { ...balanced(periodId, income, bank, '2.00'), reversesEntryId: id })), 'duplicate');
      await expectRefused(world(), tx((x) => world().bypass.setJournalStatus(x, id, 'posted')), 'rule');
    });

    it('posts one entry per record and rule', async () => {
      const { ledger, records } = world().stores;
      const recordId = await tx(async (x) => (await records.insert(x, newRecord('ledgerSource'))).id);
      const source = { sourceRecordId: recordId, sourceRule: 'donation.paid' };
      await tx((x) => ledger.insertEntry(x, ACTOR, balanced(periodId, bank, income, '5.00', source)));
      await expectRefused(world(), tx((x) => ledger.insertEntry(x, ACTOR, balanced(periodId, bank, income, '5.00', source))), 'duplicate');
    });

    it('keeps the financial-year start held for the transaction', async () => {
      const { ledger } = world().stores;
      await tx(async (x) => {
        await ledger.holdFiscalYearStart(x);
        expect(await ledger.fiscalYearStartMonth(x)).toBeGreaterThanOrEqual(1);
      });
    });
  });
}
