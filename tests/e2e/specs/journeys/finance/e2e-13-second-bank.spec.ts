import { expect, test, type APIRequestContext, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { memberApi, runTag } from '../../../src/api.js';
import { utcToday } from '../../../src/journeys/donation.js';
import { signIn } from '../../../src/sign-in.js';

/**
 * A second real bank account, from opening it to the trial balance: move money into it, import the bank's statement,
 * pair what the books already hold, book what is missing (a bank charge), sign the month off, and check that the
 * trial balance still balances and agrees with the Money page. It uses the administrator, who may do all of this.
 */

const today = utcToday();
const tag = runTag('E2E13').toLowerCase();
const key = `proj-${tag}`.slice(0, 40);
const tags = ['@e2e', '@finance', '@P1'];

interface StatementLine { id: string; date: string; amount: string; description: string; status: string; journalLineId: string | null }
interface TrialRow { code: string; moneyKey: string | null; debit: string; credit: string }

let admin: APIRequestContext;
let context: BrowserContext;
let page: Page;
let ledgerCode = '';
let chargeCode = '';

const json = async <T>(res: APIResponse, what: string, status = 200): Promise<T> => {
  expect(res.status(), `${what}: ${await res.text()}`).toBe(status);
  return (await res.json()) as T;
};
const base = `/api/money/accounts/${key}`;
const statement = async (status?: string) => json<StatementLine[]>(await admin.get(`${base}/statement${status ? `?status=${status}` : ''}`), 'statement');
const trialBalance = async () => json<{ rows: TrialRow[]; balanced: boolean; totalDebit: string; totalCredit: string }>(await admin.get(`/api/ledger/trial-balance?asOf=${today}`), 'trial balance');

test.describe.serial('FT-E2E-13 A second bank account, to the trial balance', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async ({ browser }, info) => {
    admin = await memberApi(accounts.admin.email);
    context = await browser.newContext({ baseURL: info.project.use.baseURL ?? process.env.APP_BASE_URL ?? 'http://localhost:4200', viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await admin?.dispose();
    await context?.close();
  });

  test('FT-FIN-060 opens a second bank account with its own ledger account', { tag: tags }, async () => {
    const opened = await json<{ key: string; ledgerCode: string; kind: string }>(
      await admin.post('/api/money/accounts', { data: { key, name: `Project bank ${tag}`, kind: 'bank' } }),
      'open the account',
      201,
    );
    ledgerCode = opened.ledgerCode;
    expect(opened).toMatchObject({ key, kind: 'bank' });
    expect(ledgerCode).toBeTruthy();
    const list = await json<{ key: string }[]>(await admin.get('/api/money/accounts'), 'list accounts');
    expect(list.map((a) => a.key)).toContain(key);

    const ledgerAccounts = await json<{ code: string; type: string; moneyKey: string | null }[]>(await admin.get('/api/ledger/accounts'), 'ledger accounts');
    expect(ledgerAccounts.find((a) => a.code === ledgerCode)).toMatchObject({ type: 'asset', moneyKey: key });
    chargeCode = ledgerAccounts.find((a) => a.type === 'expense' && a.moneyKey === null)?.code ?? '';
    expect(chargeCode, 'an expense account to book a bank charge against').toBeTruthy();
  });

  test('FT-FIN-061 a transfer moves money between the two banks and shows on both statements', { tag: tags }, async () => {
    await json(await admin.post('/api/money/transfers', { data: { from: 'upi', to: key, amount: 100, date: today, reference: `T-${tag}`, overrideReason: 'Opening the second bank in the finance journey' } }), 'transfer', 201);
    const balances = await json<{ accounts: { key: string; balance: string }[] }>(await admin.get(`/api/money/balances?asOf=${today}`), 'balances');
    expect(balances.accounts.find((a) => a.key === key)?.balance).toBe('100.00');
    const ledger = await json<{ closing: string; lines: { debit: string; kind: string }[] }>(await admin.get(`${base}/ledger?from=${today}&to=${today}`), 'account ledger');
    expect(ledger.closing).toBe('100.00');
    expect(ledger.lines.map((l) => [l.debit, l.kind])).toEqual([['100.00', 'transfer']]);
  });

  test('FT-FIN-062 an imported statement pairs the transfer and leaves the bank charge to book', { tag: tags }, async () => {
    const imported = await json<{ added: number; duplicates: number; matched: number }>(
      await admin.post(`${base}/statement`, {
        data: { lines: [{ date: today, amount: 100, description: `Transfer in ${tag}`, reference: `T-${tag}` }, { date: today, amount: -12.5, description: `SMS charges ${tag}` }] },
      }),
      'import',
      201,
    );
    expect(imported).toEqual({ added: 2, duplicates: 0, matched: 1 });

    const again = await json<{ added: number; duplicates: number }>(
      await admin.post(`${base}/statement`, { data: { lines: [{ date: today, amount: 100, description: `Transfer in ${tag}`, reference: `T-${tag}` }] } }),
      're-import',
      201,
    );
    expect(again).toMatchObject({ added: 0, duplicates: 1 });

    const open = await statement('unmatched');
    expect(open.map((l) => [l.amount, l.status])).toEqual([['-12.50', 'unmatched']]);
  });

  test('FT-FIN-063 sign-off is refused while a line is unbooked, then accepted once the charge is booked', { tag: tags }, async () => {
    const before = await json<{ reconciled: boolean; difference: string; unbooked: { lines: unknown[] } }>(await admin.get(`${base}/reconciliation?asOf=${today}&statementBalance=87.50`), 'report');
    expect(before.reconciled).toBe(false);
    expect(before.unbooked.lines).toHaveLength(1);
    const refused = await admin.post(`${base}/reconciliations`, { data: { asOf: today, statementBalance: 87.5 } });
    expect(refused.status()).toBeGreaterThanOrEqual(400);

    const [charge] = await statement('unmatched');
    await json(await admin.post(`${base}/statement/${charge!.id}/book`, { data: { accountCode: chargeCode, memo: 'Bank SMS charges' } }), 'book the charge');
    expect(await statement('unmatched')).toHaveLength(0);

    const after = await json<{ reconciled: boolean; difference: string; bookBalance: string }>(await admin.get(`${base}/reconciliation?asOf=${today}&statementBalance=87.50`), 'report');
    expect(after).toMatchObject({ reconciled: true, difference: '0.00', bookBalance: '87.50' });
    await json(await admin.post(`${base}/reconciliations`, { data: { asOf: today, statementBalance: 87.5, note: 'Finance journey' } }), 'sign off', 201);
    const signOffs = await json<{ asOf: string; statementBalance: string }[]>(await admin.get(`${base}/reconciliations`), 'sign-offs');
    expect(signOffs[0]).toMatchObject({ asOf: today, statementBalance: '87.50' });
  });

  test('FT-FIN-064 a matched line can be reopened, and matching it again keeps the books and statement equal', { tag: tags }, async () => {
    const matched = (await statement('matched')).find((l) => l.amount === '100.00');
    expect(matched?.journalLineId).toBeTruthy();
    await json(await admin.post(`${base}/statement/${matched!.id}/reopen`), 'reopen');
    expect((await statement('unmatched')).map((l) => l.amount)).toEqual(['100.00']);
    await json(await admin.post(`${base}/statement/auto-match`), 'auto-match');
    expect(await statement('unmatched')).toHaveLength(0);
  });

  test('FT-FIN-065 the trial balance balances and its money accounts add up to the Money page', { tag: tags }, async () => {
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.rows.find((r) => r.code === ledgerCode)).toMatchObject({ moneyKey: key, debit: '87.50', credit: '0.00' });
    expect(tb.rows.find((r) => r.code === chargeCode)?.debit).not.toBe('0.00');

    const money = await json<{ total: string }>(await admin.get(`/api/money/balances?asOf=${today}`), 'balances');
    const cents = tb.rows.filter((r) => r.moneyKey).reduce((sum, r) => sum + Math.round((Number(r.debit) - Number(r.credit)) * 100), 0);
    expect((cents / 100).toFixed(2)).toBe(money.total);
  });

  test('FT-FIN-066 the three screens open for the account: statement, reconcile and trial balance', { tag: tags }, async () => {
    await signIn(page, accounts.admin.email, accounts.admin.name);

    await page.goto(`/accounts/${key}/statement`);
    await expect(page.getByTestId('statement-table')).toBeVisible();
    await expect(page.getByTestId('statement-row').first()).toBeVisible();
    await expect(page.getByTestId('statement-closing')).toContainText('87.50');

    await page.goto(`/accounts/${key}/reconcile`);
    await expect(page.getByText(`Project bank ${tag}`).first()).toBeVisible();

    await page.goto('/accounts/trial-balance');
    await expect(page.getByTestId('tb-badge')).toHaveText('Balanced');
    await expect(page.locator(`[data-testid="tb-row"][data-code="${ledgerCode}"]`)).toContainText('87.50');
    const debit = await page.getByTestId('tb-total-debit').innerText();
    expect(debit).toBe(await page.getByTestId('tb-total-credit').innerText());
  });
});
