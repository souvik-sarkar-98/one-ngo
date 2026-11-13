import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseCapabilities } from '../../domain/ports/database-capabilities.js';
import type { Tx } from '../../domain/ports/transaction.js';
import type { RecordQueryAst } from '../../runtime/records/ports/record-query.js';
import { ACTOR, expectRefused, gate, newRecord, type World } from './support.js';

/** `RecordStore` (get, save with expected version, link) and `RecordQuery` (validated AST, count, aggregate). */
export function defineRecordContract(world: World, capabilities: DatabaseCapabilities): void {
  describe('RecordStore', () => {
    let t: string;
    beforeAll(async () => {
      t = await world().newTenant();
    });

    it('saves a new record at version 1 and reads it back as written', async () => {
      const { records } = world().stores;
      const saved = await world().transactions.withTenant(t, (tx) =>
        records.insert(tx, newRecord('contact', { name: 'Asha', amount: 12.5, tags: ['a', 'b'], nested: { ok: true } }, { number: 'C-1', status: 'active' })),
      );
      expect(saved).toMatchObject({ type_key: 'contact', number: 'C-1', status: 'active', version: 1, owner_id: ACTOR });
      const read = await world().transactions.withTenant(t, (tx) => records.get(tx, saved.id));
      expect(read?.data).toEqual({ name: 'Asha', amount: 12.5, tags: ['a', 'b'], nested: { ok: true } });
      expect(new Date(read!.created_at).getTime()).not.toBeNaN();
    });

    it('refuses a second record with the same number in one record type', async () => {
      const { records } = world().stores;
      await world().transactions.withTenant(t, (tx) => records.insert(tx, newRecord('numbered', {}, { number: 'N-1' })));
      await expectRefused(world(), world().transactions.withTenant(t, (tx) => records.insert(tx, newRecord('numbered', {}, { number: 'N-1' }))), 'duplicate');
      await world().transactions.withTenant(t, (tx) => records.insert(tx, newRecord('otherNumbered', {}, { number: 'N-1' })));
    });

    it('links files to a record field and unlinks the ones not kept', async () => {
      const { records, files } = world().stores;
      await world().transactions.withTenant(t, async (tx) => {
        const r = await records.insert(tx, newRecord('linked'));
        const file = (id: string) => files.add(tx, { id, name: `${id}.png`, mime: 'image/png', size: 10, sha256: '0'.repeat(64), storageKey: `k/${id}`, storeRef: 'platform', createdBy: ACTOR });
        const [keep, drop] = [randomUUID(), randomUUID()];
        await file(keep);
        await file(drop);
        await records.linkFiles(tx, r.id, 'photo', [keep, drop]);
        expect((await records.files(tx, [keep, drop])).map((f) => [f.record_id, f.field_key])).toEqual([
          [r.id, 'photo'],
          [r.id, 'photo'],
        ]);
        await records.unlinkFiles(tx, r.id, ['photo'], [keep]);
        const after = Object.fromEntries((await records.files(tx, [keep, drop])).map((f) => [f.id, f.record_id]));
        expect(after).toEqual({ [keep]: r.id, [drop]: null });
      });
    });

    it('hands out a gap-free counter that a rolled-back transaction does not consume', async () => {
      const { records } = world().stores;
      const take = () => world().transactions.withTenant(t, (tx) => records.nextSequenceValue(tx, 'contract:counter', '2030'));
      expect(await take()).toBe(1);
      await expect(
        world().transactions.withTenant(t, async (tx) => {
          await records.nextSequenceValue(tx, 'contract:counter', '2030');
          throw new Error('rolled back');
        }),
      ).rejects.toThrow();
      expect(await take()).toBe(2);
    });
  });

  describe('optimistic writes', () => {
    let t: string;
    let id: string;
    beforeAll(async () => {
      t = await world().newTenant();
      id = await world().transactions.withTenant(t, async (tx) => (await world().stores.records.insert(tx, newRecord('versioned', { n: 0 }))).id);
    });

    it('saves at the expected version and raises it by one', async () => {
      const { records } = world().stores;
      const saved = await world().transactions.withTenant(t, (tx) => records.update(tx, id, 1, newRecord('versioned', { n: 1 })));
      expect(saved?.version).toBe(2);
      expect(saved?.data).toEqual({ n: 1 });
    });

    it('refuses a save at a version the record has moved on from', async () => {
      const { records } = world().stores;
      expect(await world().transactions.withTenant(t, (tx) => records.update(tx, id, 1, newRecord('versioned', { n: 99 })))).toBeUndefined();
      expect((await world().transactions.withTenant(t, (tx) => records.get(tx, id)))?.data).toEqual({ n: 1 });
    });

    it('lets exactly one of two concurrent saves at the same version win, by the database’s conditional write', async () => {
      const { records } = world().stores;
      const version = (await world().transactions.withTenant(t, (tx) => records.versionOf(tx, id)))!;
      const firstWrote = gate();
      const release = gate();
      const first = world().transactions.withTenant(t, async (tx) => {
        const r = await records.update(tx, id, version, newRecord('versioned', { n: 'first' }));
        firstWrote.open();
        await release.wait;
        return r;
      });
      await firstWrote.wait;
      const second = world().transactions.withTenant(t, (tx) => records.update(tx, id, version, newRecord('versioned', { n: 'second' })));
      release.open();
      const [a, b] = await Promise.all([first, second]);
      expect(a?.version).toBe(version + 1);
      expect(b).toBeUndefined();
      expect((await world().transactions.withTenant(t, (tx) => records.get(tx, id)))?.data).toEqual({ n: 'first' });
    });
  });

  describe('RecordQuery', () => {
    let t: string;
    const q = (where: RecordQueryAst['where'], sort: RecordQueryAst['sort'] = { kind: 'id' }): RecordQueryAst => ({ where, sort, limit: 50, offset: 0 });

    beforeAll(async () => {
      t = await world().newTenant();
      const { records } = world().stores;
      await world().transactions.withTenant(t, async (tx) => {
        const gift = (n: string, amount: number, city: string, status: string, on: string) =>
          records.insert(tx, newRecord('gift', { amount, city, on }, { number: n, status, searchText: `${n} ${city}`.toLowerCase() }));
        await gift('G-1', 100, 'Pune', 'paid', '2030-04-10');
        await gift('G-2', 250.5, 'Delhi', 'paid', '2030-05-20');
        await gift('G-3', 40, 'Pune', 'pledged', '2030-06-01');
        await records.insert(tx, newRecord('other', { amount: 1000, city: 'Pune' }));
      });
    });

    const run = <T>(fn: (tx: Tx) => Promise<T>) => world().transactions.withTenant(t, fn);

    it('matches by type, status, equality, range and text', async () => {
      const { queries } = world().stores;
      const numbers = async (where: RecordQueryAst['where']) => (await run((tx) => queries.rows(tx, q(where, { kind: 'column', column: 'number', dir: 'asc' })))).map((r) => r.number);
      expect(await numbers([{ kind: 'ofType', type: 'gift' }])).toEqual(['G-1', 'G-2', 'G-3']);
      expect(await numbers([{ kind: 'ofType', type: 'gift' }, { kind: 'statusIn', values: ['paid'] }])).toEqual(['G-1', 'G-2']);
      expect(await numbers([{ kind: 'ofType', type: 'gift' }, { kind: 'equals', field: 'city', value: 'Pune' }])).toEqual(['G-1', 'G-3']);
      expect(await numbers([{ kind: 'ofType', type: 'gift' }, { kind: 'range', field: 'amount', as: 'numeric', from: 50, to: 250.5 }])).toEqual(['G-1', 'G-2']);
      expect(await numbers([{ kind: 'ofType', type: 'gift' }, { kind: 'range', field: 'on', as: 'date', from: '2030-05-01' }])).toEqual(['G-2', 'G-3']);
      expect(await numbers([{ kind: 'ofType', type: 'gift' }, { kind: 'oneOf', field: 'city', as: 'text', values: ['Delhi', 'Mumbai'] }])).toEqual(['G-2']);
      expect(await numbers([{ kind: 'ofType', type: 'gift' }, { kind: 'numberIs', number: 'g-3' }])).toEqual(['G-3']);
      if (capabilities.jsonRecordQueries === 'native') {
        expect(await numbers([{ kind: 'ofType', type: 'gift' }, { kind: 'search', text: 'DEL' }])).toEqual(['G-2']);
      }
    });

    it('orders and pages', async () => {
      const { queries } = world().stores;
      const page = await run((tx) => queries.rows(tx, { where: [{ kind: 'ofType', type: 'gift' }], sort: { kind: 'field', field: 'amount', as: 'numeric', dir: 'desc' }, limit: 2, offset: 1 }));
      expect(page.map((r) => r.number)).toEqual(['G-1', 'G-3']);
    });

    it('counts, totals and groups exactly', async () => {
      const { queries } = world().stores;
      const gifts = { where: [{ kind: 'ofType' as const, type: 'gift' }] };
      expect(await run((tx) => queries.count(tx, gifts))).toBe(3);
      expect(await run((tx) => queries.sums(tx, gifts, ['amount']))).toEqual({ amount: 390.5 });
      const byStatus = await run((tx) => queries.aggregate<{ k: string; v: number | string }>(tx, gifts, { measure: { kind: 'count' }, group: { kind: 'status' } }));
      expect(Object.fromEntries(byStatus.map((r) => [r.k, Number(r.v)]))).toEqual({ paid: 2, pledged: 1 });
      const sumByCity = await run((tx) => queries.aggregate<{ k: string; v: number | string }>(tx, gifts, { measure: { kind: 'sum', field: 'amount' }, group: { kind: 'field', field: 'city' } }));
      expect(Object.fromEntries(sumByCity.map((r) => [r.k, Number(r.v)]))).toEqual({ Pune: 140, Delhi: 250.5 });
    });

    it('binds values, so a hostile value matches nothing and changes nothing', async () => {
      const { queries } = world().stores;
      const hostile = "Pune' or '1'='1";
      expect(await run((tx) => queries.count(tx, { where: [{ kind: 'ofType', type: 'gift' }, { kind: 'equals', field: 'city', value: hostile }] }))).toBe(0);
      expect(await run((tx) => queries.count(tx, { where: [{ kind: 'ofType', type: 'gift' }] }))).toBe(3);
    });

    it('refuses a field key outside the definition grammar', async () => {
      const { queries } = world().stores;
      await expect(run((tx) => queries.count(tx, { where: [{ kind: 'ofType', type: 'gift' }, { kind: 'equals', field: "city') or (1=1", value: 'x' }] }))).rejects.toThrow();
    });
  });
}
