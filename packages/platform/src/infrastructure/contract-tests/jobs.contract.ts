import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseCapabilities } from '../../domain/ports/database-capabilities.js';
import { ctxOf, gate, type World } from './support.js';

type Steps = { step?: number };

/** `JobStore`: append, claim with a lease, complete, fail, retry (resume), cancel; tenant-scoped reads. */
export function defineJobContract(world: World, capabilities: DatabaseCapabilities): void {
  describe('JobStore', () => {
    let t: string;
    let other: string;

    beforeAll(async () => {
      t = await world().newTenant();
      other = await world().newTenant();
    });

    it('runs a queued job to done in batches, saving its state between them', async () => {
      const jobs = world().jobs();
      const seen: number[] = [];
      jobs.register<{ upTo: number }, Steps>('contract.count', {
        label: 'Count',
        async run({ input, state }) {
          const step = (state.step ?? 0) + 1;
          seen.push(step);
          return { state: { step }, progress: step, total: input.upTo, done: step >= input.upTo, result: { last: step } };
        },
      });
      const job = await jobs.create(ctxOf(t), 'contract.count', { upTo: 3 });
      expect(job.status).toBe('queued');
      expect(await jobs.runOnce()).toEqual({ jobs: 1, batches: 3 });
      expect(seen).toEqual([1, 2, 3]);
      expect(await jobs.get(ctxOf(t), job.id)).toMatchObject({ status: 'done', progress: 3, result: { last: 3 } });
    });

    it('records a failed job with its error', async () => {
      const jobs = world().jobs();
      jobs.register('contract.fail', {
        label: 'Fail',
        async run() {
          throw new Error('the source file is gone');
        },
      });
      const job = await jobs.create(ctxOf(t), 'contract.fail', {});
      await jobs.runOnce();
      expect(await jobs.get(ctxOf(t), job.id)).toMatchObject({ status: 'failed', error: 'the source file is gone' });
    });

    it('cancels a queued job before it runs', async () => {
      const jobs = world().jobs();
      let ran = false;
      jobs.register('contract.cancel', {
        label: 'Cancel',
        async run() {
          ran = true;
          return { state: {}, progress: 1, done: true };
        },
      });
      const job = await jobs.create(ctxOf(t), 'contract.cancel', {});
      expect((await jobs.cancel(ctxOf(t), job.id)).status).toBe('cancelled');
      await jobs.runOnce();
      expect(ran).toBe(false);
    });

    it('shows a job only to its organisation', async () => {
      const jobs = world().jobs();
      jobs.register('contract.private', { label: 'Private', run: async () => ({ state: {}, progress: 0, done: true }) });
      const job = await jobs.create(ctxOf(t), 'contract.private', {});
      await expect(jobs.get(ctxOf(other), job.id)).rejects.toThrow();
      await jobs.runOnce();
    });

    it('lets no second worker claim a job while its lease holds, and resumes it from saved state once the lease ends', async () => {
      const inFirst = gate();
      const release = gate();
      const runs: { worker: string; from: number }[] = [];
      const kind = (worker: string) => ({
        label: 'Lease',
        async run({ state }: { state: Steps }) {
          const from = state.step ?? 0;
          runs.push({ worker, from });
          if (worker === 'first' && from === 1) {
            inFirst.open();
            await release.wait;
            throw new Error('worker lost');
          }
          return { state: { step: from + 1 }, progress: from + 1, done: from + 1 >= 3 };
        },
      });
      const first = world().jobs();
      const second = world().jobs();
      first.register('contract.lease', kind('first'));
      second.register('contract.lease', kind('second'));
      const job = await first.create(ctxOf(t), 'contract.lease', {});

      const firstRun = first.runOnce();
      await inFirst.wait;
      expect(await second.runOnce()).toEqual({ jobs: 0, batches: 0 });

      await world().transactions.withTenant(t, (tx) => world().bypass.expireJobLeases(tx));
      await second.runOnce();
      expect(await second.get(ctxOf(t), job.id)).toMatchObject({ status: 'done', progress: 3 });
      release.open();
      await firstRun;
      expect(runs).toEqual([
        { worker: 'first', from: 0 },
        { worker: 'first', from: 1 },
        { worker: 'second', from: 1 },
        { worker: 'second', from: 2 },
      ]);
      expect((await first.get(ctxOf(t), job.id)).status).toBe('done');
    });

    it('hands each job to exactly one of several concurrent workers', async () => {
      const ran: string[] = [];
      const workers = [world().jobs(), world().jobs(), world().jobs()];
      for (const w of workers) {
        w.register('contract.once', {
          label: 'Once',
          async run({ jobId }) {
            ran.push(jobId);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { state: {}, progress: 1, done: true };
          },
        });
      }
      const created = await Promise.all(Array.from({ length: 6 }, () => workers[0]!.create(ctxOf(t), 'contract.once', {})));
      const results = await Promise.all(workers.map((w) => w.runOnce()));
      expect(ran.sort()).toEqual(created.map((j) => j.id).sort());
      if (capabilities.skipLocked) expect(results.filter((r) => r.jobs > 0).length).toBeGreaterThan(1);
    });

    it('runs one exclusive job per organisation at a time, in order', async () => {
      const order: string[] = [];
      const jobs = world().jobs();
      jobs.register<{ name: string }, Steps>('contract.exclusive', {
        label: 'Exclusive',
        exclusive: true,
        async run({ input }) {
          order.push(input.name);
          return { state: {}, progress: 1, done: true };
        },
      });
      await jobs.create(ctxOf(t), 'contract.exclusive', { name: 'a' });
      await jobs.create(ctxOf(t), 'contract.exclusive', { name: 'b' });
      await jobs.runOnce();
      expect(order).toEqual(['a', 'b']);
    });
  });
}
