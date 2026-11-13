import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordAggregates } from '../src/runtime/records/aggregates.js';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { transactions } from '../src/infrastructure/postgres/tx.js';
import type { DefinitionBodies, DefinitionKind } from '../src/runtime/definitions/types.js';
import { admin, completeIdentity, createWorld, expectCode, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

let w: TestWorld;
const finance: Actor = { id: 'fin-1', roles: ['finance'], permissions: ['record:donor:*', 'record:donation:*'] };
const ctx = (actor: Actor = finance) => w.as(w.ngoA, actor);
let asha: string;
let bala: string;

async function publish<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<void> {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, body.key);
}
async function donation(donor: string | null, amount: number, paid?: { method: string; paidOn: string; reference?: string }) {
  const { record } = await w.platform.records.create(ctx(), 'donation', donor ? { donor, amount } : { donorName: 'Walk-in', amount });
  if (paid) await w.platform.records.transition(ctx(), record.id, 'markPaid', { expectedVersion: 1, data: paid });
  return record.id;
}

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await completeIdentity(w, w.ngoA);
  await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.openFiscalYear(asTx(tx), admin, '2025-26'));
  asha = (await w.platform.records.create(ctx(), 'donor', { name: 'Asha' })).record.id;
  bala = (await w.platform.records.create(ctx(), 'donor', { name: 'Bala' })).record.id;
  await donation(asha, 500, { method: 'cash', paidOn: '2026-03-31' });
  await donation(asha, 250, { method: 'upi', paidOn: '2026-04-01', reference: 'UPI-1' });
  await donation(bala, 1000, { method: 'cash', paidOn: '2026-04-15' });
  await donation(bala, 75);
  await donation(null, 25);
});
afterAll(() => w.close());

describe('query sums and reference filters', () => {
  it('totals over every matching record, not just the page', async () => {
    const all = await w.platform.records.query(ctx(), 'donation', { sum: ['amount'], limit: 1 });
    expect(all).toMatchObject({ total: 5, sums: { amount: 1850 } });
    expect(all.items).toHaveLength(1);
    const paid = await w.platform.records.query(ctx(), 'donation', { statusIn: ['paid'], sum: ['amount', 'netAmount'] });
    expect(paid.sums).toEqual({ amount: 1750, netAmount: 1750 });
    expect((await w.platform.records.query(ctx(), 'donation', { statusIn: ['cancelled'], sum: ['amount'] })).sums).toEqual({ amount: 0 });
    await expectCode(w.platform.records.query(ctx(), 'donation', { sum: ['donorName'] }), 'validation_failed');
  });

  it('filters by a chosen record, as related sections do', async () => {
    const mine = await w.platform.records.query(ctx(), 'donation', { filters: { donor: { in: [asha] } }, sum: ['amount'] });
    expect(mine).toMatchObject({ total: 2, sums: { amount: 750 } });
  });
});

describe('locations', () => {
  beforeAll(async () => {
    await publish('recordType', { key: 'site', label: 'Site', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'place', label: 'Place', type: 'location' }] });
    for (const [name, lat, lng] of [
      ['Mumbai', 19.07609, 72.877426],
      ['Pune', 18.52043, 73.856743],
      ['Delhi', 28.613939, 77.209021],
    ] as const) {
      await w.platform.records.create(w.as(w.ngoA), 'site', { name, place: { lat, lng } });
    }
    await w.platform.records.create(w.as(w.ngoA), 'site', { name: 'Nowhere' });
  });
  const names = (r: { items: { data: Record<string, unknown> }[] }) => r.items.map((i) => i.data.name);

  it('finds records within a distance of a point', async () => {
    const near = await w.platform.records.query(w.as(w.ngoA), 'site', { filters: { place: { near: { lat: 19.07609, lng: 72.877426, km: 200 } } } });
    expect(names(near).sort()).toEqual(['Mumbai', 'Pune']);
    const close = await w.platform.records.query(w.as(w.ngoA), 'site', { filters: { place: { near: { lat: 19.07609, lng: 72.877426, km: 5 } } } });
    expect(names(close)).toEqual(['Mumbai']);
  });

  it('sorts nearest first from a point, with no location last', async () => {
    const sorted = await w.platform.records.query(w.as(w.ngoA), 'site', { sort: { field: 'place', dir: 'asc', from: { lat: 28.6, lng: 77.2 } } });
    expect(names(sorted)).toEqual(['Delhi', 'Mumbai', 'Pune', 'Nowhere']);
  });

  it('refuses bad points and distances', async () => {
    await expectCode(w.platform.records.query(w.as(w.ngoA), 'site', { filters: { place: { near: { lat: 95, lng: 0, km: 5 } } } }), 'validation_failed');
    await expectCode(w.platform.records.query(w.as(w.ngoA), 'site', { filters: { place: { near: { lat: 1, lng: 1, km: 0 } } } }), 'validation_failed');
    await expectCode(w.platform.records.query(w.as(w.ngoA), 'site', { filters: { name: { near: { lat: 1, lng: 1, km: 1 } } } }), 'validation_failed');
    await expectCode(w.platform.records.query(w.as(w.ngoA), 'site', { sort: { field: 'place' } }), 'validation_failed');
  });
});

describe('workflow states', () => {
  beforeAll(async () => {
    await publish('recordType', { key: 'ticket', label: 'Ticket', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }] });
    await publish('workflow', {
      key: 'ticket',
      recordType: 'ticket',
      initial: 'open',
      states: [{ key: 'open', label: 'Open' }, { key: 'done', label: 'Done' }],
      transitions: [{ key: 'finish', label: 'Finish', from: ['open'], to: 'done' }],
    });
    await publish('workflow', {
      key: 'review',
      recordType: 'ticket',
      role: 'parallel',
      initial: 'pending',
      states: [{ key: 'pending', label: 'Pending' }, { key: 'reviewed', label: 'Reviewed' }],
      transitions: [{ key: 'approveIt', label: 'Review', from: ['pending'], to: 'reviewed' }],
    });
    const a = (await w.platform.records.create(w.as(w.ngoA), 'ticket', { title: 'A' })).record;
    await w.platform.records.create(w.as(w.ngoA), 'ticket', { title: 'B' });
    await w.platform.records.transition(w.as(w.ngoA), a.id, 'approveIt', { expectedVersion: 1 });
  });

  it('filters by the states of any workflow', async () => {
    const q = (states: Record<string, string[]>) => w.platform.records.query(w.as(w.ngoA), 'ticket', { states }).then((r) => r.items.map((i) => i.data.title));
    expect(await q({ review: ['reviewed'] })).toEqual(['A']);
    expect((await q({ review: ['pending'] })).sort()).toEqual(['B']);
    expect((await q({ ticket: ['open'] })).sort()).toEqual(['A', 'B']);
    await expectCode(q({ ghost: ['x'] }), 'validation_failed');
  });
});

describe('restricted visibility in lists and totals', () => {
  const person = (id: string, extra: string[] = []): Actor => ({ id, roles: [], permissions: ['record:memo:read', 'record:memo:create', ...extra] });
  beforeAll(async () => {
    await publish('recordType', {
      key: 'memo',
      label: 'Memo',
      visibility: 'restricted',
      fields: [{ key: 'text', label: 'Text', type: 'text', required: true }, { key: 'cost', label: 'Cost', type: 'money' }],
    });
    await w.platform.records.create(w.as(w.ngoA, person('author')), 'memo', { text: 'Mine', cost: 10 });
    const shared = await w.platform.records.create(w.as(w.ngoA, person('other')), 'memo', { text: 'Shared', cost: 20 });
    await w.platform.records.create(w.as(w.ngoA, person('other')), 'memo', { text: 'Hidden', cost: 40 });
    await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query(
        `insert into record_share (tenant_id, record_id, principal_kind, principal, access, created_by) values (app_tenant(), $1, 'user', 'author', 'read', 'other')`,
        [shared.record.id],
      ),
    );
  });

  it('applies to the list, its total and sums', async () => {
    const mine = await w.platform.records.query(w.as(w.ngoA, person('author')), 'memo', { sum: ['cost'] });
    expect(mine.items.map((i) => i.data.text).sort()).toEqual(['Mine', 'Shared']);
    expect(mine).toMatchObject({ total: 2, sums: { cost: 30 } });
    expect((await w.platform.records.query(w.as(w.ngoA, person('nosy')), 'memo')).total).toBe(0);
    expect((await w.platform.records.query(w.as(w.ngoA, person('boss', ['record:memo:read:all'])), 'memo')).total).toBe(3);
  });

  it('applies to aggregates', async () => {
    const agg = new RecordAggregates(transactions(w.platform.db), w.platform.records);
    expect(await agg.aggregate(w.as(w.ngoA, person('author')), 'memo', { measure: 'sum', field: 'cost' })).toEqual({ value: 30 });
    expect(await agg.aggregate(w.as(w.ngoA, person('nosy')), 'memo', { measure: 'count' })).toEqual({ value: 0 });
  });
});

describe('aggregates', () => {
  let clock = 0;
  const agg = () => new RecordAggregates(transactions(w.platform.db), w.platform.records, () => clock);

  it('count and sum, optionally filtered', async () => {
    const a = agg();
    expect(await a.aggregate(ctx(), 'donation', { measure: 'count' })).toEqual({ value: 5 });
    expect(await a.aggregate(ctx(), 'donation', { measure: 'sum', field: 'amount', statusIn: ['paid'] })).toEqual({ value: 1750 });
    expect(await a.aggregate(ctx(), 'donation', { measure: 'sum', field: 'amount', filters: { method: { in: ['cash'] } } })).toEqual({ value: 1500 });
  });

  it('group by status, choice and chosen record, with labels', async () => {
    const a = agg();
    expect(await a.aggregate(ctx(), 'donation', { measure: 'count', groupBy: { field: 'status' } })).toEqual({
      buckets: [
        { key: 'paid', label: 'Paid', value: 3 },
        { key: 'raised', label: 'Raised', value: 2 },
      ],
    });
    expect(await a.aggregate(ctx(), 'donation', { measure: 'sum', field: 'amount', groupBy: { field: 'method' } })).toEqual({
      buckets: [
        { key: 'cash', label: 'Cash', value: 1500 },
        { key: 'upi', label: 'UPI', value: 250 },
      ],
    });
    expect(await a.aggregate(ctx(), 'donation', { measure: 'sum', field: 'amount', groupBy: { field: 'donor' } })).toEqual({
      buckets: [
        { key: bala, label: 'Bala', value: 1075 },
        { key: asha, label: 'Asha', value: 750 },
      ],
    });
  });

  it('group by month and by financial year (April to March)', async () => {
    const a = agg();
    expect(await a.aggregate(ctx(), 'donation', { measure: 'sum', field: 'amount', groupBy: { period: 'month', dateField: 'paidOn' } })).toEqual({
      buckets: [
        { key: '2026-03', label: 'Mar 2026', value: 500 },
        { key: '2026-04', label: 'Apr 2026', value: 1250 },
      ],
    });
    expect(await a.aggregate(ctx(), 'donation', { measure: 'count', groupBy: { period: 'financialYear', dateField: 'paidOn' } })).toEqual({
      buckets: [
        { key: '2025-26', label: 'FY 2025-26', value: 1 },
        { key: '2026-27', label: 'FY 2026-27', value: 2 },
      ],
    });
    const byDay = await a.aggregate(ctx(), 'donation', { measure: 'count', groupBy: { period: 'day', dateField: 'createdAt' } });
    expect('buckets' in byDay && byDay.buckets.reduce((n, b) => n + b.value, 0)).toBe(5);
  });

  it('refuse sensitive, unknown and unsuitable fields, and people who cannot read', async () => {
    const a = agg();
    const viewer: Actor = { id: 'v', roles: [], permissions: ['record:donation:read'] };
    await expectCode(a.aggregate(w.as(w.ngoA, viewer), 'donation', { measure: 'count', groupBy: { field: 'donorPan' } }), 'forbidden');
    await expectCode(a.aggregate(ctx(), 'donation', { measure: 'sum', field: 'donorName' }), 'validation_failed');
    await expectCode(a.aggregate(ctx(), 'donation', { measure: 'count', groupBy: { field: 'notes' } }), 'validation_failed');
    await expectCode(a.aggregate(ctx(), 'donation', { measure: 'count', groupBy: { period: 'month', dateField: 'amount' } }), 'validation_failed');
    await expectCode(a.aggregate(w.as(w.ngoA, { id: 'n', roles: [], permissions: [] }), 'donation', { measure: 'count' }), 'forbidden');
  });

  it('keep a result for five minutes', async () => {
    const a = agg();
    clock = 1_000;
    expect(await a.aggregate(ctx(), 'donor', { measure: 'count' })).toEqual({ value: 2 });
    await w.platform.records.create(ctx(), 'donor', { name: 'Chitra' });
    clock += 4 * 60_000;
    expect(await a.aggregate(ctx(), 'donor', { measure: 'count' })).toEqual({ value: 2 });
    clock += 2 * 60_000;
    expect(await a.aggregate(ctx(), 'donor', { measure: 'count' })).toEqual({ value: 3 });
  });

  it('are available over HTTP', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/records/donation/aggregate',
      headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(finance) },
      payload: { measure: 'sum', field: 'amount', groupBy: { period: 'financialYear', dateField: 'paidOn' } },
    });
    expect(res.json()).toEqual({ buckets: [{ key: '2025-26', label: 'FY 2025-26', value: 500 }, { key: '2026-27', label: 'FY 2026-27', value: 1250 }] });
    await app.close();
  });
});
