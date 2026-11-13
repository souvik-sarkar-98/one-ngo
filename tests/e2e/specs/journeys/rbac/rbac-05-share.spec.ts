import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { label } from '../../../src/catalogue.js';
import { knownDefect } from '../../../src/shell.js';
import {
  S,
  T,
  addPerson,
  apiAs,
  createRecord,
  createRole,
  memberById,
  names,
  newContext,
  nextRequest,
  ok,
  openWorld,
  perm,
  publishRole,
  query,
  recordButton,
  refused,
  setMemberRoles,
  signInAs,
  type RecordView,
  type World,
} from '../../../src/journeys/rbac.js';

const subjectPermissions = [perm.sharedRead, perm.sharedCreate, perm.sharedUpdate, perm.read, perm.create, perm.import];
/** What the peer role gives the second member: see and edit the restricted type, but not all of it and not share. */
const peerPermissions = [perm.sharedRead, perm.sharedUpdate];

test.describe.serial('Role matrix 5: a share adds access the role does not', () => {
  test.describe.configure({ timeout: 300_000 });

  let world: World;
  let peer = { key: '', label: '' };
  let directoryBefore: string[] = [];
  let other: APIRequestContext;
  let otherContext: BrowserContext;
  let otherPage: Page;
  let mine: RecordView;
  let jobId = '';

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(180_000);
    world = await openWorld(browser, info, { permissions: subjectPermissions });
    const { admin, tag, directoryId } = world;
    peer = { key: `${tag}-peer`, label: `E2E RBAC peer ${tag}` };
    await createRole(admin, peer.key, peer.label, peerPermissions);
    world.created.push(peer.key);
    directoryBefore = (await memberById(admin, directoryId)).roles.filter((r) => !r.startsWith('rbac-'));
    await setMemberRoles(admin, directoryId, [...directoryBefore, peer.key]);
    mine = await createRecord(world.api, S, { name: `Shared ${tag}` });
    other = await apiAs(accounts.directory.email);
    otherContext = await newContext(browser, info);
    otherPage = await otherContext.newPage();
    await signInAs(otherPage, accounts.directory.email, accounts.directory.name);
  });

  test.afterAll(async () => {
    if (world) await setMemberRoles(world.admin, world.directoryId, directoryBefore.length ? directoryBefore : ['directory']).catch((e) => console.warn('Directory roles not restored', e));
    await other?.dispose();
    await otherContext?.close();
    await world?.close();
  });

  const peerAllows = (extra: string[] = []) => publishRole(world.admin, peer.key, { permissions: [...peerPermissions, ...extra] });
  const listedFor = async (api: APIRequestContext) => (await query(api, S, { search: `Shared ${world.tag}` })).items.map((r) => r.id);

  test('FT-REC-130 someone with read but not see-all does not see another person’s record, until a permission or share says so', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    expect(await listedFor(other)).not.toContain(mine.id);
    await refused(await other.get(`/api/records/${S}/${mine.id}`), 'open another person’s record by id', [404]);
    await nextRequest(otherPage, `/records/${S}`);
    await expect(otherPage.getByRole('heading', { name: names.shareds })).toBeVisible();
    await expect(otherPage.getByText(`Shared ${world.tag}`)).toHaveCount(0);

    await peerAllows([perm.sharedReadAll]);
    await expect.poll(() => listedFor(other), { timeout: 10_000 }).toContain(mine.id);
    await peerAllows();
    await expect.poll(() => listedFor(other), { timeout: 10_000 }).not.toContain(mine.id);
  });

  test('FT-REC-131 a Can view share lets them open but not save; a Can edit share with their role lets them save', { tag: ['@e2e', '@rbac', '@P0'] }, async () => {
    const { page, api, tag, directoryId } = world;
    await nextRequest(page, `/records/${S}?id=${mine.id}&panel=share`);
    await page.getByLabel(label('ui.share.add')).fill(accounts.directory.name);
    await page.getByRole('option', { name: new RegExp(accounts.directory.name) }).first().click();
    await page.getByRole('radio', { name: label('ui.share.canView') }).click();
    await page.getByRole('button', { name: label('ui.share.submit'), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: label('ui.share.done', { name: accounts.directory.name, line: '' }).split(' (')[0]! })).toBeVisible();
    const shares = (await ok(await api.get(`/api/records/${S}/${mine.id}/shares`), 'shares')) as { principal: string; access: string }[];
    expect(shares.find((s) => s.principal === directoryId)?.access).toBe('read');

    await ok(await other.get(`/api/records/${S}/${mine.id}`), 'open with a Can view share');
    expect(await listedFor(other)).toContain(mine.id);
    const fresh = (await other.get(`/api/records/${S}/${mine.id}`).then((r) => r.json())) as RecordView;
    await refused(await other.patch(`/api/records/${S}/${mine.id}`, { data: { data: { note: `viewed ${tag}` }, expectedVersion: fresh.version } }), 'save with a Can view share', [403, 404]);
    await nextRequest(otherPage, `/records/${S}?id=${mine.id}`);
    await expect(otherPage.getByText(`Shared ${tag}`).first()).toBeVisible();
    await expect(recordButton(otherPage, label('ui.common.edit'))).toHaveCount(0);

    await ok(await api.post(`/api/records/${S}/${mine.id}/shares`, { data: { principalKind: 'role', principal: peer.key, access: 'edit' } }), 'share with the role, Can edit');
    await ok(await other.patch(`/api/records/${S}/${mine.id}`, { data: { data: { note: `edited ${tag}` }, expectedVersion: fresh.version } }), 'save with a Can edit share');
    await nextRequest(otherPage, `/records/${S}?id=${mine.id}`);
    await expect(otherPage.getByText(`Shared ${tag}`).first()).toBeVisible();
    const edit = recordButton(otherPage, label('ui.common.edit'));
    if ((await edit.count()) === 0) knownDefect('DEF-10', 'A Can edit share opens the record read-only with no Edit.');
    await expect(edit).toBeVisible();
  });

  test('FT-REC-136 a person with an edit share who did not create the record and may not share cannot share it', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { role } = world;
    const share = () => other.post(`/api/records/${S}/${mine.id}/shares`, { data: { principalKind: 'role', principal: role.key, access: 'read' } });
    const body = await refused(await share(), 'share without the share permission');
    expect(body.message).toBe('Only its creator or people allowed to share can share this record.');

    await peerAllows([perm.sharedShare]);
    await expect.poll(async () => (await share()).status(), { timeout: 10_000 }).toBe(201);
    const shares = (await ok(await other.get(`/api/records/${S}/${mine.id}/shares`), 'shares')) as { id: string; principal: string }[];
    const added = shares.find((s) => s.principal === role.key);
    if (added) await ok(await other.delete(`/api/records/${S}/${mine.id}/shares/${added.id}`), 'remove the extra share');
    await peerAllows();
  });

  test('FT-REC-137 a record of a type visible to everyone is not shared', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, tag } = world;
    const open = await createRecord(admin, T, { name: `Not shared ${tag}` });
    const body = await refused(await admin.post(`/api/records/${T}/${open.id}/shares`, { data: { principalKind: 'role', principal: 'viewer', access: 'read' } }), 'share an organisation-wide record', [422]);
    expect(body.message).toBe(`${names.type} records are visible to everyone who may see them, so they are not shared.`);
  });

  test('FT-REC-138 sharing with a suspended member or an unknown role is refused', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { admin, api, tag } = world;
    const person = await addPerson(admin, tag, 'share-suspended');
    await ok(await admin.post(`/api/admin/people/${person.userId}/suspend`), 'suspend');
    const suspended = await refused(await api.post(`/api/records/${S}/${mine.id}/shares`, { data: { principalKind: 'user', principal: person.userId, access: 'read' } }), 'share with a suspended member', [422]);
    expect(JSON.stringify(suspended.issues)).toContain('is not a member of this organisation');
    const unknown = await refused(await api.post(`/api/records/${S}/${mine.id}/shares`, { data: { principalKind: 'role', principal: `${tag}-nobody`, access: 'read' } }), 'share with an unknown role', [422]);
    expect(JSON.stringify(unknown.issues)).toContain('is not a role of this organisation');
  });

  test('FT-REC-232 a job stops when its creator loses the permission mid-job', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    test.skip(true, 'Needs a bulk or import job still running when the permission is taken away. The throwaway type has too few rows to keep a job running, and timing it would make the case flaky.');
  });

  test('FT-REC-235 someone else’s job is refused without admin:jobs, and opens with it', { tag: ['@e2e', '@rbac', '@P1'] }, async () => {
    const { api, tag } = world;
    const upload = await ok(
      await api.post(`/api/records/${T}/imports`, { data: Buffer.from(`Name\nJob ${tag}\n`), headers: { 'content-type': 'text/csv', 'x-file-name': `rbac-job-${tag}.csv` } }),
      'upload an import',
    );
    await ok(await api.put(`/api/imports/${upload.id}/mapping`, { data: {} }), 'map the import');
    const run = await ok(await api.post(`/api/imports/${upload.id}/run`), 'run the import');
    jobId = String(run.jobId ?? '');
    expect(jobId).not.toBe('');
    await ok(await api.get(`/api/jobs/${jobId}`), 'the creator opens their job');

    await refused(await other.get(`/api/jobs/${jobId}`), 'open someone else’s job', [403, 404]);
    await refused(await other.post(`/api/jobs/${jobId}/cancel`), 'cancel someone else’s job', [403, 404]);

    await peerAllows(['admin:jobs']);
    await expect.poll(async () => (await other.get(`/api/jobs/${jobId}`)).status(), { timeout: 10_000 }).toBe(200);
    await peerAllows();
    await expect.poll(async () => (await other.get(`/api/jobs/${jobId}`)).status(), { timeout: 10_000 }).not.toBe(200);
  });
});
