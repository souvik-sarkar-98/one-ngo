import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../src/application/migration/migration-service.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;

const TYPES = ['guardReceipt', 'guardPosting', 'guardNote', 'guardJournal', 'guardPlain'];

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(migrator), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const CSV = ['Code,Name,Amount', 'A-1,Asha,10', 'A-2,Ravi,20'].join('\r\n');
/** Starts the check (a background job, answered 202), runs that job, and returns the checked profile. */
async function checkNow(id: string): Promise<ProfileView> {
  await ok(await call('POST', `/api/migrations/${id}/check`), 202);
  await w.platform.jobs.runOnce();
  return ok(await call('GET', `/api/migrations/${id}`));
}

/** A profile with one file mapped onto `type`; not yet checked. */
async function mapped(type: string): Promise<ProfileView> {
  const created = await ok(await call('POST', '/api/migrations', { name: `Guard ${type}` }), 201);
  const added = await app.inject({
    method: 'POST',
    url: `/api/migrations/${created.id}/sources`,
    headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': encodeURIComponent(`${type}.csv`) },
    payload: Buffer.from(CSV),
  });
  const view = await ok(added, 201);
  return ok(await call('PUT', `/api/migrations/${created.id}/sources/${view.sources[0]!.id}/mapping`, {
    targets: [{ key: 'row', type, oldId: 'Code', fields: { name: 'Name', amount: 'Amount' } }],
  }));
}

/** A profile with one file mapped onto `type`, and its check. */
async function checked(type: string): Promise<ProfileView> {
  return checkNow((await mapped(type)).id);
}

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ('guard-migrator@example.org', 'guard') returning id`),
  );
  const permissions = ['data:migrate', ...TYPES.map((t) => `record:${t}:*`)];
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, 'held-guard', 'held-guard', $2::text[])`, [w.ngoA, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, 'held-guard')`, [w.ngoA, u!.id]);
  });
  migrator = { id: u!.id, roles: [], permissions };
  for (const key of TYPES) {
    await publish('recordType', {
      key,
      label: key,
      titleField: 'name',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'amount', label: 'Amount', type: 'money' },
      ],
    });
    await publish('workflow', {
      key: `${key}Flow`,
      recordType: key,
      initial: 'open',
      states: [
        { key: 'open', label: 'Open' },
        { key: 'paid', label: 'Paid' },
      ],
      transitions: [{ key: 'pay', label: 'Pay', from: ['open'], to: 'paid' }],
    });
  }
  await publish('receiptRule', { key: 'guardReceiptOnOpen', recordType: 'guardReceipt', whenStatus: 'open', series: 'donation-receipt', amount: 'record.amount', date: 'today()' });
  await publish('postingRule', {
    key: 'guardPostOnOpen',
    recordType: 'guardPosting',
    whenStatus: 'open',
    date: 'today()',
    lines: [
      { side: 'debit', account: 'CASH', amount: 'record.amount' },
      { side: 'credit', account: 'DONATION_INCOME', amount: 'record.amount' },
    ],
  });
  // A rule on a later state is harmless: new records do not enter it.
  await publish('receiptRule', { key: 'guardPlainOnPaid', recordType: 'guardPlain', whenStatus: 'paid', series: 'donation-receipt', amount: 'record.amount', date: 'today()' });
  await publish('script', {
    key: 'guardTell',
    recordType: 'guardNote',
    hook: 'afterSave',
    effects: { allow: ['notify'] },
    code: 'ctx.log(1);',
  });
  await publish('script', {
    key: 'guardBook',
    recordType: 'guardJournal',
    hook: 'afterSave',
    effects: { allow: ['ledger.propose'], accounts: ['CASH', 'DONATION_INCOME'], maxTotalAmount: '100.00' },
    code: 'ctx.log(1);',
  });
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('migration check guards and warnings', () => {
  it('blocks a type whose initial state issues a receipt', async () => {
    const view = await checked('guardReceipt');
    expect(view.check).toMatchObject({ rows: 2, ready: 0, invalid: 2, warnings: [] });
    expect(view.check!.problems).toHaveLength(1);
    expect(view.check!.problems[0]).toMatchObject({ row: 0, severity: 'error', fileName: 'guardReceipt.csv' });
    expect(view.check!.problems[0]!.message).toContain('issue a receipt');
    expect((await call('POST', `/api/migrations/${view.id}/run`)).statusCode).toBe(409);
  });

  it('blocks a type whose initial state posts a journal entry', async () => {
    const view = await checked('guardPosting');
    expect(view.check).toMatchObject({ ready: 0, invalid: 2 });
    expect(view.check!.problems[0]!.message).toContain('post a journal entry');
    expect((await call('POST', `/api/migrations/${view.id}/run`)).statusCode).toBe(409);
  });

  it('blocks a script that may propose journal entries, which a quiet save does not suppress', async () => {
    const view = await checked('guardJournal');
    expect(view.check).toMatchObject({ ready: 0, invalid: 2 });
    expect(view.check!.problems[0]!.message).toContain("script 'guardBook'");
  });

  it('leaves a rule on a later state alone', async () => {
    const view = await checked('guardPlain');
    expect(view.check).toMatchObject({ ready: 2, invalid: 0, problems: [], warnings: [] });
  });

  let noteProfile: ProfileView;
  it('warns, without blocking, about a notify script', async () => {
    noteProfile = await checked('guardNote');
    expect(noteProfile.check).toMatchObject({ ready: 2, invalid: 0, problems: [] });
    expect(noteProfile.check!.warnings).toEqual([
      {
        kind: 'script-effects-suppressed',
        sourceId: noteProfile.sources[0]!.id,
        fileName: 'guardNote.csv',
        count: 1,
        samples: [expect.stringContaining('notifications and connector calls are skipped during a migration')],
      },
    ]);
  });

  it('runs a checked migration that has only warnings', async () => {
    const run = await ok(await call('POST', `/api/migrations/${noteProfile.id}/run`), 202);
    expect(run.status).toBe('running');
    await w.platform.jobs.runOnce();
    const done = await ok(await call('GET', `/api/migrations/${noteProfile.id}`));
    expect(done.status).toBe('done');
    expect(done.sources[0]!.counts).toEqual({ created: 2, updated: 0, failed: 0 });
  });

  it('runs the check in the background: answers 202 with its job, a run waits for it, and the result appears when it ends', async () => {
    const profile = await mapped('guardPlain');
    const started = await ok(await call('POST', `/api/migrations/${profile.id}/check`), 202);
    expect(started.checkJobId).toEqual(expect.any(String));
    expect((await call('POST', `/api/migrations/${profile.id}/run`)).statusCode).toBe(409);
    await w.platform.jobs.runOnce();
    const done = await ok(await call('GET', `/api/migrations/${profile.id}`));
    expect(done.checkJobId).toBeNull();
    expect(done.status).toBe('checked');
    expect(done.check).toMatchObject({ rows: 2, ready: 2, invalid: 0 });
  });

  it('drops a check that an edit overtakes while it runs', async () => {
    const profile = await mapped('guardPlain');
    await ok(await call('POST', `/api/migrations/${profile.id}/check`), 202);
    await ok(await call('PUT', `/api/migrations/${profile.id}/sources/${profile.sources[0]!.id}/mapping`, {
      targets: [{ key: 'row', type: 'guardPlain', oldId: 'Code', fields: { name: 'Name' } }],
    }));
    await w.platform.jobs.runOnce();
    const after = await ok(await call('GET', `/api/migrations/${profile.id}`));
    expect(after.checkJobId).toBeNull();
    expect(after.check).toBeNull();
  });

  it('reads a check stored before warnings existed', async () => {
    const view = await checked('guardPlain');
    await w.platform.db.asSystem((tx) =>
      tx.query(`update migration_profile set check_result = check_result - 'warnings' where id = $1`, [view.id]),
    );
    const stored = await w.platform.db.asSystem((tx) => tx.query<{ has: boolean }>(`select check_result ? 'warnings' as has from migration_profile where id = $1`, [view.id]));
    expect(stored[0]!.has).toBe(false);
    const again = await ok(await call('GET', `/api/migrations/${view.id}`));
    expect(again.check).toMatchObject({ ready: 2, warnings: [] });
  });
});
