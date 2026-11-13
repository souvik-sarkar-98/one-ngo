import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { PostgresJobStore } from '../src/infrastructure/postgres/stores/job-store.js';
import { JobRunner } from '../src/infrastructure/jobs/jobs.js';
import type { JobItemResult, JobKind } from '../src/runtime/records/ports/job-runner.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let owner: Actor;
const stranger: Actor = { id: 'stranger-1', roles: [], permissions: [] };
const supervisor: Actor = { id: 'super-1', roles: ['admin'], permissions: ['admin:jobs'] };
const calls: string[] = [];

beforeAll(async () => {
  w = await createWorld({ donations: false, autoRunJobs: false });
  const [user] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ('jobs@example.org', 'Jobs Person') returning id`),
  );
  await w.platform.db.asSystem((tx) => tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, user!.id]));
  owner = { id: user!.id, roles: [], permissions: [] };

  // Counts to n; every fifth item fails.
  w.platform.jobs.register<{ n: number }, { next?: number }>('count', {
    label: 'Counting',
    batchSize: 3,
    async run({ jobId, input, state, batchSize }) {
      calls.push(jobId);
      const from = state.next ?? 1;
      const to = Math.min(from + batchSize - 1, input.n);
      const items: JobItemResult[] = [];
      for (let seq = from; seq <= to; seq++) {
        items.push(seq % 5 === 0 ? { seq, status: 'failed', message: `Row ${seq} is not valid` } : { seq, status: 'done' });
      }
      return { state: { next: to + 1 }, items, progress: to, total: input.n, done: to >= input.n, result: { counted: to } };
    },
  });
  w.platform.jobs.register<{ n: number }, { next?: number }>('exclusive', {
    label: 'Import',
    exclusive: true,
    batchSize: 1,
    async run({ jobId, input, state }) {
      calls.push(jobId);
      const next = (state.next ?? 0) + 1;
      return { state: { next }, progress: next, done: next >= input.n };
    },
  });
  w.platform.jobs.register('broken', {
    label: 'Broken',
    async run() {
      throw new Error('the file could not be read');
    },
  });
});
afterAll(() => w.close());

const job = (id: string, actor: Actor = owner, tenant?: string) => w.platform.jobs.get(w.as(tenant ?? w.ngoA, actor), id);

describe('background jobs', () => {
  it('run in batches, record item results and progress, and notify the creator', async () => {
    const created = await w.platform.jobs.create(w.as(w.ngoA, owner), 'count', { n: 7 });
    expect(created).toMatchObject({ status: 'queued', progress: 0 });
    calls.length = 0;
    await w.platform.jobs.runOnce();
    expect(calls.filter((c) => c === created.id)).toHaveLength(3);
    expect(await job(created.id)).toMatchObject({ status: 'done', progress: 7, total: 7, result: { counted: 7 } });
    const failed = await w.platform.jobs.items(w.as(w.ngoA, owner), created.id, { status: 'failed' });
    expect(failed.items).toEqual([{ seq: 5, status: 'failed', message: 'Row 5 is not valid' }]);
    expect((await w.platform.jobs.items(w.as(w.ngoA, owner), created.id)).items).toHaveLength(7);
    const inbox = await w.platform.notifications.inbox(w.as(w.ngoA, owner));
    expect(inbox[0]).toMatchObject({ subject: 'Counting finished', body: 'Counting finished: 6 done, 1 failed.' });
  });

  it('resume where they stopped after a short tick or a stopped process', async () => {
    const created = await w.platform.jobs.create(w.as(w.ngoA, owner), 'count', { n: 8 });
    await w.platform.jobs.runOnce({ timeBudgetMs: 0 });
    expect(await job(created.id)).toMatchObject({ status: 'running', progress: 3 });

    // Another process claimed it and stopped: the lease blocks others until it lapses.
    await w.platform.db.asSystem((tx) => tx.query(`update job set locked_until = now() + interval '1 minute' where id = $1`, [created.id]));
    await w.platform.jobs.runOnce();
    expect((await job(created.id)).progress).toBe(3);
    await w.platform.db.asSystem((tx) => tx.query(`update job set locked_until = now() - interval '1 second' where id = $1`, [created.id]));
    await w.platform.jobs.runOnce();
    expect(await job(created.id)).toMatchObject({ status: 'done', progress: 8 });
    expect((await w.platform.jobs.items(w.as(w.ngoA, owner), created.id)).items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('tell the creator once when another runner finished the job after the lease ran out', async () => {
    const other = new JobRunner(new PostgresJobStore(w.platform.db), {
      autoRun: false,
      notify: async (tenantId, userId, n) => {
        await w.platform.notifications.notifyText(tenantId, { to: { users: [userId] }, subject: n.subject, body: n.body });
      },
    });
    let handedOver = false;
    const handover: JobKind<Record<string, never>, Record<string, never>> = {
      label: 'Handover',
      async run({ jobId }) {
        if (!handedOver) {
          handedOver = true;
          // This batch outlives its lease, and another runner claims and finishes the job meanwhile.
          await w.platform.db.asSystem((tx) => tx.query(`update job set locked_until = now() - interval '1 second' where id = $1`, [jobId]));
          await other.runOnce();
        }
        return { state: {}, progress: 1, done: true };
      },
    };
    w.platform.jobs.register('handover', handover);
    other.register('handover', handover);
    const created = await w.platform.jobs.create(w.as(w.ngoA, owner), 'handover', {});
    await w.platform.jobs.runOnce();
    expect(await job(created.id)).toMatchObject({ status: 'done', progress: 1 });
    const notices = (await w.platform.notifications.inbox(w.as(w.ngoA, owner))).filter((n) => n.subject === 'Handover finished');
    expect(notices).toHaveLength(1);
  });

  it('cancel at once when queued, and before the next batch when running', async () => {
    const queued = await w.platform.jobs.create(w.as(w.ngoA, owner), 'count', { n: 3 });
    expect(await w.platform.jobs.cancel(w.as(w.ngoA, owner), queued.id)).toMatchObject({ status: 'cancelled', cancelRequested: true });

    const running = await w.platform.jobs.create(w.as(w.ngoA, owner), 'count', { n: 9 });
    await w.platform.jobs.runOnce({ timeBudgetMs: 0 });
    expect((await w.platform.jobs.cancel(w.as(w.ngoA, owner), running.id)).status).toBe('running');
    await w.platform.jobs.runOnce();
    expect(await job(running.id)).toMatchObject({ status: 'cancelled', progress: 3 });
    await expectCode(w.platform.jobs.cancel(w.as(w.ngoA, owner), running.id), 'conflict');
    expect((await w.platform.notifications.inbox(w.as(w.ngoA, owner)))[0]!.subject).toBe('Counting cancelled');
  });

  it('run one import or bulk job per organisation at a time, others in order', async () => {
    const a1 = await w.platform.jobs.create(w.as(w.ngoA, owner), 'exclusive', { n: 2 });
    const a2 = await w.platform.jobs.create(w.as(w.ngoA, owner), 'exclusive', { n: 1 });
    const b1 = await w.platform.jobs.create(w.as(w.ngoB, owner), 'exclusive', { n: 1 });
    await w.platform.db.asSystem((tx) =>
      tx.query(`update job set status = 'running', locked_until = now() + interval '1 minute' where id = $1`, [a1.id]),
    );
    await w.platform.jobs.runOnce();
    expect((await job(a2.id)).status).toBe('queued');
    expect((await job(b1.id, owner, w.ngoB)).status).toBe('done');

    await w.platform.db.asSystem((tx) => tx.query(`update job set locked_until = null where id = $1`, [a1.id]));
    calls.length = 0;
    await w.platform.jobs.runOnce();
    expect(calls).toEqual([a1.id, a1.id, a2.id]);
    expect((await job(a2.id)).status).toBe('done');
  });

  it('fail with the reason and tell the creator', async () => {
    const created = await w.platform.jobs.create(w.as(w.ngoA, owner), 'broken', {});
    await w.platform.jobs.runOnce();
    expect(await job(created.id)).toMatchObject({ status: 'failed', error: 'the file could not be read' });
    expect((await w.platform.notifications.inbox(w.as(w.ngoA, owner)))[0]).toMatchObject({ subject: 'Broken failed' });
  });

  it('are seen only by the creator or someone with admin:jobs, over HTTP too', async () => {
    const created = await w.platform.jobs.create(w.as(w.ngoA, owner), 'count', { n: 5 });
    await expectCode(job(created.id, stranger), 'not_found');
    await expectCode(job(created.id, owner, w.ngoB), 'not_found');
    await expectCode(w.platform.jobs.create(w.as(w.ngoA, owner), 'mystery', {}), 'validation_failed');
    expect((await job(created.id, supervisor)).id).toBe(created.id);

    const app = buildServer(w.platform, { devAuth: true });
    const call = (method: 'GET' | 'POST', url: string, actor: Actor) =>
      app.inject({ method, url, headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) } });
    expect((await call('GET', `/api/jobs/${created.id}`, owner)).json()).toMatchObject({ id: created.id, kind: 'count', status: 'queued' });
    expect((await call('GET', `/api/jobs/${created.id}`, stranger)).statusCode).toBe(404);
    await w.platform.jobs.runOnce();
    expect((await call('GET', `/api/jobs/${created.id}/items?status=failed`, owner)).json()).toEqual({
      items: [{ seq: 5, status: 'failed', message: 'Row 5 is not valid' }],
    });
    expect((await call('GET', `/api/jobs/${created.id}/items?status=nope`, owner)).statusCode).toBe(422);
    const again = await w.platform.jobs.create(w.as(w.ngoA, owner), 'count', { n: 3 });
    expect((await call('POST', `/api/jobs/${again.id}/cancel`, supervisor)).json()).toMatchObject({ status: 'cancelled' });
    await app.close();
  });
});
