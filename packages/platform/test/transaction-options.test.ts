import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinTransaction, type SqlExecutor } from '../src/infrastructure/postgres/db.js';
import { createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld({ donations: false });
});
afterAll(() => w.close());

const mode = (tx: SqlExecutor) =>
  tx.query<{ isolation: string; read_only: string }>(
    `select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only`,
  );

describe('transaction options', () => {
  it('opens tenant and owner transactions with the requested isolation and read-only mode', async () => {
    const options = { isolation: 'repeatable read', readOnly: true } as const;
    expect(await w.platform.db.withTenant(w.ngoA, mode, options)).toEqual([{ isolation: 'repeatable read', read_only: 'on' }]);
    expect(await w.platform.db.asSystem(mode, options)).toEqual([{ isolation: 'repeatable read', read_only: 'on' }]);
    expect(await w.platform.db.asSystem(mode, { isolation: 'serializable' })).toEqual([{ isolation: 'serializable', read_only: 'off' }]);
  });

  it('keeps the server defaults without options', async () => {
    expect(await w.platform.db.withTenant(w.ngoA, mode)).toEqual([{ isolation: 'read committed', read_only: 'off' }]);
    expect(await w.platform.db.asSystem(mode)).toEqual([{ isolation: 'read committed', read_only: 'off' }]);
  });

  it('rejects writes in a read-only transaction', async () => {
    await expect(
      w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`update tenant_setting set value = value`), { readOnly: true }),
    ).rejects.toThrow(/read-only transaction/);
  });

  it('cannot change the isolation of a joined transaction', async () => {
    await w.platform.db.withTenant(w.ngoA, async (tx) => {
      const joined = joinTransaction(w.ngoA, tx);
      await expect(joined.withTenant(w.ngoA, mode, { isolation: 'serializable' })).rejects.toThrow(/keeps the isolation/);
      expect(await joined.withTenant(w.ngoA, mode)).toEqual([{ isolation: 'read committed', read_only: 'off' }]);
    });
  });
});
