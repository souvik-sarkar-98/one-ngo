import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { PersonOption } from '../src/application/identity/people-service.js';
import { admin, createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;

const anyone: Actor = { id: 'clerk-9', roles: [], permissions: [] };

const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, actor: Actor = admin) =>
  app.inject({
    method,
    url,
    headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) },
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });

const person = async (email: string, displayName: string, signIn = true) => {
  const res = await call('POST', '/api/admin/people', { email, displayName, roles: [] });
  expect(res.statusCode, res.body).toBe(201);
  const userId = (res.json() as { userId: string }).userId;
  if (signIn) await w.platform.identity.signInVerifiedUser({ tenantId: w.ngoA, userId, method: 'test' });
  return userId;
};

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true, rateLimits: { api: 100_000 } });
  for (let i = 1; i <= 9; i++) await person(`p${i}@pick.test`, `Pick Person ${i}`);
  await person('invited@pick.test', 'Pick Invited', false);
  const gone = await person('gone@pick.test', 'Pick Suspended');
  expect((await call('POST', `/api/admin/people/${gone}/suspend`)).statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await w.close();
});

describe('person picker', () => {
  it('offers up to eight active people by name with their email', async () => {
    const res = await call('GET', '/api/people?pick=1&limit=8&q=pick');
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: PersonOption[] }).items;
    expect(items).toHaveLength(8);
    expect(items[0]).toEqual({ id: expect.any(String), name: 'Pick Person 1', email: 'p1@pick.test' });
    expect(items.map((p) => p.name)).not.toContain('Pick Invited');
    expect(items.map((p) => p.name)).not.toContain('Pick Suspended');
  });

  it('matches by email, never lists invited or suspended people, and refuses someone who edits no person field', async () => {
    const find = async (q: string) => ((await call('GET', `/api/people?pick=1&q=${q}`)).json() as { items: PersonOption[] }).items;
    expect((await find('p9%40pick')).map((p) => p.name)).toEqual(['Pick Person 9']);
    expect(await find('invited%40pick')).toEqual([]);
    expect(await find('gone%40pick')).toEqual([]);
    expect((await call('GET', '/api/people?pick=1&q=pick', undefined, anyone)).statusCode).toBe(403);
    expect((await call('GET', '/api/people?q=pick', undefined, anyone)).statusCode).toBe(403);
  });
});
