import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseCapabilities } from '../../domain/ports/database-capabilities.js';
import { ACTOR, expectRefused, issueReceipt, newRecord, setUpFinance, type World } from './support.js';

/** ADR-13 criterion 1: one organisation's rows are never visible to, or writable by, another, and the database enforces it. */
export function defineTenancyContract(world: World, capabilities: DatabaseCapabilities): void {
  describe('tenancy isolation', () => {
    let a: string;
    let b: string;
    let recordA: string;

    beforeAll(async () => {
      a = await world().newTenant();
      b = await world().newTenant();
      await setUpFinance(world(), a);
      const { records, shares } = world().stores;
      recordA = await world().transactions.withTenant(a, async (tx) => {
        const r = await records.insert(tx, newRecord('tenancyThing', { name: 'Only in A' }, { number: 'T-1' }));
        await records.enqueueEvent(tx, 'tenancy.created', { id: r.id });
        await shares.addShare(tx, { recordId: r.id, principalKind: 'role', principal: 'finance', access: 'read', createdBy: ACTOR, expiresAt: null });
        await issueReceipt(world(), tx, '10.00', r.id);
        return r.id;
      });
    });

    it('isolates by the database itself, never by application filtering alone', () => {
      expect(['rls', 'database-per-tenant']).toContain(capabilities.tenantIsolation);
    });

    it('hides one organisation’s records from another through every read port', async () => {
      const { records, queries, shares } = world().stores;
      await world().transactions.withTenant(b, async (tx) => {
        expect(await records.get(tx, recordA)).toBeUndefined();
        expect(await records.getMany(tx, [recordA])).toEqual([]);
        expect(await records.versionOf(tx, recordA)).toBeUndefined();
        expect(await records.countOfType(tx, 'tenancyThing')).toBe(0);
        expect(await queries.ids(tx, { where: [{ kind: 'ofType', type: 'tenancyThing' }], sort: { kind: 'id' }, limit: 10, offset: 0 })).toEqual([]);
        expect(await queries.count(tx, { where: [{ kind: 'ofType', type: 'tenancyThing' }] })).toBe(0);
        expect(await shares.list(tx, recordA)).toEqual([]);
        expect(await world().stores.receipts.forRecord(tx, recordA)).toEqual([]);
      });
      await world().transactions.withTenant(a, async (tx) => {
        expect((await records.get(tx, recordA))?.data).toEqual({ name: 'Only in A' });
        expect(await queries.count(tx, { where: [{ kind: 'ofType', type: 'tenancyThing' }] })).toBe(1);
      });
    });

    it('hides other organisations’ rows from a read that bypasses the ports', async () => {
      const { bypass } = world();
      await world().transactions.withTenant(b, async (tx) => {
        for (const entity of ['record', 'journal', 'receipt', 'outbox', 'job'] as const) expect(await bypass.visibleRows(tx, entity), entity).toBe(0);
      });
      await world().transactions.withTenant(a, async (tx) => {
        expect(await bypass.visibleRows(tx, 'record')).toBe(1);
        expect(await bypass.visibleRows(tx, 'receipt')).toBe(1);
        expect(await bypass.visibleRows(tx, 'outbox')).toBe(1);
      });
    });

    it('refuses a bypassing write stamped with another organisation', async () => {
      await expectRefused(
        world(),
        world().transactions.withTenant(b, (tx) => world().bypass.insertRecordFor(tx, a, 'tenancyThing')),
        'isolation',
      );
    });

    it('changes nothing of another organisation through a bypassing update', async () => {
      expect(await world().transactions.withTenant(b, (tx) => world().bypass.touchRecord(tx, recordA))).toBe(0);
      const { records } = world().stores;
      expect(await world().transactions.withTenant(b, (tx) => records.update(tx, recordA, 1, newRecord('tenancyThing', { name: 'hijack' })))).toBeUndefined();
      expect((await world().transactions.withTenant(a, (tx) => records.get(tx, recordA)))?.data).toEqual({ name: 'Only in A' });
    });

    it('lets two organisations use the same record number and receipt number', async () => {
      const { records } = world().stores;
      await setUpFinance(world(), b);
      const r = await world().transactions.withTenant(b, async (tx) => {
        const rec = await records.insert(tx, newRecord('tenancyThing', {}, { number: 'T-1' }));
        return issueReceipt(world(), tx, '10.00', rec.id);
      });
      const inA = await world().transactions.withTenant(a, (tx) => world().stores.receipts.forRecord(tx, recordA));
      expect(r.number).toBe(inA[0]!.number);
    });

    it('refuses an organisation id that is not an id', async () => {
      await expect(world().transactions.withTenant('not-a-tenant', async () => undefined)).rejects.toThrow();
    });
  });
}
