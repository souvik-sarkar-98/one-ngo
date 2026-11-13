import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { AuditEntry, OrganisationSettings } from '../src/application/administration/administration-service.js';
import type { DirectoryPage, MemberPage, MemberView } from '../src/application/identity/people-service.js';
import type { CatalogueEntry } from '../src/application/identity/roles-service.js';
import { admin, clerk, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;

const manager: Actor = { id: 'manager-1', roles: [], permissions: ['members:manage'] };
// Giving a role needs holding what it allows (S4-7): the viewer role allows these, the owners role allows admin:roles.
const viewerManager: Actor = { ...manager, permissions: ['members:manage', 'record:donor:read', 'record:donation:read', 'people:read'] };
const ownersManager: Actor = { ...manager, permissions: ['members:manage', 'admin:roles'] };
const rolesAdmin: Actor = { id: 'roles-1', roles: [], permissions: ['admin:roles'] };
const reader: Actor = { id: 'reader-1', roles: [], permissions: ['people:read'] };
const PASSWORD = 'violet harbour lantern 42';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = async (method: Method, url: string, payload?: unknown, actor: Actor = admin, tenant = w.ngoA) =>
  app.inject({
    method,
    url,
    headers: { 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) },
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });

const signIn = async (userId: string, tenantId = w.ngoA) => {
  const r = await w.platform.identity.signInVerifiedUser({ tenantId, userId, method: 'test' });
  if (r.kind !== 'tokens') throw new Error('Expected a session');
  return r.pair;
};

/** Adds someone over HTTP; they have signed in once unless `signIn` is false, so they count as active. */
const person = async (email: string, displayName: string, roles: string[] = [], options: { signIn?: boolean; tenant?: string } = {}) => {
  const tenant = options.tenant ?? w.ngoA;
  const res = await call('POST', '/api/admin/people', { email, displayName, roles }, admin, tenant);
  expect(res.statusCode, res.body).toBe(201);
  const userId = (res.json() as { userId: string }).userId;
  if (options.signIn !== false) await signIn(userId, tenant);
  return userId;
};

const memberOf = async (userId: string, tenant = w.ngoA) => (await call('GET', `/api/admin/people/${userId}`, undefined, admin, tenant)).json() as MemberView;
const linkToken = (text: string) => new URL(/(https:\/\/ngo\.test\S+)/.exec(text)![1]!).searchParams.get('token')!;
const auditOf = (action: string, entityId: string) =>
  w.platform.db.withTenant(w.ngoA, (tx) =>
    tx.query<{ actor_id: string; before: unknown; after: unknown }>(`select actor_id, before, after from audit_event where action = $1 and entity_id = $2 order by id`, [action, entityId]),
  );

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true, rateLimits: { api: 100_000 } });
});

afterAll(async () => {
  await app.close();
  await w.close();
});

describe('adding people', () => {
  it('adds a new account with roles and sends the invitation when asked', async () => {
    w.mail.sent.length = 0;
    const res = await call('POST', '/api/admin/people', { email: ' Nina@Example.org ', displayName: 'Nina New', roles: ['viewer'], invite: true }, viewerManager);
    expect(res.statusCode).toBe(201);
    const { userId } = res.json() as { userId: string };
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]!.subject).toBe('You have been invited to Asha Trust');

    const nina = await memberOf(userId);
    expect(nina).toMatchObject({ displayName: 'Nina New', email: 'nina@example.org', status: 'invited', twoStep: 'off', roles: ['viewer'], lastSignedInAt: null });
    expect(nina.invitedAt).not.toBeNull();
    expect((await auditOf('member.added', userId))[0]).toMatchObject({ actor_id: 'manager-1', after: { roles: ['viewer'] } });
    expect(await auditOf('member.invited', userId)).toHaveLength(1);

    await w.platform.identity.completePasswordToken({ token: linkToken(w.mail.sent[0]!.text), password: PASSWORD });
    await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'nina@example.org', password: PASSWORD });
    const active = await memberOf(userId);
    expect(active.status).toBe('active');
    expect(active.lastSignedInAt).not.toBeNull();
  });

  it('adds without an email unless asked', async () => {
    w.mail.sent.length = 0;
    const res = await call('POST', '/api/admin/people', { email: 'quiet@example.org', displayName: 'Quiet Add', roles: [] });
    expect(res.statusCode).toBe(201);
    expect(w.mail.sent).toHaveLength(0);
    expect((await memberOf(res.json().userId)).invitedAt).toBeNull();
  });

  it('keeps the sign-in of an account that already belongs to another organisation', async () => {
    const omar = await person('omar@example.org', 'Omar Other', [], { tenant: w.ngoB });
    await w.platform.identity.setPassword(omar, PASSWORD);
    const res = await call('POST', '/api/admin/people', { email: 'OMAR@example.org', displayName: 'Someone Else', roles: ['finance'] });
    expect(res.statusCode).toBe(201);
    expect(res.json().userId).toBe(omar);
    // Each organisation keeps the name it typed (S4-10): the account's other organisation is not shown to this one.
    expect(await memberOf(omar)).toMatchObject({ displayName: 'Someone Else', status: 'invited', roles: ['finance'] });
    expect(await memberOf(omar, w.ngoB)).toMatchObject({ displayName: 'Omar Other' });
    await w.platform.identity.loginWithPassword({ tenantKey: 'bodhi', email: 'omar@example.org', password: PASSWORD });
    await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'omar@example.org', password: PASSWORD });
    expect((await memberOf(omar)).status).toBe('active');
  });

  it('refuses an existing member, and points to reactivation for a suspended one', async () => {
    const dup = await person('dup@example.org', 'Dana Dup');
    const again = await call('POST', '/api/admin/people', { email: 'dup@example.org', displayName: 'Dana Dup', roles: [] });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toContain('already a member');

    expect((await call('POST', `/api/admin/people/${dup}/suspend`)).statusCode).toBe(200);
    const suspended = await call('POST', '/api/admin/people', { email: 'dup@example.org', displayName: 'Dana Dup', roles: ['viewer'] });
    expect(suspended.statusCode).toBe(409);
    expect(suspended.json().message).toContain('Reactivate');
    expect(await memberOf(dup)).toMatchObject({ status: 'suspended', roles: [] });
  });

  it('checks the email, name, roles and invite flag before creating anything', async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ email: 'not-an-email', displayName: 'X', roles: [] }, 'email'],
      [{ email: 'ghost@example.org', displayName: 'Ghost', roles: ['ghost'] }, 'roles'],
      [{ email: 'ghost@example.org', roles: [] }, 'displayName'],
    ];
    for (const [body, path] of bad) {
      const res = await call('POST', '/api/admin/people', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json().issues[0].path).toBe(path);
    }
    const malformed: [Record<string, unknown>, string][] = [
      [{ email: 'ghost@example.org', displayName: 'Ghost', roles: 'viewer' }, '/roles'],
      [{ email: 'ghost@example.org', displayName: 'Ghost', roles: [], invite: 'yes' }, '/invite'],
    ];
    for (const [body, path] of malformed) {
      const res = await call('POST', '/api/admin/people', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().issues[0].path).toBe(path);
    }
    const [ghost] = await w.platform.db.asSystem((tx) => tx.query(`select 1 from app_user where email = 'ghost@example.org'`));
    expect(ghost).toBeUndefined();
  });
});

describe('invitations', () => {
  it('resends with a new link, and the old one stops working', async () => {
    const res = await call('POST', '/api/admin/people', { email: 'resend@example.org', displayName: 'Rita Resend', roles: [], invite: true });
    const rita = res.json().userId as string;
    w.mail.sent.length = 0;
    const first = (await call('POST', `/api/admin/people/${rita}/invite`, undefined, manager)).statusCode;
    expect(first).toBe(204);
    expect((await call('POST', `/api/admin/people/${rita}/invite`, undefined, manager)).statusCode).toBe(204);
    const [oldToken, newToken] = w.mail.sent.map((m) => linkToken(m.text));
    await expectCode(w.platform.identity.completePasswordToken({ token: oldToken!, password: PASSWORD }), 'forbidden');
    await w.platform.identity.completePasswordToken({ token: newToken!, password: PASSWORD });
    expect(await auditOf('member.invited', rita)).toHaveLength(3);

    expect((await call('POST', `/api/admin/people/${rita}/suspend`)).statusCode).toBe(200);
    const blocked = await call('POST', `/api/admin/people/${rita}/invite`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain('Reactivate');
    expect((await call('POST', '/api/admin/people/00000000-0000-0000-0000-000000000000/invite')).statusCode).toBe(404);
  });
});

describe('suspending and reactivating', () => {
  it('signs the person out everywhere, blocks sign-in, and reactivates', async () => {
    const sam = await person('sam@example.org', 'Sam Suspend', ['viewer']);
    await w.platform.identity.setPassword(sam, PASSWORD);
    const phone = await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'sam@example.org', password: PASSWORD });
    const laptop = await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'sam@example.org', password: PASSWORD });
    await w.platform.identity.authenticate(phone.accessToken);

    const res = await call('POST', `/api/admin/people/${sam}/suspend`, undefined, manager);
    expect(res.statusCode).toBe(200);
    expect((res.json() as MemberView).status).toBe('suspended');
    const open = await w.platform.db.asSystem((tx) =>
      tx.query(`select 1 from refresh_token where user_id = $1 and tenant_id = $2 and revoked_at is null`, [sam, w.ngoA]),
    );
    expect(open).toHaveLength(0);
    await expectCode(w.platform.identity.refresh(phone.refreshToken), 'forbidden');
    await expectCode(w.platform.identity.refresh(laptop.refreshToken), 'forbidden');
    await expectCode(w.platform.identity.authenticate(phone.accessToken), 'forbidden');
    await expectCode(w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'sam@example.org', password: PASSWORD }), 'forbidden');
    expect((await call('POST', `/api/admin/people/${sam}/suspend`)).statusCode).toBe(409);

    const back = await call('POST', `/api/admin/people/${sam}/reactivate`, undefined, manager);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ status: 'active', roles: ['viewer'] });
    await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'sam@example.org', password: PASSWORD });
    expect((await call('POST', `/api/admin/people/${sam}/reactivate`)).statusCode).toBe(409);
    expect((await auditOf('member.suspended', sam))[0]!.actor_id).toBe('manager-1');
    expect(await auditOf('member.reactivated', sam)).toHaveLength(1);
  });

  it('never suspends yourself, and an unknown person is not found', async () => {
    const self = await person('self@example.org', 'Selma Self');
    const res = await call('POST', `/api/admin/people/${self}/suspend`, undefined, { ...manager, id: self });
    expect(res.statusCode).toBe(422);
    expect((await memberOf(self)).status).toBe('active');
    expect((await call('POST', '/api/admin/people/00000000-0000-0000-0000-000000000000/suspend')).statusCode).toBe(404);
    expect((await call('POST', '/api/admin/people/not-a-uuid/reactivate')).statusCode).toBe(404);
  });
});

describe('members list', () => {
  let ids: Record<string, string>;
  beforeAll(async () => {
    await call('POST', '/api/admin/roles', { key: 'treasurers', label: 'Treasurers', permissions: ['payments:confirm'], requireTwoStep: true });
    ids = {
      anu: await person('anu@list.test', 'Anu Active', ['viewer']),
      bala: await person('bala@list.test', 'Bala Invited', ['finance'], { signIn: false }),
      chitra: await person('chitra@list.test', 'Chitra Suspended', ['viewer']),
      dev: await person('dev@list.test', 'Dev Two-step', ['viewer']),
      esha: await person('esha@list.test', 'Esha Treasurer', ['treasurers'], { signIn: false }),
    };
    await call('POST', `/api/admin/people/${ids.chitra}/suspend`);
    await w.platform.db.asSystem((tx) => tx.query(`update app_user set totp_enabled = true where id = $1`, [ids.dev]));
  });
  const list = async (query: string, actor: Actor = admin) => {
    const res = await call('GET', `/api/admin/people?q=list.test&${query}`, undefined, actor);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as MemberPage;
  };

  it('shows status, two-step state, dates and counts for the chips', async () => {
    const page = await list('');
    expect(page.items.map((m) => [m.displayName, m.status, m.twoStep])).toEqual([
      ['Anu Active', 'active', 'off'],
      ['Bala Invited', 'invited', 'off'],
      ['Chitra Suspended', 'suspended', 'off'],
      ['Dev Two-step', 'active', 'on'],
      ['Esha Treasurer', 'invited', 'required-not-set'],
    ]);
    expect(page.counts).toEqual({ active: 2, invited: 2, suspended: 1, all: 5 });
    expect(page).toMatchObject({ total: 5, limit: 50, offset: 0 });
    expect(page.roles).toContainEqual({ key: 'treasurers', label: 'Treasurers' });
    for (const m of page.items) expect(Date.parse(m.joinedAt)).not.toBeNaN();
  });

  it('filters by status, role and search', async () => {
    const invited = await list('status=invited');
    expect(invited.items.map((m) => m.displayName)).toEqual(['Bala Invited', 'Esha Treasurer']);
    expect(invited.total).toBe(2);
    expect(invited.counts.all).toBe(5);
    expect((await list('status=active&status=suspended')).total).toBe(3);
    expect((await list('role=viewer')).items.map((m) => m.displayName)).toEqual(['Anu Active', 'Chitra Suspended', 'Dev Two-step']);
    expect((await list('role[]=finance&role[]=treasurers')).total).toBe(2);
    expect((await list('role=viewer&status=active')).total).toBe(2);
    const search = (await call('GET', '/api/admin/people?q=chitra')).json() as MemberPage;
    expect(search.items.map((m) => m.userId)).toEqual([ids.chitra]);
    expect(((await call('GET', '/api/admin/people?q=%25')).json() as MemberPage).total).toBe(0);
    expect((await call('GET', '/api/admin/people?status=gone')).statusCode).toBe(422);
  });

  it('sorts and pages', async () => {
    expect((await list('sort=name&dir=desc')).items[0]!.displayName).toBe('Esha Treasurer');
    expect((await list('sort=joined')).items[0]!.displayName).toBe('Esha Treasurer');
    expect((await list('sort=joined&dir=asc')).items[0]!.displayName).toBe('Anu Active');
    expect((await list('sort=status')).items.map((m) => m.status)).toEqual(['active', 'active', 'invited', 'invited', 'suspended']);
    const second = await list('limit=2&offset=2');
    expect(second.items.map((m) => m.displayName)).toEqual(['Chitra Suspended', 'Dev Two-step']);
    expect(second).toMatchObject({ total: 5, limit: 2, offset: 2 });
    expect((await list('limit=2&offset=10')).items).toEqual([]);
    expect((await call('GET', '/api/admin/people?sort=email')).statusCode).toBe(422);
  });
});

describe('directory', () => {
  beforeAll(async () => {
    await person('zara@dir.test', 'Zara Active', ['viewer']);
    await person('yusuf@dir.test', 'Yusuf Active', ['finance']);
    await person('xena@dir.test', 'Xena Invited', ['viewer'], { signIn: false });
    const gone = await person('will@dir.test', 'Will Suspended', ['viewer']);
    await call('POST', `/api/admin/people/${gone}/suspend`);
  });

  it('returns active people only, with no administrator fields', async () => {
    const res = await call('GET', '/api/people?q=dir.test', undefined, reader);
    expect(res.statusCode).toBe(200);
    const page = res.json() as DirectoryPage;
    expect(page.items.map((p) => p.displayName)).toEqual(['Yusuf Active', 'Zara Active']);
    expect(page.total).toBe(2);
    for (const p of page.items) expect(Object.keys(p).sort()).toEqual(['displayName', 'email', 'roles', 'userId']);
    expect(page.items[1]).toMatchObject({ email: 'zara@dir.test', roles: ['viewer'] });
    expect(res.body).not.toMatch(/status|twoStep|invited|joined|signedIn|counts/i);
  });

  it('searches, filters by role, sorts by name and pages', async () => {
    const get = async (q: string) => (await call('GET', `/api/people?q=dir.test&${q}`, undefined, reader)).json() as DirectoryPage;
    expect((await get('role=viewer')).items.map((p) => p.displayName)).toEqual(['Zara Active']);
    expect((await get('sort=name&dir=desc')).items.map((p) => p.displayName)).toEqual(['Zara Active', 'Yusuf Active']);
    expect(await get('limit=1&offset=1')).toMatchObject({ total: 2, limit: 1, offset: 1, items: [{ displayName: 'Zara Active' }] });
    expect(await get('limit=1&offset=5')).toMatchObject({ total: 2, items: [] });
    expect((await call('GET', '/api/people?sort=joined', undefined, reader)).statusCode).toBe(422);
  });
});

describe('role membership', () => {
  it('lists, adds and removes members of a role', async () => {
    const ivy = await person('ivy@role.test', 'Ivy Invited', [], { signIn: false });
    const jai = await person('jai@role.test', 'Jai Active', ['viewer']);
    const kim = await person('kim@role.test', 'Kim Suspended');
    await call('POST', `/api/admin/people/${kim}/suspend`);
    await call('POST', '/api/admin/roles', { key: 'drivers', label: 'Drivers', permissions: [] });

    const added = await call('POST', '/api/admin/roles/drivers/members', { userIds: [ivy, jai, jai] }, rolesAdmin);
    expect(added.statusCode).toBe(200);
    const page = added.json() as MemberPage & { role: { key: string; label: string } };
    expect(page.role).toEqual({ key: 'drivers', label: 'Drivers' });
    expect(page.items.map((m) => m.displayName)).toEqual(['Ivy Invited', 'Jai Active']);
    expect((await memberOf(jai)).roles).toEqual(['drivers', 'viewer']);
    expect((await auditOf('member.roles.changed', jai)).at(-1)).toMatchObject({ actor_id: 'roles-1', before: { roles: ['viewer'] }, after: { roles: ['drivers', 'viewer'] } });
    expect((await call('POST', '/api/admin/roles/drivers/members', { userIds: [jai] }, manager)).statusCode).toBe(200);

    const listed = (await call('GET', '/api/admin/roles/drivers/members', undefined, manager)).json() as MemberPage;
    expect(listed.total).toBe(2);

    const refused = await call('POST', '/api/admin/roles/drivers/members', { userIds: [kim] });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toContain('Kim Suspended');
    expect((await call('POST', '/api/admin/roles/drivers/members', { userIds: ['00000000-0000-0000-0000-000000000000'] })).statusCode).toBe(422);
    expect((await call('POST', '/api/admin/roles/drivers/members', { userIds: [] })).statusCode).toBe(422);
    expect((await call('POST', '/api/admin/roles/nobody/members', { userIds: [jai] })).statusCode).toBe(404);
    expect((await call('GET', '/api/admin/roles/nobody/members')).statusCode).toBe(404);

    expect((await call('DELETE', `/api/admin/roles/drivers/members/${jai}`, undefined, manager)).statusCode).toBe(204);
    expect((await memberOf(jai)).roles).toEqual(['viewer']);
    expect((await auditOf('member.roles.changed', jai)).at(-1)).toMatchObject({ actor_id: 'manager-1', after: { roles: ['viewer'] } });
    expect((await call('DELETE', `/api/admin/roles/drivers/members/${jai}`)).statusCode).toBe(404);
  });

  it('never removes the last person who can manage roles, through either route', async () => {
    const t = w.ngoB;
    await call('POST', '/api/admin/roles', { key: 'owners', label: 'Owners', permissions: ['admin:roles'] }, admin, t);
    const olga = await person('olga@owners.test', 'Olga Owner', ['owners'], { tenant: t });
    const helper = await person('hari@owners.test', 'Hari Helper', [], { tenant: t });

    const viaRole = await call('DELETE', `/api/admin/roles/owners/members/${olga}`, undefined, manager, t);
    expect(viaRole.statusCode).toBe(409);
    expect(viaRole.json().message).toContain('nobody who can manage roles');
    expect((await call('PUT', `/api/admin/people/${olga}/roles`, { roles: [] }, manager, t)).statusCode).toBe(409);
    expect((await call('POST', `/api/admin/people/${olga}/suspend`, undefined, manager, t)).statusCode).toBe(409);
    expect((await memberOf(olga, t))).toMatchObject({ status: 'active', roles: ['owners'] });

    expect((await call('POST', '/api/admin/roles/owners/members', { userIds: [helper] }, ownersManager, t)).statusCode).toBe(200);
    expect((await call('DELETE', `/api/admin/roles/owners/members/${olga}`, undefined, manager, t)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/admin/roles/owners/members/${helper}`, undefined, rolesAdmin, t)).statusCode).toBe(409);
  });
});

describe('permissions', () => {
  it('splits people management, role changes and the directory', async () => {
    const target = await person('perm@example.org', 'Pia Perm', ['viewer']);
    const routes: [Method, string, unknown?][] = [
      ['GET', '/api/admin/people'],
      ['GET', `/api/admin/people/${target}`],
      ['POST', '/api/admin/people', { email: 'perm2@example.org', displayName: 'P2', roles: [] }],
      ['PUT', `/api/admin/people/${target}/roles`, { roles: ['viewer'] }],
      ['POST', `/api/admin/people/${target}/invite`],
      ['POST', `/api/admin/people/${target}/suspend`],
      ['POST', `/api/admin/people/${target}/reactivate`],
      ['GET', '/api/admin/roles/viewer/members'],
      ['POST', '/api/admin/roles/viewer/members', { userIds: [target] }],
      ['DELETE', `/api/admin/roles/finance/members/${target}`],
      ['GET', '/api/people'],
    ];
    const allowed = {
      manager: ['GET /api/admin/people', `GET /api/admin/people/${target}`, 'POST /api/admin/people', `PUT /api/admin/people/${target}/roles`, `POST /api/admin/people/${target}/invite`, `POST /api/admin/people/${target}/suspend`, `POST /api/admin/people/${target}/reactivate`, 'GET /api/admin/roles/viewer/members', 'POST /api/admin/roles/viewer/members', `DELETE /api/admin/roles/finance/members/${target}`],
      rolesAdmin: ['GET /api/admin/people', `GET /api/admin/people/${target}`, `PUT /api/admin/people/${target}/roles`, 'GET /api/admin/roles/viewer/members', 'POST /api/admin/roles/viewer/members', `DELETE /api/admin/roles/finance/members/${target}`],
      reader: ['GET /api/people'],
      clerk: [] as string[],
    };
    for (const [name, actor] of [['clerk', clerk], ['reader', reader], ['rolesAdmin', rolesAdmin], ['manager', manager]] as const) {
      for (const [method, url, body] of routes) {
        const res = await call(method, url, body, actor);
        const forbidden = res.statusCode === 403;
        expect(forbidden, `${name} ${method} ${url} → ${res.statusCode}`).toBe(!allowed[name].includes(`${method} ${url}`));
      }
    }
  });

  it('lists the new permissions in the Setup group of the catalogue', async () => {
    const { entries } = (await call('GET', '/api/admin/permission-catalogue')).json() as { entries: CatalogueEntry[] };
    const setup = Object.fromEntries(entries.filter((e) => e.group === 'setup').map((e) => [e.permission, e.label]));
    expect(setup).toMatchObject({
      'people:read': 'See people',
      'members:manage': 'Manage people',
      'admin:roles': 'Manage roles',
      'admin:audit': 'See the audit log',
      'admin:settings': 'Change organisation settings',
    });
  });

  it('reports each administration area in /api/people/me capabilities', async () => {
    const some = (await call('GET', '/api/people/me', undefined, { id: 'some', roles: [], permissions: ['people:read', 'admin:audit'] })).json();
    expect(some.capabilities).toMatchObject({
      peopleDirectory: true,
      people: false,
      roles: false,
      connectors: false,
      apiKeys: false,
      jobs: false,
      audit: true,
      settings: false,
    });
    const all = (await call('GET', '/api/people/me')).json().capabilities as Record<string, boolean>;
    for (const k of ['peopleDirectory', 'people', 'roles', 'connectors', 'apiKeys', 'jobs', 'audit', 'settings']) expect(all[k], k).toBe(true);
  });
});

describe('audit log', () => {
  const auditor: Actor = { id: 'auditor-1', roles: [], permissions: ['admin:audit'] };
  const get = async (query: string, actor: Actor = auditor) => {
    const res = await call('GET', `/api/admin/audit?${query}`, undefined, actor);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: AuditEntry[]; total: number; limit: number; offset: number };
  };

  it('filters by person, API key, area, record type and date, newest first', async () => {
    const donor = await w.platform.records.create(w.as(w.ngoA, admin), 'donor', { name: 'Audit Donor' });
    const key = await w.platform.apiKeys.create(w.as(w.ngoA), { name: 'Donor sync', role: 'finance' });
    const viaKey = await app.inject({
      method: 'POST',
      url: '/api/records/donor',
      headers: { authorization: `ApiKey ${key.token}` },
      payload: { name: 'From the API' },
    });
    expect(viaKey.statusCode).toBe(201);

    const byManager = await get('person=manager-1');
    expect(byManager.total).toBeGreaterThan(0);
    expect(byManager.items.every((e) => e.actorId === 'manager-1')).toBe(true);
    const times = byManager.items.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const byKey = await get(`person=${encodeURIComponent('api:Donor sync')}`);
    expect(byKey.items).toHaveLength(1);
    expect(byKey.items[0]).toMatchObject({ actorId: 'api:Donor sync', actorName: 'Donor sync', action: 'record.created', area: 'records', recordType: 'donor' });

    const people = await get('area=people&limit=500');
    expect(people.items.length).toBeGreaterThan(0);
    expect(people.items.every((e) => e.entity === 'member' && e.area === 'people')).toBe(true);
    const donors = await get('area=records&recordType=donor');
    expect(donors.items.map((e) => e.entityId)).toContain(donor.record.id);
    expect(donors.items.every((e) => e.recordType === 'donor')).toBe(true);
    expect((await get('recordType=donation')).items.some((e) => e.recordType === 'donor')).toBe(false);

    const named = (await get('area=people')).items.find((e) => e.actorId && /^[0-9a-f-]{36}$/.test(e.actorId));
    if (named) expect(named.actorName).toBeTruthy();

    expect((await get(`from=${today()}&to=${today()}`)).total).toBeGreaterThan(0);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect((await get(`to=${yesterday}`)).total).toBe(0);
    const paged = await get('limit=2&offset=1');
    expect(paged).toMatchObject({ limit: 2, offset: 1 });
    expect(paged.items).toHaveLength(2);
  });

  it('refuses unknown filters and people without admin:audit', async () => {
    expect((await call('GET', '/api/admin/audit?area=everything', undefined, auditor)).statusCode).toBe(422);
    expect((await call('GET', '/api/admin/audit?from=yesterday', undefined, auditor)).statusCode).toBe(422);
    expect((await call('GET', '/api/admin/audit', undefined, manager)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/audit', undefined, clerk)).statusCode).toBe(403);
  });
});

describe('organisation settings', () => {
  const settingsAdmin: Actor = { id: 'settings-1', roles: [], permissions: ['admin:settings'] };

  it('shows and changes the name, language, storage quota and API rate, with an audit entry', async () => {
    const t = w.ngoB;
    const before = (await call('GET', '/api/admin/settings', undefined, settingsAdmin, t)).json() as OrganisationSettings;
    expect(before).toMatchObject({
      name: 'Bodhi Society',
      defaultLanguage: 'en',
      storage: { usedBytes: 0, quotaBytes: 1024 * 1024 * 1024 },
      apiRequestsPerMinute: 120,
    });
    expect(before.languages).toEqual(expect.arrayContaining(['en', 'hi']));

    const res = await call('PUT', '/api/admin/settings', { name: ' Bodhi Foundation ', defaultLanguage: 'hi', storageQuotaBytes: 5_000_000, apiRequestsPerMinute: 60 }, settingsAdmin, t);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Bodhi Foundation', defaultLanguage: 'hi', storage: { quotaBytes: 5_000_000 }, apiRequestsPerMinute: 60 });
    expect((await call('GET', '/api/people/me', undefined, settingsAdmin, t)).json()).toMatchObject({ tenant: { name: 'Bodhi Foundation' }, locale: 'hi' });
    expect(await w.platform.files.usage(w.as(t))).toMatchObject({ quota: 5_000_000 });

    const audit = await w.platform.db.withTenant(t, (tx) =>
      tx.query<{ actor_id: string; before: unknown; after: unknown }>(`select actor_id, before, after from audit_event where action = 'settings.changed'`),
    );
    expect(audit).toEqual([
      {
        actor_id: 'settings-1',
        before: { name: 'Bodhi Society', defaultLanguage: 'en', storageQuotaBytes: 1024 * 1024 * 1024, apiRequestsPerMinute: 120 },
        after: { name: 'Bodhi Foundation', defaultLanguage: 'hi', storageQuotaBytes: 5_000_000, apiRequestsPerMinute: 60 },
      },
    ]);

    expect((await call('PUT', '/api/admin/settings', { apiRequestsPerMinute: 60 }, settingsAdmin, t)).statusCode).toBe(200);
    expect((await call('PUT', '/api/admin/settings', { apiRequestsPerMinute: 90 }, settingsAdmin, t)).json().apiRequestsPerMinute).toBe(90);
    const changes = await w.platform.db.withTenant(t, (tx) => tx.query<{ after: unknown }>(`select after from audit_event where action = 'settings.changed' order by id`));
    expect(changes.map((c) => c.after)).toEqual([expect.anything(), { apiRequestsPerMinute: 90 }]);
  });

  it('validates every setting and needs admin:settings', async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ name: '  ' }, 'name'],
      [{ name: 'x'.repeat(121) }, 'name'],
      [{ defaultLanguage: 'xx' }, 'defaultLanguage'],
      [{ defaultLanguage: 'english' }, 'defaultLanguage'],
      [{ storageQuotaBytes: -1 }, 'storageQuotaBytes'],
      [{ apiRequestsPerMinute: 0 }, 'apiRequestsPerMinute'],
      [{ apiRequestsPerMinute: 1_000_000 }, 'apiRequestsPerMinute'],
    ];
    for (const [body, path] of bad) {
      const res = await call('PUT', '/api/admin/settings', body, settingsAdmin);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json().issues[0].path).toBe(path);
    }
    for (const body of [{ storageQuotaBytes: 1.5 }, { storageQuotaBytes: '100' }]) {
      const res = await call('PUT', '/api/admin/settings', body, settingsAdmin);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().issues[0].path).toBe('/storageQuotaBytes');
    }
    expect(((await call('GET', '/api/admin/settings', undefined, settingsAdmin)).json() as OrganisationSettings).name).toBe('Asha Trust');
    expect((await call('GET', '/api/admin/settings', undefined, clerk)).statusCode).toBe(403);
    expect((await call('PUT', '/api/admin/settings', { name: 'Taken over' }, manager)).statusCode).toBe(403);
  });

  it('publishes the organisation theme and layout, and refuses a layout without Home', async () => {
    expect((await call('PUT', '/api/admin/theme', { key: 'organisation', brand: '#0e7c66' }, clerk)).statusCode).toBe(403);
    const theme = await call('PUT', '/api/admin/theme', { key: 'organisation', brand: '#0e7c66', radius: '8px' }, settingsAdmin);
    expect(theme.statusCode, theme.body).toBe(200);
    expect(theme.json()).toMatchObject({ key: 'organisation', brand: '#0e7c66', radius: '8px' });

    expect((await call('GET', '/api/admin/layout', undefined, settingsAdmin)).json()).toMatchObject({ items: null, listLayout: 'table' });
    expect((await call('PUT', '/api/admin/layout', { items: ['records'], listLayout: 'cards' }, settingsAdmin)).statusCode).toBe(422);
    expect((await call('PUT', '/api/admin/layout', { items: ['home', 'records'], more: ['settings'], listLayout: 'cards' }, settingsAdmin)).statusCode).toBe(422);
    expect((await call('PUT', '/api/admin/layout', { primary: ['home', 'records'], listLayout: 'cards' }, settingsAdmin)).statusCode).toBe(422);
    const layout = await call('PUT', '/api/admin/layout', { items: ['home', 'records', 'settings'], listLayout: 'cards' }, settingsAdmin);
    expect(layout.statusCode, layout.body).toBe(200);

    const defs = (await call('GET', '/api/runtime/definitions', undefined, settingsAdmin)).json() as {
      theme: { brand: string; radius: string };
      navigation: { items: string[] };
      listLayout: string;
      pages: { placement?: string }[];
    };
    expect(defs.theme).toMatchObject({ brand: '#0e7c66', radius: '8px' });
    expect(defs.navigation).toEqual({ items: ['home', 'records', 'settings'] });
    expect(defs.navigation).not.toHaveProperty('more');
    expect(defs.listLayout).toBe('cards');
    expect(defs.pages.every((page) => !('placement' in page))).toBe(true);

    const custom = await call(
      'PUT',
      '/api/admin/layout',
      { items: ['home', 'inbox', 'record:donation'], listLayout: 'table', icons: { inbox: 'bell', 'record:donation': 'search' } },
      settingsAdmin,
    );
    expect(custom.statusCode, custom.body).toBe(200);
    const again = (await call('GET', '/api/runtime/definitions', undefined, settingsAdmin)).json() as {
      navigation: { items: string[]; icons?: Record<string, string> };
    };
    expect(again.navigation).toEqual({
      items: ['home', 'inbox', 'record:donation'],
      icons: { inbox: 'bell', 'record:donation': 'search' },
    });
    expect((await call('PUT', '/api/admin/layout', { items: ['home'], listLayout: 'table', icons: { home: 'nope' } }, settingsAdmin)).statusCode).toBe(422);
  });
});

describe('background jobs for administrators', () => {
  it("lists everyone's jobs with filters and paging, for admin:jobs only", async () => {
    const jobsAdmin: Actor = { id: 'jobs-1', roles: [], permissions: ['admin:jobs'] };
    const mine = await w.platform.jobs.create(w.as(w.ngoA, clerk), 'files.cleanup', {});
    const theirs = await w.platform.jobs.create(w.as(w.ngoA, manager), 'index.build', {});
    await w.platform.jobs.cancel(w.as(w.ngoA, manager), theirs.id);
    type Page = { items: { id: string; kind: string; label: string; status: string; createdBy: string; progress: number }[]; total: number };
    const get = async (query: string) => {
      const res = await call('GET', `/api/admin/jobs?${query}`, undefined, jobsAdmin);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Page;
    };

    const byClerk = await get('startedBy=clerk-1');
    expect(byClerk.items).toEqual([expect.objectContaining({ id: mine.id, kind: 'files.cleanup', label: 'File clean-up', status: 'queued', progress: 0 })]);
    expect(byClerk.total).toBe(1);
    expect((await get('startedBy=manager-1&kind=index.build')).items.map((j) => j.id)).toEqual([theirs.id]);
    expect((await get('startedBy=manager-1&kind=files.cleanup')).total).toBe(0);
    expect((await get('startedBy=manager-1&status=cancelled')).items.map((j) => j.status)).toEqual(['cancelled']);
    expect((await get(`startedBy=clerk-1&from=${today()}&to=${today()}`)).total).toBe(1);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect((await get(`to=${yesterday}`)).total).toBe(0);
    const all = await get('limit=1');
    expect(all.items).toHaveLength(1);
    expect(all.total).toBeGreaterThanOrEqual(2);

    expect((await call('GET', '/api/admin/jobs?status=stuck', undefined, jobsAdmin)).statusCode).toBe(422);
    expect((await call('GET', '/api/admin/jobs', undefined, clerk)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/jobs', undefined, manager)).statusCode).toBe(403);
  });
});
