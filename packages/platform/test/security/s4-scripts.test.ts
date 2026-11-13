import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/infrastructure/postgres/db.js';
import { SANDBOX_WORKER, SCHEMA_DIR } from '../../src/platform.js';
import { ScriptFailure, ScriptPool, ScriptSandbox, type ScriptRunInput } from '../../src/runtime/scripts/sandbox.js';
import { createWorld, type TestWorld } from '../helpers.js';

/**
 * Probes for S4-2 and S4-8 (docs/reports/s4-review-2026-10-26.md). Each asserts the SAFE
 * behaviour; `it.fails` marks a finding the current code still has.
 */

const base: ScriptRunInput = { hook: 'validate', code: '', record: {}, previous: null, status: null, recordType: 't', user: { id: 'u', roles: [] } };
const loop = (tenantId: string, timeoutMs = 1000): ScriptRunInput => ({ ...base, code: 'while (true) {}', tenantId, timeoutMs });
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as ScriptFailure);

describe('S4-2 one organisation’s script cannot stall the server for the others', () => {
  it('S4-2: a script at its time limit does not block other requests on the same instance', async () => {
    const sandbox = new ScriptSandbox(SCHEMA_DIR, SANDBOX_WORKER);
    await sandbox.run(base);
    const started = performance.now();
    let otherRequestWaitedMs = -1;
    const other = new Promise<void>((resolve) =>
      setTimeout(() => {
        otherRequestWaitedMs = performance.now() - started;
        resolve();
      }, 0),
    );
    const run = sandbox.run(loop('', 1000)).catch(() => undefined);
    await Promise.all([run, other]);
    // Another organisation's request should be served within a fraction of the script's limit.
    expect(otherRequestWaitedMs).toBeLessThan(200);
  });

  describe('worker pool', () => {
    const pool = new ScriptPool(SANDBOX_WORKER, { size: 2 });
    const sandbox = new ScriptSandbox(SCHEMA_DIR, SANDBOX_WORKER, pool);
    afterAll(() => pool.close());

    it('runs organisation B’s script promptly while organisation A’s scripts loop', async () => {
      await Promise.all([sandbox.run({ ...base, tenantId: 'a' }), sandbox.run({ ...base, tenantId: 'b' })]);
      const loops = [1, 2, 3].map(() => failure(sandbox.run(loop('a', 800))));
      const started = performance.now();
      const out = await sandbox.run({ ...base, code: "ctx.log('b')", tenantId: 'b' });
      const waited = performance.now() - started;
      expect(out.logs).toEqual(['b']);
      expect(waited).toBeLessThan(500);
      for (const e of await Promise.all(loops)) expect(e).toMatchObject({ code: 'script_limit' });
    }, 15_000);

    it('keeps the result contract: record changes, effects, logs and error codes', async () => {
      const out = await sandbox.run({ ...base, hook: 'beforeSave', record: { a: 1 }, code: "ctx.record.a = 2; ctx.propose.notify('t', 'creator'); ctx.log('x', 1);", tenantId: 'a' });
      expect(out.output).toEqual({ record: { a: 2 }, effects: [{ type: 'notify', template: 't', to: 'creator' }] });
      expect(out.logs).toEqual(['x 1']);
      expect(await failure(sandbox.run({ ...base, code: "ctx.fail('No')", tenantId: 'a' }))).toMatchObject({ code: 'script_failed', message: 'No' });
      expect(await failure(sandbox.run({ ...base, code: "const a = []; while (true) a.push('x'.repeat(100000));", memoryMb: 2, tenantId: 'a' }))).toMatchObject({
        code: 'script_limit',
      });
    });
  });

  it('ends and replaces a worker that does not stop at its limit', async () => {
    // A negative grace makes the main thread give up before QuickJS interrupts the script.
    const pool = new ScriptPool(SANDBOX_WORKER, { size: 1, graceMs: -900 });
    const sandbox = new ScriptSandbox(SCHEMA_DIR, SANDBOX_WORKER, pool);
    try {
      await sandbox.run({ ...base, timeoutMs: 1000 });
      const [before] = pool.stats().threadIds;
      const started = performance.now();
      const e = await failure(sandbox.run(loop('a', 1000)));
      expect(performance.now() - started).toBeLessThan(600);
      expect(e).toBeInstanceOf(ScriptFailure);
      expect(e).toMatchObject({ code: 'script_limit', message: 'Script exceeded its 1000 ms time limit.' });
      const out = await sandbox.run({ ...base, code: "ctx.log('again')", tenantId: 'a', timeoutMs: 1000 });
      expect(out.logs).toEqual(['again']);
      const after = pool.stats();
      expect(after.replaced).toBe(1);
      expect(after.workers).toBe(1);
      expect(after.threadIds[0]).not.toBe(before);
    } finally {
      await pool.close();
    }
  }, 15_000);

  it('refuses an organisation’s runs once its script time budget is used, without touching another organisation', async () => {
    const pool = new ScriptPool(SANDBOX_WORKER, { size: 2, orgBudgetMs: 100 });
    const sandbox = new ScriptSandbox(SCHEMA_DIR, SANDBOX_WORKER, pool);
    try {
      await sandbox.run({ ...base, tenantId: 'b' });
      expect(await failure(sandbox.run(loop('a', 150)))).toMatchObject({ code: 'script_limit' });
      expect(await failure(sandbox.run({ ...base, tenantId: 'a' }))).toMatchObject({ code: 'script_limit', message: expect.stringMatching(/used its script time/) });
      expect((await sandbox.run({ ...base, code: "ctx.log('b')", tenantId: 'b' })).logs).toEqual(['b']);
    } finally {
      await pool.close();
    }
  }, 15_000);

  it('runs one Try it at a time per organisation', async () => {
    const pool = new ScriptPool(SANDBOX_WORKER, { size: 2 });
    const sandbox = new ScriptSandbox(SCHEMA_DIR, SANDBOX_WORKER, pool);
    try {
      await sandbox.run({ ...base, tenantId: 'a' });
      const first = failure(sandbox.run({ ...loop('a', 300), trial: true }));
      expect(await failure(sandbox.run({ ...base, tenantId: 'a', trial: true }))).toMatchObject({ code: 'script_limit', message: expect.stringMatching(/Try it/) });
      expect((await sandbox.run({ ...base, tenantId: 'b', trial: true })).logs).toEqual([]);
      expect(await first).toMatchObject({ code: 'script_limit' });
    } finally {
      await pool.close();
    }
  }, 15_000);
});

describe('S4-8 trying a script needs the same rights as publishing it', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(() => w.close());

  it('S4-8: a script author without config:script:admin cannot read ledger balances through Try it', async () => {
    const author: Actor = { id: 'author-1', roles: ['author'], permissions: ['config:script:publish', 'record:donation:read'] };
    const builder = w.platform.builderSupport();
    let out: unknown;
    try {
      out = await builder.tryScript(w.as(w.ngoA, author), {
        recordType: 'donation',
        hook: 'validate',
        inputs: { balances: {} },
        code: 'ctx.log(JSON.stringify(ctx.inputs.balances));',
      });
    } catch (e) {
      expect((e as { code?: string }).code).toBe('forbidden');
      return;
    }
    expect(out).not.toHaveProperty('inputs.balances');
  });

  it('S4-8: nor try a script that runs as a role; an administrator may do both', async () => {
    const author: Actor = { id: 'author-1', roles: ['author'], permissions: ['config:script:publish', 'record:donation:read'] };
    const builder = w.platform.builderSupport();
    await expect(builder.tryScript(w.as(w.ngoA, author), { recordType: 'donation', hook: 'validate', runAs: 'admin', code: '1' })).rejects.toMatchObject({ code: 'forbidden' });
    const admin: Actor = { id: 'admin-1', roles: ['admin'], permissions: ['*'] };
    const out = (await builder.tryScript(w.as(w.ngoA, admin), { recordType: 'donation', hook: 'validate', inputs: { balances: {} }, code: '1' })) as { ok: boolean; inputs?: unknown };
    expect(out.ok).toBe(true);
    expect(out).toHaveProperty('inputs.balances');
  });

  it('caps a Try it run at 250 ms whatever limit is asked for', async () => {
    const admin: Actor = { id: 'admin-1', roles: ['admin'], permissions: ['*'] };
    const out = (await w.platform.builderSupport().tryScript(w.as(w.ngoA, admin), { recordType: 'donation', hook: 'validate', code: 'while (true) {}', timeoutMs: 1000 })) as {
      ok: boolean;
      code: string;
      error: string;
    };
    expect(out).toMatchObject({ ok: false, code: 'script_limit', error: 'Script exceeded its 250 ms time limit.' });
  });
});
