import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { label } from '../../../src/catalogue.js';
import { expectDestination, knownDefect } from '../../../src/shell.js';
import {
  P,
  S,
  T,
  accessRow,
  actionBody,
  apiAs,
  createRecord,
  createRole,
  gridRow,
  newContext,
  names,
  nextRequest,
  ok,
  openWorld,
  perm,
  publishDefinition,
  publishRole,
  recordButton,
  recordTypeBody,
  records,
  refused,
  rolePermissions,
  runtime,
  runtimeAction,
  runtimeType,
  signInAs,
  type RecordView,
  type World,
} from '../../../src/journeys/rbac.js';

/** The destination (Builder), the field (Secret note) and the action (Stamp item) this file switches. */
const baseline = [perm.read, P.secret, perm.stamp, 'config:read'];
const fieldRow = `${names.secret} (${names.type})`;
const actionRow = `Action ${names.stamp} (${names.types})`;

test.describe.serial('Role matrix 2: the organisation changes the permission and publishes', () => {
  test.describe.configure({ timeout: 300_000 });

  let world: World;
  let item: RecordView;
  let adminContext: BrowserContext;
  let adminPage: Page;
  let viewerBefore: string[] | undefined;

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(180_000);
    world = await openWorld(browser, info, { permissions: baseline });
    item = await createRecord(world.admin, T, { name: `Publish ${world.tag}`, secret: `S-${world.tag}`, score: 3 });
    viewerBefore = (await rolePermissions(world.admin, 'viewer')).permissions;
    adminContext = await newContext(browser, info);
    adminPage = await adminContext.newPage();
    await signInAs(adminPage, accounts.admin.email, accounts.admin.name);
  });

  test.afterAll(async () => {
    if (world) {
      if (viewerBefore) await publishRole(world.admin, 'viewer', { permissions: viewerBefore }).catch((e) => console.warn('Viewer role not restored', e));
      await publishDefinition(world.admin, 'recordType', recordTypeBody()).catch((e) => console.warn('record type not restored', e));
      await publishDefinition(world.admin, 'action', actionBody()).catch((e) => console.warn('action not restored', e));
    }
    await adminContext?.close();
    await world?.close();
  });

  /** What the subject sees of the field and the action, on their next request, on screen and by API. */
  async function expectFieldAndAction(visible: boolean): Promise<void> {
    const { page, api } = world;
    await expect
      .poll(async () => (await api.get(`/api/records/${T}/${item.id}`).then((r) => r.json())).data.secret, { timeout: 10_000 })
      .toBe(visible ? `S-${world.tag}` : '***');
    expect(runtimeAction(await runtime(api), T, 'e2eStamp')?.allowed).toBe(visible);
    if (!visible) await refused(await api.post(`/api/records/${T}/${item.id}/actions/e2eStamp`, { data: {} }), 'the action without its permission');
    await nextRequest(page, `/records/${T}?id=${item.id}`);
    await expect(page.getByText(`Publish ${world.tag}`).first()).toBeVisible();
    if (visible) {
      await expect(page.getByText(`S-${world.tag}`).first()).toBeVisible();
      await expect(recordButton(page, names.stamp)).toBeVisible();
    } else {
      await expect(page.getByText(`S-${world.tag}`)).toHaveCount(0);
      await expect(page.getByText('***').first()).toBeVisible();
      await expect(recordButton(page, names.stamp)).toHaveCount(0);
    }
  }

  async function changeInMap(row: string, from: string, to: string): Promise<void> {
    const r = accessRow(adminPage, row, from);
    await r.getByRole('button', { name: label('ui.builder.access.change'), exact: true }).click();
    await adminPage.getByLabel(label('ui.builder.access.requires')).fill(to);
    await adminPage.getByRole('button', { name: label('ui.builder.access.apply'), exact: true }).click();
    await expect(adminPage.locator('table.access-table tr').filter({ hasText: row }).filter({ hasText: label('ui.builder.access.draft') }).first()).toBeVisible();
  }

  async function publishAllDrafts(): Promise<void> {
    adminPage.once('dialog', (d) => void d.accept());
    await adminPage.getByRole('button', { name: label('ui.builder.publishEllipsis'), exact: true }).click();
    await expect(adminPage.getByText(label('ui.builder.access.published'))).toBeVisible();
  }

  test('FT-BLD-070 an access-map change is a draft until published, then the member’s next request follows it', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    await expectFieldAndAction(true);

    await nextRequest(adminPage, `/builder/access?recordType=${T}`);
    await expect(adminPage.getByRole('heading', { name: label('ui.crumbs.builder.access') })).toBeVisible();
    await adminPage.getByRole('searchbox', { name: label('ui.builder.access.searchPlaceholder') }).fill(names.secret);
    await expect(adminPage.locator('table.access-table tbody tr').filter({ hasText: fieldRow })).toHaveCount(2);
    await adminPage.getByRole('searchbox', { name: label('ui.builder.access.searchPlaceholder') }).fill('');

    await changeInMap(fieldRow, P.secret, P.alt);
    await changeInMap(actionRow, perm.stamp, P.stampAlt);
    await expect(adminPage.locator('.builder-foot').getByText(label('ui.builder.access.drafts.other', { count: 2, list: '' }).trim())).toBeVisible();
    for (const kind of ['recordType', 'action']) {
      const key = kind === 'action' ? 'e2eStamp' : T;
      await expect
        .poll(async () => !!(await world.admin.get(`/api/builder/definitions/${kind}/${key}`).then((r) => r.json())).draft, { timeout: 10_000, message: `${kind} ${key} has a draft` })
        .toBe(true);
    }
    await expectFieldAndAction(true);

    await publishAllDrafts();
    await expectFieldAndAction(false);

    await nextRequest(adminPage, `/builder/access?recordType=${T}`);
    await changeInMap(fieldRow, P.alt, P.secret);
    await changeInMap(actionRow, P.stampAlt, '');
    await publishAllDrafts();
    await expectFieldAndAction(true);
  });

  test('FT-BLD-071 “What can this role see?” and the member both follow the role as it is saved', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, api, page, role, allow } = world;
    const summary = async () => ((await ok(await admin.get(`/api/admin/access-map?role=${role.key}`), 'the role view')).role as { summary: string }).summary;

    await nextRequest(adminPage, `/builder/access?role=${role.key}`);
    await expect(adminPage.getByRole('heading', { name: label('ui.builder.access.roleTitle', { role: role.label }) })).toBeVisible();
    await expect(adminPage.locator('.access-summary li').filter({ hasText: names.types })).toBeVisible();
    expect(await summary()).not.toContain('masked');
    await nextRequest(page, '/');
    await expectDestination(page, label('ui.builder.title'), true);

    await allow([perm.read]);
    expect(await summary()).toContain('2 fields are masked');
    await nextRequest(adminPage, `/builder/access?role=${role.key}`);
    await expect(adminPage.locator('.access-summary li').filter({ hasText: names.types })).toBeVisible();
    await expectFieldAndAction(false);
    await nextRequest(page, '/');
    await expectDestination(page, label('ui.builder.title'), false);
    await refused(await api.get('/api/builder/catalogue'), 'the Builder without config:read');

    await allow(baseline);
    expect(await summary()).not.toContain('masked');
    await expectFieldAndAction(true);
    await nextRequest(page, '/');
    await expectDestination(page, label('ui.builder.title'), true);
    await ok(await api.get('/api/builder/catalogue'), 'the Builder with config:read');
  });

  test('FT-BLD-072 permission autocomplete lists known permissions with where they are used, and a new string is still allowed', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, role, tag, allow } = world;
    const found = (await ok(await admin.get('/api/admin/permission-suggestions?q=record:don'), 'suggestions')) as { permission: string; usedIn: unknown[] }[];
    expect(found.map((s) => s.permission)).toContain('record:donation:read');
    expect(found.every((s) => Array.isArray(s.usedIn))).toBe(true);

    await nextRequest(adminPage, `/builder/access?recordType=${T}`);
    await accessRow(adminPage, fieldRow, P.secret).getByRole('button', { name: label('ui.builder.access.change'), exact: true }).click();
    await adminPage.getByLabel(label('ui.builder.access.requires')).fill('record:don');
    await expect(adminPage.getByRole('option', { name: /record:donation:read/ }).first()).toBeVisible();
    await adminPage.getByRole('button', { name: label('ui.common.cancel'), exact: true }).click();

    const novel = `e2e-rbac:novel-${tag.split('-')[1]}`;
    await allow([...baseline, novel]);
    expect((await rolePermissions(admin, role.key)).permissions).toContain(novel);
    await allow(baseline);
  });

  test('FT-ADM-053 the Permissions tab embeds the role editor, and changes wait for publish', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { role } = world;
    await nextRequest(adminPage, `/admin/roles/${role.key}?tab=permissions`);
    await expect(adminPage.getByRole('tab', { name: label('ui.admin.roles.permissionsTab') })).toHaveAttribute('aria-selected', 'true');
    const row = gridRow(adminPage, names.types);
    await expect(row.getByRole('checkbox', { name: `See ${names.types}`, exact: true })).toBeChecked();
    await expect(row.getByRole('checkbox', { name: names.stamp, exact: true })).toBeChecked();
    const intro = adminPage.getByText(label('ui.admin.roles.permissionsIntro'));
    if (await intro.count()) knownDefect('DEF-05', 'Role permissions are saved straight away; there is no role draft to publish.');
    await expect(intro).toHaveCount(0);
  });

  test('FT-BLD-003 config:read alone can look at a definition but not change it; config:publish adds the controls', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow } = world;
    await allow(['config:read', perm.read]);
    await nextRequest(page, `/builder/recordType/${T}`);
    await expect(page.getByText(label('ui.builder.viewOnly'))).toBeVisible();
    await expect(page.getByRole('button', { name: label('ui.builder.publish'), exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: label('ui.builder.publishEllipsis'), exact: true })).toHaveCount(0);
    await nextRequest(page, '/builder');
    await expect(page.getByRole('button', { name: label('ui.builder.catalogue.new'), exact: true })).toHaveCount(0);
    await refused(await api.put(`/api/builder/definitions/recordType/${T}/draft`, { data: recordTypeBody() }), 'a draft with config:read only');
    await refused(await api.post(`/api/builder/definitions/recordType/${T}/publish`), 'publish with config:read only', [403]);

    await allow(['config:read', 'config:publish', perm.read]);
    await nextRequest(page, `/builder/recordType/${T}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.getByText(label('ui.builder.viewOnly'))).toHaveCount(0);
    await allow(baseline);
  });

  test('FT-BLD-068 turning a Viewer permission off removes it from Viewer members on their next action, and on brings it back', { tag: ['@e2e', '@rbac', '@P0'] }, async ({ browser }, info) => {
    const { admin } = world;
    expect(viewerBefore).toContain('record:donor:read');
    const viewerContext = await newContext(browser, info);
    const viewerApi = await apiAs(accounts.viewer.email);
    try {
      const viewer = await viewerContext.newPage();
      await signInAs(viewer, accounts.viewer.email, accounts.viewer.name);
      await nextRequest(viewer, '/records');
      await expect(records.typeLink(viewer, 'Donors')).toBeVisible();
      await ok(await viewerApi.get('/api/records/donor'), 'Viewer lists donors');

      const toggle = async (on: boolean) => {
        await nextRequest(adminPage, '/admin/roles/viewer?tab=permissions');
        const see = gridRow(adminPage, 'Donors').getByRole('checkbox', { name: 'See donors', exact: true });
        await expect(see).toBeChecked({ checked: !on });
        await see.setChecked(on);
        await adminPage.locator('.builder-foot').getByRole('button', { name: label('ui.common.save'), exact: true }).click();
        await expect(adminPage.getByText(label('ui.builder.roles.saved'))).toBeVisible();
      };

      await toggle(false);
      const map = await ok(await admin.get('/api/admin/access-map?role=viewer&recordType=donor'), 'the access map for Viewer');
      const seeDonors = (map.elements as { element: string; access: string; visible?: boolean }[]).find((e) => e.element === 'recordType' && e.access === 'see');
      expect(seeDonors?.visible).toBe(false);
      await expect.poll(async () => (await viewerApi.get('/api/records/donor')).status(), { timeout: 10_000 }).toBe(403);
      await nextRequest(viewer, '/records');
      await expect(viewer.getByRole('heading', { name: label('ui.nav.records') })).toBeVisible();
      await expect(records.typeLink(viewer, 'Donors')).toHaveCount(0);

      await toggle(true);
      await expect.poll(async () => (await viewerApi.get('/api/records/donor')).status(), { timeout: 10_000 }).toBe(200);
      await nextRequest(viewer, '/records');
      await expect(records.typeLink(viewer, 'Donors')).toBeVisible();
    } finally {
      if (viewerBefore) await publishRole(admin, 'viewer', { permissions: viewerBefore });
      await viewerApi.dispose();
      await viewerContext.close();
    }
  });

  test('FT-BLD-069 a newly published role gives nobody anything', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, api, tag, created } = world;
    const key = `${tag}-new`;
    await createRole(admin, key, `E2E RBAC new ${tag}`, [perm.read, P.secret, 'admin:audit']);
    created.push(key);
    const members = await ok(await admin.get(`/api/admin/roles/${key}/members`), 'members of the new role');
    expect(members.total).toBe(0);
    const listed = (await ok(await admin.get('/api/admin/roles'), 'roles')) as { key: string; members: number }[];
    expect(listed.find((r) => r.key === key)?.members).toBe(0);
    await refused(await api.get('/api/admin/audit'), 'the audit log, which only the new role allows');
  });

  test('FT-BLD-043 “only their own and shared” generates see-all and share permissions and the Shared with me chip', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, page, allow } = world;
    const catalogue = (await ok(await admin.get('/api/admin/permission-catalogue'), 'permission catalogue')) as { entries: { permission: string }[] };
    const all = catalogue.entries.map((e) => e.permission);
    expect(all).toEqual(expect.arrayContaining([perm.sharedReadAll, perm.sharedShare]));
    expect(all).not.toContain(`record:${T}:read:all`);
    expect(all).not.toContain(`record:${T}:share`);

    await allow([perm.sharedRead, perm.read]);
    await nextRequest(page, `/records/${S}`);
    await expect(page.getByText(label('ui.records.sharedWithMe'), { exact: true }).first()).toBeVisible();
    await nextRequest(page, `/records/${T}`);
    await expect(page.getByRole('heading', { name: names.types })).toBeVisible();
    await expect(page.getByText(label('ui.records.sharedWithMe'), { exact: true })).toHaveCount(0);
    expect(runtimeType(await runtime(world.api), S)).toBeTruthy();
    await allow(baseline);
  });
});
