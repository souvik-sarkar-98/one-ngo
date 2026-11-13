import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';
import { accessElements, APP_AREAS, generatedPermissions, type PermissionDefs } from '../src/runtime/definitions/permission-usage.js';
import type { ReportDef } from '../src/runtime/definitions/types.js';
import { admin, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;

const onPaid = { transition: 'markPaid', fields: { paidOn: 'paidOn', reference: 'reference', method: 'method' } };
const donation = ['record:donation:read', 'record:donation:update'];
const payer: Actor = { id: 'payer-1', roles: [], permissions: [...donation, 'record:donation:action:payByUpi'] };
const reader: Actor = { id: 'reader-1', roles: [], permissions: ['record:donation:read'] };
const editor: Actor = { id: 'editor-1', roles: [], permissions: donation };
const builder: Actor = { id: 'builder-1', roles: [], permissions: ['config:read'] };

type Method = 'GET' | 'POST' | 'DELETE';
const call = (method: Method, url: string, actor: Actor = admin, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) }, ...(payload ? { payload } : {}) });

const newDonation = async (donorName: string, amount: number) => (await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName, amount })).record;

beforeAll(async () => {
  w = await createWorld();
  app = buildServer(w.platform, { devAuth: true, rateLimits: { api: 100_000, auth: 100_000 } });
  const ctx = w.as(w.ngoA);
  await w.platform.moneyAccounts.open(ctx, { key: 'main', name: 'SBI current', kind: 'bank', upiId: 'asha.trust@sbi' });
  const action = { key: 'payByUpi', recordType: 'donation', label: 'Pay by UPI', placement: ['panel', 'bulk'], steps: [{ type: 'createPayment', provider: 'upi', amount: 'record.amount', account: 'main', onPaid }] };
  await w.platform.definitions.saveDraft(ctx, 'action', action as never);
  await w.platform.definitions.publish(ctx, 'action', 'payByUpi');
  await w.platform.roles.create(ctx, { key: 'desk', label: 'Desk', permissions: ['record:donation:read'] });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

describe('published definitions by address', () => {
  it('refuses someone who cannot read the setup', async () => {
    expect((await call('GET', '/api/definitions/recordType/donation', reader)).statusCode).toBe(403);
  });

  it('answers someone who can', async () => {
    const res = await call('GET', '/api/definitions/recordType/donation', builder);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ key: 'donation' });
  });
});

describe('record actions that request a payment', () => {
  it('refuses a person who may run the action but not take payments', async () => {
    const record = await newDonation('No payments', 100);
    await expectCode(w.platform.actions.run(w.as(w.ngoA, payer), 'donation', record.id, 'payByUpi'), 'forbidden');
    await expectCode(w.platform.actions.checkBulk(w.as(w.ngoA, payer), 'donation', 'payByUpi', {}), 'forbidden');
  });

  it('runs for a person who may also take payments', async () => {
    const record = await newDonation('Takes payments', 120);
    const taker: Actor = { ...payer, permissions: [...payer.permissions, 'payments:create'] };
    const result = await w.platform.actions.run(w.as(w.ngoA, taker), 'donation', record.id, 'payByUpi');
    expect(result.payment).toMatchObject({ recordId: record.id, status: 'awaiting_payment' });
    await expect(w.platform.actions.checkBulk(w.as(w.ngoA, taker), 'donation', 'payByUpi', {})).resolves.toEqual({});
  });
});

describe('looking up a payment request', () => {
  it('refuses someone who cannot read the record it is for', async () => {
    const record = await newDonation('Hidden payment', 140);
    const intent = await w.platform.payments.createIntent(w.as(w.ngoA), { recordId: record.id, amount: 140, provider: 'upi_direct', onPaid, upiAccountKey: 'main' });
    await expectCode(w.platform.payments.get(w.as(w.ngoA, { id: 'cashier-1', roles: [], permissions: ['payments:create'] }), intent.id), 'forbidden');
  });

  it('answers someone who can', async () => {
    const record = await newDonation('Visible payment', 150);
    const intent = await w.platform.payments.createIntent(w.as(w.ngoA), { recordId: record.id, amount: 150, provider: 'upi_direct', onPaid, upiAccountKey: 'main' });
    const cashier: Actor = { id: 'cashier-2', roles: [], permissions: ['payments:create', 'record:donation:read'] };
    expect(await w.platform.payments.get(w.as(w.ngoA, cashier), intent.id)).toMatchObject({ id: intent.id, status: 'awaiting_payment' });
  });
});

describe('the access map without role management', () => {
  it('hides which roles hold what, and refuses a role view', async () => {
    const map = await call('GET', '/api/admin/access-map', builder);
    expect(map.statusCode, map.body).toBe(200);
    const elements = (map.json() as { elements: { roles: string[] }[] }).elements;
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.every((e) => e.roles.length === 0)).toBe(true);
    expect((await call('GET', '/api/admin/access-map?role=desk', builder)).statusCode).toBe(403);
    const suggestions = (await call('GET', '/api/admin/permission-suggestions?q=record:donation:read', builder)).json() as { permission: string; roles: number }[];
    expect(suggestions.find((s) => s.permission === 'record:donation:read')).toMatchObject({ roles: 0 });
  });

  it('shows them to someone who manages roles', async () => {
    const roleAdmin: Actor = { id: 'roles-1', roles: [], permissions: ['config:read', 'admin:roles'] };
    const map = (await call('GET', '/api/admin/access-map', roleAdmin)).json() as { elements: { permission: string | null; roles: string[] }[] };
    expect(map.elements.find((e) => e.permission === 'record:donation:read')!.roles).toContain('desk');
    const role = await call('GET', '/api/admin/access-map?role=desk', roleAdmin);
    expect(role.statusCode, role.body).toBe(200);
    expect(role.json()).toMatchObject({ role: { key: 'desk' } });
    const suggestions = (await call('GET', '/api/admin/permission-suggestions?q=record:donation:read', roleAdmin)).json() as { permission: string; roles: number }[];
    expect(suggestions.find((s) => s.permission === 'record:donation:read')!.roles).toBeGreaterThan(0);
  });
});

describe('public receipt links', () => {
  const issue = async (donorName: string) => {
    const record = await newDonation(donorName, 80);
    return w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 80, recordId: record.id }));
  };

  it('refuses making or ending one for someone who can only read the record', async () => {
    const receipt = await issue('Read only');
    expect((await call('POST', `/api/print/receipt/${receipt.id}/link`, reader)).statusCode).toBe(403);
    expect((await call('POST', `/api/print/receipt/${receipt.id}/link`, editor)).statusCode).toBe(200);
    expect((await call('DELETE', `/api/print/receipt/${receipt.id}/link`, reader)).statusCode).toBe(403);
    expect((await call('GET', `/api/print/receipt/${receipt.id}`, reader)).json()).toMatchObject({ publicLink: expect.stringMatching(/^\/r\//) });
  });

  it('lets someone who can change the record make and end one', async () => {
    const receipt = await issue('Editor');
    const made = await call('POST', `/api/print/receipt/${receipt.id}/link`, editor);
    expect(made.statusCode, made.body).toBe(200);
    expect((await call('DELETE', `/api/print/receipt/${receipt.id}/link`, editor)).statusCode).toBe(204);
  });
});

describe('storage usage', () => {
  it('refuses someone who can only read the setup', async () => {
    expect((await call('GET', '/api/admin/storage', builder)).statusCode).toBe(403);
  });

  it('answers someone who changes organisation settings', async () => {
    const res = await call('GET', '/api/admin/storage', { id: 'settings-1', roles: [], permissions: ['admin:settings'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ used: expect.any(Number), quota: expect.any(Number) });
  });
});

describe('the permission catalogue', () => {
  const report: ReportDef = { key: 'yearly', label: 'Yearly summary', audience: ['desk'], datasets: [{ key: 'rows', label: 'Rows', source: 'query', recordType: 'donation', fields: ['amount'] }] };
  const defs: PermissionDefs = { recordTypes: [], workflows: [], listViews: [], actions: [], pages: [], reports: [report] };

  it('lists script administration and each report as an app permission', () => {
    expect(APP_AREAS.map(([p]) => p)).toContain('config:script:admin');
    expect(generatedPermissions(defs).has('report:yearly:run')).toBe(true);
    expect(accessElements(defs).find((e) => e.permission === 'report:yearly:run')).toMatchObject({ area: 'app', access: 'run', label: 'Report: Yearly summary' });
  });

  it('does not invent report permissions when there are no reports', () => {
    const none = { ...defs, reports: undefined };
    expect([...generatedPermissions(none)].some((p) => p.startsWith('report:'))).toBe(false);
    expect(accessElements(none).some((e) => e.permission?.startsWith('report:'))).toBe(false);
  });

  it('offers script administration in the role grid and marks screens that do not exist yet', async () => {
    const catalogue = await w.platform.roles.catalogue(w.as(w.ngoA));
    expect(catalogue.entries.find((e) => e.permission === 'config:script:admin')).toMatchObject({ group: 'setup' });
    for (const p of ['payments:create', 'money:transfer', 'privacy:erase', 'auth:configure', 'data:export']) {
      expect(catalogue.entries.find((e) => e.permission === p)!.label, p).toMatch(/\(API only\)$/);
    }
    expect(catalogue.entries.find((e) => e.permission === 'admin:roles')!.label).not.toMatch(/API only/);
    await expectCode(w.platform.roles.catalogue(w.as(w.ngoA, builder)), 'forbidden');
  });
});

describe('managing roles through the identity service', () => {
  it('needs the role management permission', async () => {
    const old: Actor = { id: 'old-1', roles: [], permissions: ['roles:manage'] };
    await expectCode(w.platform.identity.upsertRole(w.as(w.ngoA, old), { key: 'legacy', label: 'Legacy', permissions: [] }), 'forbidden');
    const manager: Actor = { id: 'manager-1', roles: [], permissions: ['admin:roles'] };
    await w.platform.identity.upsertRole(w.as(w.ngoA, manager), { key: 'legacy', label: 'Legacy', permissions: [] });
    expect((await w.platform.roles.get(w.as(w.ngoA), 'legacy')).label).toBe('Legacy');
  });
});
