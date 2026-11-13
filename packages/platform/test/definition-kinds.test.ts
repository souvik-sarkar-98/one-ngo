import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWarnings, type DefinitionLookup } from '../src/runtime/definitions/cross-refs.js';
import { loadModulePackage, publishModulePackage } from '../src/runtime/definitions/package-loader.js';
import type { ActionDef, DefinitionBodies, DefinitionKind, PageDef } from '../src/runtime/definitions/types.js';
import { SCHEMA_DIR } from '../src/platform.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

async function publishIssues<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<string> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, kind, body);
  const err = await expectCode(w.platform.definitions.publish(ctx, kind, body.key), 'definition_invalid');
  await w.platform.definitions.discardDraft(ctx, kind, body.key);
  return (err as unknown as { issues: { path: string; message: string }[] }).issues.map((i) => `${i.path} ${i.message}`).join(' | ');
}

async function publish<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<void> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, kind, body);
  await w.platform.definitions.publish(ctx, kind, body.key);
}

const sendReminder: ActionDef = {
  key: 'nudge',
  recordType: 'donation',
  label: 'Nudge',
  placement: ['panel', 'row', 'bulk'],
  when: "record.status == 'raised'",
  confirm: 'Send a reminder to the donor?',
  form: { fields: [{ key: 'note', label: 'Note', type: 'longText' }] },
  steps: [{ type: 'notify', template: 'donationThanks', to: { creator: true }, channels: ['inApp'] }],
};

describe('schemas', () => {
  const valid = (kind: DefinitionKind, body: unknown) => w.platform.schemas.validate(kind, body);

  it('accept well-formed translations, actions and pages', () => {
    expect(valid('translation', { key: 'hi', locale: 'hi', entries: { 'recordType.donation.label': 'दान', 'ui.nav.home': 'होम' } })).toEqual([]);
    expect(valid('action', sendReminder)).toEqual([]);
    expect(valid('action', { ...sendReminder, steps: [{ type: 'connector', connector: 'crm', body: { amount: 'record.amount' } }] })).toEqual([]);
    expect(
      valid('page', {
        key: 'home',
        label: 'Home',
        widgets: [
          { type: 'groups' },
          { type: 'stat', label: 'Raised', recordType: 'donation', measure: 'sum', field: 'amount', view: { chip: 'outstanding' } },
          { type: 'chart', label: 'By month', recordType: 'donation', measure: 'count', groupBy: { period: 'month', dateField: 'createdAt' }, chart: 'bar' },
          { type: 'list', label: 'Mine', listView: 'donations', limit: 5, view: { owner: 'me' } },
          { type: 'links', label: 'Go', items: [{ label: 'Outstanding', to: '/records/donation?chip=outstanding' }] },
        ],
      }),
    ).toEqual([]);
  });

  it('refuse malformed ones', () => {
    expect(valid('translation', { key: 'hi', locale: 'Hindi', entries: {} })).not.toEqual([]);
    expect(valid('translation', { key: 'hi', locale: 'hi', entries: { 'nowhere.x': 'y' } })).not.toEqual([]);
    expect(valid('action', { ...sendReminder, placement: ['toolbar'] })).not.toEqual([]);
    expect(valid('action', { ...sendReminder, steps: [] })).not.toEqual([]);
    expect(valid('action', { ...sendReminder, steps: [{ type: 'runShell' }] })).not.toEqual([]);
    expect(valid('action', { ...sendReminder, steps: [{ type: 'connector' }] })).not.toEqual([]);
    for (const to of ['https://example.org', '//example.org', 'records']) {
      expect(valid('page', { key: 'p', label: 'P', widgets: [{ type: 'links', label: 'L', items: [{ label: 'x', to }] }] })).not.toEqual([]);
    }
    expect(valid('page', { key: 'p', label: 'P', placement: 'more', widgets: [{ type: 'groups' }] })).not.toEqual([]);
    expect(valid('page', { key: 'p', label: 'P', widgets: [{ type: 'stat', label: 'S', recordType: 'donation' }] })).not.toEqual([]);
  });

  it('describe every property, so the generic editor has hints', async () => {
    const { readFile } = await import('node:fs/promises');
    const missing: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      for (const [k, v] of Object.entries((n.properties as Record<string, Record<string, unknown>>) ?? {})) {
        if (!v.description && !v.$ref) missing.push(`${path}/${k}`);
        walk(v, `${path}/${k}`);
      }
      for (const key of ['items', 'additionalProperties']) walk(n[key], `${path}/${key}`);
      for (const key of ['oneOf', 'anyOf']) (n[key] as unknown[] | undefined)?.forEach((s, i) => walk(s, `${path}/${key}/${i}`));
      for (const [k, v] of Object.entries((n.definitions as Record<string, unknown>) ?? {})) walk(v, `${path}#${k}`);
    };
    for (const kind of ['translation', 'action', 'page']) {
      walk(JSON.parse(await readFile(join(SCHEMA_DIR, `${kind}.schema.json`), 'utf8')), kind);
    }
    expect(missing).toEqual([]);
  });
});

describe('action checks', () => {
  it('publishes a valid action', async () => {
    await publish('action', sendReminder);
    const actions = await w.platform.definitions.list(w.ngoA, 'action');
    expect(actions.map((a) => a.key)).toContain('nudge');
  });

  it('refuses actions that refer to things that do not exist', async () => {
    const messages = await publishIssues('action', {
      key: 'broken',
      recordType: 'donation',
      label: 'Broken',
      placement: ['panel'],
      when: 'record.status ==',
      form: {
        fields: [
          { key: 'a', label: 'A', type: 'choice' },
          { key: 'a', label: 'Again', type: 'reference', referenceType: 'ghost' },
        ],
      },
      steps: [
        { type: 'setFields', values: { netAmount: '1', notes: 'input.a' } },
        { type: 'transition', transition: 'teleport' },
        { type: 'createRecord', recordType: 'ghost', values: {} },
        { type: 'notify', template: 'nothing', to: {} },
        { type: 'createPayment', provider: 'upi', amount: 'record.amount +', account: '', onPaid: { transition: 'fly', fields: { paidOn: 'netAmount' } } },
        { type: 'webhook', connector: '', body: { x: '(' } },
      ],
    });
    for (const m of [
      '/when expression error',
      '/form/fields/0/choices choice fields need at least one choice',
      "/form/fields/1/key duplicate field 'a'",
      "/form/fields/1/referenceType record type 'ghost' is not published",
      "/steps/0/values/netAmount 'netAmount' is not a writable field",
      "/steps/1/transition workflow has no step 'teleport'",
      "/steps/2/recordType record type 'ghost' is not published",
      "/steps/3/template template 'nothing' is not published",
      '/steps/3/to choose at least one recipient',
      '/steps/4/amount expression error',
      '/steps/4/account choose the account',
      "/steps/4/onPaid/transition workflow has no step 'fly'",
      "/steps/4/onPaid/fields/paidOn 'netAmount' is not a writable field",
      '/steps/5/connector choose a connector',
      '/steps/5/body/x expression error',
    ]) {
      expect(messages).toContain(m);
    }
    expect(messages).not.toContain('/steps/0/values/notes');
  });

  it('allows opening the receipt only where a receipt rule exists', async () => {
    await publish('action', { key: 'printSlip', recordType: 'donation', label: 'Print slip', placement: ['panel'], steps: [{ type: 'openReceipt' }] });
    await publish('recordType', { key: 'visit', label: 'Visit', fields: [{ key: 'place', label: 'Place', type: 'text' }] });
    expect(
      await publishIssues('action', { key: 'visitReceipt', recordType: 'visit', label: 'Receipt', placement: ['panel'], steps: [{ type: 'openReceipt' }] }),
    ).toContain("/steps/0 record type 'visit' has no receipt rule");
  });
});

describe('connector checks', () => {
  beforeAll(async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.connectors.save(ctx, 'crm', { kind: 'webhook', config: { url: 'https://crm.test/hooks' } });
    await w.platform.connectors.save(ctx, 'chat', { kind: 'http', config: { mode: 'send', method: 'POST', url: 'https://chat.test/post' } });
    await w.platform.connectors.save(ctx, 'ifsc', {
      kind: 'http',
      config: { mode: 'lookup', method: 'GET', url: 'https://ifsc.test/{{record.ifsc}}', inputs: ['ifsc'], responseMap: { bank: 'BANK' } },
    });
  });
  const step = (steps: ActionDef['steps']): ActionDef => ({ key: 'callOut', recordType: 'donation', label: 'Call out', placement: ['panel'], steps });

  it('let connector steps name only http send connectors, and webhook steps only webhooks', async () => {
    await publish('action', step([{ type: 'connector', connector: 'chat', body: { amount: 'record.amount' } }]));
    const messages = await publishIssues(
      'action',
      step([
        { type: 'connector', connector: 'crm' },
        { type: 'connector', connector: 'ifsc' },
        { type: 'connector', connector: 'ghost' },
        { type: 'webhook', connector: 'chat' },
      ]),
    );
    expect(messages).toContain("/steps/0/connector connector 'crm' is a webhook connector; choose a http connector in send mode");
    expect(messages).toContain("/steps/1/connector connector 'ifsc' is a http connector in lookup mode; choose a http connector in send mode");
    expect(messages).toContain("/steps/2/connector http connector in send mode 'ghost' does not exist");
    expect(messages).toContain("/steps/3/connector connector 'chat' is a http connector in send mode; choose a webhook connector");
  });

  it('check record type lookups: an http lookup connector, known inputs, and editable non-money fields to fill', async () => {
    const fields: DefinitionBodies['recordType']['fields'] = [
      { key: 'ifsc', label: 'IFSC', type: 'text' },
      { key: 'bankName', label: 'Bank name', type: 'text' },
      { key: 'fee', label: 'Fee', type: 'money' },
      { key: 'shout', label: 'Shout', type: 'text', calculated: 'record.bankName' },
    ];
    await publish('recordType', { key: 'payee', label: 'Payee', fields, lookups: [{ key: 'bank', connector: 'ifsc', inputs: ['ifsc'], map: { bankName: 'bank' } }] });
    const messages = await publishIssues('recordType', {
      key: 'payee',
      label: 'Payee',
      fields,
      lookups: [
        { key: 'bank', connector: 'chat', inputs: ['code'], map: { bankName: 'bank', fee: 'bank', shout: 'bank', ghost: 'bank' } },
        { key: 'bank', connector: 'nowhere', inputs: ['ifsc'], map: { bankName: 'bank' } },
      ],
    });
    for (const m of [
      "/lookups/0/connector connector 'chat' is a http connector in send mode; choose a http connector in lookup mode",
      "/lookups/0/inputs/0 unknown field 'code'",
      "/lookups/0/map/fee money field 'fee' cannot be filled by a lookup",
      "/lookups/0/map/shout 'shout' is filled automatically and cannot be filled by a lookup",
      "/lookups/0/map/ghost unknown field 'ghost'",
      "/lookups/1/key duplicate lookup 'bank'",
      "/lookups/1/connector http connector in lookup mode 'nowhere' does not exist",
    ]) {
      expect(messages).toContain(m);
    }
    expect(messages).not.toContain('/lookups/0/map/bankName');
  });
});

describe('form placeholders and columns', () => {
  it('a placeholder is for fields that show an empty box, not files, ticks, maps, drawings or formatted text', async () => {
    const messages = await publishIssues('recordType', {
      key: 'pledger',
      label: 'Pledger',
      fields: [
        { key: 'pan', label: 'PAN', type: 'text', placeholder: 'ABCDE1234F' },
        { key: 'photo', label: 'Photo', type: 'file', placeholder: 'Pick a photo' },
        { key: 'agreed', label: 'Agreed', type: 'boolean', placeholder: 'Yes' },
      ],
    });
    expect(messages).toContain('/fields/1/placeholder file fields cannot have a placeholder');
    expect(messages).toContain('/fields/2/placeholder boolean fields cannot have a placeholder');
    expect(messages).not.toContain('/fields/0/placeholder');
  });

  it('a list view form may use two or three columns, and its full-width fields must be on that form', async () => {
    await publish('listView', {
      key: 'donationForm',
      recordType: 'donation',
      create: { fields: ['donorName', 'amount', 'method'], columns: 2, fullWidth: ['method'] },
      edit: { fields: ['amount', 'method'], columns: 3, fullWidth: ['amount'] },
    });
    const messages = await publishIssues('listView', {
      key: 'donationForm',
      recordType: 'donation',
      create: { fields: ['donorName'], columns: 2, fullWidth: ['amount'] },
      edit: { fields: ['amount'], fullWidth: ['donorName'] },
    });
    expect(messages).toContain("/create/fullWidth/0 'amount' is not on this form");
    expect(messages).toContain("/edit/fullWidth/0 'donorName' is not on this form");
    expect(w.platform.schemas.validate('listView', { key: 'donationForm', recordType: 'donation', create: { fields: ['donorName'], columns: 4 } })).not.toEqual([]);
  });

  it('an action form may use columns, and its full-width fields must be on the form', async () => {
    const form = {
      fields: [
        { key: 'note', label: 'Note', type: 'longText' as const, placeholder: 'Say why' },
        { key: 'when', label: 'When', type: 'date' as const },
      ],
      columns: 2 as const,
      fullWidth: ['note'],
    };
    await publish('action', { ...sendReminder, key: 'nudgeForm', form });
    const messages = await publishIssues('action', { ...sendReminder, key: 'nudgeForm', form: { ...form, fullWidth: ['ghost'] } });
    expect(messages).toContain("/form/fullWidth/0 'ghost' is not on this form");
  });
});

describe('page checks', () => {
  const page = (widgets: PageDef['widgets'], extra: Partial<PageDef> = {}): PageDef => ({ key: 'dash', label: 'Dashboard', widgets, ...extra });

  it('publishes a valid page', async () => {
    await publish(
      'page',
      page(
        [
          { type: 'stat', label: 'Outstanding', recordType: 'donation', measure: 'sum', field: 'amount', view: { chip: 'outstanding', filters: { method: { in: ['cash'] } } } },
          { type: 'chart', label: 'By method', recordType: 'donation', measure: 'count', groupBy: { field: 'method' }, chart: 'bar' },
          { type: 'chart', label: 'By year', recordType: 'donation', measure: 'sum', field: 'amount', groupBy: { period: 'financialYear', dateField: 'paidOn' }, chart: 'line' },
          { type: 'list', label: 'Mine', listView: 'donations', limit: 5, view: { chip: 'mine' } },
        ],
        { audience: ['finance'] },
      ),
    );
  });

  it('refuses pages that refer to things that do not exist', async () => {
    const messages = await publishIssues(
      'page',
      page(
        [
          { type: 'stat', label: 'A', recordType: 'ghost', measure: 'count' },
          { type: 'stat', label: 'B', recordType: 'donation', measure: 'sum', field: 'donorName' },
          { type: 'stat', label: 'C', recordType: 'donation', measure: 'sum' },
          { type: 'chart', label: 'D', recordType: 'donation', measure: 'count', groupBy: { field: 'donorPan' }, chart: 'bar' },
          { type: 'chart', label: 'E', recordType: 'donation', measure: 'count', groupBy: { period: 'month', dateField: 'amount' }, chart: 'bar' },
          { type: 'list', label: 'F', listView: 'ghosts', limit: 5 },
          { type: 'list', label: 'G', listView: 'donations', limit: 5, view: { chip: 'nowhere', filters: { donorPan: { eq: 'x' }, notes: { eq: 'x' } } } },
        ],
        { audience: ['finance', 'wizards'] },
      ),
    );
    for (const m of [
      "/audience/1 role 'wizards' does not exist",
      "/widgets/0/recordType record type 'ghost' is not published",
      "/widgets/1/field 'donorName' is not a number or money field",
      '/widgets/2/field choose a number or money field to total',
      "/widgets/3/groupBy/field 'donorPan' cannot be grouped by",
      "/widgets/4/groupBy/dateField 'amount' is not a date field",
      "/widgets/5/listView list view 'ghosts' is not published",
      "/widgets/6/view/chip unknown chip 'nowhere'",
      "/widgets/6/view/filters/donorPan sensitive field 'donorPan' cannot be filtered",
      "/widgets/6/view/filters/notes 'notes' (longText) cannot be filtered",
    ]) {
      expect(messages).toContain(m);
    }
  });
});

describe('translation checks', () => {
  it('allows one translation per language', async () => {
    await publish('translation', { key: 'hi', locale: 'hi', entries: { 'recordType.donation.label': 'दान' } });
    expect(await publishIssues('translation', { key: 'hindi', locale: 'hi', entries: {} })).toContain("/locale translation 'hi' already covers 'hi'");
  });

  it('warns about entries whose text no longer exists', () => {
    const defs: Record<string, unknown> = {
      'recordType|donation': { key: 'donation', label: 'Donation', fields: [{ key: 'amount', label: 'Amount', choices: [{ value: 'a', label: 'A' }] }] },
      'page|home': { key: 'home', label: 'Home', widgets: [{ type: 'stat', label: 'Raised' }] },
    };
    const lookup = { definition: (k: string, key: string) => defs[`${k}|${key}`] } as unknown as DefinitionLookup;
    const warnings = checkWarnings(
      'translation',
      {
        key: 'hi',
        locale: 'hi',
        entries: {
          'recordType.donation.label': 'x',
          'recordType.donation.fields.amount.label': 'x',
          'recordType.donation.fields.amount.choices.a.label': 'x',
          'page.home.widgets.0.label': 'x',
          'ui.nav.home': 'x',
          'recordType.donation.fields.gone.label': 'x',
          'recordType.ghost.label': 'x',
          'page.home.widgets.3.label': 'x',
          'recordType.donation.fields': 'x',
        },
      },
      lookup,
    );
    expect(warnings.map((x) => x.path)).toEqual([
      '/entries/recordType.donation.fields.gone.label',
      '/entries/recordType.ghost.label',
      '/entries/page.home.widgets.3.label',
      '/entries/recordType.donation.fields',
    ]);
  });
});

describe('modules with the new kinds', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ngo-kinds-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('load, install in order, and enable', async () => {
    const files: Record<string, unknown> = {
      'module.json': {
        key: 'outreach',
        version: '0.1.0',
        label: 'Outreach',
        engine: '0.1.0',
        definitions: ['hi.translation.json', 'outreach.page.json', 'call.action.json', 'call.recordType.json', 'call-done.template.json'],
        setup: { roles: [{ key: 'caller', label: 'Caller', permissions: ['record:call:*'] }] },
      },
      'call.recordType.json': { key: 'call', label: 'Call', fields: [{ key: 'who', label: 'Who', type: 'text' }, { key: 'done', label: 'Done', type: 'boolean' }] },
      'call-done.template.json': { key: 'call-done', subject: 'Call done', body: 'Done: {{ record.who }}' },
      'call.action.json': {
        key: 'markDone',
        recordType: 'call',
        label: 'Mark done',
        placement: ['row'],
        steps: [{ type: 'setFields', values: { done: 'true' } }, { type: 'notify', template: 'call-done', to: { creator: true } }],
      },
      'outreach.page.json': { key: 'outreach', label: 'Outreach', audience: ['caller'], widgets: [{ type: 'stat', label: 'Calls', recordType: 'call', measure: 'count' }] },
      'hi.translation.json': { key: 'outreach-hi', locale: 'ta', entries: { 'recordType.call.label': 'அழைப்பு', 'action.markDone.label': 'முடிந்தது' } },
    };
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(body));

    const pkg = await loadModulePackage(dir, w.platform.schemas);
    expect(pkg.definitions.map((d) => d.kind)).toEqual(['recordType', 'template', 'translation', 'action', 'page']);
    await publishModulePackage(w.platform.definitions, pkg);
    const result = await w.platform.definitions.enableModule(w.as(w.ngoB), pkg.manifest);
    expect(result.materialised.sort()).toEqual(['action|markDone', 'page|outreach', 'recordType|call', 'template|call-done', 'translation|outreach-hi']);
    expect((await w.platform.definitions.list(w.ngoB, 'page')).map((p) => p.key)).toEqual(['outreach']);
  });
});
