import { beforeAll, describe, expect, it } from 'vitest';
import { gate, newRecord, type World } from './support.js';

/** `TransactionManager`: tenant-scoped transaction, rollback, isolation level, read-only, joined transactions. */
export function defineTransactionContract(world: World): void {
  describe('TransactionManager', () => {
    let t: string;
    const count = (typeKey: string) => world().transactions.withTenant(t, (tx) => world().stores.records.countOfType(tx, typeKey));

    beforeAll(async () => {
      t = await world().newTenant();
    });

    it('commits what the function wrote and returns its value', async () => {
      const id = await world().transactions.withTenant(t, async (tx) => (await world().stores.records.insert(tx, newRecord('txCommit'))).id);
      expect(typeof id).toBe('string');
      expect(await count('txCommit')).toBe(1);
    });

    it('rolls back everything when the function throws', async () => {
      await expect(
        world().transactions.withTenant(t, async (tx) => {
          await world().stores.records.insert(tx, newRecord('txRollback'));
          await world().stores.records.enqueueEvent(tx, 'tx.rollback', {});
          throw new Error('stop');
        }),
      ).rejects.toThrow('stop');
      expect(await count('txRollback')).toBe(0);
      expect((await world().transactions.withTenant(t, (tx) => world().bypass.outboxEvents(tx))).filter((e) => e.type === 'tx.rollback')).toEqual([]);
    });

    it('refuses writes in a read-only transaction', async () => {
      await expect(world().transactions.withTenant(t, (tx) => world().stores.records.insert(tx, newRecord('txReadOnly')), { readOnly: true })).rejects.toThrow();
      expect(await count('txReadOnly')).toBe(0);
    });

    it('keeps one snapshot for a repeatable-read transaction', async () => {
      const held = gate();
      const read = gate();
      const reader = world().transactions.withTenant(
        t,
        async (tx) => {
          const before = await world().stores.records.countOfType(tx, 'txSnapshot');
          read.open();
          await held.wait;
          return [before, await world().stores.records.countOfType(tx, 'txSnapshot')];
        },
        { isolation: 'repeatable read' },
      );
      await read.wait;
      await world().transactions.withTenant(t, (tx) => world().stores.records.insert(tx, newRecord('txSnapshot')));
      held.open();
      expect(await reader).toEqual([0, 0]);
      expect(await count('txSnapshot')).toBe(1);
    });

    it('lets services join one open transaction, committing or rolling back together', async () => {
      await expect(
        world().transactions.withTenant(t, async (tx) => {
          const joined = world().joinTx(t, tx);
          await joined.withTenant(t, (inner) => world().stores.records.insert(inner, newRecord('txJoined')));
          throw new Error('outer fails');
        }),
      ).rejects.toThrow('outer fails');
      expect(await count('txJoined')).toBe(0);
      await world().transactions.withTenant(t, (tx) => world().joinTx(t, tx).withTenant(t, (inner) => world().stores.records.insert(inner, newRecord('txJoined'))));
      expect(await count('txJoined')).toBe(1);
    });

    it('refuses to join a transaction for another organisation', async () => {
      const other = await world().newTenant();
      await expect(world().transactions.withTenant(t, (tx) => world().joinTx(t, tx).withTenant(other, async () => undefined))).rejects.toThrow();
    });
  });
}
