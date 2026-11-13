import { expect, test, type APIRequestContext, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { keyApi } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import { expectDestination } from '../../../src/shell.js';
import {
  KEY_ROLE,
  P,
  T,
  addPerson,
  apiAs,
  code,
  createRecord,
  createRole,
  ensureKeyRole,
  memberById,
  names,
  newContext,
  nextRequest,
  ok,
  openWorld,
  perm,
  publishRole,
  query,
  records,
  recordButton,
  refused,
  signInAs,
  subjectAccount,
  type RecordView,
  type World,
} from '../../../src/journeys/rbac.js';

const baseline = [perm.read, perm.create, perm.update, perm.import, perm.export, perm.bulk, perm.finish];

test.describe.serial('Role matrix 3: the same member’s next request follows the new permission', () => {
  test.describe.configure({ timeout: 300_000 });

  let world: World;
  let item: RecordView;
  let builderRole = { key: '', label: '' };
  let adminContext: BrowserContext;
  let adminPage: Page;
  let keyId = '';

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(180_000);
    world = await openWorld(browser, info, { permissions: baseline });
    builderRole = { key: `${world.tag}-builder`, label: `E2E RBAC builder ${world.tag}` };
    await createRole(world.admin, builderRole.key, builderRole.label, ['config:read']);
    world.created.push(builderRole.key);
    item = await createRecord(world.admin, T, { name: `Next ${world.tag}`, secret: `S-${world.tag}`, score: 5 });
    adminContext = await newContext(browser, info);
    adminPage = await adminContext.newPage();
    await signInAs(adminPage, accounts.admin.email, accounts.admin.name);
  });

  test.afterAll(async () => {
    if (world && keyId) await world.admin.delete(`/api/admin/api-keys/${keyId}`).catch(() => undefined);
    if (world) await publishRole(world.admin, KEY_ROLE, { permissions: [] }).catch(() => undefined);
    await adminContext?.close();
    await world?.close();
  });

  const builderStatus = async (api: APIRequestContext) => (await api.get('/api/builder/catalogue')).status();

  async function expectBuilder(visible: boolean): Promise<void> {
    await expect.poll(() => builderStatus(world.api), { timeout: 10_000 }).toBe(visible ? 200 : 403);
    await nextRequest(world.page, '/');
    await expectDestination(world.page, label('ui.builder.title'), visible);
  }

  test('FT-ADM-026 changing roles in the person panel applies on the member’s next request', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    await expectBuilder(false);
    await nextRequest(adminPage, '/admin/people');
    await adminPage.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(subjectAccount.name);
    await adminPage.getByText(subjectAccount.name).first().click();
    const panel = adminPage.getByRole('dialog');
    await expect(panel.getByRole('button', { name: label('ui.people.saveRoles'), exact: true })).toHaveCount(0);
    await panel.getByRole('combobox').fill(builderRole.label);
    await adminPage.getByRole('option', { name: builderRole.label, exact: true }).click();
    await panel.getByRole('button', { name: label('ui.people.saveRoles'), exact: true }).click();
    await expect(adminPage.getByText(label('ui.people.rolesSaved', { name: subjectAccount.name }))).toBeVisible();
    await expectBuilder(true);

    await panel.getByRole('button', { name: `${label('ui.common.remove')} ${builderRole.label}` }).click();
    await panel.getByRole('button', { name: label('ui.people.saveRoles'), exact: true }).click();
    await expect(adminPage.getByText(label('ui.people.rolesSaved', { name: subjectAccount.name }))).toBeVisible();
    await expectBuilder(false);
  });

  test('FT-AUTH-107 a role removed while signed in is gone on the next request, within 5 seconds', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, subjectId } = world;
    await ok(await admin.post(`/api/admin/roles/${builderRole.key}/members`, { data: { userIds: [subjectId] } }), 'give the role');
    await expectBuilder(true);
    await ok(await admin.delete(`/api/admin/roles/${builderRole.key}/members/${subjectId}`), 'take the role away');
    const removed = Date.now();
    await expect.poll(() => builderStatus(world.api), { timeout: 10_000, intervals: [250, 500, 1000] }).toBe(403);
    expect(Date.now() - removed).toBeLessThan(5_000 + 1_000);
    await nextRequest(world.page, '/');
    await expectDestination(world.page, label('ui.builder.title'), false);
  });

  test('FT-ADM-027 adding, removing and suspending apply to every selected person', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, subjectId, directoryId, tag } = world;
    const directory = await apiAs(accounts.directory.email);
    try {
      const added = await ok(await admin.post(`/api/admin/roles/${builderRole.key}/members`, { data: { userIds: [subjectId, directoryId] } }), 'add the role to two people');
      expect(added.total).toBe(2);
      await expect.poll(() => builderStatus(world.api), { timeout: 10_000 }).toBe(200);
      await expect.poll(() => builderStatus(directory), { timeout: 10_000 }).toBe(200);
      for (const id of [subjectId, directoryId]) await ok(await admin.delete(`/api/admin/roles/${builderRole.key}/members/${id}`), 'remove the role');
      await expect.poll(() => builderStatus(world.api), { timeout: 10_000 }).toBe(403);
      await expect.poll(() => builderStatus(directory), { timeout: 10_000 }).toBe(403);

      const people = [await addPerson(admin, tag, 'bulk-a'), await addPerson(admin, tag, 'bulk-b')];
      for (const p of people) await ok(await admin.post(`/api/admin/people/${p.userId}/suspend`), `suspend ${p.email}`);
      for (const p of people) expect((await memberById(admin, p.userId)).status).toBe('suspended');
    } finally {
      for (const id of [subjectId, directoryId]) await admin.delete(`/api/admin/roles/${builderRole.key}/members/${id}`);
      await directory.dispose();
    }
  });

  test('FT-REC-186 an import refuses each bad row with the same checks as the screen, and the edit permission decides one of them', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { admin, api, allow, tag } = world;
    const taken = code();
    await createRecord(admin, T, { name: `Taken ${tag}`, code: taken });
    const csv = [
      `Name,Code,${names.locked}`,
      `Good ${tag},${code()},`,
      `,${code()},`,
      `Bad pattern ${tag},abc,`,
      `Duplicate ${tag},${taken},`,
      `Locked ${tag},,x`,
    ].join('\n');
    const check = async () => {
      const upload = await ok(
        await api.post(`/api/records/${T}/imports`, { data: Buffer.from(`${csv}\n`), headers: { 'content-type': 'text/csv', 'x-file-name': `rbac-${tag}.csv` } }),
        'upload the import',
      );
      await ok(await api.put(`/api/imports/${upload.id}/mapping`, { data: {} }), 'map the import');
      return (await ok(await api.post(`/api/imports/${upload.id}/check`), 'check the import')) as { valid: number; invalid: number; problems: { message: string }[] };
    };

    await allow(baseline);
    const without = await check();
    expect(without.valid).toBe(1);
    expect(without.invalid).toBe(4);
    const messages = JSON.stringify(without.problems);
    expect(messages).toContain(`you may not change '${names.locked}'`);
    expect(messages).toContain('Use three capitals and three digits.');

    await allow([...baseline, P.lock]);
    const withLock = await check();
    expect(withLock.valid).toBe(2);
    expect(withLock.invalid).toBe(3);
    expect(JSON.stringify(withLock.problems)).not.toContain(`you may not change '${names.locked}'`);
    await allow(baseline);
  });

  test('FT-REC-202 an export masks what the person may not see, and shows it once they may', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { api, allow, tag } = world;
    await allow(baseline);
    const res = await api.get(`/api/records/${T}/export.csv`);
    expect(res.status(), 'export').toBe(200);
    const masked = await res.text();
    expect(masked).toContain(`Next ${tag}`);
    expect(masked).not.toContain(`S-${tag}`);
    expect(masked).toContain('***');

    await allow([...baseline, P.secret]);
    await expect.poll(async () => (await api.get(`/api/records/${T}/export.csv`)).text(), { timeout: 10_000 }).toContain(`S-${tag}`);
    await allow(baseline);
  });

  test('FT-REC-204 export is absent and refused without its permission, and a bad query is refused', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow } = world;
    const exportItem = async () => {
      await nextRequest(page, `/records/${T}`);
      await page.locator('.list-filter-toolbar').getByRole('button', { name: label('ui.common.moreActions'), exact: true }).click();
      const entry = page.getByRole('menuitem', { name: label('ui.imports.export'), exact: true });
      return entry;
    };

    await allow(baseline.filter((p) => p !== perm.export));
    await expect(await exportItem()).toHaveCount(0);
    await page.keyboard.press('Escape');
    await refused(await api.get(`/api/records/${T}/export.csv`), 'export without export permission');

    await allow(baseline);
    await expect(await exportItem()).toBeVisible();
    await page.keyboard.press('Escape');
    const bad = await refused(await api.get(`/api/records/${T}/export.csv?q=not-json!`), 'export with a query that is not base64url JSON', [422]);
    expect(bad.code).toBe('validation_failed');
  });

  test('FT-REC-229 a bulk edit that includes a record the person cannot change fails that record and does the others', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, api, allow, tag } = world;
    await allow(baseline);
    const open = await createRecord(admin, T, { name: `Bulk open ${tag}` });
    const closed = await createRecord(admin, T, { name: `Bulk closed ${tag}` });
    await ok(await admin.post(`/api/records/${T}/${closed.id}/transitions/finish`, { data: { expectedVersion: closed.version } }), 'finish one');
    const out = await ok(await api.post(`/api/records/${T}/bulk`, { data: { ids: [open.id, closed.id], operation: { type: 'edit', values: { note: `bulk ${tag}` } } } }), 'bulk edit');
    expect(out.done).toBe(1);
    expect(out.failed).toBe(1);
    const results = out.results as { id: string; ok: boolean }[];
    expect(results.find((r) => r.id === open.id)?.ok).toBe(true);
    expect(results.find((r) => r.id === closed.id)?.ok).toBe(false);
  });

  test('FT-FIN-047 money endpoints follow the money permission', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { api, allow } = world;
    await allow(baseline);
    await refused(await api.get('/api/money/accounts'), 'money accounts without money:accounts:read');
    await allow([...baseline, 'money:accounts:read']);
    await expect.poll(async () => (await api.get('/api/money/accounts')).status(), { timeout: 10_000 }).toBe(200);
    await allow(baseline);
    await expect.poll(async () => (await api.get('/api/money/accounts')).status(), { timeout: 10_000 }).toBe(403);
  });

  test('FT-FIN-067 payments:create without the action permission cannot create a payment', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, api, allow } = world;
    const raised = (await query(admin, 'donation', { statusIn: ['raised'], limit: 1 })).items[0];
    test.skip(!raised, 'No Raised donation is loaded.');
    await allow([...baseline, 'payments:create', 'record:donation:read']);
    await refused(await api.post('/api/payments', { data: { recordId: raised!.id, action: 'payNow' } }), 'a payment without record:donation:action:payNow');
    await allow(baseline);
  });

  test('FT-SEC-009 every write as a read-only member is refused by direct API call', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow, tag } = world;
    await allow([perm.read]);
    await nextRequest(page, `/records/${T}?id=${item.id}`);
    await expect(page.getByText(`Next ${tag}`).first()).toBeVisible();
    await expect(records.newButton(page, names.type)).toHaveCount(0);
    await expect(recordButton(page, label('ui.common.edit'))).toHaveCount(0);
    await expect(recordButton(page, names.finish)).toHaveCount(0);

    const writes: [string, () => Promise<APIResponse>][] = [
      ['create', () => api.post(`/api/records/${T}`, { data: { name: `Refused ${tag}` } })],
      ['update', () => api.patch(`/api/records/${T}/${item.id}`, { data: { data: { note: 'x' }, expectedVersion: item.version } })],
      ['step', () => api.post(`/api/records/${T}/${item.id}/transitions/finish`, { data: { expectedVersion: item.version } })],
      ['action', () => api.post(`/api/records/${T}/${item.id}/actions/e2eStamp`, { data: {} })],
      ['bulk', () => api.post(`/api/records/${T}/bulk`, { data: { ids: [item.id], operation: { type: 'edit', values: { note: 'x' } } } })],
      ['import', () => api.post(`/api/records/${T}/imports`, { data: Buffer.from('Name\nx\n'), headers: { 'content-type': 'text/csv', 'x-file-name': 'refused.csv' } })],
      ['export', () => api.get(`/api/records/${T}/export.csv`)],
      ['share', () => api.post(`/api/records/${T}/${item.id}/shares`, { data: { principalKind: 'role', principal: 'viewer', access: 'read' } })],
      ['role', () => api.put(`/api/admin/roles/${world.role.key}`, { data: { permissions: ['*'] } })],
      ['person', () => api.post('/api/admin/people', { data: { email: `${tag}-refused@riverbank.example`, displayName: 'Refused', roles: [] } })],
      ['definition', () => api.post(`/api/builder/definitions/recordType/${T}/publish`)],
    ];
    for (const [what, call] of writes) await refused(await call(), `${what} as a read-only member`);
  });

  test('FT-ADM-081 an API key acts with its role’s permissions as they are now, masked where the role may not see', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { admin, tag } = world;
    await ensureKeyRole(admin);
    await publishRole(admin, KEY_ROLE, { permissions: [perm.read] });
    const name = `e2e rbac ${tag}`;
    const created = await ok(await admin.post('/api/admin/api-keys', { data: { name, role: KEY_ROLE } }), 'create a key');
    keyId = String(created.id);
    const token = String(created.token);
    const dot = token.indexOf('.');
    const key = await keyApi(token.slice(0, dot), token.slice(dot + 1));
    try {
      const secretOf = async () => {
        const found = (await ok(await key.post(`/api/records/${T}/query`, { data: { search: `Next ${tag}` } }), 'query with the key')) as { items: RecordView[] };
        return found.items.find((r) => r.id === item.id)?.data['secret'];
      };
      expect(await secretOf()).toBe('***');
      const keys = (await ok(await admin.get('/api/admin/api-keys'), 'keys')) as { id: string; lastUsedAt: string | null }[];
      expect(keys.find((k) => k.id === keyId)?.lastUsedAt).toBeTruthy();
      await refused(await key.post(`/api/records/${T}`, { data: { name: 'Key refused' } }), 'a write the key role does not allow');

      await publishRole(admin, KEY_ROLE, { permissions: [perm.read, P.secret] });
      await expect.poll(secretOf, { timeout: 10_000 }).toBe(`S-${tag}`);
      await publishRole(admin, KEY_ROLE, { permissions: [perm.read] });
      await expect.poll(secretOf, { timeout: 10_000 }).toBe('***');
    } finally {
      await key.dispose();
    }
  });
});
