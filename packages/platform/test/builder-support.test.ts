import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { describeChanges, diffDefinitions, type DescribeLabels } from '../src/runtime/definitions/describe.js';
import type { DefinitionBodies, DefinitionKind } from '../src/runtime/definitions/types.js';
import { MODULES_DIR } from '../src/platform.js';
import { admin, clerk, completeIdentity, createWorld, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await completeIdentity(w, w.ngoA);
  app = buildServer(w.platform, { devAuth: true });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

const headers = (actor: Actor = admin, tenant = w.ngoA) => ({ 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) });
const post = (url: string, payload: unknown = {}, actor: Actor = admin, tenant = w.ngoA) =>
  app.inject({ method: 'POST', url, headers: headers(actor, tenant), payload: payload as Record<string, unknown> });
const get = (url: string, actor: Actor = admin, tenant = w.ngoA) => app.inject({ method: 'GET', url, headers: headers(actor, tenant) });

const reader: Actor = { id: 'reader-1', roles: [], permissions: ['config:read', 'record:donation:read'] };
const publisher: Actor = { id: 'pub-1', roles: [], permissions: ['config:read', 'config:publish', 'record:donation:read'] };

async function paidDonation(tenant = w.ngoA, data: Record<string, unknown> = {}) {
  const ctx = w.as(tenant);
  const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Asha Rao', amount: 500, donorPan: 'ABCDE1234F', ...data });
  await w.platform.records.transition(ctx, record.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn: today() } });
  return record;
}

describe('check', () => {
  it('returns cross-reference errors on the draft with paths, and needs config:read', async () => {
    await w.platform.definitions.saveDraft(w.as(w.ngoA), 'listView', {
      key: 'my-donations',
      recordType: 'donation',
      filters: ['nope', 'amount'],
    });
    const res = await post('/api/builder/definitions/listView/my-donations/check');
    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toEqual([{ path: '/filters/0', message: "unknown field 'nope'" }]);
    expect((await post('/api/builder/definitions/listView/my-donations/check', {}, clerk)).statusCode).toBe(403);
    expect((await post('/api/builder/definitions/listView/nothing/check')).statusCode).toBe(404);
  });

  it('checks a body sent in the request, including schema errors', async () => {
    const res = await post('/api/builder/definitions/recordType/volunteer/check', { key: 'volunteer', label: 'Volunteer', fields: [{ key: 'x' }] });
    expect(res.json().errors.length).toBeGreaterThan(0);
    expect(res.json().errors[0].path).toMatch(/^\/fields\/0/);
    const mismatch = await post('/api/builder/definitions/recordType/volunteer/check', { key: 'other', label: 'Other', fields: [] });
    expect(mismatch.statusCode).toBe(422);
  });

  it('returns warnings from the warning checks', async () => {
    await w.platform.definitions.saveDraft(w.as(w.ngoA), 'translation', {
      key: 'hindi',
      locale: 'hi',
      entries: { 'recordType.donation.label': 'दान', 'recordType.gone.label': 'x' },
    });
    const res = await post('/api/builder/definitions/translation/hindi/check');
    expect(res.json().errors).toEqual([]);
    expect(res.json().warnings).toEqual([{ path: '/entries/recordType.gone.label', message: "nothing at 'recordType.gone.label' to translate any more" }]);
  });

  it('warns about the impact of removing a field through a patch', async () => {
    await paidDonation();
    const res = await post('/api/builder/definitions/recordType/donation/check', { patch: { fields: [{ key: 'method', $delete: true }] } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { errors: unknown[]; warnings: { path: string; message: string }[] };
    expect(body.errors).toEqual([]);
    const messages = body.warnings.map((x) => x.message);
    expect(messages.find((m) => m.startsWith("'Payment method' is removed but is still used by"))).toContain("the list 'Donations' (column)");
    expect(messages).toContain("'Payment method' is a filter in the list 'Donations'; shared links that filter on it will stop filtering.");
    expect(messages.some((m) => /^\d+ records? (has|have) a value for 'Payment method'/.test(m))).toBe(true);
  });

  it('counts records in a state a workflow patch removes', async () => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Ravi', amount: 20 });
    await w.platform.records.transition(ctx, record.id, 'cancel', { expectedVersion: 1 });
    const res = await post('/api/builder/definitions/workflow/donation/check', {
      patch: { states: [{ key: 'cancelled', $delete: true }], transitions: [{ key: 'cancel', $delete: true }] },
    });
    const messages = (res.json().warnings as { message: string }[]).map((x) => x.message);
    expect(messages).toContain("1 record is in 'Cancelled'; the workflow will no longer have that state.");
    expect(messages.find((m) => m.startsWith("The state 'Cancelled' is removed"))).toContain("chip 'Closed'");
  });
});

describe('changes', () => {
  it('describes a draft against the published version, with a structured diff', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'recordType', {
      key: 'volunteer',
      label: 'Volunteer',
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'hours', label: 'Hours', type: 'number' },
      ],
    });
    await w.platform.definitions.publish(ctx, 'recordType', 'volunteer');
    await w.platform.definitions.saveDraft(ctx, 'recordType', {
      key: 'volunteer',
      label: 'Volunteer',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'donor', label: 'Donor', type: 'reference', referenceType: 'donor' },
      ],
    });
    const res = await get('/api/builder/definitions/recordType/volunteer/changes?against=published');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lines).toEqual(["Adds the field 'Donor' (reference to Donor)", "Removes the field 'Hours'", "Makes 'Name' required"]);
    expect(body.from).toEqual({ version: 1, module: false });
    expect(body.to).toEqual({ version: 2, draft: true });
    expect(body.diff).toContainEqual({ op: 'remove', path: '/fields/1', before: { key: 'hours', label: 'Hours', type: 'number' } });
    expect(body.diff).toContainEqual({ op: 'add', path: '/fields/0/required', after: true });
    expect((await get('/api/builder/definitions/recordType/volunteer/changes', clerk)).statusCode).toBe(403);
    expect((await get('/api/builder/definitions/recordType/volunteer/changes?against=other')).statusCode).toBe(422);
  });

  it('describes the organisation version against the module version', async () => {
    await w.platform.definitions.setExtensionPatch(w.as(w.ngoB), 'workflow', 'donation', { transitions: [{ key: 'markPaid', label: 'Record payment' }] });
    const res = await get('/api/builder/definitions/workflow/donation/changes?against=module', admin, w.ngoB);
    expect(res.json().lines).toEqual(["Renames the step 'Mark as paid' to 'Record payment'"]);
    expect(res.json().from.module).toBe(true);
    const own = await get('/api/builder/definitions/recordType/volunteer/changes?against=module');
    expect(own.statusCode).toBe(404);
  });
});

describe('usages', () => {
  it('finds what uses a field, including literal names in scripts', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'script', {
      key: 'round-amount',
      recordType: 'donation',
      hook: 'beforeSave',
      enabled: false,
      code: "ctx.record['amount'] = Math.round(ctx.record.amount);",
    });
    await w.platform.definitions.publish(ctx, 'script', 'round-amount');
    const res = await get('/api/builder/usages/recordType/donation?field=amount');
    expect(res.statusCode).toBe(200);
    const uses = (res.json().usages as { kind: string; key: string; what: string; path: string }[]).map((u) => `${u.kind}:${u.key}:${u.what}`);
    expect(uses).toEqual(
      expect.arrayContaining([
        'listView:donations:column',
        'listView:donations:filter',
        'recordType:donation:calculation of \'Net amount\'',
        "recordType:donation:rule 'The processing fee cannot be more than the donation.'",
        'postingRule:donationPaid:debit line',
        'receiptRule:donationPaidReceipt:amount',
        'template:donationThanks:placeholder',
        'action:payNow:payment amount',
        'script:round-amount:script code',
      ]),
    );
    const required = await get('/api/builder/usages/recordType/donation?field=paidOn');
    expect((required.json().usages as { what: string }[]).map((u) => u.what)).toContain("required field of the step 'Mark as paid'");
  });

  it('finds what uses a record type, a workflow state, a step and a template', async () => {
    const donor = (await get('/api/builder/usages/recordType/donor')).json().usages as { kind: string; key: string; what: string }[];
    expect(donor.map((u) => `${u.kind}:${u.key}`)).toEqual(expect.arrayContaining(['recordType:donation', 'listView:donors', 'recordGroup:fundraising']));
    const paid = (await get('/api/builder/usages/workflow/donation?field=paid')).json().usages as { kind: string; what: string }[];
    expect(paid.map((u) => u.kind)).toEqual(expect.arrayContaining(['listView', 'postingRule', 'receiptRule', 'automation']));
    const step = (await get('/api/builder/usages/workflow/donation?field=markPaid')).json().usages as { kind: string; key: string }[];
    expect(step).toContainEqual(expect.objectContaining({ kind: 'action', key: 'payNow' }));
    const template = (await get('/api/builder/usages/template/donationThanks')).json().usages as { kind: string; key: string }[];
    expect(template).toEqual([expect.objectContaining({ kind: 'automation', key: 'donationThanks' })]);
    expect((await get('/api/builder/usages/recordType/donor', clerk)).statusCode).toBe(403);
  });
});

describe('next number', () => {
  it('reads the next value of a sequence without using it up', async () => {
    const ghost = await get('/api/builder/sequences/ghost/next?reset=never');
    expect(ghost.json()).toMatchObject({ next: 1, period: 'all' });
    await paidDonation();
    const first = (await get('/api/builder/sequences/donation/next')).json() as { next: number; fy: string; period: string };
    expect(first.period).toBe(first.fy);
    expect((await get('/api/builder/sequences/donation/next')).json().next).toBe(first.next);
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Ravi', amount: 100 });
    expect(record.number).toBe(`DON/${first.fy}/${String(first.next).padStart(5, '0')}`);
    expect((await get('/api/builder/sequences/donation/next')).json().next).toBe(first.next + 1);
    expect((await get('/api/builder/sequences/donation/next', clerk)).statusCode).toBe(403);
  });
});

describe('expressions', () => {
  const check = (payload: unknown, actor: Actor = admin) => post('/api/builder/expressions/check', payload, actor);

  it('checks with the server evaluator and reports the result type', async () => {
    const ok = await check({ source: 'record.amount - coalesce(record.fee, 0)', recordType: 'donation' });
    expect(ok.json()).toEqual({ ok: true, resultType: 'number' });
    expect((await check({ source: "status == 'paid' and not isEmpty(record.donor)", recordType: 'donation' })).json()).toEqual({ ok: true, resultType: 'boolean' });
    expect((await check({ source: "'Hi ' + record.donorName", recordType: 'donation', context: 'template' })).json().resultType).toBe('text');
  });

  it('reports parse errors with the position', async () => {
    expect((await check({ source: 'record.amount +', recordType: 'donation' })).json()).toEqual({ ok: false, error: "Unexpected '' at 15", position: 15 });
    expect((await check({ source: 'lenn(record.donorName)' })).json()).toMatchObject({ ok: false, error: "Unknown function 'lenn'", position: 0 });
  });

  it('suggests the field or name that was probably meant', async () => {
    const res = (await check({ source: 'record.amout > 10', recordType: 'donation' })).json();
    expect(res).toEqual({ ok: false, error: "Donation has no field 'amout'. Did you mean 'amount'?", position: 7, suggestion: 'amount' });
    const root = (await check({ source: 'recrd.amount', recordType: 'donation' })).json();
    expect(root).toMatchObject({ ok: false, suggestion: 'record', position: 0 });
    expect((await check({ source: 'input.reason', recordType: 'donation' })).json().ok).toBe(false);
    expect((await check({ source: 'input.reason', recordType: 'donation', context: 'action', input: ['reason'] })).json().ok).toBe(true);
  });

  it('needs config:read', async () => {
    expect((await check({ source: '1' }, clerk)).statusCode).toBe(403);
    expect((await check({ source: '1', context: 'nonsense' })).statusCode).toBe(422);
  });

  it('tries on a real record with masked sensitive fields, and needs read access to it', async () => {
    const record = await paidDonation();
    const res = await post('/api/builder/expressions/try', { source: 'record.amount * 2', recordId: record.id }, reader);
    expect(res.json()).toEqual({ ok: true, value: 1000, resultType: 'number' });
    const pan = await post('/api/builder/expressions/try', { source: 'record.donorPan', recordId: record.id }, reader);
    expect(pan.json().value).toBe('***');
    const unmasked = await post('/api/builder/expressions/try', { source: 'record.donorPan', recordId: record.id });
    expect(unmasked.json().value).toBe('ABCDE1234F');
    const noRead: Actor = { id: 'cfg', roles: [], permissions: ['config:read'] };
    expect((await post('/api/builder/expressions/try', { source: 'record.amount', recordId: record.id }, noRead)).statusCode).toBe(403);
  });

  it('tries on sample values and reports evaluation errors', async () => {
    const res = await post('/api/builder/expressions/try', { source: 'record.amount + 1', sample: { record: { amount: 41 } } });
    expect(res.json()).toEqual({ ok: true, value: 42, resultType: 'number' });
    const err = await post('/api/builder/expressions/try', { source: 'record.amount / 0', sample: { record: { amount: 1 } } });
    expect(err.json()).toMatchObject({ ok: false, error: 'Division by zero' });
  });
});

describe('templates', () => {
  it('previews the published template or a body with a record', async () => {
    const record = await paidDonation(w.ngoA, { donorName: 'Meera' });
    const res = await post('/api/builder/templates/preview', { key: 'donationThanks', recordId: record.id }, reader);
    expect(res.statusCode).toBe(200);
    expect(res.json().subject).toBe('Thank you for your donation, Meera');
    expect(res.json().body).toContain('Rs. 500');
    const direct = await post('/api/builder/templates/preview', { subject: 'Hi {{ record.donorName }}', body: '{{ record.amount }}', sample: { record: { donorName: 'Sam', amount: 3 } } });
    expect(direct.json()).toEqual({ subject: 'Hi Sam', body: '3' });
    const broken = await post('/api/builder/templates/preview', { subject: 'ok', body: '{{ record.amount / 0 }}', sample: { record: { amount: 3 } } });
    expect(broken.statusCode).toBe(422);
    expect(broken.json().issues).toEqual([{ path: '/body', message: 'Division by zero' }]);
    expect((await post('/api/builder/templates/preview', { key: 'donationThanks' }, clerk)).statusCode).toBe(403);
  });

  it('previews the draft when there is one', async () => {
    await w.platform.definitions.saveDraft(w.as(w.ngoA), 'template', { key: 'welcome', subject: 'Welcome {{ record.donorName }}', body: 'Hello' });
    const res = await post('/api/builder/templates/preview', { key: 'welcome', sample: { record: { donorName: 'Ana' } } });
    expect(res.json().subject).toBe('Welcome Ana');
  });

  it('sends a test to the signed-in person through the configured email', async () => {
    const userId = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'builder@asha.test', displayName: 'Builder', roles: [] });
    const me: Actor = { id: userId, roles: [], permissions: ['config:read'] };
    const before = w.mail.sent.length;
    const res = await post('/api/builder/templates/test', { subject: 'Hello {{ record.donorName }}', body: 'Body', sample: { record: { donorName: 'Ana' } } }, me);
    expect(res.statusCode).toBe(200);
    expect(res.json().sentTo).toBe('builder@asha.test');
    expect(w.mail.sent.slice(before)).toEqual([{ to: 'builder@asha.test', subject: 'Test: Hello Ana', text: 'Body' }]);
    const noEmail = await post('/api/builder/templates/test', { subject: 'x', body: 'y' });
    expect(noEmail.statusCode).toBe(422);
  });
});

describe('scripts try', () => {
  it('runs in the sandbox and returns changed fields and logs', async () => {
    const res = await post('/api/builder/scripts/try', {
      recordType: 'donation',
      code: "ctx.record.notes = 'Checked ' + ctx.record.donorName; ctx.log('ran', ctx.status);",
      sample: { record: { donorName: 'Ana', amount: 5 }, status: 'raised' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      changed: [{ field: 'notes', before: null, after: 'Checked Ana' }],
      logs: ['ran raised'],
    });
  });

  it('applies the limits and reports failures', async () => {
    const slow = await post('/api/builder/scripts/try', { recordType: 'donation', code: 'while (true) {}', timeoutMs: 20 });
    expect(slow.json()).toMatchObject({ ok: false, code: 'script_limit' });
    const fail = await post('/api/builder/scripts/try', { recordType: 'donation', code: "ctx.log('a'); ctx.fail('No way');" });
    expect(fail.json()).toMatchObject({ ok: false, code: 'script_failed', error: 'No way', logs: ['a'] });
  });

  it('runs a saved script on a real record', async () => {
    const record = await paidDonation();
    const res = await post('/api/builder/scripts/try', { key: 'round-amount', recordId: record.id });
    expect(res.json()).toMatchObject({ ok: true, changed: [] });
  });

  it('needs config:script:publish', async () => {
    expect((await post('/api/builder/scripts/try', { recordType: 'donation', code: '1' }, publisher)).statusCode).toBe(403);
  });
});

describe('posting rules try', () => {
  const sample = { record: { amount: 1200.5, method: 'cash', paidOn: '2026-04-02', number: 'DON/1', donorName: 'Ana' }, status: 'paid' };

  it('evaluates the lines on a sample record and checks the balance', async () => {
    const res = await post('/api/builder/posting-rules/try', { key: 'donationPaid', sample });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      applies: true,
      whenStatus: 'paid',
      date: '2026-04-02',
      memo: 'Donation DON/1 from Ana',
      lines: [
        { side: 'debit', account: 'CASH', amount: 1200.5, fund: null },
        { side: 'credit', account: 'DONATION_INCOME', amount: 1200.5, fund: null },
      ],
      debit: 1200.5,
      credit: 1200.5,
      balanced: true,
      errors: [],
    });
  });

  it('reports an unbalanced rule and unknown accounts', async () => {
    const rule = {
      key: 'draftRule',
      recordType: 'donation',
      whenStatus: 'paid',
      date: 'record.paidOn',
      lines: [
        { side: 'debit', account: 'NOPE', amount: 'record.amount' },
        { side: 'credit', account: 'DONATION_INCOME', amount: 'record.amount - 1' },
      ],
    };
    const res = (await post('/api/builder/posting-rules/try', { rule, sample })).json();
    expect(res.balanced).toBe(false);
    expect(res.debit).toBe(1200.5);
    expect(res.credit).toBe(1199.5);
    expect(res.errors).toEqual([{ path: '/lines/0/account', message: "Ledger account 'NOPE' does not exist." }]);
    expect((await post('/api/builder/posting-rules/try', { key: 'donationPaid', sample }, clerk)).statusCode).toBe(403);
  });
});

describe('modules', () => {
  it('lists shipped modules with their state', async () => {
    const res = await get('/api/builder/modules');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toContainEqual(expect.objectContaining({ key: 'donations', version: '0.2.3', installedVersion: '0.2.3', enabled: true, updateAvailable: false }));
    expect((await get('/api/builder/modules', clerk)).statusCode).toBe(403);
  });

  it('lists the definitions a module brings, whether it is on or off', async () => {
    const donations = (list: unknown) =>
      (list as { key: string; enabled: boolean; definitions: { kind: string; key: string }[] }[]).find((m) => m.key === 'donations')!;

    const on = donations((await get('/api/builder/modules', admin, w.ngoB)).json());
    expect(on.definitions).toContainEqual({ kind: 'recordType', key: 'donation' });
    expect(on.definitions).toContainEqual({ kind: 'receiptRule', key: 'donationPaidReceipt' });
    expect(on.definitions[0]).toEqual({ kind: 'recordType', key: 'donation' });

    expect((await post('/api/builder/modules/donations/disable', {}, admin, w.ngoB)).statusCode).toBe(200);
    try {
      const off = donations((await get('/api/builder/modules', admin, w.ngoB)).json());
      expect(off.enabled).toBe(false);
      expect(off.definitions).toEqual(on.definitions);
    } finally {
      await post('/api/builder/modules/donations/enable', {}, admin, w.ngoB);
    }
  });

  it('reviews an update with nothing to change', async () => {
    const res = await get('/api/builder/modules/donations/update');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'donations', version: '0.2.3', canUpdate: true, conflicts: [] });
    expect((res.json().definitions as { status: string }[]).every((d) => d.status === 'unchanged')).toBe(true);
    expect((await get('/api/builder/modules/nothing/update')).statusCode).toBe(404);
  });

  it('lists organisation patches that no longer apply to a newer module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ngo-modules-'));
    try {
      cpSync(join(MODULES_DIR, 'donations'), join(dir, 'donations'), { recursive: true });
      const typeFile = join(dir, 'donations', 'donation.recordType.json');
      const type = JSON.parse(readFileSync(typeFile, 'utf8')) as { fields: { key: string }[] };
      type.fields = type.fields.filter((f) => f.key !== 'notes');
      writeFileSync(typeFile, JSON.stringify(type));
      const manifestFile = join(dir, 'donations', 'module.json');
      writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace('"0.2.3"', '"0.3.0"'));

      await w.platform.definitions.setExtensionPatch(w.as(w.ngoB), 'recordType', 'donation', { fields: [{ key: 'notes', required: true }] });
      const review = await w.platform.builderSupport(dir).updateReview(w.as(w.ngoB), 'donations');
      expect(review.version).toBe('0.3.0');
      expect(review.installedVersion).toBe('0.2.3');
      expect(review.canUpdate).toBe(false);
      expect(review.conflicts).toContainEqual({
        kind: 'recordType',
        key: 'donation',
        path: '/fields/notes',
        message: "The organisation's change changes 'notes', which the module no longer has.",
      });
      const changed = review.definitions.find((d) => d.kind === 'recordType' && d.key === 'donation');
      expect(changed).toMatchObject({ status: 'changed', patched: true, lines: ["Removes the field 'Notes'"] });

      const modulePatch = await get('/api/builder/definitions/recordType/donation/changes?against=module', admin, w.ngoB);
      expect(modulePatch.json().lines).toEqual(["Makes 'Notes' required"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to turn a module off while the organisation still uses it', async () => {
    const res = await post('/api/builder/modules/donations/disable');
    expect(res.statusCode).toBe(422);
    const paths = (res.json().issues as { path: string }[]).map((i) => i.path);
    expect(paths).toEqual(['script:round-amount/recordType']);
    expect(await w.platform.definitions.get(w.ngoA, 'recordType', 'donation')).toBeDefined();
  });

  it('turns a module off and on again, and needs config:modules', async () => {
    const configurer: Actor = { id: 'c', roles: [], permissions: ['config:read', 'config:publish'] };
    expect((await post('/api/builder/modules/donations/disable', {}, configurer, w.ngoB)).statusCode).toBe(403);
    expect((await post('/api/builder/modules/donations/enable', {}, configurer, w.ngoB)).statusCode).toBe(403);

    const off = await post('/api/builder/modules/donations/disable', {}, admin, w.ngoB);
    expect(off.statusCode).toBe(200);
    expect(off.json().removed).toContain('recordType|donation');
    expect(await w.platform.definitions.get(w.ngoB, 'recordType', 'donation')).toBeUndefined();
    expect(await w.platform.definitions.get(w.ngoA, 'recordType', 'donation')).toBeDefined();
    const list = (await get('/api/builder/modules', admin, w.ngoB)).json() as { key: string; enabled: boolean }[];
    expect(list.find((m) => m.key === 'donations')?.enabled).toBe(false);
    expect((await post('/api/builder/modules/donations/disable', {}, admin, w.ngoB)).statusCode).toBe(404);

    const on = await post('/api/builder/modules/donations/enable', {}, admin, w.ngoB);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ key: 'donations', version: '0.2.3', enabled: true });
    const donation = await w.platform.definitions.get(w.ngoB, 'recordType', 'donation');
    expect(donation?.body.fields.find((f) => f.key === 'notes')?.required).toBe(true);
    expect((await post('/api/builder/modules/nothing/enable')).statusCode).toBe(404);
  });
});

describe('describe text for each kind', () => {
  const labels: DescribeLabels = {
    recordType: (k) => ({ donor: 'Donor', donation: 'Donation' })[k] ?? k,
    field: (_t, k) => ({ amount: 'Amount', method: 'Payment method', donor: 'Donor' })[k] ?? k,
    template: (k) => (k === 'thanks' ? 'Thank-you' : k),
  };
  const lines = <K extends DefinitionKind>(kind: K, before: DefinitionBodies[K] | undefined, after: DefinitionBodies[K]) =>
    describeChanges(kind, before, after, labels);

  it('recordType', () => {
    const before: DefinitionBodies['recordType'] = {
      key: 'donation',
      label: 'Donation',
      fields: [
        { key: 'amount', label: 'Amount', type: 'money' },
        { key: 'status', label: 'Closed', type: 'boolean' },
        { key: 'method', label: 'Method', type: 'choice', choices: [{ value: 'cash', label: 'Cash' }] },
      ],
    };
    const after: DefinitionBodies['recordType'] = {
      key: 'donation',
      label: 'Gift',
      fields: [
        { key: 'amount', label: 'Amount', type: 'money', required: true, sensitive: true },
        { key: 'method', label: 'Payment method', type: 'choice', choices: [{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }] },
        { key: 'donor', label: 'Donor', type: 'reference', referenceType: 'donor' },
      ],
      rules: [{ key: 'positive', expression: 'record.amount > 0', message: 'Amount must be positive' }],
    };
    expect(lines('recordType', before, after)).toEqual([
      "Renames the record type 'Donation' to 'Gift'",
      "Adds the field 'Donor' (reference to Donor)",
      "Removes the field 'Closed'",
      "Makes 'Amount' required",
      "Marks 'Amount' as sensitive",
      "Renames the field 'Method' to 'Payment method'",
      "Adds the choice 'UPI' to 'Payment method'",
      "Adds the rule 'Amount must be positive'",
    ]);
    expect(lines('recordType', undefined, after)).toEqual(["Creates the record type 'Gift' with 3 fields"]);
  });

  it('workflow', () => {
    const before: DefinitionBodies['workflow'] = {
      key: 'donation',
      recordType: 'donation',
      initial: 'raised',
      states: [
        { key: 'raised', label: 'Raised' },
        { key: 'paid', label: 'Paid' },
        { key: 'cancelled', label: 'Cancelled' },
      ],
      transitions: [
        { key: 'markPaid', label: 'Mark as paid', from: ['raised'], to: 'paid' },
        { key: 'cancel', label: 'Cancel', from: ['raised'], to: 'cancelled' },
      ],
    };
    const after: DefinitionBodies['workflow'] = {
      ...before,
      states: [
        { key: 'raised', label: 'Raised' },
        { key: 'paid', label: 'Paid', final: true },
      ],
      transitions: [{ key: 'markPaid', label: 'Record payment', from: ['raised'], to: 'paid', requiredFields: ['method'], approval: { roles: ['finance'] } }],
    };
    expect(lines('workflow', before, after)).toEqual([
      "Removes the state 'Cancelled'",
      "Makes 'Paid' a final state",
      "Removes the step 'Cancel'",
      "Renames the step 'Mark as paid' to 'Record payment'",
      "Asks for 'Payment method' in the step 'Record payment'",
      "Needs approval for the step 'Record payment'",
    ]);
  });

  it('listView', () => {
    const before: DefinitionBodies['listView'] = {
      key: 'donations',
      recordType: 'donation',
      chips: [
        { id: 'open', label: 'Open', statusIn: ['raised'] },
        { id: 'closed', label: 'Closed', statusIn: ['paid'] },
      ],
      filters: ['method'],
      columns: ['amount'],
    };
    const after: DefinitionBodies['listView'] = {
      ...before,
      chips: [{ id: 'open', label: 'Outstanding', statusIn: ['raised'] }],
      filters: ['amount'],
      columns: ['amount', 'method'],
      layout: 'table',
    };
    expect(lines('listView', before, after)).toEqual([
      'Shows records as a table by default',
      "Removes the chip 'Closed'",
      "Renames the chip 'Open' to 'Outstanding'",
      "Adds the filter 'Amount'",
      "Removes the filter 'Payment method'",
      "Adds the column 'Payment method'",
    ]);
  });

  it('postingRule and receiptRule', () => {
    const rule: DefinitionBodies['postingRule'] = {
      key: 'paid',
      recordType: 'donation',
      whenStatus: 'paid',
      date: 'record.paidOn',
      lines: [
        { side: 'debit', account: 'BANK', amount: 'record.amount' },
        { side: 'credit', account: 'INCOME', amount: 'record.amount' },
      ],
    };
    expect(lines('postingRule', rule, { ...rule, whenStatus: 'closed', lines: [rule.lines[0]!, { side: 'credit', account: 'GRANTS', amount: 'record.amount' }] })).toEqual([
      "Posts when a record becomes 'closed'",
      "Adds the credit line from 'GRANTS' for record.amount",
      "Removes the credit line from 'INCOME'",
    ]);
    expect(lines('postingRule', undefined, rule)).toEqual(["Creates the posting rule 'paid': posts when a Donation becomes 'paid'"]);
    const receipt: DefinitionBodies['receiptRule'] = { key: 'r', recordType: 'donation', whenStatus: 'paid', series: 'a', amount: 'record.amount', date: 'today()' };
    expect(lines('receiptRule', receipt, { ...receipt, series: 'b', condition: 'record.amount > 0' })).toEqual([
      'Issues receipts only when record.amount > 0',
      "Numbers receipts from the series 'b'",
    ]);
  });

  it('script', () => {
    const s: DefinitionBodies['script'] = { key: 's', recordType: 'donation', hook: 'beforeSave', code: 'a' };
    expect(lines('script', s, { ...s, code: 'b', enabled: false, timeoutMs: 500 })).toEqual(['Changes the script code', 'Turns the script off', 'Changes the script limits']);
    expect(lines('script', undefined, s)).toEqual(["Creates the script 's' that runs before a Donation is saved"]);
  });

  it('automation', () => {
    const a: DefinitionBodies['automation'] = {
      key: 'thank',
      label: 'Thank',
      recordType: 'donation',
      trigger: { event: 'statusChanged', to: 'paid' },
      actions: [{ type: 'notify', template: 'thanks', to: { creator: true } }],
    };
    expect(
      lines('automation', a, {
        ...a,
        enabled: false,
        trigger: { event: 'created' },
        condition: 'record.amount > 100',
        actions: [...a.actions, { type: 'setFields', values: { method: "'cash'" } }],
      }),
    ).toEqual([
      'Turns the automation off',
      'Now runs when a record is created',
      'Runs only when record.amount > 100',
      "Adds the action: set 'Payment method'",
    ]);
    expect(lines('automation', undefined, a)).toEqual(["Creates the automation 'Thank' for Donation: runs when a record becomes 'paid'"]);
  });

  it('template', () => {
    const t: DefinitionBodies['template'] = { key: 'thanks', subject: 'Thanks', body: 'Hello' };
    expect(lines('template', t, { ...t, subject: 'Thank you', body: 'Hi' })).toEqual(['Changes the subject to "Thank you"', 'Changes the message']);
  });

  it('theme', () => {
    expect(lines('theme', { key: 't', brand: '#123456' }, { key: 't', brand: '#654321', radius: '8px' })).toEqual([
      'Changes the brand colour from #123456 to #654321',
      'Sets the corner radius to 8px',
    ]);
  });

  it('recordGroup', () => {
    const g: DefinitionBodies['recordGroup'] = { key: 'f', label: 'Fundraising', recordTypes: ['donor', 'donation'] };
    expect(lines('recordGroup', g, { ...g, label: 'Giving', recordTypes: ['donation', 'grant'] })).toEqual([
      "Renames the group 'Fundraising' to 'Giving'",
      "Adds grant to the group 'Giving'",
      "Moves Donor out of the group 'Giving'",
    ]);
  });

  it('translation', () => {
    const t: DefinitionBodies['translation'] = { key: 'hi', locale: 'hi', entries: { a: '1', b: '2' } };
    expect(lines('translation', t, { ...t, entries: { a: '1!', c: '3', d: '4' } })).toEqual([
      'Translates 2 more texts',
      'Removes 1 translated text',
      'Changes 1 translated text',
    ]);
  });

  it('action', () => {
    const a: DefinitionBodies['action'] = {
      key: 'remind',
      recordType: 'donation',
      label: 'Remind',
      placement: ['panel'],
      steps: [{ type: 'notify', template: 'thanks', to: { creator: true } }],
    };
    expect(
      lines('action', a, {
        ...a,
        label: 'Send reminder',
        placement: ['panel', 'bulk'],
        confirm: 'Send it?',
        form: { fields: [{ key: 'note', label: 'Note', type: 'text' }] },
      }),
    ).toEqual([
      "Renames the action 'Remind' to 'Send reminder'",
      'Shows the action on the record panel and the bulk bar',
      'Asks "Send it?" before running',
      "Asks for 'Note' when the action runs",
    ]);
  });

  it('page', () => {
    const p: DefinitionBodies['page'] = { key: 'home', label: 'Home', widgets: [{ type: 'groups' }] };
    expect(
      lines('page', p, { ...p, audience: ['finance'], widgets: [{ type: 'groups' }, { type: 'stat', label: 'Raised', recordType: 'donation', measure: 'count' }] }),
    ).toEqual(["Shows the page to 'finance'", "Adds the widget 'Raised'"]);
  });

  it('falls back to naming settings no describer covers', () => {
    const before = { key: 'x', label: 'X', fields: [], extra: 1 } as unknown as DefinitionBodies['recordType'];
    expect(lines('recordType', before, { key: 'x', label: 'X', fields: [] })).toEqual(["Changes 'extra'"]);
    expect(diffDefinitions({ a: [1] }, { a: [2] })).toEqual([{ op: 'change', path: '/a', before: [1], after: [2] }]);
  });
});
