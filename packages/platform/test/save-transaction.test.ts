import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RecordService } from '../src/runtime/records/record-service.js';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { transactions } from '../src/infrastructure/postgres/tx.js';
import { admin, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
const finance: Actor = { id: 'fin-1', roles: ['finance'], permissions: ['record:donor:*', 'record:donation:*'] };
const as = () => w.as(w.ngoA, finance);

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await completeIdentity(w, w.ngoA);
  app = buildServer(w.platform, { devAuth: true });
  const { failed } = await w.platform.indexes.buildPending(w.ngoA, 100);
  expect(failed).toEqual([]);
});
afterAll(async () => {
  await app.close();
  await w.close();
});

/** The platform pool, so a test can count the connections a save checks out. */
const poolOf = () => (w.platform.db as unknown as { pool: { connect: () => Promise<unknown> } }).pool;

/** Record service over a pinned definition snapshot, so only the save itself touches the pool. */
async function pinnedRecords(): Promise<RecordService> {
  return w.platform.records.within(transactions(w.platform.db), await w.platform.definitions.pinned(w.ngoA));
}

async function checkouts<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
  const connect = vi.spyOn(poolOf(), 'connect');
  try {
    const result = await fn();
    return { result, count: connect.mock.calls.length };
  } finally {
    connect.mockRestore();
  }
}

describe('one transaction per save', () => {
  it('checks out one pool connection for a create, an update and a transition with its effects', async () => {
    const records = await pinnedRecords();
    const donor = await checkouts(() => records.create(as(), 'donor', { name: 'Asha', pan: 'ABCDE1234F', city: 'Pune' }));
    expect(donor.count).toBe(1);

    const updated = await checkouts(() => records.update(as(), donor.result.record.id, { expectedVersion: 1, data: { city: 'Mumbai', pan: 'ABCDE1234G' } }));
    expect(updated.count).toBe(1);
    expect(updated.result.record.data).toMatchObject({ city: 'Mumbai', pan: 'ABCDE1234G' });

    const donation = (await records.create(as(), 'donation', { donor: donor.result.record.id, amount: 500 })).record;
    const paid = await checkouts(() =>
      records.transition(as(), donation.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn: today() } }),
    );
    expect(paid.count).toBe(1);
    expect(paid.result.record.status).toBe('paid');
    expect(paid.result.journalEntryIds).toHaveLength(1);
  });

  it('checks out one pool connection for a save the checks refuse, and for an import check', async () => {
    const records = await pinnedRecords();
    const refused = await checkouts(() => expectCode(records.create(as(), 'donor', { name: 'Copy', pan: 'ABCDE1234G' }), 'validation_failed'));
    expect(refused.count).toBe(1);
    const checked = await checkouts(() => records.check(as(), 'donor', { data: { name: 'Dry', pan: 'PQRST6789U' } }));
    expect(checked.count).toBe(1);
    expect(checked.result.data).toMatchObject({ name: 'Dry', pan: 'PQRST6789U' });
  });

  it('logs a failed before-save script in a second transaction after the save rolls back', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'script', {
      key: 'donorGuard',
      recordType: 'donor',
      hook: 'beforeSave',
      code: `if (ctx.record.name === 'Refused') ctx.fail('Not this donor.');`,
    });
    await w.platform.definitions.publish(ctx, 'script', 'donorGuard');
    const records = await pinnedRecords();

    const ok = await checkouts(() => records.create(as(), 'donor', { name: 'Allowed' }));
    expect(ok.count).toBe(1);
    const failed = await checkouts(() => expectCode(records.create(as(), 'donor', { name: 'Refused' }), 'script_failed'));
    expect(failed.count).toBe(2);

    const rows = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ outcome: string; record_id: string | null }>(`select outcome, record_id from script_run where script_key = 'donorGuard' order by id`),
    );
    expect(rows.map((r) => r.outcome)).toEqual(['ok', 'failed']);
    const names = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from record where type_key = 'donor' and data->>'name' = 'Refused'`),
    );
    expect(names[0]!.n).toBe(0);
  });
});

describe('concurrent saves of one unique value', () => {
  const create = (name: string, pan: string) =>
    app.inject({
      method: 'POST',
      url: '/api/records/donor',
      headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(admin) },
      payload: { name, pan },
    });

  it('rejects the second with 422 when the first is still open after its check and write', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const firstWrote = new Promise<void>((resolve) => (reached = resolve));
    // linkFiles runs inside the save transaction right after the insert.
    const spy = vi.spyOn(w.platform.records as unknown as { linkFiles: (...args: unknown[]) => Promise<void> }, 'linkFiles');
    spy.mockImplementationOnce(async () => {
      reached();
      await held;
    });

    const first = create('First', 'RACEA1234B');
    await firstWrote;
    const second = create('Second', 'RACEA1234B');
    try {
      await waitForLockWait();
    } finally {
      release();
      spy.mockRestore();
    }

    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(422);
    expect(b.json()).toMatchObject({ code: 'validation_failed', issues: [{ path: '/pan' }] });
  });

  it('accepts exactly one of two saves started together', async () => {
    const results = await Promise.all([create('Left', 'RACEB1234C'), create('Right', 'RACEB1234C')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.statusCode === 422)!.json()).toMatchObject({ code: 'validation_failed', issues: [{ path: '/pan' }] });
  });
});

/**
 * Waits until the second save is blocked behind the first one's open
 * transaction (on the record number or the unique index), past its own checks.
 */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [row] = await w.platform.db.asSystem((tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'transactionid'
            and (query ilike 'insert into "record"%' or query ilike 'insert into "sequence_counter"%')`,
      ),
    );
    if (row!.n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('The second save never waited for the first.');
}
