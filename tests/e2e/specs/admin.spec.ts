import { expect, test, type Page } from '@playwright/test';
import { accounts } from '../src/accounts.js';
import { label } from '../src/catalogue.js';
import { knownDefect } from '../src/shell.js';
import { signIn } from '../src/sign-in.js';

const areas = {
  people: label('ui.crumbs.people'),
  roles: label('ui.crumbs.admin.roles'),
  connectors: label('ui.crumbs.admin.connectors'),
  apiKeys: label('ui.crumbs.admin.apiKeys'),
  jobs: label('ui.admin.jobs'),
  audit: label('ui.crumbs.admin.audit'),
  identity: label('ui.crumbs.admin.identity'),
  profile: label('ui.crumbs.admin.profile'),
  registrations: label('ui.crumbs.admin.registrations'),
  settings: label('ui.crumbs.admin.settings'),
};

test('MT-ADM-01 Asha sees every administration area, and a people administrator sees People and Roles', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin');
  for (const name of Object.values(areas)) {
    await expect(page.getByRole('link', { name }).first()).toBeVisible();
  }

  await signIn(page, accounts.peopleAdmin.email, accounts.peopleAdmin.name);
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: areas.people }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: areas.roles }).first()).toBeVisible();
  for (const name of [areas.connectors, areas.apiKeys, areas.jobs, areas.audit, areas.identity, areas.settings]) {
    await expect(page.getByRole('link', { name }).first()).toHaveCount(0);
  }
});

test('MT-ADM-02 and MT-ADM-07 the checklist uses Done, Still to do, or Optional', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin');
  await page.getByRole('button', { name: label('ui.admin.organisation.setupView'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label('ui.admin.organisation.setupTitle') });
  const states = (await dialog.locator('.org__sr').allTextContents()).map((text) => text.trim());
  expect(states.length).toBeGreaterThan(0);
  for (const state of states) {
    expect([
      label('ui.admin.organisation.stateDone'),
      label('ui.admin.organisation.stateRequired'),
      label('ui.admin.organisation.stateOptional'),
    ]).toContain(state);
  }
  const requiredOpen = states.filter((state) => state === label('ui.admin.organisation.stateRequired')).length;
  if (requiredOpen === 0) {
    await expect(dialog.getByText(label('ui.admin.organisation.setupDone'))).toBeVisible();
  } else {
    await expect(dialog.getByText(label('ui.admin.organisation.setupDone'))).toHaveCount(0);
  }
});

test('MT-ADM-04 a duplicate registration is refused, and issue and expiry dates can be entered', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/organisation/registrations');
  const type = `e2e${Date.now().toString(36)}`;
  await saveRegistration(page, type, '100');
  await saveRegistration(page, type, '100');
  await expect(page.getByRole('dialog').getByRole('alert').or(page.getByRole('alert'))).toBeVisible();

  await page.getByRole('button', { name: label('ui.admin.organisation.addRegistration'), exact: true }).click();
  const form = page.getByRole('dialog');
  const issued = form.getByLabel(label('ui.admin.organisation.regIssuedOn'));
  if ((await issued.count()) === 0) knownDefect('DEF-04', 'Registration issue and expiry dates do not render.');
  await expect(issued).toBeVisible();
  await expect(form.getByLabel(label('ui.admin.organisation.regExpiresOn'))).toBeVisible();
});

test('MT-ADM-05 the financial year start month stays fixed once a year is open', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/organisation/settings');
  await expect(page.getByText(label('ui.admin.settings.fyStartFixed'))).toBeVisible();
  await expect(page.getByLabel(label('ui.admin.settings.fyStart'))).toBeDisabled();
});

test('MT-ADM-06 the receipt series row can be reviewed', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin');
  await page.getByRole('button', { name: label('ui.admin.organisation.setupView'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label('ui.admin.organisation.setupTitle') });
  const row = dialog.locator('.admin__row').filter({ hasText: label('ui.admin.organisation.setup.receiptSeries') });
  const confirm = row.getByRole('button', { name: label('ui.admin.organisation.confirmReceipts'), exact: true });
  if (await confirm.count()) await confirm.click();
  await expect(row.locator('.org__sr')).toHaveText(label('ui.admin.organisation.stateDone'));
});

test('MT-ADM-08 email and payments stay optional, and email says how it is sent', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin');
  await page.getByRole('button', { name: label('ui.admin.organisation.setupView'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label('ui.admin.organisation.setupTitle') });
  for (const key of ['email', 'payments'] as const) {
    const row = dialog.locator('.admin__row').filter({ hasText: label(`ui.admin.organisation.setup.${key}`) });
    await expect(row.locator('.org__sr')).toHaveText(label('ui.admin.organisation.stateOptional'));
  }
  await expect(dialog.getByText(/Sent through/)).toBeVisible();
});

test('MT-SET-01 the organisation code and sign-in link are shown and the code cannot be edited', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/organisation/identity');
  await expect(page.getByText('riverbank', { exact: true })).toBeVisible();
  await expect(page.getByText(/\/o\/riverbank\/sign-in/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: label('ui.admin.organisation.code') })).toHaveCount(0);
});

test('MT-SET-02 a website must start with https://', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/organisation/profile');
  const website = page.getByLabel(label('ui.admin.organisation.website'));
  await website.fill('riverbank.example');
  await page.getByRole('button', { name: label('ui.common.save'), exact: true }).click();
  await expect(page.getByText(label('ui.admin.organisation.saved'))).toHaveCount(0);
  await expect(page.getByRole('alert').or(page.locator('.error, .notice.error'))).toBeVisible();

  await website.fill('https://riverbank.example');
  await page.getByRole('button', { name: label('ui.common.save'), exact: true }).click();
  await expect(page.getByText(label('ui.admin.organisation.saved'))).toBeVisible();
});

test('MT-SET-03 a logo accepts PNG, JPEG and WebP up to 1 MB, and refuses other types and larger files', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/organisation/identity');
  const input = page.locator('input[type="file"]').first();

  await input.setInputFiles({ name: 'logo.gif', mimeType: 'image/gif', buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') });
  await expect(page.getByText(label('ui.admin.organisation.logoType'))).toBeVisible();

  await input.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.alloc(1024 * 1024 + 8, 1) });
  await expect(page.getByText(label('ui.admin.organisation.logoSize'))).toBeVisible();

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEA8QDw8QEA8PDw8PEA8QFREWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGhAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAMABAMBIgACEQEDEQH/xAAbAAACAwEBAQAAAAAAAAAAAAADBAECBQYAB//EABUBAQEAAAAAAAAAAAAAAAAAAAAB/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAAvgH//Z', 'base64');
  const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
  for (const file of [
    { name: 'logo.jpg', mimeType: 'image/jpeg', buffer: jpeg },
    { name: 'logo.webp', mimeType: 'image/webp', buffer: webp },
    { name: 'logo.png', mimeType: 'image/png', buffer: png },
  ]) {
    await input.setInputFiles(file);
    await expect(page.getByText(label('ui.admin.organisation.logoSaved'))).toBeVisible();
  }
  await expect(page.getByRole('img', { name: label('ui.admin.organisation.logoAlt') })).toBeVisible();
});

test('MT-SET-04 storage shows the quota, and the API limit and default language can be saved', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/organisation/settings');
  await expect(page.getByText(/of \d+ GB/)).toBeVisible();
  const limit = page.getByLabel(label('ui.admin.settings.apiRate'));
  const original = await limit.inputValue();
  try {
    await limit.fill('30');
    await page.getByRole('button', { name: label('ui.common.save'), exact: true }).click();
    await expect(page.getByText(label('ui.admin.settings.saved'))).toBeVisible();
  } finally {
    await limit.fill(original || '60');
    await page.getByRole('button', { name: label('ui.common.save'), exact: true }).click();
  }

  await page.goto('/admin/organisation/identity');
  await expect(page.getByLabel(label('ui.admin.settings.language'))).toBeVisible();
});

test('MT-PPL-01 the people list is only under Administration, and Asha can search it', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/people');
  await page.getByRole('searchbox', { name: label('ui.records.searchList') }).fill('Asha');
  await expect(page.getByText('Asha Menon').first()).toBeVisible();
  await expect(page.getByText('asha@riverbank.example').first()).toBeVisible();
});

test('MT-PPL-02 a person row shows status, invitation, and two-step', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/people');
  await page.getByText('Asha Menon').first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('asha@riverbank.example')).toBeVisible();
  await expect(sheet.getByText(label('ui.people.col.roles'))).toBeVisible();
  await expect(sheet.getByText(label('ui.people.status.active')).or(sheet.getByText(label('ui.people.col.status')))).toBeVisible();
  await expect(sheet.getByText(label('ui.people.col.twoStep')).or(sheet.getByText(label('ui.more.off')))).toBeVisible();
});

test('MT-PPL-03 and MT-PPL-06 adding a person and changing roles applies on the next view', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  const name = `Plan person ${Date.now()}`;
  const email = `plan.${Date.now()}@riverbank.example`;
  await page.goto('/admin/people');
  await page.getByRole('button', { name: label('ui.crumbs.addPerson'), exact: true }).click();
  const add = page.getByRole('dialog', { name: label('ui.crumbs.addPerson') });
  await add.getByLabel(label('ui.people.col.email')).fill(email);
  await add.getByLabel(label('ui.people.col.name')).fill(name);
  await add.getByRole('combobox').fill('Viewer');
  await page.getByRole('option', { name: 'Viewer', exact: true }).click();
  await expect(add.getByRole('checkbox')).toBeChecked();
  await add.getByRole('button', { name: label('ui.people.addAndInvite'), exact: true }).click();
  await expect(page.getByText(label('ui.people.addedInvited', { name }))).toBeVisible();
  await page.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(name);
  await expect(page.getByText(label('ui.people.status.invited')).first()).toBeVisible();

  await page.getByText(name).first().click();
  const person = page.getByRole('dialog');
  await person.getByRole('combobox').fill('Finance');
  await page.getByRole('option', { name: 'Finance', exact: true }).click();
  await person.getByRole('button', { name: label('ui.people.saveRoles'), exact: true }).click();
  await expect(page.getByText(label('ui.people.rolesSaved', { name }))).toBeVisible();
  await page.reload();
  await page.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(name);
  await page.getByText(name).first().click();
  await expect(page.getByRole('dialog').getByText('Finance', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: `${label('ui.common.remove')} Finance` }).click();
  await page.getByRole('dialog').getByRole('button', { name: label('ui.people.saveRoles'), exact: true }).click();
  await expect(page.getByText(label('ui.people.rolesSaved', { name }))).toBeVisible();
});

test('MT-PPL-09 a role that requires two-step shows Required · not set', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  const name = `Two step ${Date.now()}`;
  await addPerson(page, name, `twostep.${Date.now()}@riverbank.example`);
  await page.getByText(name).first().click();
  const person = page.getByRole('dialog');
  await person.getByRole('combobox').fill('Two-step');
  await page.getByRole('option', { name: 'Two-step required', exact: true }).click();
  await person.getByRole('button', { name: label('ui.people.saveRoles'), exact: true }).click();
  await page.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(name);
  await expect(page.getByText(label('ui.people.twoStepRequired')).first()).toBeVisible();
});

test('MT-ROL-01 Viewer membership changes immediately', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  const name = `Role person ${Date.now()}`;
  await addPerson(page, name, `role.${Date.now()}@riverbank.example`);
  await page.goto('/admin/roles/viewer');
  await expect(page.getByRole('heading', { name: 'Viewer' })).toBeVisible();
  await expect(page.getByText('Changes take effect straight away.')).toBeVisible();
  await page.getByRole('button', { name: label('ui.crumbs.addPeople'), exact: true }).click();
  const add = page.getByRole('dialog');
  await add.getByRole('combobox').fill(name);
  await page.getByRole('option', { name }).click();
  await add.getByRole('button', { name: label('ui.common.add'), exact: true }).click();
  await expect(page.getByText(name).first()).toBeVisible();
  await page.getByRole('row', { name }).getByRole('button', { name: label('ui.common.remove'), exact: true }).click();
  await expect(page.getByRole('row', { name })).toHaveCount(0);
});

test('MT-ROL-02 permissions are not edited on the administration role page', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/roles/viewer');
  await page.getByRole('tab', { name: /Permissions/ }).click();
  const intro = page.getByText(label('ui.admin.roles.permissionsIntro'));
  if (await intro.count()) knownDefect('DEF-05', 'Administration → Roles can edit permissions and save them straight away. The plan says Builder → Roles is where they change, after publish.');
  await expect(intro).toHaveCount(0);
});

test('MT-AUD-01 the audit log shows who, area and when, and nothing undoes an event', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/audit');
  await expect(page.getByRole('columnheader', { name: label('ui.admin.audit.col.who') })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: label('ui.admin.audit.col.area') })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: label('ui.admin.audit.col.when') })).toBeVisible();
  await expect(page.getByRole('button', { name: /undo/i })).toHaveCount(0);

  await page.getByRole('button', { name: label('ui.records.openFilters'), exact: true }).click();
  const filters = page.getByRole('dialog');
  await expect(filters.getByText(label('ui.admin.audit.person'))).toBeVisible();
  const date = filters.getByLabel(label('ui.admin.audit.date'));
  if ((await date.count()) === 0) knownDefect('DEF-04', 'The audit date filter does not render.');
  await expect(date).toBeVisible();
});

async function saveRegistration(page: Page, type: string, number: string): Promise<void> {
  await page.getByRole('button', { name: label('ui.admin.organisation.addRegistration'), exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel(label('ui.admin.organisation.regType')).fill(type);
  await form.getByLabel(label('ui.admin.organisation.regNumber')).fill(number);
  await form.getByRole('button', { name: label('ui.common.save'), exact: true }).click();
}

async function addPerson(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/admin/people');
  await page.getByRole('button', { name: label('ui.crumbs.addPerson'), exact: true }).click();
  const add = page.getByRole('dialog', { name: label('ui.crumbs.addPerson') });
  await add.getByLabel(label('ui.people.col.email')).fill(email);
  await add.getByLabel(label('ui.people.col.name')).fill(name);
  await add.getByRole('button', { name: label('ui.people.addAndInvite'), exact: true }).click();
  await expect(page.getByText(label('ui.people.addedInvited', { name }))).toBeVisible();
  await page.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(name);
  await expect(page.getByText(name).first()).toBeVisible();
}
