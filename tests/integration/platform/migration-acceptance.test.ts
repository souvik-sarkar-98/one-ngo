import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../../../packages/platform/src/application/migration/migration-service.js';
import type { Actor } from '../../../packages/platform/src/infrastructure/postgres/db.js';
import { TENANT_TABLES } from '../../../packages/platform/src/infrastructure/postgres/tenant-export.js';
import type { DefinitionKind } from '../../../packages/platform/src/runtime/definitions/types.js';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';

/**
 * Acceptance criteria 7 and 10 of docs/documents.html#architecture, Appendix E (the legacy data migrator plan), asserted in one place
 * (the others are covered in data-migration, migration-people, migration-persons, migration-files,
 * migration-check and migration-retention; the table is at the end of the plan).
 */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;

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
const q = <T extends object>(sql: string, args: unknown[] = []) => w.platform.db.asSystem((tx) => tx.query<T>(sql, args));
const count = async (sql: string, args: unknown[] = []) => Number((await q<{ n: number }>(sql, args))[0]!.n);
const upload = (id: string, name: string, csv: string) =>
  app.inject({
    method: 'POST',
    url: `/api/migrations/${id}/sources`,
    headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': encodeURIComponent(name) },
    payload: Buffer.from(csv),
  });

/** What a run must leave alone, counted for the organisation. */
const outgoing = async () => ({
  mail: w.mail.sent.length,
  outbox: await count(
    `select count(*)::int as n from outbox_event where tenant_id = $1 and (type like 'script.%' or type like 'connector.%' or type like 'email%' or type like 'notification%' or type like 'mail%')`,
    [w.ngoA],
  ),
  emailNotices: await count(`select count(*)::int as n from notification where tenant_id = $1 and channel = 'email'`, [w.ngoA]),
  receipts: await count(`select count(*)::int as n from receipt where tenant_id = $1`, [w.ngoA]),
  invitations: await count(`select count(*)::int as n from password_token`),
});

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  const permissions = ['data:migrate', 'data:migrate:people', 'members:manage', 'people:read', 'record:accGift:*'];
  const [u] = await q<{ id: string }>(`insert into app_user (email, display_name) values ('acceptance@example.org', 'acceptance') returning id`);
  await q(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
  await q(`insert into role (tenant_id, key, label, permissions) values ($1, 'held-acceptance', 'held-acceptance', $2::text[])`, [w.ngoA, permissions]);
  await q(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, 'held-acceptance')`, [w.ngoA, u!.id]);
  migrator = { id: u!.id, roles: [], permissions };

  const ctx = w.as(w.ngoA);
  await w.platform.connectors.save(ctx, 'acc-hook', { kind: 'webhook', config: { url: 'https://acceptance.test/hooks' } });
  await w.platform.connectors.save(ctx, 'acc-tally', { kind: 'http', config: { mode: 'send', method: 'POST', url: 'https://acceptance.test/vouchers' } });
  await publish('recordType', {
    key: 'accGift',
    label: 'Gift',
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'tag', label: 'Tag', type: 'text' },
    ],
  });
  await publish('workflow', {
    key: 'accGiftFlow',
    recordType: 'accGift',
    initial: 'open',
    states: [
      { key: 'open', label: 'Open' },
      { key: 'paid', label: 'Paid' },
    ],
    transitions: [{ key: 'pay', label: 'Pay', from: ['open'], to: 'paid' }],
  });
  // Everything that could send something when a record is saved.
  await publish('receiptRule', { key: 'accReceiptOnPaid', recordType: 'accGift', whenStatus: 'paid', series: 'donation-receipt', amount: 'record.amount', date: 'today()' });
  await publish('automation', { key: 'accStamp', recordType: 'accGift', trigger: { event: 'created' }, actions: [{ type: 'setFields', values: { tag: "'auto'" } }] });
  await publish('script', {
    key: 'accNotify',
    recordType: 'accGift',
    hook: 'afterSave',
    effects: { allow: ['notify'] },
    code: `ctx.propose.notify('donationThanks', { roles: ['admin'] }, { channels: ['email', 'inApp'] });`,
  });
  await publish('script', {
    key: 'accConnect',
    recordType: 'accGift',
    hook: 'afterSave',
    effects: { allow: ['connector.call'], connectors: ['acc-tally', 'acc-hook'] },
    code: `ctx.propose.connector('acc-tally', { n: ctx.record.name }); ctx.propose.connector('acc-hook', { n: ctx.record.name });`,
  });
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('acceptance criterion 7: a run sends nothing', () => {
  it('people and records run with no mail, outbox event, email notice, receipt, invitation or automation, while a normal save of the same type does send them', async () => {
    const created = await ok(await call('POST', '/api/migrations', { name: 'Quiet end to end' }), 201);
    const people = (await ok(await upload(created.id, 'people.csv', ['Id,Email,Name', 'P-1,quiet.one@example.org,Quiet One', 'P-2,quiet.two@example.org,Quiet Two'].join('\r\n')), 201)).sources[0]!;
    const gifts = (await ok(await upload(created.id, 'gifts.csv', ['Code,Name,Amount', 'G-1,First gift,100', 'G-2,Second gift,250'].join('\r\n')), 201)).sources.find((s) => s.fileName === 'gifts.csv')!;
    await ok(await call('PUT', `/api/migrations/${created.id}/sources/${people.id}/mapping`, { kind: 'people', people: { oldId: 'Id', email: 'Email', name: 'Name' } }));
    await ok(await call('PUT', `/api/migrations/${created.id}/sources/${gifts.id}/mapping`, { targets: [{ key: 'gift', type: 'accGift', oldId: 'Code', fields: { name: 'Name', amount: 'Amount' } }] }));

    await ok(await call('POST', `/api/migrations/${created.id}/check`), 202);
    await w.platform.jobs.runOnce();
    const check = await ok(await call('GET', `/api/migrations/${created.id}`));
    expect(check.check).toMatchObject({ ready: 4, invalid: 0, problems: [] });
    // The scripts are reported, not hidden.
    expect(check.check!.warnings.map((x) => x.kind)).toContain('script-effects-suppressed');

    const before = await outgoing();
    await ok(await call('POST', `/api/migrations/${created.id}/run`), 202);
    await w.platform.jobs.runOnce();
    await w.platform.dispatcher.runOnce();
    const done = await ok(await call('GET', `/api/migrations/${created.id}`));
    expect(done.status).toBe('done');
    expect(done.sources.map((s) => s.counts)).toEqual([
      { created: 2, updated: 0, failed: 0 },
      { created: 2, updated: 0, failed: 0 },
    ]);

    expect(await outgoing()).toEqual(before);
    const saved = (await w.platform.records.query(w.as(w.ngoA), 'accGift', { limit: 10 })).items;
    expect(saved).toHaveLength(2);
    expect(saved.map((r) => r.data.tag ?? null)).toEqual([null, null]); // the automation stayed off

    // The same type still sends when saved normally, so the assertions above are not vacuous.
    const loud = await w.platform.records.create(w.as(w.ngoA, migrator), 'accGift', { name: 'Loud', amount: 5 });
    const events = await count(
      `select count(*)::int as n from outbox_event where tenant_id = $1 and type in ('script.notify', 'connector.http', 'connector.webhook') and (payload->>'recordId' = $2 or payload->'record'->>'id' = $2)`,
      [w.ngoA, loud.record.id],
    );
    expect(events).toBe(3);
  });
});

describe('acceptance criterion 10: the new tables are private and exported', () => {
  const TABLES = ['migration_profile', 'migration_source', 'migration_key', 'migration_person_key', 'migration_attachment'];

  it('has row-level security and a tenant_isolation policy on every migration table', async () => {
    for (const table of TABLES) {
      const [t] = await q<{ rls: boolean }>(`select relrowsecurity as rls from pg_class where relname = $1 and relkind = 'r' and relnamespace = current_schema()::regnamespace`, [table]);
      expect(t?.rls, `${table} has row-level security`).toBe(true);
      const policies = await q<{ qual: string }>(`select qual from pg_policies where schemaname = current_schema() and tablename = $1 and policyname = 'tenant_isolation'`, [table]);
      expect(policies, `${table} tenant_isolation policy`).toHaveLength(1);
      expect(policies[0]!.qual).toContain('tenant_id');
    }
  });

  it('is in the organisation export', () => {
    for (const table of TABLES) expect(TENANT_TABLES, table).toContain(table);
  });

  it('gives the runtime role only the narrow grants, and no delete on the people map', async () => {
    const grants = async (table: string) =>
      (await q<{ privilege_type: string }>(`select privilege_type from information_schema.role_table_grants where table_schema = current_schema() and table_name = $1 and grantee = 'app_runtime' order by 1`, [table])).map((r) => r.privilege_type);
    expect(await grants('migration_person_key')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await grants('migration_attachment')).toEqual(['DELETE', 'INSERT', 'SELECT']);
  });
});
