import { expect, request as playwrightRequest, test, type BrowserContext, type Page } from '@playwright/test';
import { accounts, apiBase, org, password } from '../../../src/accounts.js';
import { label } from '../../../src/catalogue.js';
import { signOut } from '../../../src/shell.js';
import {
  KEY_ROLE,
  T,
  addPerson,
  apiAs,
  createRole,
  ensureKeyRole,
  memberById,
  newContext,
  nextRequest,
  ok,
  openWorld,
  paceAuth,
  perm,
  publishRole,
  refused,
  setMemberRoles,
  signInAs,
  subjectAccount,
  tryLogin,
  type World,
} from '../../../src/journeys/rbac.js';

const TWO_STEP_REFUSAL = 'Your role requires two-step sign-in. Ask an administrator to help you set it up.';

test.describe.serial('Role matrix 4: a person cannot widen their own access', () => {
  test.describe.configure({ timeout: 300_000 });

  let world: World;
  let twoStep = { key: '', label: '' };
  let adminContext: BrowserContext;
  let adminPage: Page;

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(180_000);
    world = await openWorld(browser, info, { permissions: ['members:manage'] });
    twoStep = { key: `${world.tag}-2fa`, label: `E2E RBAC two-step ${world.tag}` };
    await createRole(world.admin, twoStep.key, twoStep.label, [perm.read]);
    world.created.push(twoStep.key);
    adminContext = await newContext(browser, info);
    adminPage = await adminContext.newPage();
    await signInAs(adminPage, accounts.admin.email, accounts.admin.name);
  });

  test.afterAll(async () => {
    if (world) {
      await world.admin.post(`/api/admin/people/${world.subjectId}/reactivate`).catch(() => undefined);
      await publishRole(world.admin, twoStep.key, { requireTwoStep: false }).catch(() => undefined);
    }
    await adminContext?.close();
    await world?.close();
  });

  const rolesOf = async (userId: string) => (await memberById(world.admin, userId)).roles.slice().sort();

  test('FT-ADM-034 managing people does not let someone give themselves, or anyone, a role wider than their own', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { api, allow, subjectId, directoryId, role } = world;
    await allow(['members:manage']);
    const mine = await rolesOf(subjectId);
    const theirs = await rolesOf(directoryId);

    const self = await refused(await api.put(`/api/admin/people/${subjectId}/roles`, { data: { roles: [...mine, 'admin'] } }), 'give myself admin');
    expect(self.message).toContain('You cannot give');
    const other = await refused(await api.put(`/api/admin/people/${directoryId}/roles`, { data: { roles: [...theirs, 'admin'] } }), 'give someone admin');
    expect(other.message).toBe("You cannot give the role 'Administrator': it allows more than you may do yourself.");
    await refused(await api.post('/api/admin/roles/admin/members', { data: { userIds: [directoryId] } }), 'add someone to admin');
    await refused(await api.put(`/api/admin/roles/${role.key}`, { data: { permissions: ['members:manage', '*'] } }), 'widen my own role');

    expect(await rolesOf(subjectId)).toEqual(mine);
    expect(await rolesOf(directoryId)).toEqual(theirs);
    await refused(await api.get('/api/builder/catalogue'), 'the Builder after the refused changes');
  });

  test('FT-ADM-084 a key cannot be bound to a role wider than its creator', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { api, allow, tag } = world;
    await allow(['admin:api-keys']);
    const body = await refused(await api.post('/api/admin/api-keys', { data: { name: `e2e rbac wide ${tag}`, role: 'admin' } }), 'a key bound to admin');
    expect(body.message).toBe("You cannot give the role 'Administrator': it allows more than you may do yourself.");
    const keys = (await ok(await world.admin.get('/api/admin/api-keys'), 'keys')) as { name: string }[];
    expect(keys.map((k) => k.name)).not.toContain(`e2e rbac wide ${tag}`);
    await allow(['members:manage']);
  });

  test('FT-SEC-008 hidden fields in a request are refused, and the organisation comes from the signed-in identity', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { api, allow, tag, subjectId } = world;
    await allow([perm.read, perm.create]);
    const hidden = await refused(await api.post(`/api/records/${T}`, { data: { name: `Hidden ${tag}`, createdBy: subjectId, tenant: 'harbour', owner_id: subjectId } }), 'create with hidden fields', [400, 422]);
    expect(JSON.stringify(hidden.issues)).toContain('is not a field of this record type');
    await refused(await api.post('/api/admin/roles', { data: { key: `${tag}-mine`, label: 'Mine', permissions: ['*'] } }), 'create a role for myself');
    const mine = await rolesOf(subjectId);
    const extra = await api.put(`/api/admin/people/${subjectId}/roles`, { data: { roles: mine, tenant: 'harbour' } });
    expect([400, 403], 'a role change naming another organisation').toContain(extra.status());
    expect(await rolesOf(subjectId)).toEqual(mine);
    const me = await ok(await api.get('/api/people/me'), 'who I am');
    expect(JSON.stringify(me)).toContain(org);
    await allow(['members:manage']);
  });

  test('FT-ADM-052 removing the last person who can manage roles is refused', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    test.skip(true, 'Riverbank has several people who manage roles (Asha through admin, the Roles Administrator). Making one of them the last would change seeded people that other journeys sign in as.');
  });

  test('FT-ADM-031 a suspended person cannot be invited or given a role', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { api, allow, tag, role } = world;
    await allow(['members:manage']);
    const person = await addPerson(api, tag, 'suspended');
    await ok(await api.post(`/api/admin/people/${person.userId}/suspend`), 'suspend');
    const invite = await refused(await api.post(`/api/admin/people/${person.userId}/invite`), 'invite a suspended person', [409]);
    expect(invite.message).toContain('is suspended. Reactivate them before sending an invitation.');
    const give = await refused(await api.post(`/api/admin/roles/${role.key}/members`, { data: { userIds: [person.userId] } }), 'give a suspended person a role', [422]);
    expect(give.message).toContain('Suspended people cannot be given a role');
  });

  test('FT-ADM-033 a role that requires two-step shows Required · not set for someone without an authenticator', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, subjectId } = world;
    const before = await rolesOf(subjectId);
    try {
      await setMemberRoles(admin, subjectId, [...before, twoStep.key]);
      await publishRole(admin, twoStep.key, { requireTwoStep: true });
      expect((await memberById(admin, subjectId)).twoStep).toBe('required-not-set');
      await nextRequest(adminPage, '/admin/people');
      await adminPage.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(subjectAccount.name);
      await expect(adminPage.getByText(label('ui.people.twoStepRequired')).first()).toBeVisible();

      await publishRole(admin, twoStep.key, { requireTwoStep: false });
      expect((await memberById(admin, subjectId)).twoStep).not.toBe('required-not-set');
    } finally {
      await publishRole(admin, twoStep.key, { requireTwoStep: false });
      await setMemberRoles(admin, subjectId, before);
    }
  });

  test('FT-ADM-054 role keys, names and permission counts are checked', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, tag } = world;
    for (const key of ['Finance', '1abc', `a${'b'.repeat(41)}`]) {
      const body = await refused(await admin.post('/api/admin/roles', { data: { key, label: 'Bad key', permissions: [] } }), `role key ${key}`, [422]);
      expect(body.message).toContain('Role key must start with a lowercase letter');
    }
    const longName = await refused(await admin.post('/api/admin/roles', { data: { key: `${tag}-long`, label: 'x'.repeat(81), permissions: [] } }), 'an 81-character name', [422]);
    expect(longName.message).toBe('Give the role a name of at most 80 characters.');
    const many = Array.from({ length: 501 }, (_, i) => `e2e-rbac:p${i}`);
    const tooMany = await refused(await admin.post('/api/admin/roles', { data: { key: `${tag}-many`, label: 'Too many', permissions: many } }), '501 permissions', [422]);
    expect(tooMany.message).toBe('Send the permissions as a list of at most 500.');
  });

  test('FT-ADM-055 a role with members, or used by an API key, cannot be deleted', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, role, tag } = world;
    const withMembers = await refused(await admin.delete(`/api/admin/roles/${role.key}`), 'delete a role with a member', [409]);
    expect(withMembers.message).toBe(`'${role.label}' still has 1 member. Move them to another role first.`);

    await ensureKeyRole(admin);
    const key = await ok(await admin.post('/api/admin/api-keys', { data: { name: `e2e rbac keyed ${tag}`, role: KEY_ROLE } }), 'a key on the key role');
    try {
      const used = await refused(await admin.delete(`/api/admin/roles/${KEY_ROLE}`), 'delete a role used by a key', [409]);
      expect(used.message).toBe("'E2E RBAC API key role' is used by API keys, so it cannot be deleted.");
    } finally {
      await admin.delete(`/api/admin/api-keys/${key.id}`);
    }
  });

  test('FT-ADM-056 adding people to a role that requires two-step shows the two-step note', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin } = world;
    try {
      await publishRole(admin, twoStep.key, { requireTwoStep: true });
      await nextRequest(adminPage, `/admin/roles/${twoStep.key}`);
      await adminPage.getByRole('button', { name: label('ui.crumbs.addPeople'), exact: true }).click();
      const sheet = adminPage.getByRole('dialog').filter({ hasText: label('ui.admin.roles.addTitle', { role: twoStep.label }) });
      await expect(sheet).toBeVisible();
      await sheet.getByRole('combobox').fill(accounts.directory.name);
      await adminPage.getByRole('option', { name: new RegExp(accounts.directory.name) }).first().click();
      await expect(sheet.getByText(label('ui.admin.roles.twoStepNote', { role: twoStep.label }))).toBeVisible();
      await adminPage.keyboard.press('Escape');
    } finally {
      await publishRole(admin, twoStep.key, { requireTwoStep: false });
    }
  });

  test('FT-AUTH-028 a suspended member cannot sign in, and can again once reactivated', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, subjectId } = world;
    try {
      await ok(await admin.post(`/api/admin/people/${subjectId}/suspend`), 'suspend the member');
      expect([401, 403], 'sign-in while suspended').toContain((await tryLogin(subjectAccount.email)).status());
    } finally {
      await ok(await admin.post(`/api/admin/people/${subjectId}/reactivate`), 'reactivate the member');
    }
    expect((await tryLogin(subjectAccount.email)).status(), 'sign-in after reactivation').toBe(200);
  });

  test('FT-AUTH-088 a role that requires two-step refuses sign-in without an authenticator, and stops once the role no longer requires it', { tag: ['@e2e', '@rbac', '@P0'] }, async ({ browser }, info) => {
    const { admin, subjectId } = world;
    const before = await rolesOf(subjectId);
    const context = await newContext(browser, info);
    try {
      await setMemberRoles(admin, subjectId, [...before, twoStep.key]);
      await publishRole(admin, twoStep.key, { requireTwoStep: true });
      const res = await tryLogin(subjectAccount.email);
      expect(res.status()).toBe(403);
      expect((await res.json()).message).toBe(TWO_STEP_REFUSAL);

      const visitor = await context.newPage();
      await paceAuth(3);
      await visitor.goto(`/o/${org}/sign-in`);
      await visitor.getByRole('tab', { name: label('ui.auth.tabPassword') }).click();
      await visitor.getByLabel(label('ui.auth.email')).fill(subjectAccount.email);
      await visitor.getByLabel(label('ui.auth.password')).fill(password);
      await visitor.getByRole('button', { name: label('ui.auth.signIn'), exact: true }).click();
      await expect(visitor.getByText(TWO_STEP_REFUSAL)).toBeVisible();
      await expect(visitor.getByRole('img', { name: /QR/i })).toHaveCount(0);

      await publishRole(admin, twoStep.key, { requireTwoStep: false });
      expect((await tryLogin(subjectAccount.email)).status(), 'sign-in once the role no longer requires two-step').toBe(200);
    } finally {
      await publishRole(admin, twoStep.key, { requireTwoStep: false });
      await setMemberRoles(admin, subjectId, before);
      await context.close();
    }
  });

  test('FT-AUTH-103 an access token stops working after sign-out and after suspension', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { admin, page, subjectId } = world;
    let bearer = '';
    page.on('request', (r) => {
      const h = r.headers()['authorization'];
      if (h?.startsWith('Bearer ')) bearer = h;
    });
    await signInAs(page, subjectAccount.email, subjectAccount.name);
    await nextRequest(page, '/');
    expect(bearer, 'the app sent a bearer token').not.toBe('');
    const held = await playwrightRequest.newContext({ baseURL: apiBase, extraHTTPHeaders: { authorization: bearer } });
    try {
      await ok(await held.get('/api/people/me'), 'the token while signed in');
      await signOut(page);
      await expect.poll(async () => (await held.get('/api/people/me')).status(), { timeout: 10_000 }).not.toBe(200);
      expect([401, 403]).toContain((await held.get('/api/people/me')).status());
    } finally {
      await held.dispose();
    }

    const api = await apiAs(subjectAccount.email);
    try {
      await ok(await api.get('/api/people/me'), 'a fresh token');
      await ok(await admin.post(`/api/admin/people/${subjectId}/suspend`), 'suspend the member');
      await expect.poll(async () => (await api.get('/api/people/me')).status(), { timeout: 10_000 }).not.toBe(200);
      expect([401, 403]).toContain((await api.get('/api/people/me')).status());
    } finally {
      await ok(await admin.post(`/api/admin/people/${subjectId}/reactivate`), 'reactivate the member');
      await api.dispose();
    }
  });
});
