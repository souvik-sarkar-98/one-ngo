import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { admin, createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, actor: Actor = admin) =>
  app.inject({
    method,
    url,
    headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) },
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });

beforeAll(async () => {
  w = await createWorld();
  app = buildServer(w.platform, { devAuth: true });
});
afterAll(() => w.close());

describe('an account has no attached profile', () => {
  it('GET /api/people/me returns the account and no record', async () => {
    const res = await call('GET', '/api/people/me');
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ userId: admin.id, displayName: admin.id, email: null, twoStepEnabled: false });
    expect(body).not.toHaveProperty('record');
    expect(body).not.toHaveProperty('fields');
  });

  it('no longer has profile routes', async () => {
    expect((await call('GET', '/api/me/profile')).statusCode).toBe(404);
    expect((await call('PUT', '/api/me/profile', { data: { phone: '1' } })).statusCode).toBe(404);
    expect((await call('GET', `/api/admin/people/${admin.id}/profile`)).statusCode).toBe(404);
    expect((await call('PUT', `/api/admin/people/${admin.id}/profile`, { data: {} })).statusCode).toBe(404);
  });

  it('adding a member inserts no person row', async () => {
    const res = await call('POST', '/api/admin/people', { email: 'nira@example.org', displayName: 'Nira Das', roles: [] });
    expect(res.statusCode, res.body).toBe(201);
    const userId = (res.json() as { userId: string }).userId;
    const rows = await w.platform.db.asSystem((tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from record where tenant_id = $1 and type_key = 'person' and data->>'userId' = $2`, [w.ngoA, userId]),
    );
    expect(rows[0]!.n).toBe(0);
  });
});
