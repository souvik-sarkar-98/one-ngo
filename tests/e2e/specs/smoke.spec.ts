import { expect, test } from '@playwright/test';
import { accounts, apiBase } from '../src/accounts.js';
import { label } from '../src/catalogue.js';
import { newRecord, todayLabel } from '../src/records.js';
import { expectDestination } from '../src/shell.js';
import { openUnknownOrganisation, signIn } from '../src/sign-in.js';

test('MT-AUTH-07 Asha signs in and sees the places her role allows', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.waitForURL((url) => url.pathname === '/');
  await expectDestination(page, label('ui.nav.home'), true);
  await expectDestination(page, label('ui.nav.records'), true);
  await expectDestination(page, label('ui.nav.inbox'), true);
  await expectDestination(page, label('ui.crumbs.administration'), true);
  await expectDestination(page, label('ui.builder.title'), true);
});

test('MT-AUTH-09 an unknown organisation code is not available for sign-in', async ({ page }) => {
  await openUnknownOrganisation(page, 'no-such-org');
});

test('MT-NAV-02 a directory member is not shown a people list', async ({ page }) => {
  await signIn(page, accounts.directory.email, accounts.directory.name);
  await expectDestination(page, label('ui.crumbs.people'), false);
  await expectDestination(page, label('ui.more.peopleDirectory'), false);
  await page.goto('/people');
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('heading', { name: label('ui.crumbs.administration') })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: label('ui.crumbs.people') })).toHaveCount(0);
});

test('MT-NAV-06 no-access home and Finance home', async ({ page }) => {
  await test.step('no-access member is told to ask for a role', async () => {
    await signIn(page, accounts.noAccess.email, accounts.noAccess.name);
    await expect(page.getByText(label('ui.home.noAccess'))).toBeVisible();
  });
  await test.step('Finance is greeted and can open Records', async () => {
    await signIn(page, accounts.finance.email, accounts.finance.name);
    await expect(page.getByText(label('ui.home.welcome', { name: accounts.finance.name }))).toBeVisible();
    await expect(page.getByText(label('ui.home.noAccess'))).toHaveCount(0);
    await expectDestination(page, label('ui.nav.records'), true);
    await expectDestination(page, label('ui.crumbs.administration'), false);
    await expectDestination(page, label('ui.builder.title'), false);
  });
});

test('MT-DON-02 Viewer can read donors and donations and cannot change them', async ({ page }) => {
  await signIn(page, accounts.viewer.email, accounts.viewer.name);

  await page.goto('/records/donor');
  await expect(page.getByRole('heading', { name: 'Donors' })).toBeVisible();
  await expect(newRecord(page, 'Donor')).toHaveCount(0);
  await page.getByText('Ravi Kumar', { exact: true }).first().click();
  const donor = page.getByRole('dialog');
  await expect(donor.getByRole('button', { name: label('ui.common.edit'), exact: true })).toHaveCount(0);

  await page.goto('/records/donation');
  await expect(page.getByRole('heading', { name: 'Donations' })).toBeVisible();
  await expect(newRecord(page, 'Donation')).toHaveCount(0);
  await page.getByText('Ravi Kumar').first().click();
  const donation = page.getByRole('dialog');
  for (const action of ['Mark as paid', 'Cancel', 'Send reminder', label('ui.common.edit')]) {
    await expect(donation.getByRole('button', { name: action, exact: true })).toHaveCount(0);
  }
});

test('MT-REC-06 a donor names a missing required field, then saves', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donor');
  const dialog = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donor' }) });
  await newRecord(page, 'Donor').click();
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(dialog.getByText(label('ui.records.required', { field: 'Name' }))).toBeVisible();

  const name = `Smoke donor ${Date.now()}`;
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(page.getByText(label('ui.records.createdMessage'))).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
});

test('MT-DON-08 and MT-DON-12 Finance marks a donation paid and a receipt is issued', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donation');
  const donorName = `Smoke donor ${Date.now()}`;

  await test.step('MT-DON-08 mark a raised donation paid', async () => {
    const dialog = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donation' }) });
    await newRecord(page, 'Donation').click();
    await dialog.getByLabel('Donor name').fill(donorName);
    await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
    await dialog.getByLabel('Amount').fill('1000');
    await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
    await expect(page.getByText(label('ui.records.createdMessage'))).toBeVisible();
    await page.getByText(donorName).first().click();
    await page.getByRole('button', { name: 'Mark as paid', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Mark as paid' });
    await sheet.getByRole('combobox', { name: 'Payment method' }).click();
    await page.getByRole('option', { name: 'Bank transfer' }).click();
    await sheet.getByLabel('Paid on').click();
    await page.getByRole('button', { name: todayLabel(), exact: true }).click();
    await sheet.getByRole('button', { name: 'Mark as paid', exact: true }).click();
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
  });

  await test.step('MT-DON-12 the receipt uses the RCPT series', async () => {
    await expect(page.getByText(/RCPT/).first()).toBeVisible();
  });
});

test('MT-KEY-01 an API key secret works once, then revoke refuses it', async ({ page, request }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await page.goto('/admin/api-keys');
  const keyName = `ledger-reader-${Date.now()}`;
  await page.getByRole('button', { name: label('ui.crumbs.newApiKey'), exact: true }).click();
  const create = page.getByRole('dialog', { name: label('ui.crumbs.newApiKey') });
  await create.getByLabel(label('ui.admin.keys.col.name')).fill(keyName);
  await create.getByRole('combobox', { name: label('ui.admin.keys.role') }).click();
  await page.getByRole('option', { name: 'Viewer', exact: true }).click();
  await create.getByRole('button', { name: label('ui.admin.keys.create'), exact: true }).click();

  const created = page.getByRole('dialog', { name: label('ui.admin.keys.created') });
  await expect(created.getByText(label('ui.admin.keys.copyNow'))).toBeVisible();
  await expect(created.getByText('Authorization: ApiKey')).toBeVisible();
  const token = (await created.innerText()).match(/[0-9a-f-]{36}\.\S+/i)?.[0];
  expect(token, 'secret shown once').toBeTruthy();

  const query = () =>
    request.post(`${apiBase}/api/records/donor/query`, {
      headers: { authorization: `ApiKey ${token}` },
      data: {},
    });
  expect((await query()).ok()).toBe(true);

  await created.getByRole('button', { name: label('ui.admin.keys.done') }).click();
  await page.reload();
  await expect(page.getByText(label('ui.admin.keys.copyNow'))).toHaveCount(0);
  await expect(page.getByText(token!)).toHaveCount(0);

  await page.getByRole('row', { name: keyName }).getByRole('button', { name: label('ui.common.moreActions') }).click();
  await page.getByRole('menuitem', { name: label('ui.admin.keys.revoke') }).click();
  await page.getByRole('dialog').getByRole('button', { name: label('ui.admin.keys.revoke'), exact: true }).click();
  await expect(page.getByText(label('ui.admin.keys.revokedMsg', { name: keyName }))).toBeVisible();
  expect((await query()).status()).toBeGreaterThanOrEqual(400);
});
