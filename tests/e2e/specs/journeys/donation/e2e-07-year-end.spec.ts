import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { accounts, org } from '../../../src/accounts.js';
import { memberApi, runTag } from '../../../src/api.js';
import { signIn } from '../../../src/sign-in.js';
import {
  choosePaymentMethod,
  createRecordApi,
  fiscalYear,
  getRecord,
  openMarkAsPaid,
  pickDate,
  postingsFor,
  postingTables,
  receiptsOf,
  sequenceOf,
  submitMarkAsPaid,
  tags,
  tenantSnapshot,
  transition,
  utcToday,
  expectDonationPosting,
  type Receipt,
  type Snapshot,
} from '../../../src/journeys/donation.js';

const JOURNEY = 'FT-E2E-07';
const t = (id: string, priority: 'P0' | 'P1' | 'P2') => ({ tag: tags(JOURNEY, id, priority) });

/**
 * The plan pays on 31 March and 1 April 2027, which are in the future and refused by the
 * `paidOn <= today()` guard. The run uses the latest 1 April that has passed and the 31 March
 * before it (E2E_YEAR_END_APRIL_YEAR picks another year). Both financial years must be open:
 * a posting into a year with no open period is refused, and the seed opens only the current one.
 */
const today = utcToday();
const [todayYear, todayMonth] = today.split('-').map(Number) as [number, number];
const aprilYear = Number(process.env.E2E_YEAR_END_APRIL_YEAR ?? (todayMonth >= 4 ? todayYear : todayYear - 1));
const marchLast = `${aprilYear}-03-31`;
const aprilFirst = `${aprilYear}-04-01`;
const oldFy = fiscalYear(marchLast);
const newFy = fiscalYear(aprilFirst);
const createdFy = fiscalYear(today);

const enabled = process.env.E2E_YEAR_END === '1';
const inFuture = aprilFirst > today;
const skipReason = inFuture
  ? `FT-E2E-07: 1 April ${aprilYear} is after today (${today}); a future paid-on date is refused by design. Unset E2E_YEAR_END_APRIL_YEAR or choose a past year.`
  : `FT-E2E-07 needs financial years ${oldFy} and ${newFy} open for ${org}. The seed opens only the year containing the seed date, ` +
    `so a payment on ${marchLast} is refused with "Financial year ${oldFy} is not open.", and no API opens an earlier period. ` +
    `Open it in the database (insert into fiscal_period (tenant_id, key, starts_on, ends_on) values (<${org} tenant id>, '${oldFy}', '${aprilYear - 1}-04-01', '${marchLast}')), then run with E2E_YEAR_END=1.`;

const tag = runTag('E2E07');
const donorName = `E2E07 Donor ${tag}`;

const state = {
  donorId: '',
  donorNumber: '',
  /** Donations in creation order: the two the UI pays, then the API ones. */
  donations: [] as { id: string; number: string; paidOn: string; amount: number }[],
  receipts: new Map<string, Receipt>(),
  /** Receipts of the old year issued before this run, to show they are left untouched. */
  oldYearBefore: [] as Record<string, unknown>[],
};

let context: BrowserContext;
let page: Page;
let finance: APIRequestContext;
let admin: APIRequestContext;

async function newDonation(amount: number): Promise<{ id: string; number: string }> {
  const d = await createRecordApi(finance, 'donation', { donor: state.donorId, amount });
  return { id: d.id, number: d.number ?? '' };
}

/** Marks a donation paid through the Mark as paid sheet, picking the date from the calendar. */
async function payInScreen(id: string, paidOn: string): Promise<Receipt> {
  await page.goto(`/records/donation?id=${id}`);
  await expect(page.getByRole('dialog', { name: donorName })).toBeVisible();
  const sheet = await openMarkAsPaid(page);
  await choosePaymentMethod(page, sheet, 'Bank transfer');
  await pickDate(page, sheet.getByLabel('Paid on'), paidOn);
  const reference = sheet.getByLabel('Payment reference');
  if (await reference.count()) await reference.fill(`NEFT${Date.now()}`);
  await submitMarkAsPaid(sheet);
  await expect(page.getByText(new RegExp(`^Mark as paid — receipt RCPT/${fiscalYear(paidOn)}/\\d{5} issued\\.$`))).toBeVisible();
  const receipts = await receiptsOf(finance, 'donation', id);
  expect(receipts).toHaveLength(1);
  return receipts[0]!;
}

async function payByApi(id: string, paidOn: string): Promise<Receipt> {
  const saved = await transition(finance, 'donation', id, 'markPaid', { method: 'bank_transfer', paidOn, reference: `NEFT${Date.now()}` });
  expect(saved.receipts).toHaveLength(1);
  return saved.receipts[0]!;
}

function receiptRows(s: Snapshot, period: string): Record<string, unknown>[] {
  return s.receipt!.filter((r) => r.series_key === 'donation-receipt' && r.period === period);
}

test.describe.serial('FT-E2E-07 Year end', () => {
  test.describe.configure({ timeout: 120_000 });
  test.skip(!enabled || inFuture, skipReason);

  test.beforeAll(async ({ browser }, testInfo) => {
    finance = await memberApi(accounts.finance.email);
    admin = await memberApi(accounts.admin.email);
    const s = await tenantSnapshot(admin, ['fiscal_period', 'tenant_setting', 'receipt']);
    const startMonth = s.tenant_setting!.find((r) => r.key === 'finance.financialYearStartMonth')?.value;
    if (Number(startMonth) !== 4) throw new Error(`FT-E2E-07 needs an April financial year start; ${org} has ${JSON.stringify(startMonth)}.`);
    for (const fy of [oldFy, newFy]) {
      const period = s.fiscal_period!.find((p) => p.key === fy);
      if (period?.status !== 'open') throw new Error(`${skipReason} Financial year ${fy} is ${period ? String(period.status) : 'missing'}.`);
    }
    state.oldYearBefore = receiptRows(s, oldFy);

    const appBase = testInfo.project.use.baseURL ?? process.env.APP_BASE_URL ?? 'http://localhost:4200';
    context = await browser.newContext({ baseURL: appBase, viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await signIn(page, accounts.finance.email, accounts.finance.name);

    const donor = await createRecordApi(finance, 'donor', { name: donorName, email: `${tag.toLowerCase()}@donor.example` });
    state.donorId = donor.id;
    state.donorNumber = donor.number ?? '';
  });

  test.afterAll(async () => {
    await finance?.dispose();
    await admin?.dispose();
    await context?.close();
  });

  test('FT-FIN-020 receipt numbers are gap-free in the series and year, PREFIX/<fy>/<seq>', t('FT-FIN-020', 'P0'), async () => {
    const first = await newDonation(1100);
    const firstReceipt = await payInScreen(first.id, aprilFirst);
    const second = await newDonation(1200);
    const secondReceipt = await payByApi(second.id, aprilFirst);
    state.donations.push({ ...first, paidOn: aprilFirst, amount: 1100 }, { ...second, paidOn: aprilFirst, amount: 1200 });
    state.receipts.set(first.id, firstReceipt).set(second.id, secondReceipt);

    for (const r of [firstReceipt, secondReceipt]) {
      expect(r.number).toMatch(new RegExp(`^RCPT/${newFy}/\\d{5}$`));
      expect(r.period).toBe(newFy);
      expect(r.date).toBe(aprilFirst);
    }
    expect(sequenceOf(secondReceipt.number) - sequenceOf(firstReceipt.number), `${firstReceipt.number} then ${secondReceipt.number}`).toBe(1);
  });

  test('FT-FIN-005 a payment on 31 March takes the old year; 1 April takes the new year; donation numbers follow the creation date', t('FT-FIN-005', 'P0'), async () => {
    const march = await newDonation(1300);
    const marchReceipt = await payInScreen(march.id, marchLast);
    const april = await newDonation(1400);
    const aprilReceipt = await payByApi(april.id, aprilFirst);
    const marchAgain = await newDonation(1500);
    const marchAgainReceipt = await payByApi(marchAgain.id, marchLast);
    state.donations.push(
      { ...march, paidOn: marchLast, amount: 1300 },
      { ...april, paidOn: aprilFirst, amount: 1400 },
      { ...marchAgain, paidOn: marchLast, amount: 1500 },
    );
    state.receipts.set(march.id, marchReceipt).set(april.id, aprilReceipt).set(marchAgain.id, marchAgainReceipt);

    for (const r of [marchReceipt, marchAgainReceipt]) {
      expect(r.number).toMatch(new RegExp(`^RCPT/${oldFy}/\\d{5}$`));
      expect(r.period).toBe(oldFy);
      expect(r.date).toBe(marchLast);
    }
    expect(sequenceOf(marchAgainReceipt.number) - sequenceOf(marchReceipt.number), 'the old year continues its own sequence').toBe(1);
    expect(aprilReceipt.number).toMatch(new RegExp(`^RCPT/${newFy}/\\d{5}$`));
    const lastNewYear = state.receipts.get(state.donations[1]!.id)!;
    expect(sequenceOf(aprilReceipt.number) - sequenceOf(lastNewYear.number), 'a 31 March payment takes no number from the new year').toBe(1);

    for (const d of state.donations) expect(d.number, 'donation numbers follow the creation date').toMatch(new RegExp(`^DON/${createdFy}/\\d{5}$`));

    const snapshot = await tenantSnapshot(admin, postingTables);
    for (const d of state.donations) {
      const entry = expectDonationPosting(postingsFor(snapshot, d.id), 'BANK', d.amount);
      expect(entry.period, `${d.number} posts into the year of its paid-on date`).toBe(fiscalYear(d.paidOn));
      expect(entry.date).toBe(d.paidOn);
    }
  });

  test('FT-REC-115 donor and donation numbers have their formats; donor numbers never reset', t('FT-REC-115', 'P2'), async () => {
    expect(state.donorNumber).toMatch(/^DNR\/\d{5}$/);
    const numbers = state.donations.map((d) => d.number);
    for (const n of numbers) expect(n).toMatch(new RegExp(`^DON/${createdFy}/\\d{5}$`));
    expect(new Set(numbers).size).toBe(numbers.length);
    const seqs = numbers.map(sequenceOf);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!, `${numbers[i - 1]} then ${numbers[i]}`).toBeGreaterThan(seqs[i - 1]!);
    const again = await createRecordApi(finance, 'donor', { name: `${donorName} second` });
    expect(again.number).toMatch(/^DNR\/\d{5}$/);
    expect(sequenceOf(again.number!), 'donor numbers keep counting across years').toBeGreaterThan(sequenceOf(state.donorNumber));
  });

  test('FT-E2E-07 year end: numbers restart for the new year and the old year is untouched', t('FT-E2E-07', 'P0'), async () => {
    const s = await tenantSnapshot(admin, ['receipt']);
    const oldYear = receiptRows(s, oldFy);
    const newYear = receiptRows(s, newFy);

    for (const before of state.oldYearBefore) {
      const now = oldYear.find((r) => r.id === before.id);
      expect(now, `old-year receipt ${String(before.number)} is still there`).toBeDefined();
      expect({ number: now!.number, amount: now!.amount, date: now!.receipt_date, status: now!.status }).toEqual({
        number: before.number,
        amount: before.amount,
        date: before.receipt_date,
        status: before.status,
      });
    }

    for (const rows of [oldYear, newYear]) {
      const seqs = rows.map((r) => Number(r.seq)).sort((a, b) => a - b);
      expect(seqs[0], 'each year starts at 1').toBe(1);
      seqs.forEach((seq, i) => expect(seq, 'no gaps in the year').toBe(i + 1));
    }

    for (const d of state.donations) {
      const kept = state.receipts.get(d.id)!;
      const now = await receiptsOf(finance, 'donation', d.id);
      expect(now).toHaveLength(1);
      expect(now[0]).toMatchObject({ id: kept.id, number: kept.number, date: d.paidOn, status: 'issued', period: fiscalYear(d.paidOn) });
      expect(Number(now[0]!.amount)).toBe(d.amount);
      expect((await getRecord(finance, 'donation', d.id)).status).toBe('paid');
    }
  });
});
