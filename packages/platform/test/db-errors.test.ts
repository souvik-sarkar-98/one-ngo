import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { databaseErrorOf, fromDatabaseError, type DatabaseErrorInfo } from '../src/infrastructure/postgres/db-errors.js';
import { platformErrorOf } from '../src/composition/infrastructure-errors.js';
import { PlatformError, validationFailed } from '@onengo/kernel/errors';
import { MemoryLogger } from '@onengo/kernel/observability';
import { admin, createWorld, currentFiscalYear, today, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

const pgError = (code: string, message: string, constraint?: string) => Object.assign(new Error(message), { code, constraint });
const raised = (message: string): DatabaseErrorInfo => ({ code: 'P0001', message });

describe('database error mapping', () => {
  it('recognises errors raised by the database server only', () => {
    expect(databaseErrorOf(pgError('23505', 'duplicate key value violates unique constraint "rx_x"', 'rx_x'))).toEqual({
      code: '23505',
      message: 'duplicate key value violates unique constraint "rx_x"',
      constraint: 'rx_x',
    });
    expect(databaseErrorOf(pgError('ECONNREFUSED', 'connect ECONNREFUSED'))).toBeUndefined();
    expect(databaseErrorOf(new Error('boom'))).toBeUndefined();
    expect(databaseErrorOf(validationFailed('x'))).toBeUndefined();
    expect(databaseErrorOf({ code: '23505', message: 'not an Error' })).toBeUndefined();
  });

  it('turns a unique violation into a field issue when the field is known, and a plain message when not', () => {
    const dup = { code: '23505', message: 'duplicate key value violates unique constraint "receipt_tenant_id_number_key"' };
    expect(fromDatabaseError(dup, 'pan')).toMatchObject({
      code: 'validation_failed',
      message: 'Another record already has this value.',
      issues: [{ path: '/pan', message: 'Another record already has this value.' }],
    });
    const plain = fromDatabaseError(dup)!;
    expect(plain).not.toBeInstanceOf(PlatformError);
    expect(platformErrorOf(plain)).toBeInstanceOf(PlatformError);
    expect(plain).toMatchObject({ code: 'validation_failed', message: 'Another record already has this value.', issues: [] });
  });

  it('turns money and receipt trigger messages into rule violations without internal ids', () => {
    const id = '3f1c2a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
    const cases: [string, RegExp][] = [
      [`journal entry ${id} does not balance (debit 50.00, credit 0, lines 1)`, /does not balance/],
      ['period is closed', /period is closed/],
      ['entry date is outside its period', /outside its accounting period/],
      ['posted journal entries cannot be changed', /Reverse the entry/],
      ['posted journal lines cannot be changed', /Reverse the entry/],
      ['journal entries cannot be deleted', /cannot be deleted/],
      ['receipts cannot be deleted', /Void the receipt/],
      ['issued receipts cannot be changed except by voiding', /Void the receipt/],
    ];
    for (const [message, expected] of cases) {
      const mapped = fromDatabaseError(raised(message))!;
      expect(mapped.code).toBe('rule_violation');
      expect(mapped.message).toMatch(expected);
      expect(mapped.message).not.toContain(id);
      expect(mapped.message).not.toMatch(/debit 50|lines 1/);
    }
    expect(fromDatabaseError(raised('some new trigger rule'))).toMatchObject({ code: 'rule_violation', message: 'This change is not allowed.' });
  });

  it('leaves platform faults and other database errors to the unexpected-error path', () => {
    expect(fromDatabaseError(raised('no organisation is set for this query'))).toBeUndefined();
    expect(fromDatabaseError(raised('invalid record query'))).toBeUndefined();
    expect(fromDatabaseError({ code: '23503', message: 'violates foreign key constraint' })).toBeUndefined();
    expect(fromDatabaseError({ code: '40001', message: 'could not serialize access' })).toBeUndefined();
  });
});

describe('database rejections over HTTP', () => {
  let w: TestWorld;
  let app: ReturnType<typeof buildServer>;
  const logger = new MemoryLogger();
  const headers = () => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(admin) });
  const unhandled = () => logger.entries.filter((e) => e.message === 'Unhandled error');
  const rejected = () => logger.entries.filter((e) => e.message === 'Database rejected the change');

  beforeAll(async () => {
    w = await createWorld({ autoRunJobs: false, logger });
    app = buildServer(w.platform, { devAuth: true });
    const inA = <T>(fn: Parameters<TestWorld['platform']['db']['withTenant']>[1]) => w.platform.db.withTenant(w.ngoA, fn) as Promise<T>;
    app.post('/test/post-into-period', async () => {
      await inA(async (tx) => {
        const [p] = await tx.query<{ id: string }>(`select id from fiscal_period where key = $1`, [currentFiscalYear()]);
        await tx.query(`insert into journal_entry (tenant_id, period_id, entry_date) values (app_tenant(), $1, $2)`, [p!.id, today()]);
      });
      return { ok: true };
    });
    app.post('/test/unbalanced', async () => {
      await inA(async (tx) => {
        const [p] = await tx.query<{ id: string }>(`select id from fiscal_period where key = $1`, [currentFiscalYear()]);
        const [a] = await tx.query<{ id: string }>(`select id from ledger_account where code = 'BANK'`);
        const [e] = await tx.query<{ id: string }>(
          `insert into journal_entry (tenant_id, period_id, entry_date) values (app_tenant(), $1, $2) returning id`,
          [p!.id, today()],
        );
        await tx.query(`insert into journal_line (tenant_id, entry_id, account_id, debit) values (app_tenant(), $1, $2, 50)`, [e!.id, a!.id]);
      });
      return { ok: true };
    });
    app.post('/test/bad-record-query', async () => {
      await inA((tx) => tx.query(`select id from app_record_ids($1, 'id', '[]', 1, 0)`, ['true; drop table record']));
      return { ok: true };
    });
  });
  afterAll(async () => {
    await app.close();
    await w.close();
  });

  it('returns 422 with the field when the unique index rejects a duplicate PAN the save check missed', async () => {
    const { failed } = await w.platform.indexes.buildPending(w.ngoA, 100);
    expect(failed).toEqual([]);
    const create = () => app.inject({ method: 'POST', url: '/api/records/donor', headers: headers(), payload: { name: 'Asha', pan: 'QWERT1234Y' } });
    expect((await create()).statusCode).toBe(201);

    // Both saves of a race pass the duplicate check before either writes; only the index can refuse the second.
    const check = vi
      .spyOn(w.platform.records as unknown as { checkUniqueAndPatterns: () => Promise<unknown[]> }, 'checkUniqueAndPatterns')
      .mockResolvedValue([]);
    const before = logger.entries.length;
    try {
      const second = await create();
      expect(check).toHaveBeenCalled();
      expect(second.statusCode).toBe(422);
      expect(second.json()).toEqual({
        code: 'validation_failed',
        message: 'Another record already has this value.',
        issues: [{ path: '/pan', message: 'Another record already has this value.' }],
      });
      expect(second.body).not.toMatch(/rx_|QWERT1234Y|duplicate key/);
    } finally {
      check.mockRestore();
    }
    const logged = logger.entries.slice(before);
    expect(logged.filter((e) => e.message === 'Unhandled error')).toEqual([]);
    expect(logged.find((e) => e.message === 'Database rejected the change')).toMatchObject({
      severity: 'WARNING',
      fields: { dbCode: '23505', constraint: expect.stringMatching(/^rx_[0-9a-f]{20}$/), method: 'POST', path: '/api/records/donor' },
    });
  });

  it('returns 422 when the trigger refuses a post into a closed period', async () => {
    await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.closePeriod(asTx(tx), admin, currentFiscalYear()));
    try {
      const res = await app.inject({ method: 'POST', url: '/test/post-into-period', headers: headers() });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ code: 'rule_violation', message: 'This accounting period is closed, so nothing can be posted to it.', issues: [] });
    } finally {
      await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.reopenPeriod(asTx(tx), admin, currentFiscalYear(), 'Test done'));
    }
    expect(rejected().at(-1)).toMatchObject({ severity: 'WARNING', fields: { dbCode: 'P0001', dbMessage: 'period is closed' } });
    expect(unhandled()).toEqual([]);
  });

  it('returns 422 without the entry id when the deferred balance check fails at commit', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/unbalanced', headers: headers() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'rule_violation', message: expect.stringMatching(/does not balance/) });
    expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(rejected().at(-1)!.fields.dbCode).toBe('P0001');
    expect(unhandled()).toEqual([]);
  });

  it('keeps 500 for database faults that are not the user\'s doing', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/bad-record-query', headers: headers() });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'internal' });
    expect(unhandled()).toHaveLength(1);
  });
});
