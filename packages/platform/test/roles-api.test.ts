import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { MemberView } from '../src/application/identity/people-service.js';
import type { CatalogueEntry, CatalogueGroup, RoleView } from '../src/application/identity/roles-service.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { admin, clerk, createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;

const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, actor: Actor = admin, tenant = w.ngoA) =>
  app.inject({
    method,
    url,
    headers: { 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) },
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });

const member = async (email: string, displayName: string, roles: string[] = [], tenant = w.ngoA) => {
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [email, displayName]),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [tenant, u!.id]);
    for (const role of roles) {
      await tx.query(`insert into role_assignment (tenant_id, user_id, role_key, assigned_by) values ($1, $2, $3, 'test')`, [tenant, u!.id, role]);
    }
  });
  return u!.id;
};

const sessionFor = async (userId: string) => {
  const signIn = await w.platform.identity.signInVerifiedUser({ tenantId: w.ngoA, userId, method: 'test' });
  if (signIn.kind !== 'tokens') throw new Error('Expected a session');
  return async () => (await w.platform.identity.authenticate(signIn.pair.accessToken)).actor.permissions;
};

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
    await w.platform.definitions.saveDraft(w.as(w.ngoB), kind, body as never);
    await w.platform.definitions.publish(w.as(w.ngoB), kind, String(body.key));
  };
  await publish('recordType', {
    key: 'case',
    label: 'Case',
    titleField: 'title',
    visibility: 'restricted',
    fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
  });
});

afterAll(async () => {
  await app.close();
  await w.close();
});

describe('permission catalogue', () => {
  it('lists every permission of the Donations module, grouped for the grid', async () => {
    const res = await call('GET', '/api/admin/permission-catalogue');
    expect(res.statusCode).toBe(200);
    const { groups, entries } = res.json() as { groups: CatalogueGroup[]; entries: CatalogueEntry[] };
    expect(groups.map((g) => g.key)).toEqual(['record:donation', 'record:donor', 'money', 'setup']);
    expect(groups.find((g) => g.key === 'record:donation')!.kind).toBe('recordType');
    const of = (group: string) => entries.filter((e) => e.group === group).map((e) => e.permission);

    expect(of('record:donation')).toEqual([
      'record:donation:read',
      'record:donation:create',
      'record:donation:update',
      'record:donation:sensitive',
      'record:donation:import',
      'record:donation:import:quiet',
      'record:donation:export',
      'record:donation:bulk',
      'record:donation:transition:markPaid',
      'record:donation:transition:cancel',
      'record:donation:action:payNow',
      'record:donation:action:printReceipt',
      'record:donation:action:sendReminder',
    ]);
    expect(of('record:donor')).toEqual(
      expect.arrayContaining(['record:donor:read', 'record:donor:create', 'record:donor:update', 'record:donor:sensitive', 'record:donor:export']),
    );
    expect(of('record:donor').some((p) => p.includes(':transition:') || p.includes(':action:'))).toBe(false);
    expect(entries.some((e) => e.permission.endsWith(':read:all') || e.permission.endsWith(':share'))).toBe(false);
    expect(of('money')).toEqual(expect.arrayContaining(['payments:create', 'payments:confirm', 'money:accounts:read', 'money:accounts:manage', 'money:transfer']));
    expect(of('setup')).toEqual(
      expect.arrayContaining([
        'config:read',
        'config:publish',
        'config:script:publish',
        'config:modules',
        'admin:roles',
        'admin:connectors',
        'admin:api-keys',
        'admin:jobs',
      ]),
    );
    for (const e of entries) expect(e.label).toMatch(/^[A-Z][^:]*(: .+)?$/);
    expect(entries.find((e) => e.permission === 'record:donation:transition:markPaid')!.label).toBe('Step: Mark as paid');
    expect(entries.find((e) => e.permission === 'record:donation:read')!.label).toBe('See donations');
  });

  it('adds See all and Share for restricted record types only', async () => {
    const { entries } = (await call('GET', '/api/admin/permission-catalogue', undefined, admin, w.ngoB)).json() as { entries: CatalogueEntry[] };
    const caseEntries = entries.filter((e) => e.group === 'record:case').map((e) => e.permission);
    expect(caseEntries).toEqual(expect.arrayContaining(['record:case:read:all', 'record:case:share']));
    expect(entries.some((e) => e.permission === 'record:donation:read:all')).toBe(false);
  });
});

describe('roles', () => {
  it('lists roles with member counts', async () => {
    await member('fin@example.org', 'Farah Finance', ['finance']);
    const roles = (await call('GET', '/api/admin/roles')).json() as RoleView[];
    expect(roles.map((r) => r.key)).toEqual(['finance', 'viewer']);
    expect(roles[0]).toMatchObject({ label: 'Finance', members: 1, requireTwoStep: false, customised: false });
    expect(roles[1]).toMatchObject({ members: 0, permissions: ['record:donor:read', 'record:donation:read', 'people:read'] });
  });

  it('marks edited roles as customised, and module re-sync keeps them while still updating the others', async () => {
    const res = await call('PUT', '/api/admin/roles/finance', {
      label: 'Accounts team',
      permissions: ['record:donation:read', 'payments:confirm'],
      requireTwoStep: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'finance', label: 'Accounts team', customised: true, requireTwoStep: true });
    await w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`update role set label = 'Stale' where tenant_id = app_tenant() and key = 'viewer'`));

    const pkg = await w.platform.publishShippedModule('donations');
    await w.platform.definitions.enableModule(w.as(w.ngoA), pkg.manifest);

    const finance = (await call('GET', '/api/admin/roles/finance')).json() as RoleView;
    expect(finance).toMatchObject({ label: 'Accounts team', permissions: ['record:donation:read', 'payments:confirm'], requireTwoStep: true, customised: true });
    const viewer = (await call('GET', '/api/admin/roles/viewer')).json() as RoleView;
    expect(viewer).toMatchObject({ label: 'Viewer', customised: false });
    const audit = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ before: { label: string } }>(`select before from audit_event where action = 'role.updated' and entity_id = 'finance'`),
    );
    expect(audit[0]!.before.label).toBe('Finance');
  });

  it('creates customised roles and refuses duplicates and bad input', async () => {
    const res = await call('POST', '/api/admin/roles', { key: 'volunteers', label: 'Volunteers', permissions: ['record:donor:read'] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ key: 'volunteers', customised: true, members: 0, requireTwoStep: false });
    expect((await call('POST', '/api/admin/roles', { key: 'volunteers', label: 'Again' })).statusCode).toBe(409);
    expect((await call('POST', '/api/admin/roles', { key: 'Bad Key', label: 'Bad' })).statusCode).toBe(422);
    expect((await call('POST', '/api/admin/roles', { key: 'nolabel', label: ' ' })).statusCode).toBe(422);
    expect((await call('POST', '/api/admin/roles', { key: 'nolabel' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/admin/roles/volunteers', { permissions: ['not a permission'] })).statusCode).toBe(422);
    expect((await call('PUT', '/api/admin/roles/volunteers', { requireTwoStep: 'yes' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/admin/roles/nobody', { label: 'Nobody' })).statusCode).toBe(404);
    expect((await call('GET', '/api/admin/roles/nobody')).statusCode).toBe(404);
  });

  it('does not delete a role while it has members', async () => {
    await call('POST', '/api/admin/roles', { key: 'drivers', label: 'Drivers', permissions: [] });
    const driver = await member('driver@example.org', 'Dev Driver', ['drivers']);
    const blocked = await call('DELETE', '/api/admin/roles/drivers');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain('1 member');
    expect((await call('GET', '/api/admin/roles/drivers')).statusCode).toBe(200);

    expect((await call('PUT', `/api/admin/people/${driver}/roles`, { roles: [] })).statusCode).toBe(200);
    expect((await call('DELETE', '/api/admin/roles/drivers')).statusCode).toBe(204);
    expect((await call('GET', '/api/admin/roles/drivers')).statusCode).toBe(404);
    expect((await call('DELETE', '/api/admin/roles/drivers')).statusCode).toBe(404);
  });
});

describe('members', () => {
  it('lists members with their roles and replaces role assignments', async () => {
    const asha = await member('asha.member@example.org', 'Asha Member', ['viewer']);
    const permissionsOf = await sessionFor(asha);
    expect(await permissionsOf()).toEqual(['record:donor:read', 'record:donation:read', 'people:read']);

    const list = (await call('GET', '/api/admin/people')).json().items as MemberView[];
    expect(list.find((m) => m.userId === asha)).toMatchObject({ displayName: 'Asha Member', email: 'asha.member@example.org', status: 'active', roles: ['viewer'] });

    const res = await call('PUT', `/api/admin/people/${asha}/roles`, { roles: ['volunteers', 'finance', 'finance'] });
    expect(res.statusCode).toBe(200);
    expect((res.json() as MemberView).roles).toEqual(['finance', 'volunteers']);
    expect((await permissionsOf()).sort()).toEqual(['payments:confirm', 'record:donation:read', 'record:donor:read']);

    expect((await call('PUT', `/api/admin/people/${asha}/roles`, { roles: ['ghost'] })).statusCode).toBe(422);
    expect((await call('PUT', `/api/admin/people/${asha}/roles`, { roles: 'finance' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/admin/people/00000000-0000-0000-0000-000000000000/roles', { roles: [] })).statusCode).toBe(404);
    const other = await member('bodhi.only@example.org', 'Bodhi Only', [], w.ngoB);
    expect((await call('PUT', `/api/admin/people/${other}/roles`, { roles: [] })).statusCode).toBe(404);
    expect(((await call('GET', '/api/admin/people')).json().items as MemberView[]).some((m) => m.userId === other)).toBe(false);

    const audit = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ before: { roles: string[] }; after: { roles: string[] } }>(
        `select before, after from audit_event where action = 'member.roles.changed' and entity_id = $1 order by id limit 1`,
        [asha],
      ),
    );
    expect(audit[0]).toEqual({ before: { roles: ['viewer'] }, after: { roles: ['finance', 'volunteers'] } });
  });

  it('never removes the last person who can manage roles', async () => {
    await call('POST', '/api/admin/roles', { key: 'owners', label: 'Owners', permissions: ['admin:roles', 'config:read'] });
    const owner = await member('owner@example.org', 'Olga Owner', ['owners']);

    const lockout = await call('PUT', `/api/admin/people/${owner}/roles`, { roles: ['viewer'] });
    expect(lockout.statusCode).toBe(409);
    expect((await call('PUT', '/api/admin/roles/owners', { permissions: ['config:read'] })).statusCode).toBe(409);
    expect(((await call('GET', '/api/admin/roles/owners')).json() as RoleView).permissions).toEqual(['admin:roles', 'config:read']);
    expect(((await call('GET', '/api/admin/people')).json().items as MemberView[]).find((m) => m.userId === owner)!.roles).toEqual(['owners']);

    await call('POST', '/api/admin/roles', { key: 'super', label: 'Super', permissions: ['*'] });
    const deputy = await member('deputy@example.org', 'Dina Deputy', ['super']);
    expect((await call('PUT', `/api/admin/people/${owner}/roles`, { roles: ['viewer'] })).statusCode).toBe(200);
    expect((await call('PUT', `/api/admin/people/${deputy}/roles`, { roles: [] })).statusCode).toBe(409);

    await w.platform.db.asSystem((tx) => tx.query(`update tenant_member set status = 'suspended' where tenant_id = $1 and user_id = $2`, [w.ngoA, owner]));
    expect((await call('PUT', `/api/admin/people/${owner}/roles`, { roles: ['owners'] })).statusCode).toBe(200);
    expect((await call('PUT', `/api/admin/people/${deputy}/roles`, { roles: [] })).statusCode).toBe(409);
  });
});

describe('permissions', () => {
  it('needs admin:roles for every roles and members route', async () => {
    const routes: [('GET' | 'POST' | 'PUT' | 'DELETE'), string, unknown?][] = [
      ['GET', '/api/admin/roles'],
      ['POST', '/api/admin/roles', { key: 'sneaky', label: 'Sneaky', permissions: ['*'] }],
      ['GET', '/api/admin/roles/viewer'],
      ['PUT', '/api/admin/roles/viewer', { permissions: ['*'] }],
      ['DELETE', '/api/admin/roles/viewer'],
      ['GET', '/api/admin/permission-catalogue'],
      ['GET', '/api/admin/people'],
      ['PUT', `/api/admin/people/${clerk.id}/roles`, { roles: ['finance'] }],
    ];
    const rolesAdmin: Actor = { id: 'roles-admin', roles: ['owners'], permissions: ['admin:roles'] };
    for (const [method, url, body] of routes) {
      const res = await call(method, url, body, clerk);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await call('GET', '/api/admin/roles', undefined, rolesAdmin)).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/permission-catalogue', undefined, rolesAdmin)).statusCode).toBe(200);
    await expectCode(w.platform.roles.list(w.as(w.ngoA, { id: 'config', roles: [], permissions: ['config:*'] })), 'forbidden');
    expect(((await call('GET', '/api/admin/roles/viewer')).json() as RoleView).permissions).toEqual(['record:donor:read', 'record:donation:read', 'people:read']);
  });
});
