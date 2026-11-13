import { expect, test, type APIRequestContext, type APIResponse, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { memberApi, runTag } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import { newRecord } from '../../../src/records.js';
import { knownDefect } from '../../../src/shell.js';
import { signIn } from '../../../src/sign-in.js';
import {
  addDays,
  choosePaymentMethod,
  createDialog,
  createRecordApi,
  escapeRegExp,
  expectDonationPosting,
  findRecords,
  fiscalYear,
  getRecord,
  messages,
  openMarkAsPaid,
  pickDate,
  postingsFor,
  postingTables,
  receiptsOf,
  refused,
  sequenceOf,
  settledEmail,
  submitMarkAsPaid,
  tags,
  tenantSnapshot,
  transition,
  tryCreate,
  tryTransition,
  tryUpdate,
  uniquePan,
  utcToday,
  type Receipt,
} from '../../../src/journeys/donation.js';

const JOURNEY = 'FT-E2E-02';
const t = (id: string, priority: 'P0' | 'P1' | 'P2') => ({ tag: tags(JOURNEY, id, priority) });

const tag = runTag('E2E02');
const donorName = `E2E02 Donor ${tag}`;
const donorEmail = `${tag.toLowerCase()}@donor.example`;
const donorPhone = '+91 90000 40002';
const pan = uniquePan();
const walkIn = `E2E02 Walkin ${tag}`;
const paidOn = utcToday();
const fy = fiscalYear(paidOn);
const createdFy = fiscalYear(utcToday());
const thanksSubject = `Thank you for your donation, ${donorName}`;
const reminderSubject = `A reminder about your pledge, ${donorName}`;

const state = {
  donorId: '',
  mainId: '',
  mainNumber: '',
  walkInId: '',
  reminderId: '',
  reminderNumber: '',
  receipt: undefined as Receipt | undefined,
  receiptUrl: '',
  publicPath: '',
  /** Every donation of this donor that the journey has marked paid, with the account its posting debits. */
  paid: [] as { id: string; amount: number; debit: 'BANK' | 'CASH' }[],
};

let appBase: string;
let context: BrowserContext;
let page: Page;
let finance: APIRequestContext;
let admin: APIRequestContext;
let viewerContext: BrowserContext | undefined;
let viewerPage: Page;
let viewer: APIRequestContext | undefined;

const create = () => label('ui.common.create');
const next = () => label('ui.common.next');
const createdMessage = () => page.getByText(label('ui.records.createdMessage'));
const searchbox = (p: Page) => p.getByRole('searchbox', { name: label('ui.records.searchList') });
const panelOf = (p: Page, title: string) => p.getByRole('dialog', { name: title });

async function openRecord(p: Page, type: 'donor' | 'donation', id: string, title: string): Promise<Locator> {
  await p.goto(`/records/${type}?id=${id}`);
  const panel = panelOf(p, title);
  await expect(panel).toBeVisible();
  return panel;
}

async function useTable(p: Page): Promise<void> {
  const layout = p.getByRole('group', { name: label('ui.records.layout') });
  if (await layout.count()) await layout.getByRole('button', { name: label('ui.records.table'), exact: true }).click();
}

async function openDonorCreate(): Promise<Locator> {
  await page.goto('/records/donor');
  await newRecord(page, 'Donor').click();
  const dialog = createDialog(page, 'donor');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openDonationCreate(): Promise<Locator> {
  await page.goto('/records/donation');
  await newRecord(page, 'Donation').click();
  const dialog = createDialog(page, 'donation');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function signedOutPage(): Promise<{ ctx: BrowserContext; p: Page }> {
  const ctx = await context.browser()!.newContext({ baseURL: appBase });
  return { ctx, p: await ctx.newPage() };
}

test.describe.serial('FT-E2E-02 Donation to receipt', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ browser }, testInfo) => {
    appBase = testInfo.project.use.baseURL ?? process.env.APP_BASE_URL ?? 'http://localhost:4200';
    context = await browser.newContext({ baseURL: appBase, viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    page = await context.newPage();
    await signIn(page, accounts.finance.email, accounts.finance.name);
    finance = await memberApi(accounts.finance.email);
    admin = await memberApi(accounts.admin.email);
  });

  test.afterAll(async () => {
    await viewer?.dispose();
    await viewerContext?.close();
    await finance?.dispose();
    await admin?.dispose();
    await context?.close();
  });

  // Open the lists

  test('FT-REC-001 Records holds Donors then Donations under Fundraising', t('FT-REC-001', 'P0'), async () => {
    await page.goto('/records');
    const heading = page.getByRole('button', { name: 'Fundraising' });
    await expect(heading).toBeVisible();
    if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
    const links = page.locator('section').filter({ has: heading }).getByRole('link');
    await expect(links.first()).toBeVisible();
    const names = (await links.allInnerTexts()).map((n) => n.trim());
    const donors = names.findIndex((n) => /^Donors\b/.test(n));
    const donations = names.findIndex((n) => /^Donations\b/.test(n));
    expect(donors, 'Donors is in Fundraising').toBeGreaterThanOrEqual(0);
    expect(donations, 'Donations follows Donors').toBeGreaterThan(donors);
  });

  test('FT-REC-010 Donations chips: Outstanding by default, Mine, and Closed filter by status', t('FT-REC-010', 'P1'), async () => {
    await page.goto('/records/donation');
    await useTable(page);
    await expect(page.getByRole('tab', { name: 'Outstanding', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Mine', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Raised', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Paid', exact: true })).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'Cancelled', exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Closed', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Closed', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('cell', { name: /^(Paid|Cancelled)$/ }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Raised', exact: true })).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]show=/);

    await page.getByRole('tab', { name: 'Mine', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Mine', exact: true })).toHaveAttribute('aria-selected', 'true');
  });

  test('FT-REC-011 search asks the server once, about 300 ms after typing stops', t('FT-REC-011', 'P1'), async () => {
    await page.goto('/records/donation');
    const search = searchbox(page);
    await expect(search).toHaveAttribute('placeholder', label('ui.records.searchPlaceholder', { items: 'donations' }));
    const sent: number[] = [];
    const onRequest = (r: Request) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/records/donation/query') sent.push(Date.now());
    };
    page.on('request', onRequest);
    await search.pressSequentially('Ravi', { delay: 100 });
    const typed = Date.now();
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    page.off('request', onRequest);
    expect(sent, 'one query for the whole word, not one per key').toHaveLength(1);
    expect(sent[0]! - typed, 'the query waits for typing to stop').toBeGreaterThanOrEqual(200);
    await expect(page.getByText('Ravi Kumar').first()).toBeVisible();
  });

  test('FT-REC-026 New donation shows only where the chip allows create', t('FT-REC-026', 'P1'), async () => {
    await page.goto('/records/donation');
    await expect(newRecord(page, 'Donation')).toBeVisible();
    await page.getByRole('tab', { name: 'Closed', exact: true }).click();
    await expect(newRecord(page, 'Donation')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Outstanding', exact: true }).click();
    await expect(newRecord(page, 'Donation')).toBeVisible();
  });

  // Create the donor

  test('FT-DON-005 a donor without a name is refused', t('FT-DON-005', 'P1'), async () => {
    const dialog = await openDonorCreate();
    await dialog.getByLabel('Email').fill(donorEmail);
    await dialog.getByRole('button', { name: create(), exact: true }).click();
    await expect(dialog.getByText(label('ui.records.required', { field: 'Name' }))).toBeVisible();
    await expect(createdMessage()).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('FT-DON-002 a badly formed PAN is refused', t('FT-DON-002', 'P0'), async () => {
    const dialog = await openDonorCreate();
    await dialog.getByLabel('Name').fill(donorName);
    for (const bad of ['abcde1234f', 'ABCDE12345', 'ABCD1234F', 'ABCDE12345F']) {
      await dialog.getByLabel('PAN').fill(bad);
      await dialog.getByRole('button', { name: create(), exact: true }).click();
      await expect(dialog.getByText(messages.pan), `PAN ${bad}`).toBeVisible();
    }
    await expect(createdMessage()).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('FT-DON-001 Finance creates the donor and it gets a DNR number', t('FT-DON-001', 'P0'), async () => {
    const dialog = await openDonorCreate();
    await dialog.getByLabel('Name').fill(donorName);
    await dialog.getByLabel('Email').fill(donorEmail);
    await dialog.getByLabel('Phone').fill(donorPhone);
    await dialog.getByLabel('City').fill('Bengaluru');
    await dialog.getByLabel('Address').fill('12 Journey Road');
    await dialog.getByLabel('PAN').fill(pan);
    await dialog.getByRole('button', { name: create(), exact: true }).click();
    await expect(createdMessage()).toBeVisible();

    const found = await findRecords(finance, 'donor', donorName, (r) => r.data.name === donorName);
    expect(found, 'exactly one donor with this run name').toHaveLength(1);
    const donor = found[0]!;
    state.donorId = donor.id;
    expect(donor.number).toMatch(/^DNR\/\d{5}$/);
    expect(donor.data.pan).toBe(pan);
    const panel = await openRecord(page, 'donor', donor.id, donorName);
    await expect(panel.getByText(donor.number!)).toBeVisible();
  });

  test('FT-DON-004 name, city and address over their limits are refused', t('FT-DON-004', 'P1'), async () => {
    const atLimit = { name: `E2E02 Bounds ${tag} `.padEnd(200, 'N'), city: 'C'.repeat(100), address: 'A'.repeat(1000) };
    const kept = await createRecordApi(finance, 'donor', atLimit);
    expect(kept.data.name).toBe(atLimit.name);

    const over: [Record<string, string>, RegExp][] = [
      [{ ...atLimit, name: `${atLimit.name}N` }, /Use at most 200 characters for Name\./],
      [{ ...atLimit, name: `E2E02 City ${tag}`, city: 'C'.repeat(101) }, /Use at most 100 characters for City\./],
      [{ ...atLimit, name: `E2E02 Address ${tag}`, address: 'A'.repeat(1001) }, /Use at most 1,?000 characters for Address\./],
    ];
    for (const [data, message] of over) {
      const res = await tryCreate(finance, 'donor', data);
      expect(refused(res), `over-limit ${Object.keys(data).join(',')} answered ${res.status()}`).toBe(true);
      expect(await res.text()).toMatch(message);
    }

    const dialog = await openDonorCreate();
    await dialog.getByLabel('Name').fill(`${atLimit.name}N`);
    await dialog.getByRole('button', { name: create(), exact: true }).click();
    await expect(dialog.getByText(/Use at most 200 characters for Name\./)).toBeVisible();
    await expect(createdMessage()).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('FT-DON-003 a second donor with the same PAN is refused', t('FT-DON-003', 'P0'), async () => {
    const dialog = await openDonorCreate();
    await dialog.getByLabel('Name').fill(`${donorName} twin`);
    await dialog.getByLabel('PAN').fill(pan);
    await dialog.getByRole('button', { name: create(), exact: true }).click();
    await expect(dialog.getByText(messages.duplicatePan)).toBeVisible();
    await expect(createdMessage()).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(await findRecords(finance, 'donor', `${donorName} twin`, (r) => r.data.name === `${donorName} twin`)).toHaveLength(0);
  });

  test('FT-DON-006 the donor is found by name, email and phone', t('FT-DON-006', 'P1'), async () => {
    const donor = await getRecord(finance, 'donor', state.donorId);
    await page.goto('/records/donor');
    for (const query of [donorName, donorEmail, String(donor.data.phone)]) {
      await searchbox(page).fill(query);
      await expect(page.getByText(donorName).first(), `search "${query}"`).toBeVisible();
      await expect(page.getByText('Ravi Kumar'), `search "${query}" leaves out other donors`).toHaveCount(0);
    }
  });

  test('FT-DON-007 the donor list: table columns, a page of 20, and a city filter', t('FT-DON-007', 'P1'), async () => {
    await page.goto('/records/donor');
    await useTable(page);
    for (const column of ['Name', 'Email', 'Phone', 'City']) {
      await expect(page.getByRole('columnheader', { name: new RegExp(`^${column}`) })).toBeVisible();
    }
    await expect(page.getByRole('row').nth(1)).toBeVisible();
    expect(await page.getByRole('row').count(), 'at most 20 rows and the header').toBeLessThanOrEqual(21);
    await page.getByRole('button', { name: label('ui.records.openFilters'), exact: true }).click();
    const filters = page.getByRole('dialog', { name: label('ui.records.filterTitle', { items: 'donors' }) });
    await expect(filters.getByText('City').first()).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('FT-DON-008 the donor detail offers New donation for the donor, with the donor chosen', t('FT-DON-008', 'P1'), async () => {
    const panel = await openRecord(page, 'donor', state.donorId, donorName);
    await panel.getByRole('button', { name: label('ui.records.newFor', { type: 'donation', title: donorName }), exact: true }).click();
    const dialog = createDialog(page, 'donation');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Donor name')).toHaveValue(donorName);
    await expect(dialog.getByLabel('Donor name')).toBeDisabled();
    await dialog.getByRole('button', { name: label('ui.common.cancel'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  // Create the donation

  test('FT-REC-042 required fields left empty are named, and nothing is saved', t('FT-REC-042', 'P0'), async () => {
    const dialog = await openDonationCreate();
    await dialog.getByRole('button', { name: next(), exact: true }).click();
    await expect(dialog.getByText(label('ui.records.required', { field: 'Donor name' }))).toBeVisible();
    await dialog.getByLabel('Donor name').fill(walkIn);
    await dialog.getByRole('button', { name: next(), exact: true }).click();
    await dialog.getByRole('button', { name: create(), exact: true }).click();
    await expect(dialog.getByText(label('ui.records.required', { field: 'Amount' }))).toBeVisible();
    await expect(createdMessage()).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(await findRecords(finance, 'donation', walkIn, (r) => r.data.donorName === walkIn)).toHaveLength(0);
  });

  test('FT-REC-044 the two-step create keeps its step in the address', t('FT-REC-044', 'P1'), async () => {
    const dialog = await openDonationCreate();
    await expect(dialog.getByText(label('ui.records.stepProgress', { step: 1, count: 2 }))).toBeVisible();
    await expect(dialog.getByRole('button', { name: label('ui.common.cancel'), exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: label('ui.common.back'), exact: true })).toHaveCount(0);
    await dialog.getByLabel('Donor name').fill(walkIn);
    await dialog.getByRole('button', { name: next(), exact: true }).click();
    await expect(dialog.getByText(label('ui.records.stepProgress', { step: 2, count: 2 }))).toBeVisible();
    await expect(page).toHaveURL(/[?&]createStep=1\b/);
    await expect(dialog.getByRole('button', { name: label('ui.common.back'), exact: true })).toBeVisible();

    await page.reload();
    await expect(createDialog(page, 'donation').getByText(label('ui.records.stepProgress', { step: 2, count: 2 }))).toBeVisible();
    await createDialog(page, 'donation').getByRole('button', { name: label('ui.common.back'), exact: true }).click();
    await expect(createDialog(page, 'donation').getByText(label('ui.records.stepProgress', { step: 1, count: 2 }))).toBeVisible();
    await createDialog(page, 'donation').getByRole('button', { name: label('ui.common.cancel'), exact: true }).click();
    await expect(createDialog(page, 'donation')).toHaveCount(0);
  });

  test('FT-DON-021 a donation with no donor takes a typed name, and the PAN pattern still applies', t('FT-DON-021', 'P1'), async () => {
    const dialog = await openDonationCreate();
    await dialog.getByLabel('Donor name').fill(walkIn);
    await dialog.getByLabel('Donor PAN').fill('ABC123');
    await dialog.getByRole('button', { name: next(), exact: true }).click();
    await expect(dialog.getByText(messages.pan)).toBeVisible();
    await dialog.getByLabel('Donor PAN').fill('');
    await dialog.getByRole('button', { name: next(), exact: true }).click();
    await dialog.getByLabel('Amount', { exact: true }).fill('500');
    await dialog.getByRole('button', { name: create(), exact: true }).click();
    await expect(createdMessage()).toBeVisible();

    const found = await findRecords(finance, 'donation', walkIn, (r) => r.data.donorName === walkIn);
    expect(found).toHaveLength(1);
    const walk = found[0]!;
    state.walkInId = walk.id;
    expect(walk.status).toBe('raised');
    expect(walk.data.donor || null).toBeNull();
    expect(walk.data.donorEmail || null).toBeNull();
  });

  test('FT-DON-022 a fee above the amount is refused on the fee field', t('FT-DON-022', 'P1'), async () => {
    const dialog = await openDonationCreate();
    await dialog.getByLabel('Donor name').fill(`${walkIn} fee`);
    await dialog.getByRole('button', { name: next(), exact: true }).click();
    await dialog.getByLabel('Amount', { exact: true }).fill('1000');
    await dialog.getByLabel('Processing fee').fill('1001');
    await dialog.getByRole('button', { name: create(), exact: true }).click();
    await expect(dialog.getByText(messages.fee)).toBeVisible();
    await expect(dialog.getByLabel('Processing fee'), 'UX-012: the message belongs to the fee field').toHaveAttribute('aria-invalid', 'true');
    await expect(createdMessage()).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('FT-DON-023 a fee equal to the amount and a fee of 0 are accepted; -1 is refused', t('FT-DON-023', 'P1'), async () => {
    const donor = `E2E02 Fee bounds ${tag}`;
    const equal = await createRecordApi(finance, 'donation', { donorName: donor, amount: 500, fee: 500 });
    const zero = await createRecordApi(finance, 'donation', { donorName: donor, amount: 500, fee: 0 });
    const negative = await tryCreate(finance, 'donation', { donorName: donor, amount: 500, fee: -1 });
    expect(refused(negative), `fee -1 answered ${negative.status()}`).toBe(true);
    expect(Number(equal.data.netAmount)).toBe(0);
    expect(Number(zero.data.netAmount)).toBe(500);
    for (const r of [equal, zero]) await transition(finance, 'donation', r.id, 'cancel');
  });

  test('FT-DON-024 amounts below 1 or with more than two decimals are refused', t('FT-DON-024', 'P1'), async () => {
    const donor = `E2E02 Amount bounds ${tag}`;
    for (const amount of [0, 0.99, 1.005]) {
      const res = await tryCreate(finance, 'donation', { donorName: donor, amount });
      expect(refused(res), `amount ${amount} answered ${res.status()}`).toBe(true);
    }
    for (const amount of [1, 99_999_999.99]) {
      const kept = await createRecordApi(finance, 'donation', { donorName: donor, amount });
      expect(Number(kept.data.amount)).toBe(amount);
      await transition(finance, 'donation', kept.id, 'cancel');
    }

    const dialog = await openDonationCreate();
    await dialog.getByLabel('Donor name').fill(donor);
    await dialog.getByRole('button', { name: next(), exact: true }).click();
    await dialog.getByLabel('Amount', { exact: true }).fill('0');
    await dialog.getByRole('button', { name: create(), exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(createdMessage()).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('FT-DON-020 the linked donation copies and locks the donor, shows the net, and is Raised with a DON number', t('FT-DON-020', 'P0'), async () => {
    const dialog = await openDonationCreate();
    await dialog.getByRole('combobox', { name: 'Donor' }).fill(donorName);
    await page.getByRole('option', { name: new RegExp(escapeRegExp(donorName)) }).first().click();
    await expect(dialog.getByLabel('Donor name')).toHaveValue(donorName);
    await expect(dialog.getByLabel('Donor name')).toBeDisabled();
    await expect(dialog.getByLabel('Donor email')).toHaveValue(donorEmail);
    await expect(dialog.getByLabel('Donor email')).toBeDisabled();
    await expect(dialog.getByLabel('Donor PAN')).toHaveValue(pan);
    await dialog.getByRole('button', { name: next(), exact: true }).click();
    await dialog.getByLabel('Amount', { exact: true }).fill('1000');
    await dialog.getByLabel('Processing fee').fill('10');
    await expect(dialog.getByText('990')).toBeVisible();
    await dialog.getByRole('button', { name: create(), exact: true }).click();
    await expect(createdMessage()).toBeVisible();

    const found = await findRecords(finance, 'donation', donorName, (r) => r.data.donor === state.donorId);
    expect(found, 'one donation for the donor').toHaveLength(1);
    const main = found[0]!;
    state.mainId = main.id;
    state.mainNumber = main.number ?? '';
    expect(main.status).toBe('raised');
    expect(main.number).toMatch(new RegExp(`^DON/${createdFy}/\\d{5}$`));
    expect(main.data.donorName).toBe(donorName);
    expect(Number(main.data.netAmount)).toBe(990);

    const panel = await openRecord(page, 'donation', main.id, donorName);
    await expect(panel.getByText('Raised', { exact: true }).first()).toBeVisible();
    await expect(panel.getByText(state.mainNumber)).toBeVisible();
    await expect(panel.getByText('990')).toBeVisible();
  });

  test('FT-REC-104 the net amount is calculated and cannot be edited', t('FT-REC-104', 'P1'), async () => {
    const panel = await openRecord(page, 'donation', state.mainId, donorName);
    await expect(panel.getByText('990')).toBeVisible();
    await panel.getByRole('button', { name: label('ui.common.edit'), exact: true }).click();
    const net = panel.getByRole('textbox', { name: 'Net amount' });
    if (await net.count()) await expect(net).not.toBeEditable();
    await panel.getByRole('button', { name: label('ui.records.cancelEdit'), exact: true }).click();

    await tryUpdate(finance, 'donation', state.mainId, { netAmount: 5 });
    expect(Number((await getRecord(finance, 'donation', state.mainId)).data.netAmount)).toBe(990);
  });

  test('FT-DON-025 method, paid on and reference are hidden while Raised', t('FT-DON-025', 'P1'), async () => {
    const panel = await openRecord(page, 'donation', state.mainId, donorName);
    await expect(panel.getByText(state.mainNumber)).toBeVisible();
    for (const field of ['Payment method', 'Paid on', 'Payment reference']) {
      await expect(panel.getByText(field, { exact: true }), field).toHaveCount(0);
    }
  });

  // Mark as paid

  test('FT-DON-027 a paid-on date after today is refused and the donation stays Raised', t('FT-DON-027', 'P0'), async () => {
    await openRecord(page, 'donation', state.mainId, donorName);
    const sheet = await openMarkAsPaid(page);
    await choosePaymentMethod(page, sheet, 'Bank transfer');
    await pickDate(page, sheet.getByLabel('Paid on'), addDays(utcToday(), 1));
    await submitMarkAsPaid(sheet);
    await expect(page.getByText(messages.future)).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await getRecord(finance, 'donation', state.mainId)).status).toBe('raised');
  });

  test('FT-DON-029 UPI with no reference is refused', t('FT-DON-029', 'P1'), async () => {
    await openRecord(page, 'donation', state.mainId, donorName);
    const sheet = await openMarkAsPaid(page);
    await choosePaymentMethod(page, sheet, 'UPI');
    await pickDate(page, sheet.getByLabel('Paid on'), paidOn);
    await submitMarkAsPaid(sheet);
    await expect(page.getByText(messages.upi)).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await getRecord(finance, 'donation', state.mainId)).status).toBe('raised');
  });

  test('FT-DON-030 a payment reference of 101 characters is refused', t('FT-DON-030', 'P1'), async () => {
    const tooLong = await tryTransition(finance, 'donation', state.mainId, 'markPaid', { method: 'upi', paidOn, reference: 'R'.repeat(101) });
    expect(refused(tooLong), `101-character reference answered ${tooLong.status()}`).toBe(true);
    expect(await tooLong.text()).toMatch(/Use at most 100 characters for Payment reference\./);
    expect((await getRecord(finance, 'donation', state.mainId)).status).toBe('raised');

    await openRecord(page, 'donation', state.mainId, donorName);
    const sheet = await openMarkAsPaid(page);
    const reference = sheet.getByLabel('Payment reference');
    if ((await reference.count()) === 0) knownDefect('DEF-07', 'UPI requires a reference, and the Mark as paid form has no field to enter one.');
    await expect(reference).toBeVisible();
    await choosePaymentMethod(page, sheet, 'UPI');
    await pickDate(page, sheet.getByLabel('Paid on'), paidOn);
    await reference.fill('R'.repeat(101));
    await submitMarkAsPaid(sheet);
    await expect(page.getByText(/Use at most 100 characters for Payment reference\./)).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await getRecord(finance, 'donation', state.mainId)).status).toBe('raised');
  });

  test('FT-DON-026 Mark as paid by UPI with a reference issues a receipt', t('FT-DON-026', 'P0'), async () => {
    await openRecord(page, 'donation', state.mainId, donorName);
    const sheet = await openMarkAsPaid(page);
    await submitMarkAsPaid(sheet);
    await expect(sheet.getByText(/Payment method.*required/i).first(), 'method is required').toBeVisible();

    const upiReference = `UPI${Date.now()}`;
    const reference = sheet.getByLabel('Payment reference');
    const hasReference = (await reference.count()) > 0;
    if (hasReference) {
      await choosePaymentMethod(page, sheet, 'UPI');
      await pickDate(page, sheet.getByLabel('Paid on'), paidOn);
      await reference.fill(upiReference);
      await submitMarkAsPaid(sheet);
      await expect(page.getByText(new RegExp(`^Mark as paid — receipt RCPT/${fy}/\\d{5} issued\\.$`))).toBeVisible();
    } else {
      // The journey needs a UPI payment with its reference; the server takes it even though the form cannot (DEF-07).
      await page.keyboard.press('Escape');
      await transition(finance, 'donation', state.mainId, 'markPaid', { method: 'upi', paidOn, reference: upiReference });
    }
    state.paid.push({ id: state.mainId, amount: 1000, debit: 'BANK' });

    const paid = await getRecord(finance, 'donation', state.mainId);
    expect(paid.status).toBe('paid');
    expect(paid.data.method).toBe('upi');
    expect(paid.data.paidOn).toBe(paidOn);
    expect(paid.data.reference).toBe(upiReference);
    const panel = await openRecord(page, 'donation', state.mainId, donorName);
    await expect(panel.getByText('Paid', { exact: true }).first()).toBeVisible();

    if (!hasReference) knownDefect('DEF-07', 'UPI requires a reference, and the Mark as paid form has no field to enter one.');
    expect(hasReference, 'Mark as paid has a Payment reference field').toBe(true);
  });

  test('FT-DON-031 every payment method is accepted; cash debits CASH and the rest debit BANK', t('FT-DON-031', 'P1'), async () => {
    const methods: { method: string; amount: number; debit: 'BANK' | 'CASH'; reference?: string }[] = [
      { method: 'cash', amount: 101, debit: 'CASH' },
      { method: 'bank_transfer', amount: 202, debit: 'BANK', reference: `NEFT${Date.now()}` },
      // A reference of exactly 100 characters is the longest accepted (FT-DON-030).
      { method: 'cheque', amount: 303, debit: 'BANK', reference: `CHQ${tag}`.padEnd(100, '0') },
      { method: 'online', amount: 404, debit: 'BANK', reference: `GATEWAY${Date.now()}` },
    ];
    const ids: Record<string, string> = {};
    for (const m of methods) {
      const donation = await createRecordApi(finance, 'donation', { donor: state.donorId, amount: m.amount });
      const saved = await transition(finance, 'donation', donation.id, 'markPaid', { method: m.method, paidOn, ...(m.reference ? { reference: m.reference } : {}) });
      expect(saved.record.status, m.method).toBe('paid');
      expect(saved.receipts, `${m.method} issues one receipt`).toHaveLength(1);
      ids[m.method] = donation.id;
      state.paid.push({ id: donation.id, amount: m.amount, debit: m.debit });
    }
    const snapshot = await tenantSnapshot(admin, postingTables);
    for (const m of methods) expectDonationPosting(postingsFor(snapshot, ids[m.method]!), m.debit, m.amount);
    expectDonationPosting(postingsFor(snapshot, state.mainId), 'BANK', 1000);
  });

  // Receipt, posting, and public link

  test('FT-DON-032 amount and fee cannot be changed after Paid', t('FT-DON-032', 'P1'), async () => {
    for (const change of [{ amount: 2000 }, { fee: 0 }]) {
      const res = await tryUpdate(finance, 'donation', state.mainId, change);
      expect(refused(res), `${JSON.stringify(change)} answered ${res.status()}`).toBe(true);
    }
    const kept = await getRecord(finance, 'donation', state.mainId);
    expect(Number(kept.data.amount)).toBe(1000);
    expect(Number(kept.data.fee)).toBe(10);

    const panel = await openRecord(page, 'donation', state.mainId, donorName);
    const edit = panel.getByRole('button', { name: label('ui.common.edit'), exact: true });
    if (await edit.count()) {
      await edit.click();
      for (const field of ['Amount', 'Processing fee']) {
        const input = panel.getByLabel(field, { exact: true });
        if (await input.count()) await expect(input, field).not.toBeEditable();
      }
      await panel.getByRole('button', { name: label('ui.records.cancelEdit'), exact: true }).click();
    }
  });

  test('FT-DON-034 a Paid donation cannot be cancelled', t('FT-DON-034', 'P1'), async () => {
    const panel = await openRecord(page, 'donation', state.mainId, donorName);
    await expect(panel.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    const res = await tryTransition(finance, 'donation', state.mainId, 'cancel');
    expect(refused(res), `cancel on Paid answered ${res.status()}`).toBe(true);
    expect((await getRecord(finance, 'donation', state.mainId)).status).toBe('paid');
  });

  test('FT-DON-035 the receipt has the RCPT number, the donation amount, the paid-on date, and an audit entry', t('FT-DON-035', 'P0'), async () => {
    const receipts = await receiptsOf(finance, 'donation', state.mainId);
    expect(receipts, 'one receipt for the donation').toHaveLength(1);
    const receipt = receipts[0]!;
    state.receipt = receipt;
    expect(receipt.number).toMatch(new RegExp(`^RCPT/${fy}/\\d{5}$`));
    expect(receipt.status).toBe('issued');
    expect(receipt.seriesKey).toBe('donation-receipt');
    expect(receipt.period).toBe(fy);
    expect(Number(receipt.amount)).toBe(1000);
    expect(receipt.date).toBe(paidOn);

    const panel = await openRecord(page, 'donation', state.mainId, donorName);
    await expect(panel.getByText(label('ui.records.receipts'), { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: new RegExp(escapeRegExp(receipt.number)) })).toBeVisible();

    const { audit_event: audit } = await tenantSnapshot(admin, ['audit_event']);
    const issued = audit!.filter((e) => e.action === 'receipt.issued' && e.entity_id === receipt.id);
    expect(issued, 'audit has the receipt.issued event').toHaveLength(1);
    expect((issued[0]!.after as { number?: string } | null)?.number).toBe(receipt.number);
  });

  test('FT-DON-037 the payment posts one balanced journal: debit BANK, credit DONATION_INCOME', t('FT-DON-037', 'P0'), async () => {
    const snapshot = await tenantSnapshot(admin, postingTables);
    const entry = expectDonationPosting(postingsFor(snapshot, state.mainId), 'BANK', 1000);
    expect(entry.rule).toBe('donationPaid');
    expect(entry.period).toBe(fy);
    expect(entry.date).toBe(paidOn);
  });

  test('FT-DON-009 donor totals count only Paid donations', t('FT-DON-009', 'P0'), async () => {
    const raised = await createRecordApi(finance, 'donation', { donor: state.donorId, amount: 777 });
    state.reminderId = raised.id;
    state.reminderNumber = raised.number ?? '';
    expect(raised.data.donorEmail).toBe(donorEmail);

    const total = state.paid.reduce((sum, p) => sum + p.amount, 0);
    await expect
      .poll(async () => {
        const d = await getRecord(finance, 'donor', state.donorId);
        return [Number(d.data.totalGiven), Number(d.data.donationCount)];
      })
      .toEqual([total, state.paid.length]);

    const panel = await openRecord(page, 'donor', state.donorId, donorName);
    await expect(panel.getByText(new RegExp(`^Donations · ${state.paid.length + 1} · `))).toBeVisible();
  });

  test('FT-DON-038 the thank-you email is sent to the donor, or skipped with a reason', t('FT-DON-038', 'P1'), async () => {
    const email = await settledEmail(admin, state.mainId, thanksSubject);
    expect(email.to_address).toBe(donorEmail);
    if (email.status === 'skipped') expect(String(email.error ?? ''), 'a skipped email says why').not.toBe('');
  });

  test('FT-DON-055 Print receipt opens the print view with the issuer, logo and signatory', t('FT-DON-055', 'P1'), async () => {
    const receipt = state.receipt!;
    const panel = await openRecord(page, 'donation', state.mainId, donorName);
    await panel.getByRole('button', { name: 'Print receipt', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/print/receipt/${receipt.id}$`));
    state.receiptUrl = page.url();

    const res = await finance.get(`/api/print/receipt/${receipt.id}`);
    expect(res.status()).toBe(200);
    const print = (await res.json()) as {
      organisation: { name: string };
      issuer?: { legalName: string | null; displayName: string; logoUrl: string | null; signatory?: { name: string | null; designation: string | null } | null };
    };
    const paper = page.locator('article.print__paper');
    await expect(paper.getByText(receipt.number)).toBeVisible();
    await expect(paper.getByRole('heading', { name: 'Donation acknowledgement' })).toBeVisible();
    await expect(paper.locator('.print__org')).toHaveText(print.issuer?.legalName || print.issuer?.displayName || print.organisation.name);
    if (print.issuer?.logoUrl) await expect(paper.locator('img.print__logo')).toBeVisible();
    if (print.issuer?.signatory?.name) await expect(paper.getByText(print.issuer.signatory.name)).toBeVisible();
    await expect(paper.getByText(label('ui.print.signatory'))).toBeVisible();

    if (!print.issuer?.legalName) knownDefect('DEF-19', 'A receipt issued before setup is complete prints without the legal name.');
    expect(print.issuer?.legalName, 'the legal name is kept with the receipt').toBeTruthy();
  });

  test('FT-FIN-026 the print view has Back, Download, Copy and Revoke public link, and Print, hidden when printed', t('FT-FIN-026', 'P1'), async () => {
    const receipt = state.receipt!;
    await page.goto(state.receiptUrl);
    await expect(page.locator('article.print__paper').getByText(receipt.number)).toBeVisible();
    for (const name of [label('ui.common.back'), label('ui.print.download'), label('ui.print.copyLink'), label('ui.print.revokeLink'), label('ui.print.print')]) {
      await expect(page.getByRole('button', { name, exact: true }), name).toBeVisible();
    }
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: label('ui.print.download'), exact: true }).click();
    expect((await download).suggestedFilename()).toBe(`${receipt.number.replace(/\//g, '-')}.pdf`);

    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: label('ui.print.print'), exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: label('ui.print.copyLink'), exact: true })).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
  });

  test('FT-FIN-027 Copy public link gives /r/<token>, which opens signed out with Download and Print only', t('FT-FIN-027', 'P1'), async () => {
    const receipt = state.receipt!;
    await page.goto(state.receiptUrl);
    await expect(page.locator('article.print__paper').getByText(receipt.number)).toBeVisible();
    await page.getByRole('button', { name: label('ui.print.copyLink'), exact: true }).click();
    await expect(page.getByText(label('ui.print.linkCopied'))).toBeVisible();
    const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{20,128}$/);
    state.publicPath = copied.pathname;

    const { ctx, p } = await signedOutPage();
    await p.goto(state.publicPath);
    await expect(p.locator('article.print__paper').getByText(receipt.number)).toBeVisible();
    await expect(p.getByRole('button', { name: label('ui.print.download'), exact: true })).toBeVisible();
    await expect(p.getByRole('button', { name: label('ui.print.print'), exact: true })).toBeVisible();
    for (const name of [label('ui.common.back'), label('ui.print.copyLink'), label('ui.print.revokeLink')]) {
      await expect(p.getByRole('button', { name, exact: true }), name).toHaveCount(0);
    }
    await ctx.close();
  });

  test('FT-FIN-028 a revoked link stops working, and a new link has a new address', t('FT-FIN-028', 'P0'), async () => {
    const receipt = state.receipt!;
    const old = state.publicPath;
    await page.goto(state.receiptUrl);
    await expect(page.locator('article.print__paper').getByText(receipt.number)).toBeVisible();
    await page.getByRole('button', { name: label('ui.print.revokeLink'), exact: true }).click();
    await expect(page.getByRole('button', { name: label('ui.print.revokeLink'), exact: true })).toBeDisabled();

    const { ctx, p } = await signedOutPage();
    await p.goto(old);
    await expect(p.getByText(label('ui.print.notFound'))).toBeVisible();
    await expect(p.getByText(receipt.number)).toHaveCount(0);

    await page.getByRole('button', { name: label('ui.print.copyLink'), exact: true }).click();
    await expect(page.getByText(label('ui.print.linkCopied'))).toBeVisible();
    const fresh = new URL(await page.evaluate(() => navigator.clipboard.readText())).pathname;
    expect(fresh).toMatch(/^\/r\/[A-Za-z0-9_-]{20,128}$/);
    expect(fresh, 'the new link has a new address').not.toBe(old);
    state.publicPath = fresh;
    await p.goto(fresh);
    await expect(p.locator('article.print__paper').getByText(receipt.number)).toBeVisible();
    await ctx.close();
  });

  test('FT-DON-036 three more payments take the next receipt numbers, with no gaps or repeats', t('FT-DON-036', 'P0'), async () => {
    const numbers: string[] = [];
    for (const amount of [111, 222, 333]) {
      const donation = await createRecordApi(finance, 'donation', { donor: state.donorId, amount });
      const saved = await transition(finance, 'donation', donation.id, 'markPaid', { method: 'bank_transfer', paidOn, reference: `NEFT${Date.now()}` });
      expect(saved.receipts).toHaveLength(1);
      numbers.push(saved.receipts[0]!.number);
      state.paid.push({ id: donation.id, amount, debit: 'BANK' });
    }
    for (const n of numbers) expect(n).toMatch(new RegExp(`^RCPT/${fy}/\\d{5}$`));
    expect(new Set(numbers).size, 'no repeats').toBe(3);
    const seqs = numbers.map(sequenceOf);
    expect(seqs[1]! - seqs[0]!, `${numbers[0]} then ${numbers[1]}`).toBe(1);
    expect(seqs[2]! - seqs[1]!, `${numbers[1]} then ${numbers[2]}`).toBe(1);
  });

  // Reminder and cancel

  test('FT-DON-050 Send reminder on a Raised donation asks first, then sends an email', t('FT-DON-050', 'P1'), async () => {
    const panel = await openRecord(page, 'donation', state.reminderId, donorName);
    await expect(panel.getByText(state.reminderNumber)).toBeVisible();
    await panel.getByRole('button', { name: 'Send reminder', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Send reminder' });
    await expect(sheet.getByText(messages.reminder)).toBeVisible();
    await sheet.getByRole('button', { name: 'Send reminder', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    const email = await settledEmail(admin, state.reminderId, reminderSubject);
    expect(email.to_address).toBe(donorEmail);
  });

  test('FT-DON-051 Send reminder is not offered on a Paid donation or a Raised one without an email', t('FT-DON-051', 'P1'), async () => {
    const paid = await openRecord(page, 'donation', state.mainId, donorName);
    await expect(paid.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(paid.getByRole('button', { name: 'Send reminder', exact: true })).toHaveCount(0);
    const noEmail = await openRecord(page, 'donation', state.walkInId, walkIn);
    await expect(noEmail.getByText('Raised', { exact: true }).first()).toBeVisible();
    await expect(noEmail.getByRole('button', { name: 'Mark as paid', exact: true })).toBeVisible();
    await expect(noEmail.getByRole('button', { name: 'Send reminder', exact: true })).toHaveCount(0);
  });

  test('FT-DON-033 Cancel moves a Raised donation to Cancelled, with no further step', t('FT-DON-033', 'P1'), async () => {
    const panel = await openRecord(page, 'donation', state.walkInId, walkIn);
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Cancel' });
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    const after = panelOf(page, walkIn);
    await expect(after.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    await expect(after.getByRole('button', { name: 'Mark as paid', exact: true })).toHaveCount(0);
    await expect(after.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    for (const step of ['markPaid', 'cancel']) {
      const res = await tryTransition(finance, 'donation', state.walkInId, step, step === 'markPaid' ? { method: 'cash', paidOn } : undefined);
      expect(refused(res), `${step} on Cancelled answered ${res.status()}`).toBe(true);
    }
    expect((await getRecord(finance, 'donation', state.walkInId)).status).toBe('cancelled');
  });

  // Viewer on the same records

  test('FT-DON-040 Viewer reads the donations, and every change, step, action and print is refused', t('FT-DON-040', 'P0'), async () => {
    const receipt = state.receipt!;
    viewerContext = await context.browser()!.newContext({ baseURL: appBase, viewport: { width: 1280, height: 900 } });
    viewerPage = await viewerContext.newPage();
    await signIn(viewerPage, accounts.viewer.email, accounts.viewer.name);
    viewer = await memberApi(accounts.viewer.email);

    await viewerPage.goto('/records/donation');
    await expect(viewerPage.getByRole('tab', { name: 'Outstanding', exact: true })).toBeVisible();
    await expect(newRecord(viewerPage, 'Donation')).toHaveCount(0);
    const raised = await openRecord(viewerPage, 'donation', state.reminderId, donorName);
    await expect(raised.getByText(state.reminderNumber)).toBeVisible();
    for (const name of [label('ui.common.edit'), 'Mark as paid', 'Cancel', 'Send reminder', 'Pay now']) {
      await expect(raised.getByRole('button', { name, exact: true }), name).toHaveCount(0);
    }
    const paid = await openRecord(viewerPage, 'donation', state.mainId, donorName);
    await expect(paid.getByText(state.mainNumber)).toBeVisible();
    await expect(paid.getByRole('button', { name: 'Print receipt', exact: true })).toHaveCount(0);

    const refusals: [string, Promise<APIResponse>][] = [
      ['create', tryCreate(viewer, 'donation', { donorName: `${walkIn} viewer`, amount: 100 })],
      ['edit', tryUpdate(viewer, 'donation', state.reminderId, { notes: 'viewer edit' })],
      ['Mark as paid', tryTransition(viewer, 'donation', state.reminderId, 'markPaid', { method: 'cash', paidOn })],
      ['Send reminder', viewer.post(`/api/records/donation/${state.reminderId}/actions/sendReminder`, { data: { input: {} } })],
      ['Print receipt action', viewer.post(`/api/records/donation/${state.mainId}/actions/printReceipt`, { data: { input: {} } })],
    ];
    for (const [what, call] of refusals) {
      const res = await call;
      expect(refused(res), `Viewer ${what} answered ${res.status()}`).toBe(true);
    }
    expect((await getRecord(finance, 'donation', state.reminderId)).status).toBe('raised');

    const printApi = await viewer.get(`/api/print/receipt/${receipt.id}`);
    const linkApi = await viewer.post(`/api/print/receipt/${receipt.id}/link`);
    await viewerPage.goto(state.receiptUrl);
    await viewerPage.waitForLoadState('networkidle');
    const printShown = viewerPage.url().includes('/print/receipt/') && (await viewerPage.getByText(receipt.number).count()) > 0;

    if (printApi.ok() || printShown) knownDefect('DEF-08', 'Viewer can open /print/receipt/{id} without the Print receipt action.');
    if (linkApi.ok()) knownDefect('DEF-17', 'Viewer can create a public receipt link.');
    expect(refused(printApi), `Viewer print API answered ${printApi.status()}`).toBe(true);
    expect(printShown, 'Viewer does not see the receipt by its address').toBe(false);
    expect(refused(linkApi), `Viewer public link answered ${linkApi.status()}`).toBe(true);
  });

  test('FT-REC-109 Viewer sees the donor PAN as *** with no partial characters', t('FT-REC-109', 'P0'), async () => {
    const panel = await openRecord(viewerPage, 'donor', state.donorId, donorName);
    await expect(panel.getByText('***').first()).toBeVisible();
    await expect(panel.getByText(pan)).toHaveCount(0);
    await expect(panel.getByText(pan.slice(0, 5))).toHaveCount(0);

    expect((await getRecord(viewer!, 'donor', state.donorId)).data.pan).toBe('***');
    expect((await getRecord(viewer!, 'donation', state.mainId)).data.donorPan).toBe('***');
    const exported = await viewer!.post('/api/records/donor/bulk', { data: { ids: [state.donorId], operation: { type: 'export' } } });
    if (exported.ok()) expect(await exported.text()).not.toContain(pan);
  });

  test('FT-E2E-02 donation to receipt: RCPT number, balanced posting, donor totals, public link signed out', t('FT-E2E-02', 'P0'), async () => {
    const receipt = (await receiptsOf(finance, 'donation', state.mainId))[0]!;
    expect(receipt.number, 'RCPT/<fy>/<seq>; 00001 only on an organisation with no earlier receipt this year').toMatch(new RegExp(`^RCPT/${fy}/\\d{5}$`));
    expect(receipt.status).toBe('issued');

    const snapshot = await tenantSnapshot(admin, postingTables);
    for (const p of state.paid) expectDonationPosting(postingsFor(snapshot, p.id), p.debit, p.amount);

    const donor = await getRecord(finance, 'donor', state.donorId);
    expect(Number(donor.data.totalGiven)).toBe(state.paid.reduce((sum, p) => sum + p.amount, 0));
    expect(Number(donor.data.donationCount)).toBe(state.paid.length);

    const { ctx, p } = await signedOutPage();
    await p.goto(state.publicPath);
    const paper = p.locator('article.print__paper');
    await expect(paper.getByText(receipt.number)).toBeVisible();
    await expect(paper.getByRole('heading', { name: 'Donation acknowledgement' })).toBeVisible();
    await expect(paper.getByText(new RegExp(escapeRegExp(donorName))).first()).toBeVisible();
    await ctx.close();
  });
});
