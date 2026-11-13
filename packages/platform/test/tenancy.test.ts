import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clerk, createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

describe('NGO data separation', () => {
  it('keeps records, ledgers, and audit events inside their own NGO', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'Ravi', amount: 500 });

    await expectCode(w.platform.records.get(w.as(w.ngoB, clerk), record.id), 'not_found');
    expect(await w.platform.records.list(w.as(w.ngoB, clerk), 'donation')).toHaveLength(0);

    const raw = await w.platform.db.withTenant(w.ngoB, (tx) =>
      tx.query<{ n: number }>(
        `select (select count(*) from record)::int + (select count(*) from audit_event where entity like 'record:%')::int as n`,
      ),
    );
    expect(raw[0]!.n).toBe(0);
  });

  it('blocks writes that name another NGO even in raw SQL', async () => {
    await expect(
      w.platform.db.withTenant(w.ngoB, (tx) =>
        tx.query(`insert into record (tenant_id, type_key, schema_version, data) values ($1, 'donation', 1, '{}')`, [w.ngoA]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('gives each NGO its own number sequences', async () => {
    const a = await w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'A', amount: 10 });
    const b = await w.platform.records.create(w.as(w.ngoB, clerk), 'donation', { donorName: 'B', amount: 10 });
    expect(a.record.number).toMatch(/\/00002$/);
    expect(b.record.number).toMatch(/\/00001$/);
  });

  it('runs tenant transactions without owner privileges', async () => {
    await expect(w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`delete from audit_event`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`update tenant set name = 'x'`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('rejects a tenant id that is not a UUID', async () => {
    await expect(w.platform.db.withTenant("x'; drop table record; --", async () => 1)).rejects.toThrow(/UUID/);
  });
});
