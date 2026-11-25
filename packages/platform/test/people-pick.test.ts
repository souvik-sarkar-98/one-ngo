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
  const find = async (query: string) => ((await call('GET', `/api/people?pick=1&${query}`)).json() as { items: PersonOption[] }).items;
  const names = async (query: string) => (await find(query)).map((p) => p.name);

  it('by default offers only active people, by name with their email', async () => {
    const res = await call('GET', '/api/people?pick=1&limit=8&q=pick');
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: PersonOption[] }).items;
    expect(items).toHaveLength(8);
    expect(items[0]).toEqual({ id: expect.any(String), name: 'Pick Person 1', email: 'p1@pick.test', joinedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(items.map((p) => p.name)).not.toContain('Pick Invited');
    expect(items.map((p) => p.name)).not.toContain('Pick Suspended');
  });

  it('adds invited people only when asked with include=invited, and never offers suspended people', async () => {
    expect(await names('q=invited%40pick')).toEqual([]);
    expect(await names('q=invited%40pick&include=invited')).toEqual(['Pick Invited']);
    // Names sort alphabetically, so the invited person comes first.
    expect((await names('q=pick&limit=8&include=invited'))[0]).toBe('Pick Invited');
    expect(await names('q=gone%40pick&include=invited')).toEqual([]);
  });

  it('with email= returns only the one person with exactly that email, ignoring case', async () => {
    expect(await names('email=p1%40pick.test')).toEqual(['Pick Person 1']);
    expect(await names('email=P1%40PICK.TEST')).toEqual(['Pick Person 1']);
    // A partial address is not the same person.
    expect(await names('email=p1%40pick')).toEqual([]);
    expect(await names('email=p1%40pick.test&q=person%202')).toEqual([]);
    // Invited people need include=invited, as with name search.
    expect(await names('email=invited%40pick.test')).toEqual([]);
    expect(await names('email=invited%40pick.test&include=invited')).toEqual(['Pick Invited']);
    expect(await names('email=gone%40pick.test&include=invited')).toEqual([]);
  });

  it('refuses someone who edits no person field', async () => {
    expect((await call('GET', '/api/people?pick=1&q=pick', undefined, anyone)).statusCode).toBe(403);
    expect((await call('GET', '/api/people?pick=1&email=p1%40pick.test', undefined, anyone)).statusCode).toBe(403);
    expect((await call('GET', '/api/people?q=pick', undefined, anyone)).statusCode).toBe(403);
  });
});
