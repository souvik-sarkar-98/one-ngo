import { beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from '../../domain/ports/transaction.js';
import { type World } from './support.js';

/** `OutboxStore`: append in the change's transaction, claim with a lease, complete, fail, retry. */
export function defineOutboxContract(world: World): void {
  describe('OutboxStore', () => {
    let t: string;
    const tx = <T>(fn: (x: Tx) => Promise<T>) => world().transactions.withTenant(t, fn);
    const events = (type: string) => tx(async (x) => (await world().bypass.outboxEvents(x)).filter((e) => e.type === type));
    const append = (type: string, payload: Record<string, unknown>) => tx((x) => world().stores.records.enqueueEvent(x, type, payload));

    beforeAll(async () => {
      t = await world().newTenant();
    });

    it('delivers an appended event once to each handler, with its organisation and payload, then marks it done', async () => {
      const outbox = world().outbox();
      const seen: unknown[] = [];
      outbox.on('contract.done', 'first', async (e) => {
        seen.push(['first', e.tenantId, e.payload]);
      });
      outbox.on('contract.done', 'second', async (e) => {
        seen.push(['second', e.tenantId, e.payload]);
      });
      await append('contract.done', { gift: 'G-1' });
      expect((await outbox.runOnce()).processed).toBeGreaterThanOrEqual(1);
      expect(seen).toEqual([
        ['first', t, { gift: 'G-1' }],
        ['second', t, { gift: 'G-1' }],
      ]);
      expect(await events('contract.done')).toMatchObject([{ status: 'done', attempts: 1 }]);
      await outbox.runOnce();
      expect(seen).toHaveLength(2);
    });

    it('appends nothing when the change’s transaction rolls back', async () => {
      await expect(
        tx(async (x) => {
          await world().stores.records.enqueueEvent(x, 'contract.rolledBack', {});
          throw new Error('rolled back');
        }),
      ).rejects.toThrow();
      expect(await events('contract.rolledBack')).toEqual([]);
    });

    it('retries a failed handler later, re-running only the handlers not yet finished', async () => {
      const outbox = world().outbox();
      const calls: string[] = [];
      let failing = true;
      outbox.on('contract.retry', 'stable', async () => {
        calls.push('stable');
      });
      outbox.on('contract.retry', 'flaky', async () => {
        calls.push('flaky');
        if (failing) throw new Error('remote down');
      });
      await append('contract.retry', {});
      expect((await outbox.runOnce()).retried).toBe(1);
      expect(await events('contract.retry')).toMatchObject([{ status: 'pending', attempts: 1 }]);

      await outbox.runOnce();
      expect(calls).toEqual(['stable', 'flaky']);

      failing = false;
      await tx((x) => world().bypass.makeOutboxDue(x));
      expect((await outbox.runOnce()).processed).toBe(1);
      expect(calls).toEqual(['stable', 'flaky', 'flaky']);
      expect(await events('contract.retry')).toMatchObject([{ status: 'done', attempts: 2 }]);
    });

    it('gives up after the last attempt and marks the event failed', async () => {
      const outbox = world().outbox();
      outbox.on('contract.dead', 'always', async () => {
        throw new Error('never works');
      });
      await append('contract.dead', {});
      let failed = 0;
      for (let attempt = 0; attempt < 10 && !failed; attempt++) {
        await tx((x) => world().bypass.makeOutboxDue(x));
        failed = (await outbox.runOnce()).failed;
      }
      expect(failed).toBe(1);
      const [event] = await events('contract.dead');
      expect(event?.status).toBe('failed');
      await tx((x) => world().bypass.makeOutboxDue(x));
      expect((await outbox.runOnce()).failed).toBe(0);
    });

    it('hands each event to exactly one of several concurrent dispatchers', async () => {
      const delivered: string[] = [];
      const dispatchers = [world().outbox(), world().outbox(), world().outbox()];
      for (const d of dispatchers) {
        d.on('contract.race', 'one', async (e) => {
          delivered.push(e.id);
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      for (let i = 0; i < 8; i++) await append('contract.race', { i });
      await Promise.all(dispatchers.map((d) => d.runOnce()));
      const ids = (await events('contract.race')).map((e) => e.id);
      expect(delivered.sort()).toEqual(ids.sort());
      expect(await events('contract.race')).toEqual(ids.map(() => expect.objectContaining({ status: 'done' })));
    });
  });
}
