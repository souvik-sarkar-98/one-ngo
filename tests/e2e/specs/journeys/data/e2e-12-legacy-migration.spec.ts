import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { memberApi } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import {
  addMemberWithPassword,
  body,
  csv,
  ensureFileStore,
  noMailbox,
  openMailbox,
  queryRecords,
  suspendQuietly,
} from '../../../src/journeys/data.js';
import { createRole, publishDefinition, publishRole } from '../../../src/journeys/rbac.js';
import { signIn } from '../../../src/sign-in.js';

/**
 * Legacy data migration: people, records that point at them by legacy user id, photos, warnings,
 * a re-run, deleting the source data, and the people permission.
 *
 * Setup goes through the API (profile, files, mappings); the screens are used for what the
 * administrator sees: the Check warnings and problem, the run, the people list, the record, the
 * delete button, and the People option for someone without `data:migrate:people`.
 * Needs the same stack as e2e-05 (web on APP_BASE_URL, API on API_BASE_URL, fixture mailbox).
 */

const stamp = Date.now().toString(36);
const typeKey = 'e2eMigDonor';
const limitedRole = 'e2e-migrator';

/** A 1x1 PNG, so the file field's `accept: ['image']` check passes on the sniffed type. */
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const tags = ['@e2e', '@FT-E2E-12', '@P1'];
const email = (n: number) => `legacy.${stamp}.${n}@old-system.example`;
const personName = (n: number) => `Legacy ${stamp} Person ${n}`;
const donorName = (n: number) => `Legacy ${stamp} Donor ${n}`;

const ui = {
  checkNow: label('ui.admin.migration.checkNow'),
  checkAgain: label('ui.admin.migration.checkAgain'),
  finished: label('ui.admin.migration.finished'),
  purgeButton: label('ui.admin.migration.purge.button'),
  purgeConfirm: label('ui.admin.migration.purge.confirm'),
  purged: label('ui.admin.migration.purged'),
  downloadFailed: label('ui.admin.migration.downloadFailed'),
  unresolved: label('ui.admin.migration.warningGroup.unresolvedLegacyUsers'),
  missingFiles: label('ui.admin.migration.warningGroup.missingAttachments'),
  kindPeople: label('ui.admin.migration.kindPeople'),
  kindRecords: label('ui.admin.migration.kindRecords'),
  invited: label('ui.people.status.invited'),
  all: label('ui.people.status.all'),
  search: label('ui.records.searchList'),
};

interface Counts {
  created: number;
  updated: number;
  failed: number;
}
interface Profile {
  id: string;
  status: string;
  purgedAt: string | null;
  sources: { id: string; fileName: string; kind: string; counts: Counts | null; purgedAt: string | null }[];
  check: { ready: number; invalid: number; problems: { message: string; severity?: string }[]; warnings: { kind: string; count: number }[] } | null;
  attachments: { count: number; bytes: number };
}
interface PersonView {
  userId: string;
  email: string;
  status: string;
  roles: string[];
}

test.describe.serial('FT-E2E-12 Legacy data migration', () => {
  let page: Page;
  let admin: APIRequestContext;
  let mail: APIRequestContext | null = null;
  let limited: { email: string; name: string; userId?: string; context?: BrowserContext; api?: APIRequestContext } | undefined;
  let profileId = '';
  let peopleSource = '';
  let donorSource = '';
  let donorIds: string[] = [];
  let membersBefore = 0;
  const added: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page, accounts.admin.email, accounts.admin.name);
    admin = await memberApi(accounts.admin.email);
    mail = await openMailbox();
    await ensureFileStore(admin);
    await publishDefinition(admin, 'recordType', {
      key: typeKey,
      label: 'Legacy donor',
      pluralLabel: 'Legacy donors',
      titleField: 'name',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true, searchable: true },
        { key: 'owner', label: 'Relationship owner', type: 'person' },
        { key: 'photo', label: 'Photo', type: 'file', accept: ['image'], maxSizeMb: 1 },
      ],
    });
  });

  test.afterAll(async () => {
    await limited?.context?.close();
    await limited?.api?.dispose();
    if (admin) {
      await suspendQuietly(admin, limited?.userId);
      for (const id of added) await suspendQuietly(admin, id);
      await admin.dispose();
    }
    await mail?.dispose();
    await page?.close();
  });

  test('FT-MIG-901 people, donors and photos upload and map in order', { tag: tags }, async () => {
    const created = await body<Profile>(await admin.post('/api/migrations', { data: { name: `Legacy ${stamp}` } }), 201, 'create profile');
    profileId = created.id;

    // Row 3 has a bad email: the one blocking problem. Donor D-3 names a user the people file lacks, and D-2 a photo that was never uploaded: the two warnings.
    const peopleCsv = (badEmail: string) =>
      csv([
        ['UserId', 'Email', 'FullName', 'Roles'],
        ['U-1', email(1), personName(1), 'Viewer'],
        ['U-2', email(2), personName(2), 'Viewer;Guest'],
        ['U-3', badEmail, personName(3), ''],
      ]);
    const donorsCsv = csv([
      ['DonorId', 'Name', 'OwnerId', 'Photo'],
      ['D-1', donorName(1), 'U-1', 'photos/d-1.png'],
      ['D-2', donorName(2), 'U-2', 'photos/ghost.png'],
      ['D-3', donorName(3), 'U-404', 'photos/d-3.png'],
    ]);
    await upload(admin, profileId, 'people.csv', peopleCsv('not-an-email'));
    await upload(admin, profileId, 'donors.csv', donorsCsv);
    for (const name of ['photos/d-1.png', 'photos/d-3.png']) {
      const res = await admin.post(`/api/migrations/${profileId}/attachments`, { headers: { 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream' }, data: png });
      expect(res.status(), `attach ${name}`).toBe(201);
    }

    const profile = await view(admin, profileId);
    expect(profile.attachments.count).toBe(2);
    peopleSource = profile.sources.find((s) => s.fileName === 'people.csv')!.id;
    donorSource = profile.sources.find((s) => s.fileName === 'donors.csv')!.id;
    await mapPeople(admin, profileId, peopleSource);
    await mapDonors(admin, profileId, donorSource);

    // Saving the donor mapping reorders the files: people first.
    const ordered = await view(admin, profileId);
    expect(ordered.sources.map((s) => s.fileName)).toEqual(['people.csv', 'donors.csv']);
    expect(ordered.sources[0]!.kind).toBe('people');
  });

  test('FT-MIG-902 Check shows two warnings and one blocking problem, and fixing the file clears the problem', { tag: tags }, async () => {
    await page.goto(`/admin/migration/${profileId}/check`);
    await page.getByRole('button', { name: ui.checkNow, exact: true }).click();
    await expect(page.getByText('Email is not a valid address').first()).toBeVisible();
    await expect(page.getByText(ui.unresolved, { exact: true })).toBeVisible();
    await expect(page.getByText(ui.missingFiles, { exact: true })).toBeVisible();

    const checked = await view(admin, profileId);
    expect(checked.check!.invalid).toBe(1);
    expect(checked.check!.problems.filter((p) => p.severity !== 'warning')).toHaveLength(1);
    expect(checked.check!.warnings.map((w) => w.kind).sort()).toEqual(['missing-attachments', 'unresolved-legacy-users']);

    // Fix: remove the people file, upload it with a good address, and map it again.
    await body(await admin.delete(`/api/migrations/${profileId}/sources/${peopleSource}`), 200, 'remove people.csv');
    await upload(
      admin,
      profileId,
      'people.csv',
      csv([
        ['UserId', 'Email', 'FullName', 'Roles'],
        ['U-1', email(1), personName(1), 'Viewer'],
        ['U-2', email(2), personName(2), 'Viewer;Guest'],
        ['U-3', email(3), personName(3), ''],
      ]),
    );
    peopleSource = (await view(admin, profileId)).sources.find((s) => s.fileName === 'people.csv')!.id;
    await mapPeople(admin, profileId, peopleSource);
    expect((await view(admin, profileId)).sources[0]!.fileName).toBe('people.csv');

    await page.goto(`/admin/migration/${profileId}/check`);
    await page.getByRole('button', { name: ui.checkNow, exact: true }).click();
    await expect(page.getByText('Email is not a valid address')).toHaveCount(0);
    const fixed = await view(admin, profileId);
    expect(fixed.check!.invalid).toBe(0);
    expect(fixed.check!.warnings.map((w) => w.kind).sort()).toEqual(['missing-attachments', 'unresolved-legacy-users']);
    membersBefore = (await people(admin, `@old-system.example`)).length;
  });

  test('FT-MIG-903 the run adds people as Invited and donors with their owner and photo', { tag: tags }, async () => {
    test.setTimeout(180_000);
    await page.getByRole('button', { name: /^Run \d+ rows$|^Run /i }).first().click();
    await expect(page.getByText(ui.finished)).toBeVisible({ timeout: 150_000 });

    const done = await view(admin, profileId);
    expect(done.status).toBe('done');
    expect(done.sources.find((s) => s.fileName === 'people.csv')!.counts).toMatchObject({ created: 3, failed: 0 });
    expect(done.sources.find((s) => s.fileName === 'donors.csv')!.counts).toMatchObject({ created: 3, failed: 0 });

    const list = (await people(admin, stamp)).filter((p) => p.email.includes(`legacy.${stamp}.`));
    expect(list).toHaveLength(3);
    for (const p of list) {
      added.push(p.userId);
      expect(p.status, `${p.email} is Invited`).toBe('invited');
    }
    expect(list.find((p) => p.email === email(2))!.roles).toEqual(['viewer']); // "Guest" has no role here and is ignored by the map

    await page.goto('/admin/people');
    await page.getByRole('tab', { name: new RegExp(`^${ui.all}\\b`) }).click();
    await page.getByRole('searchbox', { name: ui.search }).fill(personName(1));
    const row = page.getByText(personName(1)).first();
    await expect(row).toBeVisible();
    await expect(page.getByText(ui.invited, { exact: true }).first()).toBeVisible();
  });

  test('FT-MIG-904 a donor shows its owner by name and its photo', { tag: tags }, async () => {
    const found = await queryRecords(admin, typeKey, { limit: 50 });
    const mine = found.items.filter((r) => String(r.data.name).startsWith(`Legacy ${stamp} Donor`));
    expect(mine).toHaveLength(3);
    donorIds = mine.map((r) => r.id);
    const first = mine.find((r) => r.data.name === donorName(1))!;
    const owner = (await people(admin, email(1)))[0]!;
    expect(first.data.owner).toBe(owner.userId);
    expect(JSON.stringify(first.data.photo ?? null)).not.toBe('null');
    // D-2's photo was never uploaded: skipped with a warning, field empty. D-3's owner is unknown: blank.
    expect(mine.find((r) => r.data.name === donorName(2))!.data.photo ?? null).toBeNull();
    expect(mine.find((r) => r.data.name === donorName(3))!.data.owner ?? null).toBeNull();

    await page.goto(`/records/${typeKey}?id=${first.id}`);
    await expect(page.getByText(personName(1)).first()).toBeVisible();
    // The photo shows as an image or as a link named after the file.
    await expect(page.locator('img[src*="file"], img[alt*="d-1"], a:has-text("d-1.png"), :text("d-1.png")').first()).toBeVisible();
  });

  test('FT-MIG-905 running the same profile again changes nothing', { tag: tags }, async () => {
    test.setTimeout(180_000);
    const recordsBefore = (await queryRecords(admin, typeKey, { limit: 1 })).total;
    const peopleBefore = await people(admin, `legacy.${stamp}.`);
    await body(await admin.post(`/api/migrations/${profileId}/check`), 200, 'check again');
    await body(await admin.post(`/api/migrations/${profileId}/run`), 202, 'run again');
    await expect
      .poll(async () => (await view(admin, profileId)).status, { timeout: 150_000, intervals: [1000, 2000] })
      .toBe('done');

    const again = await view(admin, profileId);
    for (const s of again.sources) expect(s.counts, s.fileName).toMatchObject({ created: 0, failed: 0 });
    expect((await queryRecords(admin, typeKey, { limit: 1 })).total).toBe(recordsBefore);
    const peopleAfter = await people(admin, `legacy.${stamp}.`);
    expect(peopleAfter.map((p) => [p.userId, p.status, p.roles.join()])).toEqual(peopleBefore.map((p) => [p.userId, p.status, p.roles.join()]));
    expect((await people(admin, `@old-system.example`)).length).toBe(membersBefore + 3);
  });

  test('FT-MIG-906 deleting the source data removes the files and the failed-rows download', { tag: tags }, async () => {
    await page.goto(`/admin/migration/${profileId}/run`);
    await page.getByRole('button', { name: ui.purgeButton, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: ui.purgeConfirm, exact: true }).click();
    await expect(page.getByText(ui.purged).first()).toBeVisible();
    await expect(page.getByRole('button', { name: ui.downloadFailed })).toHaveCount(0);

    const purged = await view(admin, profileId);
    expect(purged.purgedAt).not.toBeNull();
    expect(purged.attachments.count).toBe(0);
    for (const s of purged.sources) {
      expect(s.purgedAt, `${s.fileName} purged`).not.toBeNull();
      expect((await admin.get(`/api/migrations/${profileId}/sources/${s.id}/failed.csv`)).status(), `${s.fileName} failed rows`).toBe(409);
    }
    // What was loaded stays.
    expect((await queryRecords(admin, typeKey, { limit: 1 })).total).toBeGreaterThanOrEqual(donorIds.length);
  });

  test('FT-MIG-907 someone without Migrate people cannot choose People', { tag: tags }, async ({ browser }) => {
    test.skip(!mail, noMailbox);
    test.setTimeout(120_000);
    const permissions = ['data:migrate', 'members:manage', `record:${typeKey}:import`];
    if ((await admin.get(`/api/admin/roles/${limitedRole}`)).status() === 404) await createRole(admin, limitedRole, 'E2E migrator without people', permissions);
    else await publishRole(admin, limitedRole, { permissions });
    limited = { email: `migrator.${stamp}@riverbank.example`, name: `Migrator ${stamp}` };
    limited.userId = await addMemberWithPassword(admin, mail!, { ...limited, roles: [limitedRole] });
    limited.api = await memberApi(limited.email);
    limited.context = await browser.newContext();
    const other = await limited.context.newPage();
    await signIn(other, limited.email, limited.name);

    const own = await body<Profile>(await limited.api.post('/api/migrations', { data: { name: `Limited ${stamp}` } }), 201, 'create profile as limited');
    await upload(limited.api, own.id, 'people.csv', csv([['UserId', 'Email', 'FullName'], ['U-1', email(9), personName(9)]]));
    const source = (await view(limited.api, own.id)).sources[0]!.id;

    // The API refuses a people mapping too.
    const refused = await limited.api.put(`/api/migrations/${own.id}/sources/${source}/mapping`, {
      data: { kind: 'people', people: { oldId: 'UserId', email: 'Email', name: 'FullName' } },
    });
    expect(refused.status()).toBe(403);

    await other.goto(`/admin/migration/${own.id}/map`);
    const people_ = other.getByRole('radio', { name: new RegExp(ui.kindPeople) });
    await expect(people_).toBeDisabled();
    await expect(other.getByRole('radio', { name: new RegExp(ui.kindRecords) })).toBeEnabled();
  });
});

// -------------------------------------------------------------------- helpers

async function upload(api: APIRequestContext, id: string, fileName: string, text: string): Promise<void> {
  const res = await api.post(`/api/migrations/${id}/sources`, {
    headers: { 'content-type': 'text/csv', 'x-file-name': encodeURIComponent(fileName) },
    data: Buffer.from(text, 'utf8'),
  });
  expect(res.status(), `upload ${fileName}: ${await res.text()}`).toBe(201);
}

async function view(api: APIRequestContext, id: string): Promise<Profile> {
  return body<Profile>(await api.get(`/api/migrations/${id}`), 200, `migration ${id}`);
}

async function mapPeople(api: APIRequestContext, id: string, sourceId: string): Promise<void> {
  await body(
    await api.put(`/api/migrations/${id}/sources/${sourceId}/mapping`, {
      data: {
        kind: 'people',
        people: { oldId: 'UserId', email: 'Email', name: 'FullName', roles: { column: 'Roles', separator: ';', map: { Viewer: 'viewer', Guest: null } } },
      },
    }),
    200,
    'map people',
  );
}

async function mapDonors(api: APIRequestContext, id: string, sourceId: string): Promise<void> {
  await body(
    await api.put(`/api/migrations/${id}/sources/${sourceId}/mapping`, {
      data: {
        targets: [
          {
            key: 'donor',
            type: typeKey,
            oldId: 'DonorId',
            fields: { name: 'Name' },
            refs: {},
            required: true,
            persons: { owner: { column: 'OwnerId', onMissing: 'blank' } },
            files: { photo: { column: 'Photo', onMissing: 'skip' } },
          },
        ],
      },
    }),
    200,
    'map donors',
  );
}

/** Members whose email or name contains the text. */
async function people(api: APIRequestContext, q: string): Promise<PersonView[]> {
  const page = await body<{ items: PersonView[] }>(await api.get(`/api/admin/people?q=${encodeURIComponent(q)}&limit=200`), 200, `people ${q}`);
  return page.items;
}

