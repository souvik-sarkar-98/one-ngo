import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SANDBOX_WORKER, SCHEMA_DIR } from '../src/platform.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { ScriptDef } from '../src/runtime/definitions/types.js';
import { ScriptSandbox } from '../src/runtime/scripts/sandbox.js';
import { admin, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let adminMember: string;
/** May save the test record types and publish scripts, but is not an organisation administrator. */
const author: Actor = { id: 'author-1', roles: ['finance'], permissions: ['record:*', 'config:read', 'config:script:publish'] };

const ctxOf = (actor: Actor = admin) => w.as(w.ngoA, actor);
const q = async <T>(sql: string, params: unknown[] = []) => w.platform.db.withTenant(w.ngoA, (tx) => tx.query<T>(sql, params));
const count = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0]!.n;

async function recordType(key: string, extra: { key: string; label: string; type: string; referenceType?: string }[] = []) {
  await w.platform.definitions.saveDraft(ctxOf(), 'recordType', {
    key,
    label: key,
    fields: [
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'note', label: 'Note', type: 'text' },
      ...extra,
    ],
  } as never);
  await w.platform.definitions.publish(ctxOf(), 'recordType', key);
}

async function script(body: Omit<ScriptDef, 'hook'> & { hook?: ScriptDef['hook'] }, actor: Actor = admin) {
  await w.platform.definitions.saveDraft(ctxOf(actor), 'script', { hook: 'afterSave', ...body } as ScriptDef);
  return w.platform.definitions.publish(ctxOf(actor), 'script', body.key);
}

const journalCode = (amount: string) => `
  ctx.propose.journal({ date: '${today()}', memo: 'Cash ' + ctx.record.note, lines: [
    { account: 'CASH', debit: '${amount}' },
    { account: 'DONATION_INCOME', credit: '${amount}' },
  ] });`;
const journalPolicy = { allow: ['ledger.propose', 'notify'] as const, accounts: ['CASH', 'DONATION_INCOME'], maxTotalAmount: '10000.00' };

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  const ctx = ctxOf();
  await w.platform.identity.upsertRole(ctx, { key: 'admin', label: 'Organisation administrator', permissions: ['config:read'] });
  adminMember = await w.platform.identity.addMember(ctx, { email: 'boss@example.org', displayName: 'Boss', roles: ['admin'] });
});
afterAll(() => w.close());

describe('effects applied in the save transaction', () => {
  it('posts a proposed journal and queues a proposed notification with the save', async () => {
    await recordType('cashIn');
    await script({
      key: 'cashJournal',
      recordType: 'cashIn',
      effects: { ...journalPolicy, allow: [...journalPolicy.allow] },
      code: `${journalCode('1500.00')} ctx.propose.notify('donationThanks', { roles: ['admin'] }, { channels: ['inApp'] });`,
    });
    const saved = await w.platform.records.create(ctxOf(author), 'cashIn', { amount: 1500, note: 'box 1' });
    expect(saved.journalEntryIds).toHaveLength(1);

    const [entry] = await q<{ source_record_id: string; source_rule: string; memo: string }>(
      `select source_record_id, source_rule, memo from journal_entry where id = $1`,
      [saved.journalEntryIds[0]],
    );
    expect(entry).toEqual({ source_record_id: saved.record.id, source_rule: 'script:cashJournal@1', memo: 'Cash box 1' });
    const lines = await q<{ debit: string; credit: string }>(`select debit::text, credit::text from journal_line where entry_id = $1 order by debit desc`, [saved.journalEntryIds[0]]);
    expect(lines).toEqual([
      { debit: '1500.00', credit: '0.00' },
      { debit: '0.00', credit: '1500.00' },
    ]);
    expect(await count(`select count(*)::int as n from outbox_event where type = 'script.notify' and payload->>'recordId' = $1`, [saved.record.id])).toBe(1);
    const [audit] = await q<{ actor_id: string; after: { effects: { type: string; script: string }[] } }>(
      `select actor_id, after from audit_event where action = 'script.effects' and entity_id = $1`,
      [saved.record.id],
    );
    expect(audit!.actor_id).toBe(author.id);
    expect(audit!.after.effects.map((e) => `${e.script}:${e.type}`)).toEqual(['cashJournal:ledger.propose', 'cashJournal:notify']);
    const [run] = await q<{ hook: string; outcome: string; effects: unknown }>(`select hook, outcome, effects from script_run where script_key = 'cashJournal'`);
    expect(run).toEqual({ hook: 'afterSave', outcome: 'ok', effects: { count: { 'ledger.propose': 1, notify: 1 }, journalTotal: '1500.00' } });

    await w.platform.dispatcher.runOnce();
    expect(await count(`select count(*)::int as n from notification where user_id = $1 and record_id = $2`, [adminMember, saved.record.id])).toBe(1);
  });

  it('rejects an unbalanced proposal before anything is written, and logs the run as rejected', async () => {
    await recordType('badBooks');
    await script({
      key: 'lopsided',
      recordType: 'badBooks',
      hook: 'beforeSave',
      effects: { allow: ['ledger.propose'], accounts: ['CASH', 'DONATION_INCOME'], maxTotalAmount: '10000' },
      code: `ctx.effects.push({ type: 'ledger.propose', date: '${today()}', lines: [{ account: 'CASH', debit: '1500.00' }, { account: 'DONATION_INCOME', credit: '1499.99' }] });`,
    });
    const journals = await count(`select count(*)::int as n from journal_entry`);
    const err = await expectCode(w.platform.records.create(ctxOf(author), 'badBooks', { amount: 1500 }), 'rule_violation');
    expect(err.message).toBe("Script 'lopsided' effect 1: journal does not balance: debits 1500.00, credits 1499.99");
    expect(await count(`select count(*)::int as n from record where type_key = 'badBooks'`)).toBe(0);
    expect(await count(`select count(*)::int as n from journal_entry`)).toBe(journals);
    const runs = await q<{ outcome: string; record_id: string | null }>(`select outcome, record_id from script_run where script_key = 'lopsided'`);
    expect(runs).toEqual([{ outcome: 'rejected', record_id: null }]);
  });

  it('rolls the whole save back when an engine refuses an effect at apply time', async () => {
    await recordType('closedBooks');
    await script({
      key: 'oldEntry',
      recordType: 'closedBooks',
      effects: { allow: ['ledger.propose'], accounts: ['CASH', 'DONATION_INCOME'], maxTotalAmount: '10000' },
      code: `ctx.propose.journal({ date: '1999-04-01', lines: [{ account: 'CASH', debit: 10 }, { account: 'DONATION_INCOME', credit: 10 }] });`,
    });
    const err = await expectCode(w.platform.records.create(ctxOf(author), 'closedBooks', { amount: 10 }), 'rule_violation');
    expect(err.message).toMatch(/^Script 'oldEntry' effect 1: /);
    expect(await count(`select count(*)::int as n from record where type_key = 'closedBooks'`)).toBe(0);
    expect(await count(`select count(*)::int as n from audit_event where entity = 'record:closedBooks'`)).toBe(0);
  });
});

describe('records.update', () => {
  it('updates another record at the version the script read, through the full pipeline', async () => {
    await recordType('ledgerCard');
    await recordType('topUp', [{ key: 'card', label: 'Card', type: 'reference', referenceType: 'ledgerCard' }]);
    await script({
      key: 'stampCard',
      recordType: 'topUp',
      inputs: { related: [{ name: 'card', field: 'card', fields: ['note', 'amount'] }] },
      effects: { allow: ['records.update'] },
      code: `if (ctx.inputs.card) ctx.propose.update('ledgerCard', ctx.inputs.card.id, ctx.inputs.card.version, { note: 'topped up by ' + ctx.record.amount });`,
    });
    const card = (await w.platform.records.create(ctxOf(author), 'ledgerCard', { note: 'new' })).record;
    await w.platform.records.create(ctxOf(author), 'topUp', { amount: 50, card: card.id });
    const after = await w.platform.records.get(ctxOf(author), card.id);
    expect(after).toMatchObject({ version: 2, data: { note: 'topped up by 50' } });
    const [audit] = await q<{ actor_id: string }>(`select actor_id from audit_event where action = 'record.updated' and entity_id = $1`, [card.id]);
    expect(audit!.actor_id).toBe(author.id);
  });

  it('refuses a stale version and an update of the record being saved, writing nothing', async () => {
    await recordType('selfish');
    await script({
      key: 'selfUpdate',
      recordType: 'selfish',
      effects: { allow: ['records.update'] },
      code: `if (ctx.previous) ctx.propose.update('selfish', ctx.id, 1, { note: 'again' });`,
    });
    const r = (await w.platform.records.create(ctxOf(author), 'selfish', { note: 'one' })).record;
    const err = await expectCode(w.platform.records.update(ctxOf(author), r.id, { expectedVersion: 1, data: { note: 'two' } }), 'rule_violation');
    expect(err.message).toMatch(/cannot update the record being saved/);
    expect((await w.platform.records.get(ctxOf(author), r.id)).version).toBe(1);

    await recordType('staleTarget');
    await recordType('staleSource', [{ key: 'target', label: 'Target', type: 'reference', referenceType: 'staleTarget' }]);
    await script({
      key: 'staleUpdate',
      recordType: 'staleSource',
      inputs: { related: [{ name: 'target', field: 'target', fields: ['note'] }] },
      effects: { allow: ['records.update'] },
      code: `ctx.propose.update('staleTarget', ctx.inputs.target.id, ctx.inputs.target.version - 1 || 99, { note: 'late' });`,
    });
    const target = (await w.platform.records.create(ctxOf(author), 'staleTarget', { note: 'fresh' })).record;
    await expectCode(w.platform.records.create(ctxOf(author), 'staleSource', { target: target.id }), 'conflict');
    expect(await count(`select count(*)::int as n from record where type_key = 'staleSource'`)).toBe(0);
    expect((await w.platform.records.get(ctxOf(author), target.id)).data.note).toBe('fresh');
  });
});

describe('named recipients', () => {
  it('sends to a fixed recipient the administrator keeps, and refuses unknown names at publish', async () => {
    await w.platform.administration.saveSettings(ctxOf(), { namedRecipients: { auditor: { label: 'Statutory auditor', email: 'auditor@example.org' } } });
    await recordType('audited');
    await expectCode(
      script({ key: 'tellNobody', recordType: 'audited', effects: { allow: ['notify'], recipients: ['nobody'] }, code: `ctx.propose.notify('donationThanks', { named: ['nobody'] });` }),
      'definition_invalid',
    );
    await w.platform.definitions.discardDraft(ctxOf(), 'script', 'tellNobody');
    await script({
      key: 'tellAuditor',
      recordType: 'audited',
      effects: { allow: ['notify'], recipients: ['auditor'] },
      code: `ctx.propose.notify('donationThanks', { named: ['auditor'] }, { channels: ['email'] });`,
    });
    const saved = await w.platform.records.create(ctxOf(author), 'audited', { amount: 5 });
    await w.platform.dispatcher.runOnce();
    const sent = await q<{ to_address: string }>(`select to_address from notification where record_id = $1 and channel = 'email'`, [saved.record.id]);
    expect(sent).toEqual([{ to_address: 'auditor@example.org' }]);
  });

  it('refuses a script that names a recipient it did not declare', async () => {
    await recordType('sneaky');
    await script({ key: 'sneakyNotify', recordType: 'sneaky', effects: { allow: ['notify'] }, code: `ctx.propose.notify('donationThanks', { named: ['auditor'] });` });
    const err = await expectCode(w.platform.records.create(ctxOf(author), 'sneaky', {}), 'rule_violation');
    expect(err.message).toBe("Script 'sneakyNotify' effect 1: the script does not declare recipient 'auditor'");
  });
});

describe('administrator-only scripts', () => {
  it('lets only an administrator publish or roll back to a script that runs as a role, and audits both people', async () => {
    await recordType('runAsParent');
    await recordType('runAsChild');
    await w.platform.identity.upsertRole(ctxOf(), { key: 'child-maker', label: 'Child maker', permissions: ['record:runAsChild:create'] });
    const body = {
      key: 'asFinance',
      recordType: 'runAsParent',
      runAs: 'child-maker',
      effects: { allow: ['records.create' as const] },
      code: `ctx.propose.record('runAsChild', { note: 'made by script' });`,
    };
    await expectCode(script(body, author), 'forbidden');
    await w.platform.definitions.discardDraft(ctxOf(), 'script', 'asFinance');
    await script(body);
    await script({ key: body.key, recordType: body.recordType, code: 'ctx.log(1);' });
    await expectCode(w.platform.definitions.rollback(ctxOf(author), 'script', 'asFinance', 1), 'forbidden');
    await w.platform.definitions.rollback(ctxOf(), 'script', 'asFinance', 1);

    const saver: Actor = { id: 'saver-1', roles: [], permissions: ['record:runAsParent:create'] };
    const saved = await w.platform.records.create(ctxOf(saver), 'runAsParent', {});
    expect(await count(`select count(*)::int as n from record where type_key = 'runAsChild' and created_by = 'saver-1'`)).toBe(1);
    const [audit] = await q<{ after: { savedBy: string; runAs: Record<string, string> } }>(
      `select after from audit_event where action = 'script.effects' and entity_id = $1`,
      [saved.record.id],
    );
    expect(audit!.after).toMatchObject({ savedBy: 'saver-1', runAs: { asFinance: 'child-maker' } });
  });

  it('lets only an administrator publish a script that reads balances, and loads them as of the save date', async () => {
    await recordType('balanceCheck');
    const body = { key: 'readCash', recordType: 'balanceCheck', hook: 'beforeSave' as const, inputs: { balances: { accounts: ['CASH'] } }, code: `ctx.record.note = ctx.inputs.balances.accounts.CASH;` };
    await expectCode(script(body, author), 'forbidden');
    await w.platform.definitions.discardDraft(ctxOf(), 'script', 'readCash');
    await script(body);
    const [expected] = await q<{ balance: string }>(
      `select coalesce(sum(l.debit) - sum(l.credit), 0)::numeric(14, 2)::text as balance
         from journal_line l join ledger_account a on a.id = l.account_id where a.code = 'CASH'`,
    );
    const saved = await w.platform.records.create(ctxOf(author), 'balanceCheck', {});
    expect(saved.record.data.note).toBe(expected!.balance);
  });
});

describe('Try it', () => {
  it('shows the proposals and writes nothing', async () => {
    await recordType('tryMe');
    await script({ key: 'tryJournal', recordType: 'tryMe', effects: { ...journalPolicy, allow: [...journalPolicy.allow] }, code: journalCode('20.00') });
    const tables = ['journal_entry', 'outbox_event', 'audit_event', 'script_run', 'record'];
    const before = await Promise.all(tables.map((t) => count(`select count(*)::int as n from ${t}`)));
    const out = (await w.platform.builderSupport().tryScript(ctxOf(), { key: 'tryJournal', sample: { record: { note: 'sample' } } })) as {
      ok: boolean;
      effects: { type: string }[];
      issues: unknown[];
    };
    expect(out.ok).toBe(true);
    expect(out.effects.map((e) => e.type)).toEqual(['ledger.propose']);
    expect(out.issues).toEqual([]);
    const after = await Promise.all(tables.map((t) => count(`select count(*)::int as n from ${t}`)));
    expect(after).toEqual(before);
  });
});

describe('finance-script publish audit', () => {
  it('writes script.published.finance and notifies the administrators on publish and on rollback', async () => {
    await recordType('moneyBox');
    await script({ key: 'moneyNote', recordType: 'moneyBox', hook: 'beforeSave', code: `ctx.record.note = 'v1';` });
    await script({ key: 'moneyNote', recordType: 'moneyBox', hook: 'beforeSave', code: `ctx.record.note = 'v2';` });
    await w.platform.definitions.rollback(ctxOf(), 'script', 'moneyNote', 1);
    const audits = await q<{ after: { action: string; version: number; previousVersion: number | null; changed: { code: boolean } } }>(
      `select after from audit_event where action = 'script.published.finance' and entity_id = 'moneyNote' order by id`,
    );
    expect(audits.map((a) => [a.after.action, a.after.version, a.after.previousVersion, a.after.changed.code])).toEqual([
      ['published', 1, null, true],
      ['published', 2, 1, true],
      ['rolled_back', 3, 2, true],
    ]);
    expect(await count(`select count(*)::int as n from outbox_event where type = 'script.published.finance' and payload->>'key' = 'moneyNote'`)).toBe(3);
    await w.platform.dispatcher.runOnce();
    expect(await count(`select count(*)::int as n from notification where user_id = $1 and subject like 'Finance script % moneyNote'`, [adminMember])).toBe(3);
  });

  it('writes nothing more for a script that cannot touch money', async () => {
    await w.platform.definitions.saveDraft(ctxOf(), 'recordType', { key: 'visitLog', label: 'Visit', fields: [{ key: 'note', label: 'Note', type: 'text' }] } as never);
    await w.platform.definitions.publish(ctxOf(), 'recordType', 'visitLog');
    await script({ key: 'visitNote', recordType: 'visitLog', hook: 'beforeSave', code: `ctx.record.note = 'x';` });
    expect(await count(`select count(*)::int as n from audit_event where action = 'script.published.finance' and entity_id = 'visitNote'`)).toBe(0);
  });
});

describe('hooks', () => {
  it('validate and workflow-guard scripts refuse with ctx.fail; a custom button saves what its script returns', async () => {
    await recordType('hooked');
    await script({ key: 'noZero', recordType: 'hooked', hook: 'validate', code: `if (ctx.record.amount === 0) ctx.fail('Amount cannot be zero.');` });
    const err = await expectCode(w.platform.records.create(ctxOf(author), 'hooked', { amount: 0 }), 'script_failed');
    expect(err.message).toBe('Amount cannot be zero.');

    await w.platform.definitions.saveDraft(ctxOf(), 'workflow', {
      key: 'hooked',
      recordType: 'hooked',
      initial: 'open',
      states: [
        { key: 'open', label: 'Open' },
        { key: 'shut', label: 'Shut' },
      ],
      transitions: [{ key: 'shut', label: 'Shut', from: ['open'], to: 'shut' }],
    });
    await w.platform.definitions.publish(ctxOf(), 'workflow', 'hooked');
    await script({ key: 'needNote', recordType: 'hooked', hook: 'workflowGuard', code: `if (ctx.transition === 'shut' && !ctx.record.note) ctx.fail('Add a note first.');` });
    const r = (await w.platform.records.create(ctxOf(author), 'hooked', { amount: 5 })).record;
    expect((await expectCode(w.platform.records.transition(ctxOf(author), r.id, 'shut', { expectedVersion: 1 }), 'script_failed')).message).toBe('Add a note first.');

    await script({ key: 'stamp', recordType: 'hooked', hook: 'customButton', code: `ctx.record.note = 'stamped ' + ctx.number;` });
    await w.platform.definitions.saveDraft(ctxOf(), 'action', { key: 'stampIt', recordType: 'hooked', label: 'Stamp', placement: ['panel'], steps: [{ type: 'script', script: 'stamp' }] });
    await w.platform.definitions.publish(ctxOf(), 'action', 'stampIt');
    const done = await w.platform.actions.run(ctxOf(author), 'hooked', r.id, 'stampIt', { expectedVersion: 1 });
    expect(done.record).toMatchObject({ version: 2, data: { note: 'stamped null' } });
    expect((await w.platform.records.transition(ctxOf(author), r.id, 'shut', { expectedVersion: 2 })).record.status).toBe('shut');
  });
});

describe('connector effects', () => {
  it('queue connector.http for an http send connector and connector.webhook for a webhook, and refuse a lookup connector', async () => {
    const ctx = ctxOf();
    await w.platform.connectors.save(ctx, 'hooked-crm', { kind: 'webhook', config: { url: 'https://crm.test/hooks' } });
    await w.platform.connectors.save(ctx, 'tally', { kind: 'http', config: { mode: 'send', method: 'POST', url: 'https://tally.test/vouchers' } });
    await w.platform.connectors.save(ctx, 'pan-check', {
      kind: 'http',
      config: { mode: 'lookup', method: 'GET', url: 'https://pan.test/{{record.pan}}', inputs: ['pan'], responseMap: { name: 'name' } },
    });
    await recordType('voucher');
    await script({
      key: 'postVoucher',
      recordType: 'voucher',
      effects: { allow: ['connector.call'], connectors: ['tally', 'hooked-crm'] },
      code: `ctx.propose.connector('tally', { voucher: ctx.record.note }); ctx.propose.connector('hooked-crm', { voucher: ctx.record.note });`,
    });
    const saved = await w.platform.records.create(ctxOf(author), 'voucher', { note: 'R-7', amount: 70 });
    const events = await q<{ type: string; payload: Record<string, unknown> }>(
      `select type, payload from outbox_event where type in ('connector.http', 'connector.webhook') and (payload->>'recordId' = $1 or payload->'record'->>'id' = $1) order by type`,
      [saved.record.id],
    );
    expect(events.map((e) => e.type)).toEqual(['connector.http', 'connector.webhook']);
    expect(events[0]!.payload).toMatchObject({
      connector: 'tally',
      event: 'script.postVoucher',
      recordId: saved.record.id,
      binding: { record: { id: saved.record.id, note: 'R-7', voucher: 'R-7' } },
    });
    expect(events[1]!.payload).toMatchObject({ connector: 'hooked-crm', event: 'script.postVoucher', body: { voucher: 'R-7' } });

    await w.platform.definitions.saveDraft(ctx, 'script', {
      key: 'lookupEffect',
      recordType: 'voucher',
      hook: 'afterSave',
      effects: { allow: ['connector.call'], connectors: ['pan-check'] },
      code: `ctx.propose.connector('pan-check', {});`,
    } as ScriptDef);
    const err = await expectCode(w.platform.definitions.publish(ctx, 'script', 'lookupEffect'), 'definition_invalid');
    expect(JSON.stringify((err as unknown as { issues: unknown }).issues)).toContain(
      "connector 'pan-check' is a http connector in lookup mode; choose a webhook connector or http connector in send mode",
    );
  });
});

describe('effect helpers', () => {
  it('push the same objects as ctx.effects.push', async () => {
    const out = await new ScriptSandbox(SCHEMA_DIR, SANDBOX_WORKER).run({
      hook: 'afterSave',
      code: `
        ctx.propose.journal({ date: '2026-10-26', lines: [{ account: 'A', debit: '1' }, { account: 'B', credit: '1' }] });
        ctx.propose.record('task', { title: 'Call' });
        ctx.propose.update('task', '00000000-0000-0000-0000-000000000001', 3, { title: 'Called' });
        ctx.propose.notify('thanks', { roles: ['finance'] }, { channels: ['email'] });
        ctx.propose.connector('tally', { voucher: 'R-1' });
        ctx.inputs.donor.name = 'changed';`,
      record: {},
      previous: null,
      status: null,
      recordType: 'donation',
      user: { id: 'u1', roles: [] },
      inputs: { donor: { name: 'Asha' } },
    });
    expect(out.output).toEqual({
      effects: [
        { type: 'ledger.propose', date: '2026-10-26', lines: [{ account: 'A', debit: '1' }, { account: 'B', credit: '1' }] },
        { type: 'records.create', recordType: 'task', data: { title: 'Call' } },
        { type: 'records.update', recordType: 'task', id: '00000000-0000-0000-0000-000000000001', expectedVersion: 3, data: { title: 'Called' } },
        { type: 'notify', template: 'thanks', to: { roles: ['finance'] }, channels: ['email'] },
        { type: 'connector.call', connector: 'tally', body: { voucher: 'R-1' } },
      ],
    });
  });
});
