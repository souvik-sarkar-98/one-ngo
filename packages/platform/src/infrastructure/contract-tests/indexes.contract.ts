import { beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from '../../domain/ports/transaction.js';
import { expectRefused, newRecord, type World } from './support.js';

/** `IndexManager`: create, remove and inspect a managed configured-field index. */
export function defineIndexContract(world: World): void {
  describe('IndexManager', () => {
    let t: string;
    let other: string;
    const insert = (tenant: string, typeKey: string, data: Record<string, unknown>) =>
      world().transactions.withTenant(tenant, (tx: Tx) => world().stores.records.insert(tx, newRecord(typeKey, data)));

    beforeAll(async () => {
      t = await world().newTenant();
      other = await world().newTenant();
    });

    it('creates a managed index and reports it ready and present', async () => {
      const name = await world().indexes.create({ typeKey: 'indexed', field: 'city', as: 'text', unique: false });
      expect(await world().indexes.inspect(name)).toEqual({ status: 'ready', present: true });
      await insert(t, 'indexed', { city: 'Pune' });
      await insert(t, 'indexed', { city: 'Delhi' });
      const n = await world().transactions.withTenant(t, (tx) =>
        world().stores.queries.count(tx, { where: [{ kind: 'ofType', type: 'indexed' }, { kind: 'equals', field: 'city', value: 'Pune' }] }),
      );
      expect(n).toBe(1);
    });

    it('enforces a unique configured field per organisation and record type, ignoring case', async () => {
      const name = await world().indexes.create({ typeKey: 'member', field: 'email', as: 'caseless', unique: true });
      await insert(t, 'member', { email: 'asha@example.org' });
      await expectRefused(world(), insert(t, 'member', { email: 'ASHA@example.org' }), 'duplicate');
      await insert(other, 'member', { email: 'asha@example.org' });
      await insert(t, 'volunteer', { email: 'asha@example.org' });
      expect((await world().indexes.inspect(name))?.status).toBe('ready');
    });

    it('removes a managed index, after which the rule it enforced no longer applies', async () => {
      const name = await world().indexes.create({ typeKey: 'badge', field: 'code', as: 'numeric', unique: true });
      await insert(t, 'badge', { code: 7 });
      await expectRefused(world(), insert(t, 'badge', { code: 7 }), 'duplicate');
      await world().indexes.remove(name);
      expect(await world().indexes.inspect(name)).toBeUndefined();
      await insert(t, 'badge', { code: 7 });
    });

    it('is idempotent: creating the same index twice keeps one', async () => {
      const spec = { typeKey: 'twice', field: 'ref', as: 'text', unique: false } as const;
      const a = await world().indexes.create(spec);
      const b = await world().indexes.create(spec);
      expect(a).toBe(b);
      expect(await world().indexes.inspect(a)).toEqual({ status: 'ready', present: true });
    });
  });
}
