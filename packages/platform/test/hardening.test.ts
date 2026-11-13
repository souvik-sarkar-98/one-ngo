import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDevAuthAllowed, buildServer } from '@onengo/server/http/server.js';
import { MemoryLogger } from '@onengo/kernel/observability';
import { applyRetention } from '../src/infrastructure/postgres/retention.js';
import { admin, clerk, createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
const logger = new MemoryLogger();
beforeAll(async () => {
  w = await createWorld({ logger });
});
afterAll(() => w.close());

const as = (actor = admin, tenant = w.ngoA) => ({ 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) });

describe('header sign-in guard', () => {
  it('allows it only in test runs', () => {
    expect(() => assertDevAuthAllowed({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => assertDevAuthAllowed({ NODE_ENV: 'development' })).toThrow();
    expect(() => assertDevAuthAllowed({})).toThrow();
    expect(() => assertDevAuthAllowed({ NODE_ENV: 'production' })).toThrow();
    expect(() => assertDevAuthAllowed({ NODE_ENV: 'test', GAE_SERVICE: 'default' })).toThrow();
    expect(() => assertDevAuthAllowed({ NODE_ENV: 'test', K_SERVICE: 'api' })).toThrow();
  });
});

describe('logging and rate limits', () => {
  it('logs unexpected errors with a request id and returns that id, without details', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    app.get('/api/boom', async () => {
      throw new Error('database password is hunter2');
    });
    const res = await app.inject({ method: 'GET', url: '/api/boom', headers: { 'x-cloud-trace-context': 'abcdef0123456789abcdef0123456789/1;o=1' } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json().requestId).toBe('abcdef0123456789abcdef0123456789');
    const entry = logger.entries.find((e) => e.message === 'Unhandled error');
    expect(entry).toMatchObject({ severity: 'ERROR', fields: { trace: 'abcdef0123456789abcdef0123456789', path: '/api/boom' } });
    await app.close();
  });

  it('limits requests per client address and logs failed sign-ins', async () => {
    const app = buildServer(w.platform, { devAuth: true, rateLimits: { api: 3, auth: 2 } });
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'GET', url: '/api/people/me', headers: as() })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'GET', url: '/api/people/me', headers: as() });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');

    const bad = { tenant: 'asha', email: 'nobody@example.org', password: 'wrong wrong wrong' };
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: bad })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: bad })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: bad })).statusCode).toBe(429);
    const failed = logger.entries.filter((e) => e.message === 'Sign-in failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).not.toContain('nobody@example.org');
    await app.close();
  });

  it('limits sign-in code emails per address across instances', async () => {
    const id = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'codes@example.org', displayName: 'Codes', roles: [] });
    expect(id).toBeTruthy();
    w.mail.sent.length = 0;
    for (let i = 0; i < 5; i++) await w.platform.identity.requestEmailCode({ tenantKey: 'asha', email: 'codes@example.org', ip: '10.0.0.9' });
    expect(w.mail.sent).toHaveLength(3);
  });
});

describe('people are separated by NGO in the database', () => {
  it('shows the runtime role only members of the current NGO', async () => {
    await w.platform.identity.addMember(w.as(w.ngoA), { email: 'only-a@example.org', displayName: 'Only A', roles: [] });
    await w.platform.identity.addMember(w.as(w.ngoB), { email: 'only-b@example.org', displayName: 'Only B', roles: [] });
    const inB = await w.platform.db.withTenant(w.ngoB, (tx) => tx.query<{ email: string }>(`select email from app_user`));
    expect(inB.map((u) => u.email)).toContain('only-b@example.org');
    expect(inB.map((u) => u.email)).not.toContain('only-a@example.org');
    await expect(w.platform.db.withTenant(w.ngoB, (tx) => tx.query(`select password_hash from app_user`))).rejects.toThrow(/permission denied/);
  });
});

describe('scheduled automations at scale', () => {
  beforeAll(async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'recordType', {
      key: 'pledge',
      label: 'Pledge',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'reminded', label: 'Reminded', type: 'boolean' },
      ],
    });
    await w.platform.definitions.publish(ctx, 'recordType', 'pledge');
    await w.platform.definitions.saveDraft(ctx, 'automation', {
      key: 'remindPledges',
      recordType: 'pledge',
      trigger: { event: 'schedule', cron: '0 3 1 * *' },
      actions: [{ type: 'setFields', values: { reminded: 'true' } }],
    });
    await w.platform.definitions.publish(ctx, 'automation', 'remindPledges');
    for (let i = 0; i < 7; i++) await w.platform.records.create(ctx, 'pledge', { name: `Pledge ${i}` });
    await w.platform.automations.tick(new Date('2026-10-20T00:00:00Z'));
  });

  it('processes every record in batches and resumes after running out of time', async () => {
    const stopped = await w.platform.automations.tick(new Date('2026-11-01T04:00:00Z'), { timeBudgetMs: 0 });
    expect(stopped.incomplete).toBe(true);

    const resumed = await w.platform.automations.tick(new Date('2026-11-01T04:05:00Z'), { batchSize: 3 });
    expect(resumed.incomplete).toBe(false);
    const pledges = await w.platform.records.list(w.as(w.ngoA), 'pledge', { limit: 50 });
    expect(pledges).toHaveLength(7);
    expect(pledges.every((p) => p.data.reminded === true)).toBe(true);

    const again = await w.platform.automations.tick(new Date('2026-11-01T05:00:00Z'), { batchSize: 3 });
    expect(again.recordsProcessed).toBe(0);
  });
});

describe('retention', () => {
  it('removes old processed events and archives audit history before deleting it', async () => {
    await w.platform.db.asSystem((tx) =>
      tx.query(
        `insert into outbox_event (tenant_id, type, payload, status, processed_at) values ($1, 'old', '{}', 'done', now() - interval '30 days')`,
        [w.ngoA],
      ),
    );
    await w.platform.db.asSystem((tx) =>
      tx.query(`update audit_event set at = now() - interval '1000 days' where tenant_id = $1`, [w.ngoB]),
    );
    const before = await w.platform.db.asSystem((tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from audit_event where tenant_id = $1`, [w.ngoB]),
    );

    await expect(
      applyRetention(w.platform.db, {
        auditDays: 730,
        archiveAudit: async () => {
          throw new Error('bucket unavailable');
        },
      }),
    ).rejects.toThrow('bucket unavailable');
    const kept = await w.platform.db.asSystem((tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from audit_event where tenant_id = $1`, [w.ngoB]),
    );
    expect(kept[0]!.n).toBe(before[0]!.n);

    const archived: Record<string, unknown>[] = [];
    const result = await applyRetention(w.platform.db, {
      auditDays: 730,
      archiveAudit: async (_tenant, rows) => {
        archived.push(...rows);
      },
    });
    const oldEvents = await w.platform.db.asSystem((tx) => tx.query(`select 1 from outbox_event where type = 'old'`));
    expect(oldEvents).toHaveLength(0);
    expect(result.auditArchived).toBe(before[0]!.n);
    expect(archived).toHaveLength(before[0]!.n);
  });
});

describe('NGO export', () => {
  it('exports only the NGO’s own data, without secrets', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.records.create(ctx, 'donation', { donorName: 'Export A', amount: 11 });
    await w.platform.records.create(w.as(w.ngoB), 'donation', { donorName: 'Export B', amount: 22 });
    await w.platform.payments.saveGatewayCredentials(ctx, 'razorpay', { keyId: 'k', keySecret: 'super-secret-key', webhookSecret: 'whsec' });

    const lines: string[] = [];
    const summary = await w.platform.exportTenant(w.ngoA, (l) => {
      lines.push(l);
    });
    const text = lines.join('\n');
    expect(text).toContain('Export A');
    expect(text).not.toContain('Export B');
    expect(text).not.toContain('super-secret-key');
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('scrypt$');
    expect(summary.counts.record).toBeGreaterThan(0);
    expect(lines.every((l) => JSON.parse(l).table)).toBe(true);
  });

  it('downloads as gzip for people with export permission only', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    expect((await app.inject({ method: 'GET', url: '/api/admin/export', headers: as(clerk) })).statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/api/admin/export', headers: as() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    const first = gunzipSync(res.rawPayload).toString('utf8').split('\n')[0]!;
    expect(JSON.parse(first)).toMatchObject({ table: 'tenant', format: 'ngo-platform-export/1' });
    await app.close();
  });
});
