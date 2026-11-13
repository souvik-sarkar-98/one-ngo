import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ConnectorRequest, ConnectorResponse } from '../src/infrastructure/connectors/http.js';
import type { ConnectorSummary } from '../src/application/connectors/connector-service.js';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { MemberPage } from '../src/application/identity/people-service.js';
import type { RoleView } from '../src/application/identity/roles-service.js';
import { admin, clerk, createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;
const fakeHttp = async (_req: ConnectorRequest): Promise<ConnectorResponse> => ({ status: 500, body: 'down' });

const manager: Actor = { id: 'manager-1', roles: [], permissions: ['members:manage'] };
const keyAdmin: Actor = { id: 'keys-1', roles: [], permissions: ['admin:api-keys'] };
const connectorAdmin: Actor = { id: 'conn-1', roles: [], permissions: ['admin:connectors'] };

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = async (method: Method, url: string, payload?: unknown, actor: Actor = admin) =>
  app.inject({
    method,
    url,
    headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) },
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, connectorHttp: fakeHttp });
  app = buildServer(w.platform, { devAuth: true, rateLimits: { api: 100_000 } });
});

afterAll(async () => {
  await app.close();
  await w.close();
});

describe('roles to choose from', () => {
  it('lists roles with member counts for people and API key administrators, without what each allows', async () => {
    const full = (await call('GET', '/api/admin/roles')).json() as RoleView[];
    expect(full.some((r) => r.permissions.length)).toBe(true);
    for (const actor of [manager, keyAdmin]) {
      const res = await call('GET', '/api/admin/roles', undefined, actor);
      expect(res.statusCode).toBe(200);
      const roles = res.json() as RoleView[];
      expect(roles.map((r) => [r.key, r.members])).toEqual(full.map((r) => [r.key, r.members]));
      expect(roles.every((r) => r.permissions.length === 0)).toBe(true);
    }
    expect((await call('GET', '/api/admin/roles', undefined, clerk)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/roles/admin', undefined, manager)).statusCode).toBe(403);
  });
});

describe('the members list', () => {
  it('lists members without a profile record', async () => {
    const res = await call('POST', '/api/admin/people', { email: 'pia@example.org', displayName: 'Profile Pia', roles: [] });
    expect(res.statusCode, res.body).toBe(201);
    const page = (await call('GET', '/api/admin/people?q=profile%20pia', undefined, manager)).json() as MemberPage;
    expect(page).not.toHaveProperty('fields');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('profile');
    expect(page.items[0]).toMatchObject({ displayName: 'Profile Pia', email: 'pia@example.org' });
  });
});

describe('connectors in Administration', () => {
  it('lists connectors with what sends through each and their last delivery', async () => {
    await w.platform.connectors.save(w.as(w.ngoA), 'crm', { kind: 'webhook', config: { url: 'https://crm.test/hooks' }, secrets: { signingSecret: 's-1' }, enabled: true });
    await w.platform.connectors.save(w.as(w.ngoA), 'gateway', { kind: 'sms', config: { url: 'https://sms.test/send?to={{to}}', method: 'GET' } });
    await w.platform.definitions.saveDraft(w.as(w.ngoA), 'action', {
      key: 'tellCrm',
      recordType: 'donation',
      label: 'Tell the CRM',
      placement: ['panel'],
      steps: [{ type: 'webhook', connector: 'crm', body: {} }],
    } as never);
    await w.platform.definitions.publish(w.as(w.ngoA), 'action', 'tellCrm');

    const res = await call('GET', '/api/admin/connectors', undefined, connectorAdmin);
    expect(res.statusCode).toBe(200);
    const list = res.json() as ConnectorSummary[];
    expect(list.map((c) => [c.key, c.kind, c.enabled, c.configured, c.usedBy])).toEqual([
      ['crm', 'webhook', true, true, ['Tell the CRM']],
      ['gateway', 'sms', false, true, []],
    ]);
    expect(list[0]!.lastDelivery).toBeNull();
    expect(res.body).not.toContain('s-1');
    expect((await call('GET', '/api/admin/connectors', undefined, manager)).statusCode).toBe(403);
  });

  it('sends a failed delivery again now, once more', async () => {
    const [event] = await w.platform.db.asSystem((tx) =>
      tx.query<{ id: string }>(
        `insert into outbox_event (tenant_id, type, payload, status, attempts) values ($1, 'connector.webhook', $2, 'failed', 5) returning id`,
        [w.ngoA, JSON.stringify({ connector: 'crm', event: 'test.event', body: {} })],
      ),
    );
    const [delivery] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ id: string }>(
        `insert into connector_delivery (tenant_id, connector_key, event, status, attempts, error, outbox_event_id)
         values (app_tenant(), 'crm', 'test.event', 'failed', 5, 'The service answered 500', $1) returning id`,
        [event!.id],
      ),
    );
    const listed = (await call('GET', '/api/admin/connectors', undefined, connectorAdmin)).json() as ConnectorSummary[];
    expect(listed[0]!.lastDelivery).toMatchObject({ status: 'failed' });

    expect((await call('POST', `/api/admin/connectors/crm/deliveries/${delivery!.id}/retry`, {}, manager)).statusCode).toBe(403);
    expect((await call('POST', `/api/admin/connectors/crm/deliveries/${delivery!.id}/retry`, {}, connectorAdmin)).statusCode).toBe(204);
    const [after] = await w.platform.db.asSystem((tx) => tx.query<{ status: string; attempts: number }>(`select status, attempts from outbox_event where id = $1`, [event!.id]));
    expect(after).toEqual({ status: 'pending', attempts: 4 });
    const logs = (await call('GET', '/api/admin/connectors/crm/deliveries', undefined, connectorAdmin)).json() as { id: string; status: string }[];
    expect(logs.find((d) => d.id === delivery!.id)!.status).toBe('pending');

    await w.platform.dispatcher.runOnce();
    const final = (await call('GET', '/api/admin/connectors/crm/deliveries', undefined, connectorAdmin)).json() as { id: string; status: string; attempts: number }[];
    expect(final.find((d) => d.id === delivery!.id)).toMatchObject({ status: 'failed', attempts: 6 });

    expect((await call('POST', `/api/admin/connectors/crm/deliveries/00000000-0000-4000-8000-000000000000/retry`, {}, connectorAdmin)).statusCode).toBe(404);
  });
});
