import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { accounts, org } from '../../../src/accounts.js';
import { memberApi } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import { knownDefect } from '../../../src/shell.js';
import { signIn } from '../../../src/sign-in.js';
import {
  addMemberWithPassword,
  body,
  createRecord,
  getRecord,
  markPaid,
  member,
  noMailbox,
  openMailbox,
  organisationExport,
  phoneFor,
  privacyOfficer,
  signInStatus,
  suspendQuietly,
  type ApiError,
  type ExportLine,
  type RecordView,
} from '../../../src/journeys/data.js';

const ui = {
  search: label('ui.records.searchList'),
  suspend: label('ui.people.suspend'),
};

const suspendFirst = 'Suspend the person before erasing them.';
const erasedConsent = 'This person has been erased; consent cannot be recorded for them.';
const pseudonym = /^Erased person [0-9A-F]{8}$/;
const erasedEmail = /^erased-[0-9a-f]{8}@erased\.invalid$/;

/** Rows the plan accepts as remaining after erasure (FT-PRV-010): journal descriptions and provider payloads. */
const acceptedTables = new Set(['journal_entry', 'journal_line', 'payment_event', 'payment_intent']);

const tags = (priority: '@P0' | '@P1', smoke = false) => ['@e2e', '@FT-E2E-09', priority, ...(smoke ? ['@smoke'] : [])];

interface Erasure {
  id: string;
  alreadyErased: boolean;
  summary: {
    records: { id: string; type: string; fields: string[] }[];
    account: 'erased' | 'shared' | null;
    consentsWithdrawn: string[];
    sideData?: Record<string, number>;
    kept: { receipts: number; journalEntries: number; paymentIntents: number; retainedUntil: string | null; retentionYears: number };
  };
}

interface Consents {
  erased: boolean;
  current: { purpose: string; state: string; source: string }[];
}

const stamp = Date.now().toString(36);
const person = { email: `erase.${stamp}@riverbank.example`, name: `Erase Member ${stamp}`, roles: ['finance'] };

test.describe.serial('FT-E2E-09 Erasure request', () => {
  let page: Page;
  let admin: APIRequestContext;
  let privacy: APIRequestContext;
  let blocked = '';
  let userId: string | undefined;
  let donor: RecordView;
  let gifts: RecordView[] = [];
  let walkIn: RecordView;
  let receiptsBefore = 0;
  let firstErasure: { member?: Erasure; donor?: Erasure } = {};
  let dump: ExportLine[] = [];
  const devices: BrowserContext[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    admin = await memberApi(accounts.admin.email);
    privacy = await memberApi(privacyOfficer.email);
    const mail = await openMailbox();
    if (!mail) {
      blocked = noMailbox;
      return;
    }
    userId = await addMemberWithPassword(admin, mail, person);
    await mail.dispose();

    // The member is also a donor: their own donor record, two donations, one paid with a receipt, one reminded.
    const own = await memberApi(person.email);
    donor = await createRecord(own, 'donor', { name: person.name, email: person.email, phone: phoneFor(9, Date.now()), city: 'Pune' });
    const paid = await createRecord(own, 'donation', { donor: donor.id, amount: 1500, notes: 'Erasure journey' }, `erase-${stamp}-1`);
    const raised = await createRecord(own, 'donation', { donor: donor.id, amount: 700 });
    gifts = [await markPaid(own, paid), raised];
    await body(await own.post(`/api/records/donation/${raised.id}/actions/sendReminder`, { data: { input: {} } }), 200, 'send reminder');
    receiptsBefore = (await body<unknown[]>(await own.get(`/api/records/donation/${gifts[0]!.id}/receipts`), 200, 'receipts')).length;
    await own.dispose();

    // Text typed by hand that names the person but links nothing: an accepted residual.
    walkIn = await createRecord(admin, 'donation', { donorName: `Walk-in ${stamp}`, amount: 100, notes: `Introduced by ${person.name}` });

    for (const [subjectKind, subjectId] of [['member', userId], ['record', donor.id]] as const) {
      await body(
        await privacy.post('/api/privacy/consents', { data: { subjectKind, subjectId, purpose: 'newsletter', state: 'granted', source: 'form' } }),
        201,
        `consent for ${subjectKind}`,
      );
    }

    page = await browser.newPage();
    await signIn(page, accounts.admin.email, accounts.admin.name);
  });

  test.beforeEach(() => {
    test.skip(!!blocked, blocked);
  });

  test.afterAll(async () => {
    for (const d of devices) await d.close();
    if (admin && !firstErasure.member) await suspendQuietly(admin, userId);
    await admin?.dispose();
    await privacy?.dispose();
    await page?.close();
  });

  // -------------------------------------------------------- suspend, then erase

  test('FT-ADM-028 suspending a member signed in on two devices signs both out and keeps their name', { tag: tags('@P0', true) }, async ({ browser }) => {
    test.setTimeout(120_000);
    const signedIn: Page[] = [];
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext();
      devices.push(context);
      const device = await context.newPage();
      await signIn(device, person.email, person.name);
      signedIn.push(device);
    }

    await page.goto('/admin/people');
    await page.getByRole('searchbox', { name: ui.search }).fill(person.name);
    await page.getByText(person.name).first().click();
    const panel = page.getByRole('dialog').filter({ hasText: person.email });
    await panel.getByRole('button', { name: ui.suspend, exact: true }).click();
    const confirm = page.getByRole('dialog', { name: label('ui.people.suspendTitle', { name: person.name }) });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(label('ui.people.suspendNote', { name: person.name }))).toBeVisible();
    let confirmed = true;
    try {
      await confirm.getByRole('button', { name: ui.suspend, exact: true }).click({ timeout: 5000 });
      await expect.poll(async () => (await member(admin, userId!)).status, { timeout: 10_000 }).toBe('suspended');
    } catch {
      confirmed = false;
    }
    if (confirmed) {
      await expect(page.getByText(label('ui.people.suspended', { name: person.name }))).toBeVisible();
    } else {
      knownDefect('DEF-09', 'The Suspend confirmation opened from the person panel cannot be clicked.');
      await body(await admin.post(`/api/admin/people/${userId}/suspend`), 200, 'suspend by API so the journey can go on');
    }

    for (const device of signedIn) {
      await device.reload();
      await expect(device).toHaveURL(/sign-in/, { timeout: 20_000 });
    }
    expect(await signInStatus(person.email, org)).not.toBe(200);

    const audit = await body<{ items: { actorName: string | null; entity: string }[] }>(await admin.get(`/api/admin/audit?person=${userId}&limit=50`), 200, 'audit');
    expect(audit.items.some((e) => e.actorName === person.name && e.entity === 'record:donation')).toBe(true);
    expect((await getRecord(admin, 'donation', gifts[0]!.id)).number).toBe(gifts[0]!.number);

    const active = await body<{ total: number }>(await admin.get(`/api/admin/people?status=active&q=${encodeURIComponent(person.email)}`), 200, 'active people');
    expect(active.total).toBe(0);
    expect(confirmed, 'suspended from the confirmation').toBe(true);
  });

  test('FT-PRV-004 erasing an active member is refused', { tag: tags('@P0') }, async () => {
    await body(await admin.post(`/api/admin/people/${userId}/reactivate`), 200, 'reactivate');
    expect((await member(admin, userId!)).status).not.toBe('suspended');
    try {
      const refused = await body<ApiError>(await privacy.post('/api/privacy/erasures', { data: { subjectKind: 'member', subjectId: userId } }), 422, 'erase active');
      expect(refused.message).toBe(suspendFirst);
    } finally {
      await admin.post(`/api/admin/people/${userId}/suspend`);
    }
    expect((await member(admin, userId!)).status).toBe('suspended');
  });

  test('FT-PRV-005 erasing the suspended member and their donor record pseudonymises them and keeps the money', { tag: tags('@P0') }, async () => {
    test.setTimeout(180_000);
    const erasedMember = await body<Erasure>(
      await privacy.post('/api/privacy/erasures', { data: { subjectKind: 'member', subjectId: userId, reason: 'subject_request' } }),
      201,
      'erase member',
    );
    expect(erasedMember.alreadyErased).toBe(false);
    expect(erasedMember.summary.account).toBe('erased');
    expect(erasedMember.summary.consentsWithdrawn).toContain('newsletter');
    const account = await member(admin, userId!);
    expect(account.displayName).toMatch(pseudonym);
    expect(account.email).toMatch(erasedEmail);

    const erasedDonor = await body<Erasure>(
      await privacy.post('/api/privacy/erasures', { data: { subjectKind: 'record', subjectId: donor.id, reason: 'subject_request' } }),
      201,
      'erase donor record',
    );
    firstErasure = { member: erasedMember, donor: erasedDonor };
    const touched = new Map(erasedDonor.summary.records.map((r) => [r.id, r.fields]));
    expect(touched.get(donor.id)).toEqual(expect.arrayContaining(['name', 'email', 'phone']));
    for (const gift of gifts) expect(touched.get(gift.id)).toEqual(expect.arrayContaining(['donorName', 'donorEmail', 'donorPhone']));
    expect(erasedDonor.summary.kept.receipts).toBeGreaterThanOrEqual(1);
    expect(erasedDonor.summary.kept.journalEntries).toBeGreaterThanOrEqual(1);
    expect(erasedDonor.summary.kept.retainedUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(erasedDonor.summary.consentsWithdrawn).toContain('newsletter');

    const after = await getRecord(admin, 'donor', donor.id);
    expect(after.data['name']).toMatch(pseudonym);
    expect(after.data['email']).toBeUndefined();
    expect(after.data['phone']).toBeUndefined();
    for (const gift of gifts) {
      const now = await getRecord(admin, 'donation', gift.id);
      expect(now.data['donorName']).toMatch(pseudonym);
      expect(now.data['donorEmail']).toBeUndefined();
      expect(now.data['donorPhone']).toBeUndefined();
      expect({ number: now.number, status: now.status, amount: Number(now.data['amount']) }).toEqual({
        number: gift.number,
        status: gift.status,
        amount: Number(gift.data['amount']),
      });
    }
    expect((await body<unknown[]>(await admin.get(`/api/records/donation/${gifts[0]!.id}/receipts`), 200, 'receipts')).length).toBe(receiptsBefore);

    for (const [subjectKind, subjectId] of [['member', userId!], ['record', donor.id]] as const) {
      const consents = await body<Consents>(await privacy.get(`/api/privacy/consents?subjectKind=${subjectKind}&subjectId=${subjectId}`), 200, 'consents');
      expect(consents.erased).toBe(true);
      expect(consents.current.find((c) => c.purpose === 'newsletter')).toMatchObject({ state: 'withdrawn', source: 'erasure' });
    }

    dump = await organisationExport(admin);
    const reminders = dump.filter((l) => l.table === 'notification' && l.row['record_id'] === gifts[1]!.id);
    if (!reminders.length) test.info().annotations.push({ type: 'note', description: 'No notification row for the reminded donation; message erasure not checked.' });
    for (const n of reminders) expect({ to: n.row['to_address'], subject: n.row['subject'], body: n.row['body'] }).toEqual({ to: null, subject: '[erased]', body: '[erased]' });
    test.info().annotations.push({ type: 'side data cleared', description: JSON.stringify(erasedDonor.summary.sideData ?? {}) });
  });

  test('FT-PRV-006 erasing again answers 200 with the same result and changes nothing', { tag: tags('@P0') }, async () => {
    const versions = await Promise.all([donor, ...gifts].map(async (r) => (await getRecord(admin, r.type, r.id)).version));
    for (const [subjectKind, subjectId, first] of [
      ['member', userId!, firstErasure.member!],
      ['record', donor.id, firstErasure.donor!],
    ] as const) {
      const again = await body<Erasure>(await privacy.post('/api/privacy/erasures', { data: { subjectKind, subjectId } }), 200, `erase ${subjectKind} again`);
      expect(again.alreadyErased).toBe(true);
      expect(again.id).toBe(first.id);
      expect(again.summary).toEqual(first.summary);
    }
    expect(await Promise.all([donor, ...gifts].map(async (r) => (await getRecord(admin, r.type, r.id)).version))).toEqual(versions);
  });

  // ------------------------------------------------------------- what remains

  test('FT-PRV-008 consent cannot be recorded for an erased person', { tag: tags('@P1') }, async () => {
    for (const [subjectKind, subjectId] of [['member', userId!], ['record', donor.id]] as const) {
      const refused = await body<ApiError>(
        await privacy.post('/api/privacy/consents', { data: { subjectKind, subjectId, purpose: 'newsletter', state: 'granted', source: 'form' } }),
        422,
        `consent for erased ${subjectKind}`,
      );
      expect(refused.message).toBe(erasedConsent);
    }
  });

  test('FT-PRV-009 after erasure no other table still holds the person\'s name or email', { tag: tags('@P1') }, async () => {
    expect(dump.length).toBeGreaterThan(0);
    const terms = [person.name.toLowerCase(), person.email.toLowerCase()];
    const hits = dump.filter((l) => terms.some((t) => l.text.includes(t)));
    const accepted = (l: ExportLine) => acceptedTables.has(l.table) || (l.table === 'record' && l.row['id'] === walkIn.id);
    const remaining = hits.filter((l) => !accepted(l)).map((l) => `${l.table}${l.row['id'] ? ` ${String(l.row['id'])}` : ''}`);
    for (const place of remaining) test.info().annotations.push({ type: 'S4-9 residual', description: place });
    if (remaining.length) knownDefect('S4-9', 'Erasure leaves personal data in side tables (K-03).');
    expect(remaining).toEqual([]);
  });

  test('FT-PRV-010 the known remaining data is recorded as accepted residuals', { tag: tags('@P1') }, async () => {
    const note = await getRecord(admin, 'donation', walkIn.id);
    expect(note.data['notes']).toBe(`Introduced by ${person.name}`);
    test.info().annotations.push({ type: 'accepted residual', description: `Hand-typed text on ${walkIn.number}: "${String(note.data['notes'])}"` });

    const name = person.name.toLowerCase();
    const journals = dump.filter((l) => (l.table === 'journal_entry' || l.table === 'journal_line') && l.text.includes(name));
    test.info().annotations.push({ type: 'accepted residual', description: `Journal rows naming the donor: ${journals.length}` });
    const provider = dump.filter((l) => (l.table === 'payment_event' || l.table === 'payment_intent') && l.text.includes(name));
    test.info().annotations.push({ type: 'accepted residual', description: `Provider payload rows naming the donor: ${provider.length}` });
  });

  test('FT-E2E-09 erasure ends with personal data gone and the money records kept', { tag: tags('@P0') }, async () => {
    expect(await signInStatus(person.email, org)).not.toBe(200);
    const account = await member(admin, userId!);
    expect(account).toMatchObject({ status: 'suspended' });
    expect(account.displayName).toMatch(pseudonym);
    expect(account.email).toMatch(erasedEmail);
    expect((await getRecord(admin, 'donor', donor.id)).data['name']).toMatch(pseudonym);

    for (const gift of gifts) {
      const now = await getRecord(admin, 'donation', gift.id);
      expect(now.data['donorName']).toMatch(pseudonym);
      expect(now.number).toBe(gift.number);
      expect(Number(now.data['amount'])).toBe(Number(gift.data['amount']));
    }
    expect((await body<unknown[]>(await admin.get(`/api/records/donation/${gifts[0]!.id}/receipts`), 200, 'receipts')).length).toBe(receiptsBefore);
    expect(firstErasure.donor?.summary.kept.receipts).toBeGreaterThanOrEqual(1);
  });
});
