import { SANDBOX_WORKER, SCHEMA_DIR } from '../src/platform.js';
import { describe, expect, it } from 'vitest';
import { ScriptFailure, ScriptSandbox } from '../src/runtime/scripts/sandbox.js';

const sandbox = new ScriptSandbox(SCHEMA_DIR, SANDBOX_WORKER);
const base = {
  record: { amount: 100, donorName: 'Asha' },
  previous: null,
  status: 'raised',
  recordType: 'donation',
  user: { id: 'u1', roles: ['finance'] },
};

async function failure(code: string): Promise<ScriptFailure> {
  try {
    await sandbox.runBeforeSave({ ...base, code });
  } catch (e) {
    if (e instanceof ScriptFailure) return e;
    throw e;
  }
  throw new Error('expected the script to fail');
}

describe('script sandbox', () => {
  it('lets a script change the record and log', async () => {
    const out = await sandbox.runBeforeSave({
      ...base,
      code: `ctx.record.donorName = ctx.record.donorName.toUpperCase(); ctx.log('user', ctx.user.id);`,
    });
    expect(out.record.donorName).toBe('ASHA');
    expect(out.logs).toEqual(['user u1']);
  });

  it('turns ctx.fail into a user-facing failure', async () => {
    const e = await failure(`ctx.log('checking'); if (ctx.record.amount < 500) ctx.fail('Minimum donation is 500.');`);
    expect(e.code).toBe('script_failed');
    expect(e.message).toBe('Minimum donation is 500.');
    expect(e.logs).toEqual(['checking']);
  });

  it('stops infinite loops at the time limit', async () => {
    const started = Date.now();
    const e = await failure('while (true) {}');
    expect(e.code).toBe('script_limit');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stops runaway memory use', async () => {
    const e = await failure(`const a = []; while (true) a.push('x'.repeat(100000));`);
    expect(e.code).toBe('script_limit');
  });

  it('has no access to the host', async () => {
    const out = await sandbox.runBeforeSave({
      ...base,
      code: `ctx.record.notes = [typeof process, typeof require, typeof fetch, typeof globalThis.__input].join(',');`,
    });
    expect(out.record.notes).toBe('undefined,undefined,undefined,string');
  });

  it('reports syntax errors and a missing record', async () => {
    expect((await failure('this is not js')).code).toBe('script_failed');
    expect((await failure('ctx.record = 5;')).message).toMatch(/must leave ctx.record as an object/);
  });
});
