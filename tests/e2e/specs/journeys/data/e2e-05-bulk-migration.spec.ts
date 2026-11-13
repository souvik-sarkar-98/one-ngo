import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { memberApi } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import { openListMenu } from '../../../src/records.js';
import { signIn } from '../../../src/sign-in.js';
import {
  addMemberWithPassword,
  allRecords,
  body,
  csv,
  markPaid,
  member,
  messagesTo,
  noMailbox,
  openMailbox,
  panFor,
  phoneFor,
  queryRecords,
  runLetters,
  suspendQuietly,
  uploadImport,
  waitForImport,
  writeCsv,
  type ApiError,
  type CheckResult,
  type ImportView,
  type RecordView,
} from '../../../src/journeys/data.js';

/** Donor rows in the main import. The journey names 1,000; a normal run uses fewer. */
const rows = Math.min(4000, Math.max(10, Number(process.env.E2E_IMPORT_ROWS) || 60));
/** Rows in the import that is left running when the panel is closed (FT-REC-187). */
const closeRows = Math.min(4000, Math.max(1, Number(process.env.E2E_IMPORT_CLOSE_ROWS) || 120));

const ui = {
  next: label('ui.common.next'),
  close: label('ui.common.close'),
  search: label('ui.records.searchList'),
  importEntry: label('ui.imports.import'),
  sample: label('ui.imports.sample'),
  done: label('ui.imports.done'),
  willCreate: label('ui.imports.willCreate'),
  willUpdate: label('ui.imports.willUpdate'),
  haveProblems: label('ui.imports.haveProblems'),
  notCsv: label('ui.imports.notCsv'),
  matchOne: label('ui.imports.matchOne'),
  downloadFailed: label('ui.imports.downloadFailed'),
  updateByPan: label('ui.imports.updateWhen', { type: 'donor', field: 'PAN' }),
  select: label('ui.bulk.select'),
  clear: label('ui.bulk.clear'),
  editFields: label('ui.bulk.editFields'),
  nothingToSet: label('ui.bulk.nothingToSet'),
  exportOp: label('ui.imports.export'),
  addRole: label('ui.people.bulkAddRole'),
  removeRole: label('ui.people.bulkRemoveRole'),
  suspend: label('ui.people.suspend'),
  role: label('ui.bulk.role'),
  all: label('ui.people.status.all'),
  jobsRunning: label('ui.admin.jobs.status.running'),
  jobsFailed: label('ui.admin.jobs.status.failed'),
  jobDone: label('ui.admin.jobs.status.done'),
  failedItems: label('ui.admin.jobs.failedItems'),
};

/** Labels from the published Donations module (packages/product/modules/donations). */
const donorColumns = ['Name', 'Email', 'Phone', 'PAN', 'Address', 'City', 'Notes'];
const listColumns = ['Name', 'Email', 'Phone', 'City'];
const sendReminder = 'Send reminder';
const reminderConfirm = 'Send a payment reminder to the donor by email?';

const tags = (priority: '@P0' | '@P1') => ['@e2e', '@FT-E2E-05', priority];
const importTimeout = (n: number) => 120_000 + n * 400;
const count = (n: number) => new Intl.NumberFormat('en-IN').format(n);

const stamp = Date.now().toString(36);
const letters = runLetters();
const seed = Date.now() % 100000;
const prefix = `Mig ${stamp}`;
const city = `Migcity ${stamp}`;
const editedCity = `Migedit ${stamp}`;
const donorName = (i: number) => `${prefix} Donor ${String(i).padStart(4, '0')}`;
const donorEmail = (i: number) => `mig.${stamp}.${i}@donor.example`;

function donorCsv(from: number, n: number, last: string): string {
  const out: (string | number)[][] = [donorColumns];
  for (let i = from; i < from + n; i++) {
    out.push([donorName(i), donorEmail(i), phoneFor(i, seed), panFor(letters, i, last), `${i} MG Road`, city, `Pledged ₹ 1,00,000.50 on 31/03/2027`]);
  }
  return csv(out);
}

test.describe.serial('FT-E2E-05 Bulk migration', () => {
  let page: Page;
  let admin: APIRequestContext;
  let mail: APIRequestContext | null = null;
  /** Donors this run created with the run's city, before any bulk edit. */
  let expected = 0;
  const importIds: Record<'main' | 'update' | 'failed' | 'rules' | 'donations' | 'closed', string | undefined> = {
    main: undefined,
    update: undefined,
    failed: undefined,
    rules: undefined,
    donations: undefined,
    closed: undefined,
  };
  let donations: RecordView[] = [];
  let edited: string[] = [];
  let exported = false;
  let secondAdmin: { email: string; name: string; userId?: string; api?: APIRequestContext; context?: BrowserContext } | undefined;
  const people: { email: string; name: string; userId: string }[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page, accounts.admin.email, accounts.admin.name);
    admin = await memberApi(accounts.admin.email);
    mail = await openMailbox();
  });

  test.afterAll(async () => {
    await secondAdmin?.context?.close();
    await secondAdmin?.api?.dispose();
    if (admin) {
      await suspendQuietly(admin, secondAdmin?.userId);
      for (const p of people) await suspendQuietly(admin, p.userId);
      await admin.dispose();
    }
    await mail?.dispose();
    await page?.close();
  });

  // ------------------------------------------------------------ import donors

  test('FT-REC-170 a donor file imports in five addressed steps, with a sample that matches the list', { tag: tags('@P1') }, async ({}, testInfo) => {
    test.setTimeout(importTimeout(rows));
    const dialog = await openImport(page, '/records/donor', 'donors');
    await expect(page).toHaveURL(/[?&]import=new(&|$)/);
    await expect(dialog.getByText(label('ui.imports.stepOf', { step: 1, steps: 5 }))).toBeVisible();

    const sample = page.waitForEvent('download');
    await dialog.getByRole('button', { name: ui.sample }).click();
    const header = readFileSync(await (await sample).path(), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0]!.split(',');
    expect(header).toEqual(donorColumns);
    for (const column of listColumns) expect(header).toContain(column);

    await dialog.locator('input[type="file"]').setInputFiles(writeCsv(testInfo, 'donors.csv', donorCsv(1, rows, 'A')));
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(page).toHaveURL(/[?&]importStep=1(&|$)/);
    await expect(dialog.getByText(label('ui.imports.stepOf', { step: 2, steps: 5 }))).toBeVisible();
    importIds.main = new URL(page.url()).searchParams.get('import') ?? undefined;

    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(page).toHaveURL(/[?&]importStep=2(&|$)/);
    await expect(countOf(dialog, ui.willCreate)).toHaveText(count(rows));
    await expect(countOf(dialog, ui.haveProblems)).toHaveText('0');

    await dialog.getByRole('button', { name: runLabel(rows) }).click();
    await expect(dialog.getByText(label('ui.imports.finished', { created: rows, updated: 0, failed: 0 }))).toBeVisible({ timeout: importTimeout(rows) });
    await expect(page).toHaveURL(/[?&]importStep=4(&|$)/);
    await expect(dialog.getByText(label('ui.imports.stepOf', { step: 5, steps: 5 }))).toBeVisible();
    await footer(dialog, ui.done).click();
    await expect(dialog).toBeHidden();
    expected += rows;

    const landed = await queryRecords(admin, 'donor', { filters: { city: { eq: city } }, limit: 1 });
    expect(landed.total).toBe(rows);
  });

  test('FT-REC-171 a .txt, an empty file and a header-only file are refused', { tag: tags('@P1') }, async ({}, testInfo) => {
    const dialog = await openImport(page, '/records/donor', 'donors');
    const input = dialog.locator('input[type="file"]');
    const next = dialog.getByRole('button', { name: ui.next, exact: true });

    await input.setInputFiles(writeCsv(testInfo, 'donors.txt', 'Name\r\nNot a csv\r\n'));
    await expect(dialog.getByRole('alert')).toHaveText(ui.notCsv);

    await input.setInputFiles(writeCsv(testInfo, 'empty.csv', ''));
    await next.click();
    const empty = dialog.getByRole('alert');
    await expect(empty).toHaveText(/The file is empty\.|The file has no heading row\./);
    testInfo.annotations.push({ type: 'message', description: `Empty file: "${(await empty.textContent())?.trim()}"` });

    await input.setInputFiles(writeCsv(testInfo, 'header-only.csv', 'Name,Email,PAN\r\n'));
    await next.click();
    await expect(dialog.getByRole('alert')).toHaveText('The file has no rows to import.');
    await expect(page).toHaveURL(/[?&]import=new(&|$)/);
  });

  test('FT-REC-173 a file whose columns match no field cannot continue', { tag: tags('@P1') }, async ({}, testInfo) => {
    const dialog = await openImport(page, '/records/donor', 'donors');
    await dialog.locator('input[type="file"]').setInputFiles(writeCsv(testInfo, 'unmatched.csv', csv([['Colour', 'Size'], ['Blue', 'Large']])));
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(page).toHaveURL(/[?&]importStep=1(&|$)/);
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText(ui.matchOne);
    await expect(page).toHaveURL(/[?&]importStep=1(&|$)/);
  });

  test('FT-REC-174 two columns cannot fill one field', { tag: tags('@P1') }, async () => {
    // The screen lets a field go from one column when another takes it, so the refusal is the server's.
    const view = await uploadImport(admin, 'donor', 'twice.csv', csv([['Full name', 'Name'], [`${prefix} Twice A`, `${prefix} Twice B`]]));
    const refused = await body<ApiError>(await admin.put(`/api/imports/${view.id}/mapping`, { data: { columns: { 'Full name': 'name', Name: 'name' } } }), 422, 'map twice');
    expect(refused.message).toBe("More than one column fills 'Name'.");
  });

  test('FT-REC-175 calculated and rollup fields cannot be matched', { tag: tags('@P1') }, async () => {
    const donors = await uploadImport(admin, 'donor', 'rollups.csv', csv([['Given'], ['100']]));
    for (const [field, name] of [['totalGiven', 'Total given'], ['donationCount', 'Donations paid']]) {
      const refused = await body<ApiError>(await admin.put(`/api/imports/${donors.id}/mapping`, { data: { columns: { Given: field } } }), 422, `map ${field}`);
      expect(refused.message).toBe(`'${name}' cannot be imported.`);
    }
    const gifts = await uploadImport(admin, 'donation', 'calculated.csv', csv([['Net'], ['100']]));
    const refused = await body<ApiError>(await admin.put(`/api/imports/${gifts.id}/mapping`, { data: { columns: { Net: 'netAmount' } } }), 422, 'map netAmount');
    expect(refused.message).toBe("'Net amount' cannot be imported.");
    expect(donors.suggested['Given']).toBeNull();
    test.info().annotations.push({ type: 'note', description: 'Donors and Donations have no file or signature field; the sample file in FT-REC-170 leaves out the rollups.' });
  });

  test('FT-REC-176 an update by PAN changes the matching donor and creates the new one', { tag: tags('@P1') }, async ({}, testInfo) => {
    test.setTimeout(importTimeout(2));
    const note = `Updated by PAN ${stamp}`;
    const fresh = `${prefix} Donor U001`;
    const dialog = await openImport(page, '/records/donor', 'donors');
    await dialog.locator('input[type="file"]').setInputFiles(
      writeCsv(
        testInfo,
        'update-by-pan.csv',
        csv([
          ['Name', 'PAN', 'City', 'Notes'],
          [donorName(1), panFor(letters, 1, 'A'), city, note],
          [fresh, panFor(letters, 9001, 'B'), city, 'Created by the update import'],
        ]),
      ),
    );
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(page).toHaveURL(/[?&]importStep=1(&|$)/);
    importIds.update = new URL(page.url()).searchParams.get('import') ?? undefined;
    await dialog.getByRole('checkbox', { name: ui.updateByPan }).check();
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(countOf(dialog, ui.willUpdate)).toHaveText('1');
    await expect(countOf(dialog, ui.willCreate)).toHaveText('1');
    await dialog.getByRole('button', { name: runLabel(2) }).click();
    await expect(dialog.getByText(label('ui.imports.finished', { created: 1, updated: 1, failed: 0 }))).toBeVisible({ timeout: importTimeout(2) });
    await footer(dialog, ui.done).click();
    expected += 1;

    const first = (await allRecords(admin, 'donor', { search: donorName(1) })).find((r) => r.data['name'] === donorName(1));
    expect(first?.data['notes']).toBe(note);
    const created = (await allRecords(admin, 'donor', { search: fresh })).filter((r) => r.data['name'] === fresh);
    expect(created).toHaveLength(1);
  });

  test('FT-REC-178 a bad row is listed as Row n, skipped, and the good row is created', { tag: tags('@P1') }, async ({}, testInfo) => {
    test.setTimeout(importTimeout(2));
    const bad = `${prefix} Bad 1`;
    const good = `${prefix} Donor G001`;
    const dialog = await openImport(page, '/records/donor', 'donors');
    await dialog.locator('input[type="file"]').setInputFiles(
      writeCsv(
        testInfo,
        'one-bad-row.csv',
        csv([
          ['Name', 'Email', 'PAN', 'City'],
          [bad, `bad.${stamp}@donor.example`, 'PAN12', city],
          [good, `good.${stamp}@donor.example`, panFor(letters, 9002, 'C'), city],
        ]),
      ),
    );
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(page).toHaveURL(/[?&]importStep=1(&|$)/);
    importIds.failed = new URL(page.url()).searchParams.get('import') ?? undefined;
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(countOf(dialog, ui.haveProblems)).toHaveText('1');
    const problems = dialog.getByRole('list', { name: ui.haveProblems });
    await expect(problems.getByRole('listitem')).toHaveCount(1);
    await expect(problems.getByRole('listitem')).toHaveText(/^Row 2 · .*PAN/);

    await dialog.getByRole('button', { name: runLabel(1) }).click();
    await expect(dialog.getByText(label('ui.imports.finished', { created: 1, updated: 0, failed: 1 }))).toBeVisible({ timeout: importTimeout(2) });
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: ui.downloadFailed }).click();
    const failed = readFileSync(await (await download).path(), 'utf8').replace(/^\uFEFF/, '');
    const [head, ...lines] = failed.split(/\r?\n/).filter(Boolean);
    expect(head).toBe('Name,Email,PAN,City,Reason');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(bad);
    await footer(dialog, ui.done).click();
    expected += 1;

    expect((await allRecords(admin, 'donor', { search: good })).filter((r) => r.data['name'] === good)).toHaveLength(1);
    expect((await allRecords(admin, 'donor', { search: bad })).filter((r) => r.data['name'] === bad)).toHaveLength(0);
  });

  test('FT-REC-180 Indian amounts and dd/mm/yyyy dates are read correctly', { tag: tags('@P1') }, async ({}, testInfo) => {
    test.setTimeout(importTimeout(7));
    const amounts = ['1,00,000.50', '₹ 500', 'Rs 20', 'INR 5', '1,000', '250'];
    const values = [100000.5, 500, 20, 5, 1000, 250];
    const paidOn = ['31/03/2027', '2027-03-31', '', '', '', ''];
    const file: (string | number)[][] = [['Donor', 'Amount', 'Paid on', 'Notes']];
    amounts.forEach((amount, i) => file.push([donorName(i + 1), amount, paidOn[i]!, `Imported ${stamp}`]));
    file.push([donorName(7), '100', '31/02/2027', `Imported ${stamp}`]);

    const dialog = await openImport(page, '/records/donation', 'donations');
    await dialog.locator('input[type="file"]').setInputFiles(writeCsv(testInfo, 'donations.csv', csv(file)));
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(page).toHaveURL(/[?&]importStep=1(&|$)/);
    importIds.donations = new URL(page.url()).searchParams.get('import') ?? undefined;
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(countOf(dialog, ui.willCreate)).toHaveText('6');
    await expect(countOf(dialog, ui.haveProblems)).toHaveText('1');
    await expect(dialog.getByRole('list', { name: ui.haveProblems }).getByRole('listitem')).toHaveText(
      'Row 8 · Paid on is not a date (use dd/mm/yyyy or yyyy-mm-dd)',
    );
    await dialog.getByRole('button', { name: runLabel(6) }).click();
    await expect(dialog.getByText(label('ui.imports.finished', { created: 6, updated: 0, failed: 1 }))).toBeVisible({ timeout: importTimeout(7) });
    await footer(dialog, ui.done).click();

    const landed = await allRecords(admin, 'donation', { search: `${prefix} Donor` });
    donations = amounts.map((_, i) => landed.find((r) => r.data['donorName'] === donorName(i + 1))!);
    expect(donations.every(Boolean)).toBe(true);
    expect(donations.map((d) => Number(d.data['amount']))).toEqual(values);
    expect(donations.map((d) => d.data['donorEmail'])).toEqual(amounts.map((_, i) => donorEmail(i + 1)));
    testInfo.annotations.push({
      type: 'note',
      description:
        'Paid on shows only once a donation is paid, so a raised donation keeps no date; both 31/03/2027 and 2027-03-31 passed the check and 31/02/2027 was refused. Donations has no yes/no field, so yes, N and 1 are not exercised here.',
    });
  });

  test('FT-REC-186 rows that break unique, pattern and required are refused per row with the screen\'s checks', { tag: tags('@P0') }, async () => {
    test.setTimeout(importTimeout(4));
    const good = `${prefix} Donor R001`;
    const header = ['Name', 'Email', 'PAN', 'City'];
    const broken = [
      [`${prefix} Duplicate`, `dup.${stamp}@donor.example`, panFor(letters, 1, 'A'), city],
      [`${prefix} Pattern`, `pattern.${stamp}@donor.example`, 'BADPAN', city],
      ['', `required.${stamp}@donor.example`, panFor(letters, 9004, 'D'), city],
    ];
    const view = await uploadImport(admin, 'donor', 'rules.csv', csv([header, ...broken, [good, `rules.${stamp}@donor.example`, panFor(letters, 9003, 'D'), city]]));
    importIds.rules = view.id;
    await body(await admin.put(`/api/imports/${view.id}/mapping`, { data: {} }), 200, 'map rules.csv');
    const check = await body<CheckResult>(await admin.post(`/api/imports/${view.id}/check`), 200, 'check rules.csv');
    expect(check).toMatchObject({ rows: 4, valid: 1, invalid: 3, creates: 1 });
    expect([...new Set(check.problems.map((p) => p.row))]).toEqual([2, 3, 4]);

    for (const [i, cells] of broken.entries()) {
      const data = Object.fromEntries(['name', 'email', 'pan', 'city'].map((k, c) => [k, cells[c]]).filter(([, v]) => v !== ''));
      const screen = await body<ApiError>(await admin.post('/api/records/donor', { data }), 422, `save row ${i + 2} as the screen does`);
      const fromImport = check.problems.filter((p) => p.row === i + 2).map((p) => p.message).join(' | ');
      for (const issue of screen.issues?.length ? screen.issues : [{ path: '/', message: screen.message }]) expect(fromImport).toContain(issue.message);
    }

    await body(await admin.post(`/api/imports/${view.id}/run`), 202, 'run rules.csv');
    const done = await waitForImport(admin, view.id, importTimeout(4));
    expect(done.counts).toEqual({ created: 1, updated: 0, failed: 3 });
    expected += 1;
    test.info().annotations.push({ type: 'note', description: 'The donor type has no field with editPermission, so that rule is not exercised.' });
  });

  test('FT-REC-187 closing the panel leaves the import running, and its notification opens the result', { tag: tags('@P1') }, async ({}, testInfo) => {
    test.setTimeout(importTimeout(closeRows) + 60_000);
    const dialog = await openImport(page, '/records/donor', 'donors');
    await dialog.locator('input[type="file"]').setInputFiles(writeCsv(testInfo, 'donors-close.csv', donorCsv(5000, closeRows, 'E')));
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await expect(page).toHaveURL(/[?&]importStep=1(&|$)/);
    const id = new URL(page.url()).searchParams.get('import')!;
    importIds.closed = id;
    await dialog.getByRole('button', { name: ui.next, exact: true }).click();
    await dialog.getByRole('button', { name: runLabel(closeRows) }).click();

    const close = footer(dialog, ui.close);
    const done = footer(dialog, ui.done);
    await expect(close.or(done)).toBeVisible();
    if (await close.isVisible()) {
      await expect(dialog.getByText(label('ui.imports.keepWorking'))).toBeVisible();
      await close.click();
    } else {
      testInfo.annotations.push({ type: 'note', description: `The ${closeRows}-row import finished before Close could be pressed; raise E2E_IMPORT_CLOSE_ROWS.` });
      await done.click();
    }
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]import=/);

    const view = await waitForImport(admin, id, importTimeout(closeRows));
    expect(view.status).toBe('done');
    expect(view.counts).toEqual({ created: closeRows, updated: 0, failed: 0 });
    expected += closeRows;

    let link: string | undefined;
    await expect
      .poll(
        async () => {
          const items = await body<Record<string, unknown>[]>(await admin.get('/api/notifications?limit=50'), 200, 'notifications');
          link = items.map((n) => n['link']).find((l): l is string => typeof l === 'string' && l.includes(id));
          return link;
        },
        { timeout: 30_000, message: 'an Import finished notification for this import' },
      )
      .toBeTruthy();
    await page.goto(link!);
    const result = importDialog(page, 'donors');
    await expect(result.getByText(label('ui.imports.finished', { created: closeRows, updated: 0, failed: 0 }))).toBeVisible();
    await footer(result, ui.done).click();
  });

  // ----------------------------------------------------- bulk on imported rows

  test('FT-REC-220 checkboxes select rows into the bulk bar, and ✕ clears it', { tag: tags('@P1') }, async () => {
    await searchList(page, '/records/donor', `${prefix} Donor 000`);
    await openListMenu(page, ui.select);
    await checkRow(page, donorName(1));
    await checkRow(page, donorName(2));
    const bar = page.getByRole('region', { name: label('ui.bulk.selected', { count: 2 }) });
    await expect(bar).toBeVisible();
    await expect(bar.getByText(label('ui.bulk.selected', { count: 2 }))).toBeVisible();
    await bar.getByRole('button', { name: ui.clear }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: `${ui.select} ${donorName(1)}` })).not.toBeChecked();
    test.info().annotations.push({ type: 'note', description: 'Donors list as a table at this width; long-press on cards is not exercised.' });
  });

  test('FT-REC-222 Edit fields on 10 imported donors changes only the filled field on only those donors', { tag: tags('@P0') }, async () => {
    test.setTimeout(120_000);
    await searchList(page, '/records/donor', `${prefix} Donor 00`);
    await openListMenu(page, ui.select);
    const boxes = page.getByRole('checkbox', { name: new RegExp(`^${ui.select} ${escape(prefix)} Donor 00\\d\\d$`) });
    await expect.poll(() => boxes.count()).toBeGreaterThanOrEqual(10);
    edited = [];
    for (let i = 0; i < 10; i++) {
      const box = boxes.nth(i);
      edited.push((await box.getAttribute('aria-label'))!.slice(ui.select.length + 1));
      await box.check();
    }
    const before = Object.fromEntries((await allRecords(admin, 'donor', { search: `${prefix} Donor` })).map((r) => [r.id, r.data]));

    await page.getByRole('region', { name: label('ui.bulk.selected', { count: 10 }) }).getByRole('button', { name: ui.editFields, exact: true }).click();
    const panel = page.getByRole('dialog', { name: label('ui.bulk.title', { operation: ui.editFields, count: 10 }) });
    await expect(panel.getByText(label('ui.bulk.editHint'))).toBeVisible();
    await panel.getByLabel('City', { exact: true }).fill(editedCity);
    await panel.getByRole('button', { name: label('ui.bulk.apply', { count: 10 }), exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText(label('ui.bulk.done', { count: 10 }), { timeout: 60_000 });
    await footer(panel, ui.done).click();

    const moved = await allRecords(admin, 'donor', { filters: { city: { eq: editedCity } } });
    expect(moved.map((r) => r.data['name']).sort()).toEqual([...edited].sort());
    for (const r of moved) expect({ ...r.data, city: undefined }).toEqual({ ...before[r.id], city: undefined });
    const kept = await queryRecords(admin, 'donor', { filters: { city: { eq: city } }, limit: 1 });
    expect(kept.total).toBe(expected - 10);
  });

  test('FT-REC-223 Edit fields with nothing filled asks for a field', { tag: tags('@P1') }, async () => {
    await searchList(page, '/records/donor', donorName(3));
    await openListMenu(page, ui.select);
    await checkRow(page, donorName(3));
    await page.getByRole('region', { name: label('ui.bulk.selected', { count: 1 }) }).getByRole('button', { name: ui.editFields, exact: true }).click();
    const panel = page.getByRole('dialog', { name: label('ui.bulk.title', { operation: ui.editFields, count: 1 }) });
    await panel.getByRole('button', { name: label('ui.bulk.apply', { count: 1 }), exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText(ui.nothingToSet);
    await page.keyboard.press('Escape');
  });

  test('FT-REC-225 bulk Cancel on Raised and Paid cancels the Raised and reports the Paid as failed', { tag: tags('@P1') }, async () => {
    expect(donations).toHaveLength(6);
    donations[0] = await markPaid(admin, donations[0]!);
    donations[1] = await markPaid(admin, donations[1]!);
    const ids = donations.slice(0, 4).map((d) => d.id);
    const out = await body<{ results: { id: string; ok: boolean; message?: string }[]; done: number; failed: number }>(
      await admin.post('/api/records/donation/bulk', { data: { ids, operation: { type: 'step', step: 'cancel' } } }),
      200,
      'bulk cancel',
    );
    expect({ done: out.done, failed: out.failed }).toEqual({ done: 2, failed: 2 });
    const byId = new Map(out.results.map((r) => [r.id, r]));
    for (const d of donations.slice(0, 2)) {
      expect(byId.get(d.id)?.ok).toBe(false);
      expect(byId.get(d.id)?.message).toBeTruthy();
    }
    for (const d of donations.slice(2, 4)) expect(byId.get(d.id)?.ok).toBe(true);
    const statuses = await Promise.all(ids.map(async (id) => (await body<RecordView>(await admin.get(`/api/records/donation/${id}`), 200, id)).status));
    expect(statuses).toEqual(['paid', 'paid', 'cancelled', 'cancelled']);
    test.info().annotations.push({ type: 'note', description: 'The bulk bar offers a step only when every selected record allows it, so the mixed selection runs through the bulk API.' });
  });

  test('FT-REC-226 bulk Send reminder makes one delivery per eligible donation', { tag: tags('@P1') }, async () => {
    const targets = [5, 6];
    const before = mail ? await Promise.all(targets.map(async (i) => (await messagesTo(mail!, donorEmail(i))).length)) : [];
    await searchList(page, '/records/donation', `${prefix} Donor 000`);
    await openListMenu(page, ui.select);
    for (const i of targets) await checkRow(page, donorName(i));
    await page.getByRole('region', { name: label('ui.bulk.selected', { count: 2 }) }).getByRole('button', { name: sendReminder, exact: true }).click();
    const panel = page.getByRole('dialog', { name: label('ui.bulk.title', { operation: sendReminder, count: 2 }) });
    await expect(panel.getByText(reminderConfirm)).toBeVisible();
    await panel.getByRole('button', { name: label('ui.bulk.apply', { count: 2 }), exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText(label('ui.bulk.done', { count: 2 }), { timeout: 30_000 });
    await footer(panel, ui.done).click();
    if (!mail) {
      test.info().annotations.push({ type: 'blocked', description: `Deliveries not counted. ${noMailbox}` });
      return;
    }
    for (const [n, i] of targets.entries()) {
      await expect.poll(async () => (await messagesTo(mail!, donorEmail(i))).length, { timeout: 30_000 }).toBe(before[n]! + 1);
    }
  });

  test('FT-REC-228 bulk Export downloads only the selected donors', { tag: tags('@P1') }, async () => {
    const picked = [1, 2, 3].map(donorName);
    await searchList(page, '/records/donor', `${prefix} Donor 000`);
    await openListMenu(page, ui.select);
    for (const name of picked) await checkRow(page, name);
    const download = page.waitForEvent('download');
    await page.getByRole('region', { name: label('ui.bulk.selected', { count: 3 }) }).getByRole('button', { name: ui.exportOp, exact: true }).click();
    const text = readFileSync(await (await download).path(), 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(4);
    for (const name of picked) expect(text).toContain(name);
    expect(text).not.toContain(donorName(4));
    exported = true;
  });

  // ---------------------------------------------------------- jobs and a role

  test('FT-REC-233 another administrator sees everyone\'s jobs with their state', { tag: tags('@P1') }, async ({ browser }) => {
    test.skip(!mail, noMailbox);
    test.setTimeout(150_000);
    const mainJob = (await importView(admin, importIds.main)).jobId!;
    const failedJob = (await importView(admin, importIds.failed)).jobId!;
    secondAdmin = { email: `jobs.${stamp}@riverbank.example`, name: `Jobs Admin ${stamp}` };
    secondAdmin.userId = await addMemberWithPassword(admin, mail!, { ...secondAdmin, roles: ['admin'] });
    secondAdmin.api = await memberApi(secondAdmin.email);
    secondAdmin.context = await browser.newContext();
    const other = await secondAdmin.context.newPage();
    await signIn(other, secondAdmin.email, secondAdmin.name);

    await other.goto('/admin/jobs');
    for (const chip of [ui.jobsRunning, ui.jobsFailed, ui.all]) await expect(other.getByRole('tab', { name: chip, exact: true })).toBeVisible();
    await expect(other.getByText(new RegExp(`^${accounts.admin.name} · `)).first()).toBeVisible();

    await other.goto(`/admin/jobs?job=${mainJob}`);
    const panel = other.getByRole('dialog');
    await expect(panel.getByText(accounts.admin.name)).toBeVisible();
    await expect(panel.getByText(ui.jobDone, { exact: true })).toBeVisible();
    await expect(panel.getByText(label('ui.admin.jobs.noFailed'))).toBeVisible();

    await other.goto(`/admin/jobs?job=${failedJob}`);
    await expect(other.getByRole('dialog').getByText(ui.failedItems)).toBeVisible();
    await expect(other.getByRole('dialog').getByText(/PAN/).first()).toBeVisible();
    await expect(other.getByRole('dialog').getByRole('button', { name: ui.downloadFailed })).toBeVisible();

    const listed = JSON.stringify(await body(await secondAdmin.api.get('/api/admin/jobs?limit=200'), 200, 'jobs as another administrator'));
    expect(listed).toContain(mainJob);
    expect(listed).toContain(failedJob);
  });

  test('FT-ADM-027 bulk add a role, remove it again, and suspend selected people', { tag: tags('@P1') }, async () => {
    test.setTimeout(120_000);
    const group = `Bulk ${stamp}`;
    for (let i = 1; i <= 3; i++) {
      const person = { email: `bulk.${stamp}.${i}@riverbank.example`, name: `${group} P${i}` };
      const added = await body<{ userId: string }>(
        await admin.post('/api/admin/people', { data: { email: person.email, displayName: person.name, roles: ['viewer'], invite: false } }),
        201,
        `add ${person.email}`,
      );
      people.push({ ...person, userId: added.userId });
    }
    const rolesOf = async () => Promise.all(people.map(async (p) => (await member(admin, p.userId)).roles.sort().join(',')));

    await page.goto('/admin/people');
    await page.getByRole('tab', { name: new RegExp(`^${ui.all}\\b`) }).click();
    await page.getByRole('searchbox', { name: ui.search }).fill(group);
    await expect(page.getByText(people[2]!.name).first()).toBeVisible();

    await bulkPeople(page, people, ui.addRole, async (sheet) => sheet.getByLabel(ui.role).selectOption({ label: 'Directory' }));
    await expect.poll(rolesOf).toEqual(['directory,viewer', 'directory,viewer', 'directory,viewer']);

    await bulkPeople(page, people, ui.removeRole, async (sheet) => sheet.getByLabel(ui.role).selectOption({ label: 'Directory' }));
    await expect.poll(rolesOf).toEqual(['viewer', 'viewer', 'viewer']);

    await bulkPeople(page, people, ui.suspend, async (sheet) =>
      expect(sheet.getByText(label('ui.people.suspendNote', { name: label('ui.bulk.selected', { count: 3 }) }))).toBeVisible(),
    );
    await expect.poll(async () => Promise.all(people.map(async (p) => (await member(admin, p.userId)).status))).toEqual(['suspended', 'suspended', 'suspended']);
  });

  test('FT-E2E-05 bulk migration ends with matching counts, downloadable failed rows and visible jobs', { tag: tags('@P0') }, async () => {
    const tagged = await queryRecords(admin, 'donor', { filters: { city: { eq: city } }, limit: 1 });
    const moved = await queryRecords(admin, 'donor', { filters: { city: { eq: editedCity } }, limit: 1 });
    expect(tagged.total + moved.total).toBe(expected);
    expect(moved.total).toBe(edited.length);
    expect(exported).toBe(true);

    const failed = await admin.get(`/api/imports/${importIds.failed}/failed.csv`);
    expect(failed.status()).toBe(200);
    expect(await failed.text()).toContain(`${prefix} Bad 1`);

    const viewer = secondAdmin?.api ?? admin;
    if (!secondAdmin?.api) test.info().annotations.push({ type: 'blocked', description: `Jobs checked as ${accounts.admin.name}, not another administrator. ${noMailbox}` });
    const listed = JSON.stringify(await body(await viewer.get('/api/admin/jobs?limit=200'), 200, 'jobs'));
    for (const [name, id] of Object.entries(importIds)) {
      expect(listed, `${name} import job`).toContain((await importView(admin, id)).jobId!);
    }

    expect(people).toHaveLength(3);
    for (const p of people) expect(await member(admin, p.userId)).toMatchObject({ status: 'suspended', roles: ['viewer'] });
  });
});

// -------------------------------------------------------------------- helpers

function importDialog(page: Page, plural: string): Locator {
  return page.getByRole('dialog', { name: label('ui.imports.title', { type: plural }) });
}

async function openImport(page: Page, list: string, plural: string): Promise<Locator> {
  await page.goto(list);
  await openListMenu(page, ui.importEntry);
  const dialog = importDialog(page, plural);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** A button in the sheet's footer, apart from the header's own close button. */
function footer(dialog: Locator, name: string): Locator {
  return dialog.locator('button[sheetfooteractions]').filter({ hasText: name });
}

function countOf(dialog: Locator, name: string): Locator {
  return dialog.locator('.import-panel__count').filter({ hasText: name }).locator('b');
}

function runLabel(n: number): string {
  return label(n === 1 ? 'ui.imports.run.one' : 'ui.imports.run.other', { count: n });
}

async function searchList(page: Page, list: string, text: string): Promise<void> {
  await page.goto(list);
  await page.getByRole('searchbox', { name: ui.search }).fill(text);
  await expect(page.getByText(text).first()).toBeVisible();
}

async function checkRow(page: Page, title: string): Promise<void> {
  await page.getByRole('checkbox', { name: `${ui.select} ${title}`, exact: true }).check();
}

async function importView(api: APIRequestContext, id: string | undefined): Promise<ImportView> {
  expect(id, 'import id from an earlier step').toBeTruthy();
  return body(await api.get(`/api/imports/${id}`), 200, `import ${id}`);
}

/** Selects the people, runs one bulk operation from the bar, and confirms it with Apply. */
async function bulkPeople(page: Page, people: { name: string }[], operation: string, fill: (sheet: Locator) => Promise<unknown>): Promise<void> {
  const bar = page.getByRole('region', { name: label('ui.bulk.selected', { count: people.length }) });
  if (!(await bar.isVisible())) {
    if (!(await page.getByRole('checkbox', { name: `${ui.select} ${people[0]!.name}`, exact: true }).isVisible())) await openListMenu(page, ui.select);
    for (const p of people) await checkRow(page, p.name);
  }
  await bar.getByRole('button', { name: operation, exact: true }).click();
  const sheet = page.getByRole('dialog', { name: label('ui.bulk.title', { operation, count: people.length }) });
  await fill(sheet);
  await sheet.getByRole('button', { name: label('ui.bulk.apply', { count: people.length }), exact: true }).click();
  await expect(sheet).toBeHidden();
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
