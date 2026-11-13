import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { clerk, createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const treasurer: Actor = { id: 'treasurer-1', roles: ['treasurer'], permissions: ['record:*:*', 'record:donation:transition:*'] };

interface Entry {
  action: string;
  before: { status: string | null; data: Record<string, unknown>; diff?: true } | null;
  after: { status: string | null; data: Record<string, unknown>; diff?: true } | null;
}

const entriesOf = (id: string) =>
  w.platform.db.withTenant(w.ngoA, (tx) => tx.query<Entry>(`select action, before, after from audit_event where entity_id = $1 order by id`, [id]));

describe('audit entries of a record save', () => {
  it('keeps the whole record on create and only the changed fields on update', async () => {
    const ctx = w.as(w.ngoA, treasurer);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Diff Donor', amount: 100, donorPan: 'ABCDE1234F' });
    await w.platform.records.update(ctx, record.id, { expectedVersion: 1, data: { notes: 'second call' } });

    const [created, updated] = await entriesOf(record.id);
    expect(created!.before).toBeNull();
    expect(created!.after!.diff).toBeUndefined();
    expect(created!.after!.data).toMatchObject({ donorName: 'Diff Donor', amount: 100, donorPan: '***' });

    expect(updated!.after!.diff).toBe(true);
    expect(updated!.before!.diff).toBe(true);
    expect(updated!.after!.data).toEqual({ notes: 'second call' });
    expect(updated!.before!.data).toEqual({});
    expect(JSON.stringify(updated)).not.toContain('Diff Donor');
    expect(JSON.stringify([created, updated])).not.toContain('ABCDE1234F');
  });

  it('lists a changed amount with its calculated net amount, old and new', async () => {
    const ctx = w.as(w.ngoA, clerk);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Amount Donor', amount: 100, fee: 10 });
    await w.platform.records.update(ctx, record.id, { expectedVersion: 1, data: { amount: 200 } });

    const updated = (await entriesOf(record.id))[1]!;
    expect(updated.before!.data).toEqual({ amount: 100, netAmount: 90 });
    expect(updated.after!.data).toEqual({ amount: 200, netAmount: 190 });
  });
});

describe('storage settings', () => {
  it('compresses the large JSON columns with lz4', async () => {
    const rows = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ rel: string; col: string; method: string }>(
        `select c.relname as rel, a.attname as col, a.attcompression::text as method
           from pg_attribute a join pg_class c on c.oid = a.attrelid
          where c.relnamespace = current_schema()::regnamespace
            and (c.relname, a.attname) in (('record', 'data'), ('audit_event', 'before'), ('audit_event', 'after'), ('outbox_event', 'payload'))
          order by 1, 2`,
      ),
    );
    expect(rows.map((r) => `${r.rel}.${r.col}=${r.method}`)).toEqual([
      'audit_event.after=l',
      'audit_event.before=l',
      'outbox_event.payload=l',
      'record.data=l',
    ]);
  });
});
