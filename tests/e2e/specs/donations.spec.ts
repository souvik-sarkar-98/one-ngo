import { expect, test, type Page } from '@playwright/test';
import { accounts } from '../src/accounts.js';
import { label } from '../src/catalogue.js';
import { dayLabel, newRecord, todayLabel } from '../src/records.js';
import { knownDefect } from '../src/shell.js';
import { signIn } from '../src/sign-in.js';

const panMessage = 'Enter the PAN as five letters, four digits and a letter, for example ABCDE1234F.';
const feeMessage = 'The processing fee cannot be more than the donation.';
const futureMessage = 'The payment date cannot be in the future.';
const upiMessage = 'Enter the UPI transaction reference.';

test('MT-DON-01 Finance sees Donors and Donations under Fundraising', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records');
  const fundraising = page.locator('section').filter({ has: page.getByRole('button', { name: 'Fundraising' }) });
  await expect(fundraising.getByRole('link', { name: 'Donors', exact: true })).toBeVisible();
  await expect(fundraising.getByRole('link', { name: 'Donations', exact: true })).toBeVisible();
});

test('MT-DON-03 and MT-DON-04 a donor gets a DNR number, and a bad or duplicate PAN is refused', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  const name = `Pan donor ${Date.now()}`;
  const pan = nextPan();
  await page.goto('/records/donor');
  const dialog = await startDonor(page);
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Email').fill(`${Date.now()}@donor.example`);
  await dialog.getByLabel('Phone').fill('+91 90000 30001');
  await dialog.getByLabel('City').fill('Bengaluru');
  await dialog.getByLabel('PAN').fill(pan);
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(page.getByText(label('ui.records.createdMessage'))).toBeVisible();
  await page.getByText(name).first().click();
  await expect(page.getByRole('dialog').getByText(/DNR\/\d{5}/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: label('ui.common.close'), exact: true }).click();

  const again = await startDonor(page);
  await again.getByLabel('Name').fill(`${name} lower`);
  await again.getByLabel('PAN').fill(pan.toLowerCase());
  await again.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(again.getByText(panMessage)).toBeVisible();
  await again.getByLabel('PAN').fill('ABCDE12345');
  await again.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(again.getByText(panMessage)).toBeVisible();
  await again.getByLabel('PAN').fill('ABCDE1234F');
  await again.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(again.getByText(/PAN|already|unique/i)).toBeVisible();
  await expect(page.getByText(label('ui.records.createdMessage'))).toHaveCount(0);
});

test('MT-DON-05 a linked donation copies the donor, locks the copy, and shows the net', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donation');
  await page.getByRole('tab', { name: 'Outstanding', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donation' }) });
  await newRecord(page, 'Donation').click();
  await dialog.getByRole('combobox', { name: 'Donor' }).fill('Ravi Kumar');
  await page.getByRole('option', { name: /Ravi Kumar/ }).first().click();
  await expect(dialog.getByLabel('Donor name')).toBeDisabled();
  await expect(dialog.getByLabel('Donor PAN')).toHaveValue('ABCDE1234F');
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await dialog.getByLabel('Amount').fill('1000');
  await dialog.getByLabel('Processing fee').fill('10');
  await expect(dialog.getByText('990')).toBeVisible();
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(page.getByText(label('ui.records.createdMessage'))).toBeVisible();
  await page.getByText('Ravi Kumar').first().click();
  const record = page.getByRole('dialog');
  await expect(record.getByText('Raised', { exact: true }).first()).toBeVisible();
  await expect(record.getByText(/DON\/\d{4}-\d{2}\/\d{5}/)).toBeVisible();
  await expect(record.getByText('990')).toBeVisible();
});

test('MT-DON-06 a processing fee above the amount is refused', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donation');
  const dialog = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donation' }) });
  await newRecord(page, 'Donation').click();
  await dialog.getByLabel('Donor name').fill(`Fee donor ${Date.now()}`);
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await dialog.getByLabel('Amount').fill('1000');
  await dialog.getByLabel('Processing fee').fill('1001');
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(dialog.getByText(feeMessage)).toBeVisible();
});

test('MT-DON-07 an amount below 1 is refused while the donation is raised', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donation');
  const dialog = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donation' }) });
  await newRecord(page, 'Donation').click();
  await dialog.getByLabel('Donor name').fill(`Zero donor ${Date.now()}`);
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await dialog.getByLabel('Amount').fill('0');
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByText(label('ui.records.createdMessage'))).toHaveCount(0);
});

test('MT-DON-09 a payment date after today is refused', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, accounts.finance.email, accounts.finance.name);
  const donor = `Future donor ${Date.now()}`;
  await page.goto('/records/donation');
  const dialog = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donation' }) });
  await newRecord(page, 'Donation').click();
  await dialog.getByLabel('Donor name').fill(donor);
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await dialog.getByLabel('Amount').fill('1000');
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await page.getByText(donor).first().click();
  await page.getByRole('button', { name: 'Mark as paid', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Mark as paid' });
  await sheet.getByRole('combobox', { name: 'Payment method' }).click();
  await page.getByRole('option', { name: 'Bank transfer' }).click();
  await sheet.getByLabel('Paid on').click();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = page.getByRole('button', { name: dayLabel(tomorrow), exact: true });
  if ((await day.count()) === 0) await page.getByRole('button', { name: /Next month/i }).click();
  await page.getByRole('button', { name: dayLabel(tomorrow), exact: true }).click();
  await sheet.getByRole('button', { name: 'Mark as paid', exact: true }).click();
  await expect(page.getByText(futureMessage)).toBeVisible();
  await expect(page.getByText('Raised', { exact: true }).first()).toBeVisible();
});

test('MT-DON-10 UPI needs a reference, and the form has a place to enter one', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, accounts.finance.email, accounts.finance.name);
  const donor = `Upi donor ${Date.now()}`;
  await page.goto('/records/donation');
  const dialog = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donation' }) });
  await newRecord(page, 'Donation').click();
  await dialog.getByLabel('Donor name').fill(donor);
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await dialog.getByLabel('Amount').fill('1000');
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await page.getByText(donor).first().click();
  await page.getByRole('button', { name: 'Mark as paid', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Mark as paid' });
  const reference = sheet.getByLabel('Payment reference');
  if ((await reference.count()) === 0) knownDefect('DEF-07', 'UPI requires a reference, and the Mark as paid form has no field to enter one.');
  await expect(reference).toBeVisible();
  await sheet.getByRole('combobox', { name: 'Payment method' }).click();
  await page.getByRole('option', { name: 'UPI', exact: true }).click();
  await sheet.getByLabel('Paid on').click();
  await page.getByRole('button', { name: todayLabel(), exact: true }).click();
  await sheet.getByRole('button', { name: 'Mark as paid', exact: true }).click();
  await expect(page.getByText(upiMessage)).toBeVisible();
  await reference.fill(`UPI${Date.now()}`);
  await sheet.getByRole('button', { name: 'Mark as paid', exact: true }).click();
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
});

test('MT-DON-11 Cancel moves a raised donation to Cancelled, and a cancelled donation has no further step', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  const donor = `Cancel donor ${Date.now()}`;
  await page.goto('/records/donation');
  const dialog = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donation' }) });
  await newRecord(page, 'Donation').click();
  await dialog.getByLabel('Donor name').fill(donor);
  await dialog.getByRole('button', { name: label('ui.common.next'), exact: true }).click();
  await dialog.getByLabel('Amount').fill('1000');
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await page.getByText(donor).first().click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Cancel' });
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as paid', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
});

test('MT-REC-18 Finance can send a reminder from the record, and Viewer cannot', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donation');
  await page.getByRole('tab', { name: 'Outstanding', exact: true }).click();
  await page.getByText('Ravi Kumar').first().click();
  await expect(page.getByRole('button', { name: 'Send reminder', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await signIn(page, accounts.viewer.email, accounts.viewer.name);
  await page.goto('/records/donation');
  await page.getByText('Ravi Kumar').first().click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Send reminder', exact: true })).toHaveCount(0);
});

test('MT-DON-15 Finance can print a receipt, and someone without the action is refused', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donation');
  await page.getByRole('tab', { name: 'Closed', exact: true }).click();
  await page.getByText('Paid', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Print receipt', exact: true }).click();
  await expect(page).toHaveURL(/\/print\/receipt\//);
  await expect(page.getByText(/RCPT/)).toBeVisible();
  const receipt = page.url();

  await signIn(page, accounts.viewer.email, accounts.viewer.name);
  await page.goto(receipt);
  const showsReceipt = page.url().includes('/print/receipt/') && (await page.getByText(/RCPT/).count()) > 0;
  if (showsReceipt) knownDefect('DEF-08', 'Viewer can open /print/receipt/{id} without the Print receipt action.');
  await expect(page.getByText(/RCPT/)).toHaveCount(0);
});

async function startDonor(page: Page) {
  await newRecord(page, 'Donor').click();
  return page.getByRole('dialog', { name: label('ui.records.createTitle', { type: 'donor' }) });
}

function nextPan(): string {
  const digits = String(Date.now() % 10000).padStart(4, '0');
  return `E2EPN${digits}A`;
}
