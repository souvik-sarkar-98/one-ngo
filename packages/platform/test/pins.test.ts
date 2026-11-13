import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { admin, createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let asha: Actor;
let ravi: Actor;

async function member(tenant: string, email: string, permissions: string[]): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) => tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $1) returning id`, [email]));
  await w.platform.db.asSystem((tx) => tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [tenant, u!.id]));
  return { id: u!.id, roles: ['clerk'], permissions };
}

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  asha = await member(w.ngoA, 'asha-pins@example.org', ['record:donation:read']);
  ravi = await member(w.ngoA, 'ravi-pins@example.org', ['record:donation:read']);
});
afterAll(() => w.close());

describe('pins on Home', () => {
  it('keep each person’s own lists, in order, renamed and removed by them only', async () => {
    const ctx = w.as(w.ngoA, asha);
    const first = await w.platform.pins.add(ctx, { label: ' Outstanding over ₹1,000 ', listView: 'donations', address: '/records/donation?chip=outstanding&amountFrom=1000&sort=-amount' });
    const second = await w.platform.pins.add(ctx, { label: 'Mine', listView: 'donations', address: '/records/donation?chip=mine' });
    expect(first).toMatchObject({ label: 'Outstanding over ₹1,000', position: 0 });
    expect(second.position).toBe(1);

    expect(await w.platform.pins.list(w.as(w.ngoA, ravi))).toEqual([]);
    await expectCode(w.platform.pins.rename(w.as(w.ngoA, ravi), first.id, 'Theirs'), 'not_found');
    await expectCode(w.platform.pins.remove(w.as(w.ngoA, ravi), first.id), 'not_found');

    await w.platform.pins.rename(ctx, first.id, 'Large gifts waiting');
    const reordered = await w.platform.pins.reorder(ctx, [second.id]);
    expect(reordered.map((p) => p.label)).toEqual(['Mine', 'Large gifts waiting']);

    await w.platform.pins.remove(ctx, second.id);
    expect((await w.platform.pins.list(ctx)).map((p) => p.label)).toEqual(['Large gifts waiting']);
  });

  it('accept only record lists the person may read', async () => {
    const ctx = w.as(w.ngoA, asha);
    for (const address of ['https://example.org/x', '//evil/records/donation', '/admin/people', '/records/donation#x']) {
      await expectCode(w.platform.pins.add(ctx, { label: 'x', listView: 'donations', address }), 'validation_failed');
    }
    await expectCode(w.platform.pins.add(ctx, { label: '', listView: 'donations', address: '/records/donation' }), 'validation_failed');
    await expectCode(w.platform.pins.add(ctx, { label: 'Donors', listView: 'donors', address: '/records/donor' }), 'forbidden');
  });

  it('are only for members of the organisation', async () => {
    await expectCode(w.platform.pins.add(w.as(w.ngoA, admin), { label: 'All', listView: 'donations', address: '/records/donation' }), 'forbidden');
    expect(await w.platform.pins.list(w.as(w.ngoB, asha))).toEqual([]);
  });
});
