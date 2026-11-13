import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { ListViewDef } from '../src/runtime/definitions/types.js';
import { buildServer } from '@onengo/server/http/server.js';
import { admin, clerk, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
const other: Actor = { ...clerk, id: 'clerk-2' };

beforeAll(async () => {
  w = await createWorld();
  await completeIdentity(w, w.ngoA);
  const ctx = w.as(w.ngoA, clerk);
  const mk = (donorName: string, amount: number, actor = clerk) => w.platform.records.create(w.as(w.ngoA, actor), 'donation', { donorName, amount });
  await mk('Asha', 100);
  await mk('Bala', 250);
  await mk('Chitra', 900, other);
  const paid = await mk('Dev', 500);
  await w.platform.records.transition(ctx, paid.record.id, 'markPaid', {
    expectedVersion: 1,
    data: { method: 'cash', paidOn: '2026-04-10' },
  });
  const cancelled = await mk('Esha', 50);
  await w.platform.records.transition(ctx, cancelled.record.id, 'cancel', { expectedVersion: 1 });
});
afterAll(() => w.close());

describe('record query', () => {
  const q = (c: Parameters<TestWorld['platform']['records']['query']>[2], actor: Actor = clerk) =>
    w.platform.records.query(w.as(w.ngoA, actor), 'donation', c);

  it('filters by several statuses and returns a real total', async () => {
    const closed = await q({ statusIn: ['paid', 'cancelled'] });
    expect(closed.total).toBe(2);
    expect(closed.items.map((r) => r.data.donorName).sort()).toEqual(['Dev', 'Esha']);
    const page = await q({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it('limits to records the signed-in person owns', async () => {
    expect((await q({ owner: 'me' })).total).toBe(4);
    expect((await q({ owner: 'me' }, other)).items.map((r) => r.data.donorName)).toEqual(['Chitra']);
  });

  it('filters by choice lists, number ranges, and date ranges', async () => {
    expect((await q({ filters: { method: { in: ['cash'] } } })).items.map((r) => r.data.donorName)).toEqual(['Dev']);
    expect((await q({ filters: { amount: { from: 200, to: 600 } } })).items.map((r) => r.data.donorName).sort()).toEqual(['Bala', 'Dev']);
    expect((await q({ filters: { paidOn: { from: '2026-04-01', to: '2026-04-30' } } })).total).toBe(1);
    expect((await q({ filters: { paidOn: { from: '2026-05-01' } } })).total).toBe(0);
  });

  it('combines search with filters and escapes wildcards', async () => {
    expect((await q({ search: 'ash', statusIn: ['raised'] })).items.map((r) => r.data.donorName)).toEqual(['Asha']);
    expect((await q({ search: '%' })).total).toBe(0);
  });

  it('sorts by fields, numbers, and record columns, with ties broken by newest', async () => {
    const byAmount = await q({ sort: { field: 'amount', dir: 'asc' } });
    expect(byAmount.items.map((r) => r.data.amount)).toEqual([50, 100, 250, 500, 900]);
    const byName = await q({ sort: { field: 'donorName', dir: 'desc' } });
    expect(byName.items[0]!.data.donorName).toBe('Esha');
    const byNumber = await q({ sort: { field: 'number', dir: 'asc' } });
    expect(byNumber.items[0]!.number).toMatch(/00001$/);
    const paidFirst = await q({ sort: { field: 'paidOn', dir: 'asc' } });
    expect(paidFirst.items[0]!.data.donorName).toBe('Dev');
    await expectCode(q({ sort: { field: 'donorPan' } }), 'forbidden');
    await expectCode(q({ sort: { field: 'colour' } }), 'validation_failed');
  });

  it('refuses unknown or sensitive fields and bad ranges', async () => {
    await expectCode(q({ filters: { colour: { in: ['red'] } } }), 'validation_failed');
    await expectCode(q({ filters: { donorPan: { in: ['X'] } } }), 'forbidden');
    await expectCode(q({ filters: { amount: { from: 'lots' } } }), 'validation_failed');
    await expectCode(q({ filters: { donorName: { from: 'A' } } }), 'validation_failed');
    await expectCode(q({}, { id: 'n', roles: [], permissions: [] }), 'forbidden');
  });

  it('is available over HTTP', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/records/donation/query',
      headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(clerk) },
      payload: { statusIn: ['raised'], owner: 'me', limit: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 2 });
    await app.close();
  });
});

describe('field conditions', () => {
  it('ignores values for hidden fields and keeps stored ones', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA, clerk), 'donation', {
      donorName: 'Hidden',
      amount: 10,
      method: 'cash',
      paidOn: today(),
    });
    expect(record.data).not.toHaveProperty('method');
    expect(record.data).not.toHaveProperty('paidOn');
  });

  it('blocks changing a field whose editableWhen is false, but allows other edits', async () => {
    const ctx = w.as(w.ngoA, clerk);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Locked', amount: 10 });
    const paid = await w.platform.records.transition(ctx, record.id, 'markPaid', {
      expectedVersion: 1,
      data: { method: 'cash', paidOn: today() },
    });
    expect(paid.record.data).toMatchObject({ method: 'cash', paidOn: today() });

    // A final status is read-only anyway; prove editableWhen on its own with a tenant-owned type.
    const admin_ = w.as(w.ngoA, admin);
    await w.platform.definitions.saveDraft(admin_, 'recordType', {
      key: 'pledge',
      label: 'Pledge',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'locked', label: 'Locked', type: 'boolean' },
        { key: 'amount', label: 'Amount', type: 'money', editableWhen: 'record.locked != true' },
        { key: 'reason', label: 'Reason', type: 'text', required: true, visibleWhen: 'record.locked == true' },
      ],
    });
    await w.platform.definitions.publish(admin_, 'recordType', 'pledge');
    const p = await w.platform.records.create(admin_, 'pledge', { name: 'P', amount: 5 });
    expect(p.record.data).toMatchObject({ amount: 5 });

    await expectCode(w.platform.records.update(admin_, p.record.id, { expectedVersion: 1, data: { locked: true } }), 'validation_failed');
    const locked = await w.platform.records.update(admin_, p.record.id, { expectedVersion: 1, data: { locked: true, reason: 'Audit' } });
    const err = await expectCode(
      w.platform.records.update(admin_, p.record.id, { expectedVersion: locked.record.version, data: { amount: 9 } }),
      'validation_failed',
    );
    expect((err as unknown as { issues: { path: string }[] }).issues[0]!.path).toBe('/amount');
    await w.platform.records.update(admin_, p.record.id, { expectedVersion: locked.record.version, data: { amount: 5, name: 'Renamed' } });
  });

  it('rejects invalid condition expressions when publishing', async () => {
    await w.platform.definitions.saveDraft(w.as(w.ngoA), 'recordType', {
      key: 'broken',
      label: 'Broken',
      fields: [{ key: 'x', label: 'X', type: 'text', visibleWhen: 'record.x ==' }],
    });
    await expectCode(w.platform.definitions.publish(w.as(w.ngoA), 'recordType', 'broken'), 'definition_invalid');
  });
});

describe('list view definitions', () => {
  it('ships a Donations list view and serves it with permission-filtered chips', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/runtime/definitions',
      headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(clerk) },
    });
    const view = res.json().listViews.donation as ListViewDef;
    expect(view.chips!.map((c) => c.id)).toEqual(['mine', 'outstanding', 'closed']);
    expect(view.create!.steps!.map((s) => s.key)).toEqual(['donor', 'details']);
    await app.close();
  });

  it('rejects views that refer to things that do not exist', async () => {
    const bad: ListViewDef = {
      key: 'bad',
      recordType: 'donation',
      chips: [
        { id: 'a', label: 'A', statusIn: ['nowhere'] },
        { id: 'a', label: 'Again' },
      ],
      defaultChip: 'zzz',
      columns: ['donorPan', 'ghost'],
      filters: ['donorPan', 'notes', 'missing'],
      row: { title: 'nope' },
      create: { fields: ['netAmount'], steps: [{ key: 's', label: 'S', fields: ['amount'] }] },
    };
    await w.platform.definitions.saveDraft(w.as(w.ngoA), 'listView', bad);
    const err = await expectCode(w.platform.definitions.publish(w.as(w.ngoA), 'listView', 'bad'), 'definition_invalid');
    const messages = (err as unknown as { issues: { message: string }[] }).issues.map((i) => i.message).join(' | ');
    for (const m of [
      "unknown status 'nowhere'",
      "duplicate chip 'a'",
      "unknown chip 'zzz'",
      "sensitive field 'donorPan' cannot be filtered",
      "'notes' (longText) cannot be filtered",
      "unknown field 'missing'",
      "unknown field 'nope'",
      'use either fields or steps',
      "'netAmount' is calculated",
      "sensitive field 'donorPan' cannot be a column",
      "unknown field 'ghost'",
    ]) {
      expect(messages).toContain(m);
    }
  });
});
