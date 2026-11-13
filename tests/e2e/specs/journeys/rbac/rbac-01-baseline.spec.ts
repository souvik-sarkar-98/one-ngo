import { expect, test } from '@playwright/test';
import { org, password } from '../../../src/accounts.js';
import { label } from '../../../src/catalogue.js';
import { expectDestination, knownDefect } from '../../../src/shell.js';
import {
  P,
  PAGE_IN,
  PAGE_OUT,
  S,
  T,
  createRecord,
  newContext,
  names,
  nextRequest,
  ok,
  openWorld,
  paceAuth,
  perm,
  query,
  records,
  recordButton,
  refused,
  runtime,
  runtimeAction,
  runtimeStep,
  runtimeType,
  subjectAccount,
  viewerLike,
  type RecordView,
  type World,
} from '../../../src/journeys/rbac.js';

/** What the seeded Finance role holds (functional-test-data.md). */
const financeLike = [
  'record:donor:*',
  'record:donation:*',
  'record:donation:transition:*',
  'record:donation:action:*',
  'payments:create',
  'payments:confirm',
  'money:accounts:read',
  'people:read',
];

const people = () => label('ui.nav.people');
const administration = () => label('ui.crumbs.administration');
const builder = () => label('ui.builder.title');

test.describe.serial('Role matrix 1: note what the current permission shows', () => {
  test.describe.configure({ timeout: 240_000 });

  let world: World;
  let open: RecordView;
  let done: RecordView;
  let raised: RecordView | undefined;
  let paid: RecordView | undefined;
  let ravi: RecordView | undefined;
  let approvalId = '';

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(180_000);
    world = await openWorld(browser, info, { permissions: [], pages: true });
    const { admin, tag } = world;
    open = await createRecord(admin, T, { name: `Open ${tag}`, secret: `S-${tag}`, score: 7, locked: `L-${tag}` });
    done = await createRecord(admin, T, { name: `Done ${tag}`, secret: `D-${tag}` });
    await ok(await admin.post(`/api/records/${T}/${done.id}/transitions/finish`, { data: { expectedVersion: done.version } }), 'finish the done record');
    raised = (await query(admin, 'donation', { statusIn: ['raised'], limit: 1 })).items[0];
    paid = (await query(admin, 'donation', { statusIn: ['paid'], limit: 1 })).items[0];
    ravi = (await query(admin, 'donor', { search: 'Ravi Kumar', limit: 20 })).items.find((d) => d.data['pan'] === 'ABCDE1234F');
  });

  test.afterAll(async () => {
    await world?.close();
  });

  test('FT-NAV-005 People is never a destination, and Administration and Builder follow the permission', { tag: ['@e2e', '@rbac', '@P0', '@smoke'] }, async () => {
    const { page, api, allow } = world;
    const sets = [
      { as: 'ADMIN', permissions: ['*'], areas: true },
      { as: 'FIN', permissions: financeLike, areas: false },
      { as: 'NOACCESS', permissions: [] as string[], areas: false },
      { as: 'DIR', permissions: ['people:read'], areas: false },
    ];
    for (const set of sets) {
      await allow(set.permissions);
      await nextRequest(page, '/');
      await expectDestination(page, administration(), set.areas);
      await expectDestination(page, builder(), set.areas);
      if (set.areas) {
        await ok(await api.get('/api/builder/catalogue'), `${set.as} reads the Builder`);
        await ok(await api.get('/api/admin/people'), `${set.as} reads Administration`);
      } else {
        await refused(await api.get('/api/builder/catalogue'), `${set.as} reads the Builder`);
        await refused(await api.get('/api/admin/people'), `${set.as} reads Administration`);
        for (const path of ['/admin', '/builder']) {
          await nextRequest(page, path);
          await expect(page, `${set.as} opening ${path}`).toHaveURL(/\/$/);
        }
      }
      await nextRequest(page, '/');
      await expectDestination(page, people(), false);
    }
  });

  test('FT-NAV-007 managing people alone does not open API keys', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow } = world;
    await allow(['members:manage']);
    await nextRequest(page, '/admin/api-keys');
    await expect(page).toHaveURL(/\/admin$/);
    await refused(await api.get('/api/admin/api-keys'), 'API keys without admin:api-keys');
  });

  test('FT-HOME-001 a role with no permissions gets the no-access Home, and one permission ends it', { tag: ['@e2e', '@rbac', '@P0', '@smoke'] }, async () => {
    const { page, api, allow } = world;
    await allow([]);
    await nextRequest(page, '/');
    await expect(page.getByText(label('ui.home.noAccess'))).toBeVisible();
    expect((await runtime(api)).recordTypes).toHaveLength(0);

    await allow([perm.read]);
    await nextRequest(page, '/');
    await expect(page.getByText(label('ui.home.noAccess'))).toHaveCount(0);
    expect(runtimeType(await runtime(api), T)).toBeTruthy();

    await allow([]);
    await nextRequest(page, '/');
    await expect(page.getByText(label('ui.home.noAccess'))).toBeVisible();
  });

  test('FT-HOME-007 counts over a restricted type include only what the person may see', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { admin, api, allow, tag } = world;
    await allow([perm.sharedRead, perm.sharedCreate]);
    await createRecord(admin, S, { name: `Admin only ${tag}` });
    await createRecord(api, S, { name: `Mine ${tag}` });
    const mine = await query(api, S, {});
    const counted = await ok(await api.post(`/api/records/${S}/aggregate`, { data: { measure: 'count' } }), 'count as the subject');
    const all = await ok(await admin.post(`/api/records/${S}/aggregate`, { data: { measure: 'count' } }), 'count as an administrator');
    expect(counted.value).toBe(mine.total);
    expect(all.value as number).toBeGreaterThan(counted.value as number);
  });

  test('FT-HOME-010 a page outside the person’s audience says they have no access', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow } = world;
    await allow([perm.read]);
    await nextRequest(page, `/pages/${PAGE_OUT}`);
    await expect(page.getByText(label('ui.pages.noAccess'))).toBeVisible();
    await refused(await api.post(`/api/records/${T}/aggregate`, { data: { measure: 'count', widget: { page: PAGE_OUT, index: 0 } } }), 'a widget of a page outside the audience');
    const pages = (await runtime(api)).pages.map((p) => p.key);
    expect(pages).not.toContain(PAGE_OUT);
    expect(pages).toContain(PAGE_IN);

    await nextRequest(page, `/pages/${PAGE_IN}`);
    await expect(page.getByText(label('ui.pages.noAccess'))).toHaveCount(0);
    await expect(page.getByRole('heading', { name: names.pageIn })).toBeVisible();
  });

  test('FT-HOME-011 a widget with a permission the person lacks is hidden, and appears when they get it', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow } = world;
    const guarded = page.locator('app-widget').filter({ hasText: names.guardedWidget });
    const plain = page.locator('app-widget').filter({ hasText: names.openWidget });
    const ask = () => api.post(`/api/records/${T}/aggregate`, { data: { measure: 'count', widget: { page: PAGE_IN, index: 1 } } });

    await allow([perm.read]);
    await nextRequest(page, `/pages/${PAGE_IN}`);
    await expect(plain).toBeVisible();
    await expect(guarded).toHaveCount(0);
    await refused(await ask(), 'the guarded widget without its permission');

    await allow([perm.read, P.widget]);
    await nextRequest(page, `/pages/${PAGE_IN}`);
    await expect(guarded).toBeVisible();
    await ok(await ask(), 'the guarded widget with its permission');

    await allow([perm.read]);
    await nextRequest(page, `/pages/${PAGE_IN}`);
    await expect(guarded).toHaveCount(0);
  });

  test('FT-HOME-016 pinning to everyone’s Home is offered only with publish permission', { tag: ['@e2e', '@rbac', '@P2'] }, async () => {
    const { page, api, allow } = world;
    const menu = async () => {
      await nextRequest(page, '/records/donor');
      await page.locator('.list-filter-toolbar').getByRole('button', { name: label('ui.common.moreActions'), exact: true }).click();
      await expect(page.getByRole('menuitem', { name: label('ui.pins.pinMine'), exact: true })).toBeVisible();
      return page.getByRole('menuitem', { name: label('ui.pins.pinEveryone'), exact: true });
    };

    await allow(['record:donor:read']);
    await expect(await menu()).toHaveCount(0);
    await page.keyboard.press('Escape');
    await refused(await api.put('/api/builder/definitions/page/home/draft', { data: { key: 'home', label: 'Home', widgets: [] } }), 'a Home draft without config:publish');

    await allow(['record:donor:read', 'config:read', 'config:publish']);
    await expect(await menu()).toBeVisible();
    await page.keyboard.press('Escape');
    await allow(['record:donor:read']);
  });

  test('FT-AUTH-105 signed-out addresses go to sign-in with next, and sign-in returns there when allowed', { tag: ['@e2e', '@rbac', '@P1'] }, async ({ browser }, info) => {
    const { allow } = world;
    await allow([perm.read]);
    const target = `/records/${T}?id=${open.id}`;
    const context = await newContext(browser, info);
    try {
      const visitor = await context.newPage();
      for (const path of [target, '/admin', '/builder', '/print/receipt/00000000-0000-4000-8000-000000000000']) {
        await paceAuth(2);
        await visitor.goto(path);
        await expect(visitor, `signed out at ${path}`).toHaveURL(/\/sign-in\?.*next=/);
        expect(decodeURIComponent(new URL(visitor.url()).searchParams.get('next') ?? '')).toBe(path);
      }

      await paceAuth(3);
      await visitor.goto(`/o/${org}/sign-in?next=${encodeURIComponent(target)}`);
      await visitor.getByRole('tab', { name: label('ui.auth.tabPassword') }).click();
      await visitor.getByLabel(label('ui.auth.email')).fill(subjectAccount.email);
      await visitor.getByLabel(label('ui.auth.password')).fill(password);
      await visitor.getByRole('button', { name: label('ui.auth.signIn'), exact: true }).click();
      await expect(visitor).toHaveURL(new RegExp(`/records/${T}\\?id=${open.id}`));

      await nextRequest(visitor, '/admin');
      await expect(visitor).toHaveURL(/\/$/);
    } finally {
      await context.close();
    }
  });

  test('FT-ADM-001 Administration shows what the permissions allow: everything for all, People and Roles for managing people', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { page, api, allow } = world;
    const checklist = page.getByRole('button', { name: label('ui.admin.organisation.setupView'), exact: true });
    const area = (key: string) => page.getByRole('link', { name: label(key) }).first();

    await allow(['*']);
    await nextRequest(page, '/admin');
    await expect(checklist).toBeVisible();
    for (const key of ['ui.crumbs.admin.people', 'ui.crumbs.admin.roles', 'ui.crumbs.admin.connectors', 'ui.crumbs.admin.identity']) await expect(area(key)).toBeVisible();

    await allow(['members:manage']);
    await nextRequest(page, '/admin');
    await expect(area('ui.crumbs.admin.people')).toBeVisible();
    await expect(area('ui.crumbs.admin.roles')).toBeVisible();
    await expect(checklist).toHaveCount(0);
    for (const key of ['ui.crumbs.admin.connectors', 'ui.crumbs.admin.apiKeys', 'ui.crumbs.admin.audit', 'ui.crumbs.admin.identity']) {
      await expect(page.getByRole('link', { name: label(key) })).toHaveCount(0);
    }
    await refused(await api.get('/api/admin/connectors'), 'connectors without admin:connectors');
    await refused(await api.get('/api/admin/audit'), 'audit without admin:audit');
  });

  test('FT-ADM-035 status, invitation and two-step are on Administration → People only', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow } = world;
    await allow(['members:manage']);
    await nextRequest(page, '/admin/people');
    await expect(page.getByText(label('ui.people.col.status')).first()).toBeVisible();
    await expect(page.getByText(label('ui.people.col.twoStep')).first()).toBeVisible();
    await expectDestination(page, people(), false);
    await nextRequest(page, '/people');
    await expect(page).toHaveURL(/\/$/);
    await refused(await api.get('/api/people'), 'the directory without people:read');
  });

  test('FT-ADM-040 the people list is only at Administration → People, and people:read alone does not open it', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { page, api, allow } = world;
    await allow(['people:read']);
    await nextRequest(page, '/');
    await expectDestination(page, administration(), false);
    await nextRequest(page, '/admin/people');
    await expect(page).toHaveURL(/\/$/);
    await refused(await api.get('/api/admin/people'), 'Administration → People without members:manage');

    await nextRequest(page, '/people');
    await expect(page).toHaveURL(/\/$/);
    await expectDestination(page, people(), false);
  });

  test('FT-REC-004 without read on a type it is absent and its address says so; with read it is back', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { page, api, allow } = world;
    await allow(['record:donor:read']);
    await nextRequest(page, '/records');
    await expect(records.typeLink(page, 'Donors')).toBeVisible();
    await expect(records.typeLink(page, names.types)).toHaveCount(0);
    await nextRequest(page, `/records/${T}`);
    await expect(page.getByText(label('ui.records.notFound'))).toBeVisible();
    await refused(await api.get(`/api/records/${T}`), 'listing without read');
    await refused(await api.get(`/api/records/${T}/${open.id}`), 'opening without read');
    expect(runtimeType(await runtime(api), T)).toBeUndefined();

    await allow([]);
    await nextRequest(page, '/records');
    await expect(page.getByText(label('ui.home.noAccess'))).toBeVisible();
    await expect(page.locator('section').filter({ has: page.locator('.list-row') })).toHaveCount(0);

    await allow([perm.read]);
    await nextRequest(page, '/records');
    await expect(records.typeLink(page, names.types)).toBeVisible();
    await ok(await api.get(`/api/records/${T}/${open.id}`), 'opening with read');
  });

  test('FT-REC-026 the create button follows the create permission', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow, tag } = world;
    await allow([perm.read]);
    await nextRequest(page, `/records/${T}`);
    await expect(page.getByRole('heading', { name: names.types })).toBeVisible();
    await expect(records.newButton(page, names.type)).toHaveCount(0);
    expect(runtimeType(await runtime(api), T)?.canCreate).toBe(false);
    await refused(await api.post(`/api/records/${T}`, { data: { name: `Refused ${tag}` } }), 'create without create');

    await allow([perm.read, perm.create]);
    await nextRequest(page, `/records/${T}`);
    await expect(records.newButton(page, names.type)).toBeVisible();
    expect(runtimeType(await runtime(api), T)?.canCreate).toBe(true);
  });

  test('FT-REC-109 without the sensitive permission PAN shows *** on screen, by API, and in the export', { tag: ['@e2e', '@rbac', '@P0', '@smoke'] }, async () => {
    test.skip(!ravi, 'The seeded donor Ravi Kumar with PAN ABCDE1234F is not loaded.');
    const { page, api, allow } = world;
    await allow(['record:donor:read', 'record:donor:export']);
    const seen = (await api.get(`/api/records/donor/${ravi!.id}`).then((r) => r.json())) as RecordView;
    expect(seen.data['pan']).toBe('***');
    await nextRequest(page, `/records/donor?id=${ravi!.id}`);
    await expect(page.getByText('Ravi Kumar').first()).toBeVisible();
    await expect(page.getByText('***').first()).toBeVisible();
    await expect(page.getByText('ABCDE1234F')).toHaveCount(0);
    await expect(page.getByText(/ABCDE|1234F/)).toHaveCount(0);
    const csv = await (await api.get('/api/records/donor/export.csv')).text();
    expect(csv).not.toContain('ABCDE1234F');
  });

  test('FT-REC-111 a field the person may not see is *** and cannot be filtered, sorted or totalled', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow, tag } = world;
    const filter = () => api.post(`/api/records/${T}/query`, { data: { filters: { secret: { eq: `S-${tag}` } } } });
    await allow([perm.read]);
    expect((await api.get(`/api/records/${T}/${open.id}`).then((r) => r.json())).data.secret).toBe('***');
    expect(runtimeType(await runtime(api), T)?.fields.find((f) => f.key === 'secret')?.masked).toBe(true);
    const refusedFilter = await refused(await filter(), 'filter by a field the person cannot see');
    expect(refusedFilter.message).toContain(`'${names.secret}'`);
    await refused(await api.post(`/api/records/${T}/query`, { data: { sort: { field: 'secret' } } }), 'sort by a field the person cannot see');
    const refusedSum = await refused(await api.post(`/api/records/${T}/query`, { data: { sum: ['score'] } }), 'total a field the person cannot see');
    expect(refusedSum.message).toContain(`'${names.score}'`);
    await nextRequest(page, `/records/${T}?id=${open.id}`);
    await expect(page.getByText('***').first()).toBeVisible();
    await expect(page.getByText(`S-${tag}`)).toHaveCount(0);

    await allow([perm.read, P.secret]);
    await ok(await filter(), 'filter with the field permission');
    await nextRequest(page, `/records/${T}?id=${open.id}`);
    await expect(page.getByText(`S-${tag}`).first()).toBeVisible();
  });

  test('FT-REC-112 a field the person may not change is read-only, and create, update, import and bulk refuse it', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow, tag } = world;
    const refusal = `you may not change '${names.locked}'`;
    await allow([perm.read, perm.create, perm.update, perm.import, perm.bulk]);
    expect(runtimeType(await runtime(api), T)?.fields.find((f) => f.key === 'locked')?.readOnly).toBe(true);

    const update = await refused(await api.patch(`/api/records/${T}/${open.id}`, { data: { data: { locked: 'changed' }, expectedVersion: open.version } }), 'update', [422]);
    expect(JSON.stringify(update)).toContain(refusal);
    const create = await refused(await api.post(`/api/records/${T}`, { data: { name: `Locked ${tag}`, locked: 'x' } }), 'create', [422]);
    expect(JSON.stringify(create)).toContain(refusal);
    const bulk = await api.post(`/api/records/${T}/bulk`, { data: { ids: [open.id], operation: { type: 'edit', values: { locked: 'x' } } } });
    if (bulk.status() === 200) {
      const out = await bulk.json();
      expect(out.failed).toBe(1);
      expect(JSON.stringify(out.results)).toContain(refusal);
    } else expect(JSON.stringify(await refused(bulk, 'bulk', [422]))).toContain(refusal);
    const upload = await ok(
      await api.post(`/api/records/${T}/imports`, { data: Buffer.from(`Name,${names.locked}\nImported ${tag},x\n`), headers: { 'content-type': 'text/csv', 'x-file-name': 'rbac-locked.csv' } }),
      'upload an import',
    );
    await ok(await api.put(`/api/imports/${upload.id}/mapping`, { data: {} }), 'map the import');
    const checked = await ok(await api.post(`/api/imports/${upload.id}/check`), 'check the import');
    expect(checked.invalid).toBe(1);
    expect(JSON.stringify(checked.problems)).toContain(refusal);

    await nextRequest(page, `/records/${T}?id=${open.id}`);
    await recordButton(page, label('ui.common.edit')).click();
    await expect(page.getByLabel(names.locked)).not.toBeEditable();

    await allow([perm.read, perm.update, P.lock]);
    expect(runtimeType(await runtime(api), T)?.fields.find((f) => f.key === 'locked')?.readOnly).toBeUndefined();
  });

  test('FT-REC-151 an action is absent without its permission or outside its state, and the API refuses it', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow } = world;
    const run = (id: string) => api.post(`/api/records/${T}/${id}/actions/e2eStamp`, { data: {} });

    await allow([perm.read, perm.stamp]);
    expect(runtimeAction(await runtime(api), T, 'e2eStamp')?.allowed).toBe(true);
    await nextRequest(page, `/records/${T}?id=${open.id}`);
    await expect(recordButton(page, names.stamp)).toBeVisible();
    await nextRequest(page, `/records/${T}?id=${done.id}`);
    await expect(page.getByText(`Done ${world.tag}`).first()).toBeVisible();
    await expect(recordButton(page, names.stamp)).toHaveCount(0);
    await refused(await run(done.id), 'the action outside its state', [403, 409, 422]);

    await allow([perm.read]);
    expect(runtimeAction(await runtime(api), T, 'e2eStamp')?.allowed).toBe(false);
    await nextRequest(page, `/records/${T}?id=${open.id}`);
    await expect(page.getByText(`Open ${world.tag}`).first()).toBeVisible();
    await expect(recordButton(page, names.stamp)).toHaveCount(0);
    await refused(await run(open.id), 'the action without its permission');
  });

  test('FT-DON-040 Viewer permissions read donations, offer no change, and every change is refused by API', { tag: ['@e2e', '@rbac', '@P0', '@smoke'] }, async () => {
    test.skip(!raised, 'No Raised donation is loaded.');
    const { page, api, allow } = world;
    await allow(viewerLike);
    const donation = (await ok(await api.get(`/api/records/donation/${raised!.id}`), 'read a donation')) as RecordView;
    await nextRequest(page, '/records/donation');
    await expect(records.newButton(page, 'Donation')).toHaveCount(0);
    await nextRequest(page, `/records/donation?id=${raised!.id}`);
    await expect(page.getByText(String(donation.data['donorName'])).first()).toBeVisible();
    for (const name of ['Mark as paid', 'Send reminder', 'Pay now', label('ui.common.edit')]) await expect(recordButton(page, name)).toHaveCount(0);

    await refused(await api.post('/api/records/donation', { data: { donorName: 'Refused', amount: 10 } }), 'create a donation');
    await refused(await api.patch(`/api/records/donation/${raised!.id}`, { data: { data: { notes: 'x' }, expectedVersion: donation.version } }), 'edit a donation');
    await refused(await api.post(`/api/records/donation/${raised!.id}/transitions/cancel`, { data: { expectedVersion: donation.version } }), 'a donation step');
    await refused(await api.post(`/api/records/donation/${raised!.id}/actions/sendReminder`, { data: {} }), 'a donation action');
  });

  test('FT-FIN-030 the receipt print address is refused without the print permission', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    test.skip(!paid, 'No Paid donation is loaded.');
    const { admin, api, allow } = world;
    const receipts = (await ok(await admin.get(`/api/records/donation/${paid!.id}/receipts`), 'receipts of a paid donation')) as { id: string }[];
    test.skip(!receipts.length, 'The paid donation has no receipt.');
    await allow(viewerLike);
    const res = await api.get(`/api/print/receipt/${receipts[0]!.id}`);
    if (res.status() === 200) knownDefect('DEF-08', 'A Viewer without Print receipt can open the print page.');
    await refused(res, 'print a receipt without record:donation:action:printReceipt', [403, 404]);
  });

  test('FT-WF-004 a step is absent without its permission, and the API forbids it', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { page, api, allow } = world;
    await allow([perm.read, perm.update]);
    expect(runtimeStep(await runtime(api), T, 'finish')?.allowed).toBe(false);
    await nextRequest(page, `/records/${T}?id=${open.id}`);
    await expect(page.getByText(`Open ${world.tag}`).first()).toBeVisible();
    await expect(recordButton(page, names.finish)).toHaveCount(0);
    await refused(await api.post(`/api/records/${T}/${open.id}/transitions/finish`, { data: { expectedVersion: open.version } }), 'a step without its permission');

    await allow([perm.read, perm.update, perm.finish]);
    expect(runtimeStep(await runtime(api), T, 'finish')?.allowed).toBe(true);
    await nextRequest(page, `/records/${T}?id=${open.id}`);
    await expect(recordButton(page, names.finish)).toBeVisible();
  });

  test('FT-WF-021 a requester cannot approve their own request', { tag: ['@e2e', '@rbac', '@P0', '@smoke'] }, async () => {
    const { page, api, allow, tag } = world;
    await allow([perm.read, perm.create, perm.submit]);
    const mine = await createRecord(api, T, { name: `Sign-off ${tag}` });
    const step = await ok(await api.post(`/api/records/${T}/${mine.id}/transitions/submit`, { data: { expectedVersion: mine.version } }), 'ask for sign-off');
    approvalId = String(step.approvalRequestId ?? '');
    expect(approvalId).not.toBe('');
    const own = await refused(await api.post(`/api/approvals/${approvalId}/decision`, { data: { decision: 'approve' } }), 'approve my own request');
    expect(own.message).toBe('You cannot approve your own request.');
    await nextRequest(page, `/records/${T}?id=${mine.id}`);
    await expect(page.getByText(`Sign-off ${tag}`).first()).toBeVisible();
    await expect(recordButton(page, label('ui.common.approve'))).toHaveCount(0);
  });

  test('FT-WF-025 someone who is not an approver cannot decide', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    test.skip(!approvalId, 'FT-WF-021 did not leave a pending request.');
    const body = await refused(await world.admin.post(`/api/approvals/${approvalId}/decision`, { data: { decision: 'approve' } }), 'decide as a non-approver');
    expect(body.message).toBe('You are not an approver for this step.');
  });

  test('FT-WF-030 only the requester can withdraw', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    test.skip(!approvalId, 'FT-WF-021 did not leave a pending request.');
    const other = await refused(await world.admin.post(`/api/approvals/${approvalId}/withdraw`), 'withdraw as someone else');
    expect(other.message).toBe('Only the requester can withdraw this request.');
    expect((await world.api.post(`/api/approvals/${approvalId}/withdraw`)).status(), 'the requester withdraws').toBe(204);
  });
});
