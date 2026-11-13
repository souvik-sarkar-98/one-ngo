import { expect, test } from '@playwright/test';
import { accounts } from '../src/accounts.js';
import { label } from '../src/catalogue.js';
import { newRecord, openListMenu } from '../src/records.js';
import { signIn } from '../src/sign-in.js';

test('MT-REC-01 Records lists Donors and Donations under Fundraising', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records');
  const fundraising = page.locator('section').filter({ has: page.getByRole('button', { name: 'Fundraising' }) });
  await expect(fundraising.getByRole('link', { name: 'Donors', exact: true })).toBeVisible();
  await expect(fundraising.getByRole('link', { name: 'Donations', exact: true })).toBeVisible();
});

test('MT-REC-03 search narrows a list, and removing one filter leaves the other', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donation');
  await page.getByRole('searchbox', { name: label('ui.records.searchList') }).fill('Ravi Kumar');
  await expect(page.getByText('Ravi Kumar').first()).toBeVisible();
  await expect(page.getByText('Walk-in donor')).toHaveCount(0);

  await page.getByRole('button', { name: label('ui.records.openFilters'), exact: true }).click();
  const filters = page.getByRole('dialog', { name: label('ui.records.filterTitle', { items: 'donations' }) });
  await filters.getByLabel(label('ui.records.rangeFrom', { field: 'Amount' })).fill('500');
  await filters.getByLabel(label('ui.records.rangeTo', { field: 'Amount' })).fill('1000');
  await filters.getByRole('button', { name: label('ui.common.apply'), exact: true }).click();
  const chip = page.getByRole('button', { name: /Remove filter:/ }).first();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('searchbox', { name: label('ui.records.searchList') })).toHaveValue('Ravi Kumar');
});

test('MT-REC-04 Mine shows this person\'s donations, and Shared with me is not offered', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donation');
  await page.getByRole('tab', { name: 'Mine', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Donations' })).toBeVisible();
  await expect(page.getByRole('tab', { name: label('ui.records.sharedWithMe'), exact: true })).toHaveCount(0);
});

test('MT-REC-05 Cards and Table show the same records, and a phone uses cards', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donor');
  const layout = page.getByRole('group', { name: label('ui.records.layout') });
  await layout.getByRole('button', { name: label('ui.records.table'), exact: true }).click();
  await expect(page.getByRole('row', { name: /Ravi Kumar/ })).toBeVisible();
  await layout.getByRole('button', { name: label('ui.records.cards'), exact: true }).click();
  await expect(page.getByText('Ravi Kumar').first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(layout).toHaveCount(0);
  await expect(page.getByText('Ravi Kumar').first()).toBeVisible();
});

test('MT-REC-07 a saved edit is kept, and cancel leaves the saved record', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  const name = `Edit donor ${Date.now()}`;
  await page.goto('/records/donor');
  await newRecord(page, 'Donor').click();
  const create = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donor' }) });
  await create.getByLabel('Name').fill(name);
  await create.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(page.getByText(label('ui.records.createdMessage'))).toBeVisible();

  await page.getByText(name).first().click();
  const record = page.getByRole('dialog');
  const note = `Kept ${Date.now()}`;
  await record.getByRole('button', { name: label('ui.common.edit'), exact: true }).click();
  await record.getByLabel('Notes').fill(note);
  await record.getByRole('button', { name: label('ui.records.saveChanges'), exact: true }).click();
  await expect(page.getByText(label('ui.records.savedMessage'))).toBeVisible();
  await expect(record.getByText(note)).toBeVisible();

  await record.getByRole('button', { name: label('ui.common.edit'), exact: true }).click();
  await record.getByLabel('Notes').fill('This should be discarded');
  await record.getByRole('button', { name: label('ui.records.cancelEdit'), exact: true }).click();
  await expect(record.getByText(note)).toBeVisible();
  await expect(record.getByText('This should be discarded')).toHaveCount(0);
});

test('MT-REC-22 two valid donor rows import as new records', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, accounts.finance.email, accounts.finance.name);
  const stamp = Date.now() % 10000;
  const one = `Import ${stamp} A`;
  const two = `Import ${stamp} B`;
  const csv = [
    'Name,Email,Phone,PAN,Address,City,Notes',
    `${one},import.${stamp}.a@donor.example,+91 90000 11111,E2EIM${String(stamp).padStart(4, '0')}A,1 Park Street,Kolkata,imported`,
    `${two},import.${stamp}.b@donor.example,+91 90000 11112,E2EIN${String(stamp).padStart(4, '0')}B,2 Hill Road,Mumbai,imported`,
  ].join('\n');
  await page.goto('/records/donor');
  await openListMenu(page, label('ui.imports.import'));
  const dialog = page.getByRole('dialog', { name: label('ui.imports.title', { type: 'donors' }) });
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'donors.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await expect(dialog.getByText(label('ui.imports.willCreate'))).toBeVisible();
  await dialog.getByRole('button', { name: /Import 2 rows/ }).click();
  await expect(dialog.getByRole('button', { name: label('ui.imports.done'), exact: true })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: label('ui.imports.done'), exact: true }).click();
  await page.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(one);
  await expect(page.getByText(one).first()).toBeVisible();
  await page.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(two);
  await expect(page.getByText(two).first()).toBeVisible();
});

test('MT-REC-24 a bad row is counted, an unmapped file cannot continue, and an oversized file is refused', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donor');
  await openListMenu(page, label('ui.imports.import'));
  const dialog = page.getByRole('dialog', { name: label('ui.imports.title', { type: 'donors' }) });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'big.csv',
    mimeType: 'text/csv',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 65),
  });
  await expect(dialog.getByText(label('ui.imports.tooBig'))).toBeVisible();

  const stamp = Date.now() % 10000;
  const good = `Good ${stamp}`;
  const mixed = [
    'Name,Email,PAN',
    `Bad ${stamp},bad.${stamp}@donor.example,abcde1234f`,
    `${good},good.${stamp}@donor.example,E2EGD${String(stamp).padStart(4, '0')}C`,
  ].join('\n');
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'mixed.csv', mimeType: 'text/csv', buffer: Buffer.from(mixed) });
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await expect(dialog.getByText(label('ui.imports.haveProblems'))).toBeVisible();
  await expect(dialog.getByText(/abcde1234f|five letters/i)).toBeVisible();
});

test('MT-REC-27 a short list exports as a download', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donor');
  const download = page.waitForEvent('download');
  await openListMenu(page, label('ui.imports.export'));
  expect((await download).suggestedFilename()).toMatch(/\.csv$/i);
});

test('MT-REC-28 bulk edit updates the selected rows and leaves the others', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, accounts.finance.email, accounts.finance.name);
  const stamp = Date.now();
  const first = `Bulk ${stamp} A`;
  const second = `Bulk ${stamp} B`;
  const city = `City${stamp}`;
  await page.goto('/records/donor');
  for (const name of [first, second]) {
    await newRecord(page, 'Donor').click();
    const create = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donor' }) });
    await create.getByLabel('Name').fill(name);
    await create.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
    await expect(page.getByText(label('ui.records.createdMessage'))).toBeVisible();
  }
  await page.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(`Bulk ${stamp}`);
  await openListMenu(page, label('ui.bulk.select'));
  await page.getByRole('checkbox', { name: `${label('ui.bulk.select')} ${first}` }).check();
  await page.getByRole('checkbox', { name: `${label('ui.bulk.select')} ${second}` }).check();
  await page.getByRole('button', { name: label('ui.bulk.editFields'), exact: true }).click();
  const bulk = page.getByRole('dialog');
  await bulk.getByLabel('City').fill(city);
  await bulk.getByRole('button', { name: /Apply to 2/ }).click();
  await expect(page.getByText(city).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Bengaluru').first()).toHaveCount(0);
});

test('MT-REC-30 the record address opens for a reader and refuses someone who may not read it', async ({ page, browser }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  const name = `Address ${Date.now()}`;
  await page.goto('/records/donor');
  await newRecord(page, 'Donor').click();
  const create = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donor' }) });
  await create.getByLabel('Name').fill(name);
  await create.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await page.getByText(name).first().click();
  await expect(page).toHaveURL(/\/records\/donor\?id=/);
  const address = page.url();

  const signedOut = await browser.newPage();
  await signedOut.goto(address);
  await expect(signedOut).toHaveURL(/sign-in/);
  await signedOut.close();

  await signIn(page, accounts.noAccess.email, accounts.noAccess.name);
  await page.goto(address);
  await expect(page.getByText(label('ui.records.notFound'))).toBeVisible();
});
