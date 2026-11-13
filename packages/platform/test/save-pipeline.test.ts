import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { richTextToPlain, sanitiseRichText } from '../src/runtime/records/rich-text.js';
import { buildServer } from '@onengo/server/http/server.js';
import type { ConnectorRequest, ConnectorResponse } from '../src/infrastructure/connectors/http.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionBodies, DefinitionKind, ScriptDef } from '../src/runtime/definitions/types.js';
import { admin, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
const finance: Actor = { id: 'fin-1', roles: ['finance'], permissions: ['record:donor:*', 'record:donation:*'] };

/** Lookup connector calls; each answer is a response, or a function run while the call is out. */
const calls: ConnectorRequest[] = [];
let answers: (ConnectorResponse | (() => Promise<ConnectorResponse>))[] = [];
const fakeHttp = async (req: ConnectorRequest): Promise<ConnectorResponse> => {
  calls.push(req);
  const next = answers.shift();
  if (typeof next === 'function') return next();
  return next ?? { status: 500, body: 'no answer was scripted' };
};

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, connectorHttp: fakeHttp });
  await completeIdentity(w, w.ngoA);
});
afterAll(() => w.close());

const as = (actor: Actor = finance) => w.as(w.ngoA, actor);
const issuesOf = (e: Error) => (e as unknown as { issues: { path: string; message: string }[] }).issues;
async function publish<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<void> {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, body.key);
}

describe('unique values and format rules', () => {
  it('refuses a second donor with the same PAN, ignoring case and blanks', async () => {
    await w.platform.records.create(as(), 'donor', { name: 'First', pan: 'AAAAA1111A' });
    const err = await expectCode(w.platform.records.create(as(), 'donor', { name: 'Second', pan: 'AAAAA1111A' }), 'validation_failed');
    expect(issuesOf(err)).toEqual([{ path: '/pan', message: 'Another donor already has this PAN.' }]);
    await w.platform.records.create(as(), 'donor', { name: 'No PAN 1' });
    await w.platform.records.create(as(), 'donor', { name: 'No PAN 2', pan: '' });
  });

  it('lets a record keep its own unique value', async () => {
    const { record } = await w.platform.records.create(as(), 'donor', { name: 'Keeper', pan: 'BBBBB2222B' });
    const saved = await w.platform.records.update(as(), record.id, { expectedVersion: 1, data: { city: 'Pune', pan: 'BBBBB2222B' } });
    expect(saved.record.data.city).toBe('Pune');
  });

  it('checks the format with its message, only when the value changes', async () => {
    const err = await expectCode(w.platform.records.create(as(), 'donor', { name: 'Bad PAN', pan: 'abc123' }), 'validation_failed');
    expect(issuesOf(err)[0]!.message).toMatch(/five letters, four digits and a letter/);
    const { record } = await w.platform.records.create(as(), 'donation', { donorName: 'Old', amount: 5 });
    await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query(`update record set data = data || '{"donorPan": "old-format"}'::jsonb where id = $1`, [record.id]),
    );
    const edited = await w.platform.records.update(as(), record.id, { expectedVersion: 1, data: { notes: 'still editable' } });
    expect(edited.record.data.donorPan).toBe('old-format');
  });
});

describe('rollups', () => {
  it('keep a donor’s totals in step with paid donations, including re-pointing', async () => {
    const a = (await w.platform.records.create(as(), 'donor', { name: 'Asha' })).record;
    const b = (await w.platform.records.create(as(), 'donor', { name: 'Bala' })).record;
    expect(a.data).toMatchObject({ totalGiven: 0, donationCount: 0 });
    await expectCode(w.platform.records.update(as(), a.id, { expectedVersion: 1, data: { totalGiven: 9 } }), 'validation_failed');

    const d1 = (await w.platform.records.create(as(), 'donation', { donor: a.id, amount: 500 })).record;
    const d2 = (await w.platform.records.create(as(), 'donation', { donor: a.id, amount: 250.5 })).record;
    expect((await w.platform.records.get(as(), a.id)).data).toMatchObject({ totalGiven: 0, donationCount: 0 });
    for (const d of [d1, d2]) {
      await w.platform.records.transition(as(), d.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn: today() } });
    }
    expect((await w.platform.records.get(as(), a.id)).data).toMatchObject({ totalGiven: 750.5, donationCount: 2 });

    const d3 = (await w.platform.records.create(as(), 'donation', { donor: a.id, amount: 100 })).record;
    await w.platform.records.update(as(), d3.id, { expectedVersion: 1, data: { donor: b.id } });
    await w.platform.records.transition(as(), d3.id, 'markPaid', { expectedVersion: 2, data: { method: 'cash', paidOn: today() } });
    expect((await w.platform.records.get(as(), a.id)).data).toMatchObject({ totalGiven: 750.5, donationCount: 2 });
    expect((await w.platform.records.get(as(), b.id)).data).toMatchObject({ totalGiven: 100, donationCount: 1 });

    const edited = await w.platform.records.update(as(), a.id, { expectedVersion: 1, data: { city: 'Delhi' } });
    expect(edited.record.data).toMatchObject({ totalGiven: 750.5, donationCount: 2, city: 'Delhi' });

    await w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`update record set data = data || '{"totalGiven": 1}'::jsonb where id = $1`, [a.id]));
    for (let after: string | null = null; ; ) {
      const page = await w.platform.records.rebuildRollups(w.ngoA, 'donor', after, 2);
      if (!page.count) break;
      after = page.lastId;
    }
    expect((await w.platform.records.get(as(), a.id)).data.totalGiven).toBe(750.5);
  });

  it('are rebuilt in the background when the record type is published again', async () => {
    await w.platform.definitions.setExtensionPatch(w.as(w.ngoA), 'recordType', 'donor', { description: 'Everyone who gives.' });
    await w.platform.dispatcher.runOnce();
    const jobs = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ kind: string; input: { recordType: string } }>(`select kind, input from job where created_by = 'system:jobs' order by kind`),
    );
    expect(jobs.map((j) => `${j.kind}:${j.input.recordType}`)).toContain('rollup.rebuild:donor');
    await w.platform.jobs.runOnce();
    const [left] = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from job where status <> 'done'`));
    expect(left!.n).toBe(0);
  });
});

describe('rich text', () => {
  const corpus: [string, string][] = [
    ['<p>Hello <script>alert(1)</script>world</p>', '<p>Hello world</p>'],
    ['<p onclick="alert(1)" class="x">Hi</p>', '<p>Hi</p>'],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="java&#x09;script:alert(1)">x</a>', '<a>x</a>'],
    ['<a href=" JaVaScRiPt:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="https://example.org/a?b=1&c=2" target="_blank" onmouseover="x()">ok</a>', '<a href="https://example.org/a?b=1&amp;c=2" rel="noopener noreferrer">ok</a>'],
    ['<a href="mailto:help@example.org">mail</a>', '<a href="mailto:help@example.org" rel="noopener noreferrer">mail</a>'],
    ['<p style="background:url(x)">s</p><style>p{}</style>', '<p>s</p>'],
    ['<img src=x onerror=alert(1)>pic', 'pic'],
    ['<iframe src="https://evil.example"><p>inside</p></iframe>after', 'after'],
    ['<svg><script>alert(1)</script></svg>ok', 'ok'],
    ['<b>bold</b> <i>it</i> <u>u</u>', '<strong>bold</strong> <em>it</em> <u>u</u>'],
    ['<ul><li>one<li>two</ul>', '<ul><li>one<li>two</li></li></ul>'],
    ['<h1>Big</h1><h3>Small</h3><blockquote>q</blockquote>', 'Big<h3>Small</h3><blockquote>q</blockquote>'],
    ['<p>unclosed <strong>bold', '<p>unclosed <strong>bold</strong></p>'],
    ['1 < 2 & 3 > 2', '1 &lt; 2 &amp; 3 &gt; 2'],
    ['<!-- <script>x</script> -->text', 'text'],
    ['<p>a<br/>b</p>', '<p>a<br>b</p>'],
    ['&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ];
  it.each(corpus)('cleans %s', (input, output) => expect(sanitiseRichText(input)).toBe(output));

  it('gives plain text for search and templates', () => {
    expect(richTextToPlain('<h3>Visit</h3><p>Met <strong>Ravi</strong> &amp; family</p><script>x</script>')).toBe('Visit Met Ravi & family');
  });
});

describe('signatures, locations and search text', () => {
  let png: string;
  let pdf: string;
  beforeAll(async () => {
    await publish('recordType', {
      key: 'consent',
      label: 'Consent',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true, searchable: true },
        { key: 'secret', label: 'Secret', type: 'text', sensitive: true, searchable: true },
        { key: 'story', label: 'Story', type: 'richText', searchable: true },
        { key: 'sign', label: 'Signature', type: 'signature' },
        { key: 'place', label: 'Place', type: 'location' },
      ],
    });
    const file = (mime: string, size: number) =>
      w.platform.db
        .withTenant(w.ngoA, (tx) =>
          tx.query<{ id: string }>(
            `insert into file_object (tenant_id, name, mime, size, sha256, storage_key, created_by) values (app_tenant(), 'f', $1, $2, 'h', 'k', 'admin-1') returning id`,
            [mime, size],
          ),
        )
        .then((r) => r[0]!.id);
    png = await file('image/png', 4000);
    pdf = await file('application/pdf', 4000);
  });

  it('records who signed and when, and only allows clearing afterwards', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'consent', {
      name: 'Ravi',
      sign: { file: png, signedBy: 'Ravi Kumar', signedAt: '1999-01-01T00:00:00Z' },
    });
    const sign = record.data.sign as { file: string; signedAt: string; signedBy: string };
    expect(sign).toMatchObject({ file: png, signedBy: 'Ravi Kumar' });
    expect(Date.now() - Date.parse(sign.signedAt)).toBeLessThan(60_000);
    const again = await w.platform.records.update(w.as(w.ngoA), record.id, { expectedVersion: 1, data: { sign: { file: png } } });
    expect(again.record.data.sign).toEqual(sign);
    const err = await expectCode(
      w.platform.records.update(w.as(w.ngoA), record.id, { expectedVersion: 2, data: { sign: { file: pdf } } }),
      'validation_failed',
    );
    expect(issuesOf(err)[0]!.message).toMatch(/can only be cleared/);
    const cleared = await w.platform.records.update(w.as(w.ngoA), record.id, { expectedVersion: 2, data: { sign: null } });
    expect(cleared.record.data).not.toHaveProperty('sign');
    await expectCode(w.platform.records.create(w.as(w.ngoA), 'consent', { name: 'X', sign: { file: pdf } }), 'validation_failed');
  });

  it('checks locations and sanitises rich text on save', async () => {
    await expectCode(w.platform.records.create(w.as(w.ngoA), 'consent', { name: 'X', place: { lat: 100, lng: 0 } }), 'validation_failed');
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'consent', {
      name: 'Meena',
      place: { lat: 19.07609, lng: 72.877426, label: 'Mumbai' },
      story: '<p onclick="x()">Lives near the <em>station</em></p><script>steal()</script>',
    });
    expect(record.data.story).toBe('<p>Lives near the <em>station</em></p>');
  });

  it('fills the search text from searchable fields, never sensitive ones', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'consent', {
      name: 'Zeenat Ali',
      secret: 'HIDDEN-VALUE',
      story: '<p>Tailoring <strong>class</strong></p>',
    });
    const [row] = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ search_text: string }>(`select search_text from record where id = $1`, [record.id]));
    expect(row!.search_text).toBe('zeenat ali tailoring class');
    const donation = (await w.platform.records.create(as(), 'donation', { donorName: 'Search Me', amount: 1 })).record;
    const [d] = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ search_text: string }>(`select search_text from record where id = $1`, [donation.id]));
    expect(d!.search_text).toBe(`${donation.number!.toLowerCase()} search me 1`);
  });
});

describe('several workflows', () => {
  beforeAll(async () => {
    await publish('recordType', {
      key: 'case',
      label: 'Case',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'programme', label: 'Programme', type: 'choice', choices: [{ value: 'health', label: 'Health' }, { value: 'school', label: 'School' }] },
        { key: 'urgent', label: 'Urgent', type: 'boolean' },
        { key: 'outcome', label: 'Outcome', type: 'text' },
      ],
    });
    const states = (...keys: string[]) => keys.map((key) => ({ key, label: key[0]!.toUpperCase() + key.slice(1) }));
    await publish('workflow', {
      key: 'intake',
      recordType: 'case',
      initial: 'new',
      states: states('new', 'accepted'),
      transitions: [{ key: 'accept', label: 'Accept', from: ['new'], to: 'accepted' }],
    });
    await publish('workflow', {
      key: 'healthIntake',
      recordType: 'case',
      appliesWhen: "record.programme == 'health'",
      initial: 'screening',
      states: states('screening', 'enrolled'),
      transitions: [{ key: 'enrol', label: 'Enrol', from: ['screening'], to: 'enrolled' }],
    });
    await publish('workflow', {
      key: 'closure',
      recordType: 'case',
      role: 'parallel',
      initial: 'open',
      states: states('open', 'closed'),
      transitions: [
        {
          key: 'close',
          label: 'Close',
          from: ['open'],
          to: 'closed',
          requiredFields: ['outcome'],
          guard: "states.intake == 'accepted' or states.healthIntake == 'enrolled'",
          guardMessage: 'Accept the case first.',
        },
      ],
    });
    await publish('workflow', {
      key: 'escalation',
      recordType: 'case',
      role: 'parallel',
      startsWhen: 'record.urgent == true',
      initial: 'raised',
      states: states('raised', 'handled'),
      transitions: [{ key: 'handle', label: 'Handle', from: ['raised'], to: 'handled', approval: { roles: ['supervisor'] } }],
    });
  });

  it('picks the primary workflow when the record is created and keeps it', async () => {
    const health = (await w.platform.records.create(w.as(w.ngoA), 'case', { name: 'H', programme: 'health' })).record;
    expect(health).toMatchObject({ workflow: 'healthIntake', status: 'screening', states: { closure: 'open' } });
    const other = (await w.platform.records.create(w.as(w.ngoA), 'case', { name: 'S', programme: 'school' })).record;
    expect(other).toMatchObject({ workflow: 'intake', status: 'new' });
    const moved = await w.platform.records.update(w.as(w.ngoA), other.id, { expectedVersion: 1, data: { programme: 'health' } });
    expect(moved.record).toMatchObject({ workflow: 'intake', status: 'new' });
    await expectCode(w.platform.records.transition(w.as(w.ngoA), other.id, 'enrol', { expectedVersion: 2 }), 'not_found');
  });

  it('runs steps of parallel workflows beside the primary one, with states in expressions', async () => {
    const c = (await w.platform.records.create(w.as(w.ngoA), 'case', { name: 'P', programme: 'school' })).record;
    const early = await expectCode(w.platform.records.transition(w.as(w.ngoA), c.id, 'close', { expectedVersion: 1, data: { outcome: 'x' } }), 'rule_violation');
    expect(early.message).toBe('Accept the case first.');
    await w.platform.records.transition(w.as(w.ngoA), c.id, 'accept', { expectedVersion: 1 });
    await expectCode(w.platform.records.transition(w.as(w.ngoA), c.id, 'close', { expectedVersion: 2 }), 'validation_failed');
    const closed = await w.platform.records.transition(w.as(w.ngoA), c.id, 'close', { expectedVersion: 2, data: { outcome: 'Housed' } });
    expect(closed.record).toMatchObject({ status: 'accepted', states: { closure: 'closed' } });
  });

  it('starts a parallel workflow when its condition becomes true, and approvals work on its steps', async () => {
    const c = (await w.platform.records.create(w.as(w.ngoA), 'case', { name: 'U', programme: 'school' })).record;
    expect(c.states).toEqual({ closure: 'open' });
    await expectCode(w.platform.records.transition(w.as(w.ngoA), c.id, 'handle', { expectedVersion: 1 }), 'rule_violation');
    const urgent = await w.platform.records.update(w.as(w.ngoA), c.id, { expectedVersion: 1, data: { urgent: true } });
    expect(urgent.record.states).toEqual({ closure: 'open', escalation: 'raised' });
    const asked = await w.platform.records.transition(w.as(w.ngoA), c.id, 'handle', { expectedVersion: 2 });
    expect(asked.approvalRequestId).toBeDefined();
    const supervisor: Actor = { id: 'sup-1', roles: ['supervisor'], permissions: ['record:case:read'] };
    const decided = await w.platform.approvals.decide(w.as(w.ngoA, supervisor), asked.approvalRequestId!, 'approve');
    expect(decided.status).toBe('approved');
    expect((await w.platform.records.get(w.as(w.ngoA), c.id)).states).toEqual({ closure: 'open', escalation: 'handled' });
  });
});

describe('restricted visibility', () => {
  const reader = (id: string, extra: string[] = [], roles: string[] = []): Actor => ({
    id,
    roles,
    permissions: ['record:note:read', 'record:note:update', 'record:note:create', ...extra],
  });
  let noteId: string;
  beforeAll(async () => {
    await publish('recordType', {
      key: 'note',
      label: 'Note',
      visibility: 'restricted',
      fields: [{ key: 'text', label: 'Text', type: 'text', required: true }],
    });
    noteId = (await w.platform.records.create(w.as(w.ngoA, reader('author')), 'note', { text: 'Private' })).record.id;
  });
  const share = (kind: 'user' | 'role', principal: string, access: 'read' | 'edit', expires: string | null = null) =>
    w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query(
        `insert into record_share (tenant_id, record_id, principal_kind, principal, access, created_by, expires_at)
         values (app_tenant(), $1, $2, $3, $4, 'author', $5)`,
        [noteId, kind, principal, access, expires],
      ),
    );

  it('shows a record only to its creator, people it is shared with, and people who may see all', async () => {
    expect((await w.platform.records.get(w.as(w.ngoA, reader('author')), noteId)).data.text).toBe('Private');
    await expectCode(w.platform.records.get(w.as(w.ngoA, reader('nosy')), noteId), 'not_found');
    expect((await w.platform.records.get(w.as(w.ngoA, reader('boss', ['record:note:read:all'])), noteId)).id).toBe(noteId);

    await share('user', 'friend', 'read');
    expect((await w.platform.records.get(w.as(w.ngoA, reader('friend')), noteId)).id).toBe(noteId);
    await expectCode(w.platform.records.update(w.as(w.ngoA, reader('friend')), noteId, { expectedVersion: 1, data: { text: 'x' } }), 'not_found');

    await share('role', 'editors', 'edit');
    const edited = await w.platform.records.update(w.as(w.ngoA, reader('ed', [], ['editors'])), noteId, { expectedVersion: 1, data: { text: 'Edited' } });
    expect(edited.record.data.text).toBe('Edited');

    await share('user', 'late', 'read', '2000-01-01T00:00:00Z');
    await expectCode(w.platform.records.get(w.as(w.ngoA, reader('late')), noteId), 'not_found');
  });
});

describe('lookups', () => {
  const ctx = () => w.as(w.ngoA);
  const bank = (BANK: string, BRANCH: string): ConnectorResponse => ({ status: 200, body: JSON.stringify({ BANK, BRANCH, CITY: 'Mumbai' }) });
  const accounts = async () =>
    (await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from record where type_key = 'bankAccount'`)))[0]!.n;
  const account = async (ifsc = 'HDFC0000001') => {
    answers = [bank('HDFC Bank', 'Mumbai Fort')];
    return (await w.platform.records.create(ctx(), 'bankAccount', { holder: 'Asha', ifsc })).record;
  };

  beforeAll(async () => {
    await w.platform.connectors.save(ctx(), 'ifsc', {
      kind: 'http',
      config: { mode: 'lookup', method: 'GET', url: 'https://ifsc.test/{{record.ifsc}}', inputs: ['ifsc'], responseMap: { bank: 'BANK', branch: 'BRANCH', city: 'CITY' } },
      enabled: true,
    });
    await publish('recordType', {
      key: 'bankAccount',
      label: 'Bank account',
      fields: [
        { key: 'holder', label: 'Holder', type: 'text' },
        { key: 'ifsc', label: 'IFSC', type: 'text' },
        { key: 'bankName', label: 'Bank name', type: 'text' },
        { key: 'branch', label: 'Branch', type: 'text' },
        { key: 'notes', label: 'Notes', type: 'text' },
      ],
      lookups: [{ key: 'bankDetails', connector: 'ifsc', inputs: ['ifsc'], map: { bankName: 'bank', branch: 'branch' } }],
    });
  });
  beforeEach(() => {
    calls.length = 0;
    answers = [];
  });

  it('fills the mapped fields on a create from the lookup answer', async () => {
    const record = await account();
    expect(record.data).toMatchObject({ holder: 'Asha', ifsc: 'HDFC0000001', bankName: 'HDFC Bank', branch: 'Mumbai Fort' });
    expect(record.data).not.toHaveProperty('city');
    expect(calls).toEqual([expect.objectContaining({ url: 'https://ifsc.test/HDFC0000001', method: 'GET' })]);
    expect((await w.platform.connectors.deliveries(ctx(), 'ifsc'))[0]).toMatchObject({ event: 'lookup', status: 'sent', recordId: null });
  });

  it('reports a 404 as an error on the fields it would fill, and writes nothing', async () => {
    const before = await accounts();
    answers = [{ status: 404, body: 'Invalid IFSC' }];
    const err = await expectCode(w.platform.records.create(ctx(), 'bankAccount', { holder: 'Ravi', ifsc: 'HDFC000000X' }), 'validation_failed');
    const issues = issuesOf(err);
    expect(issues.map((i) => i.path)).toEqual(['/bankName', '/branch']);
    for (const i of issues) expect(i.message).toMatch(/could not be looked up: .*404/);
    expect(await accounts()).toBe(before);

    await w.platform.connectors.save(ctx(), 'ifsc', { enabled: false });
    try {
      const off = await expectCode(w.platform.records.create(ctx(), 'bankAccount', { holder: 'Ravi', ifsc: 'HDFC0000001' }), 'validation_failed');
      expect(issuesOf(off)).toEqual([{ path: '/ifsc', message: 'Not sent: the connector is not enabled.' }]);
    } finally {
      await w.platform.connectors.save(ctx(), 'ifsc', { enabled: true });
    }
    expect(calls).toHaveLength(1);
    expect(await accounts()).toBe(before);

    const record = await account();
    answers = [{ status: 404, body: 'Invalid IFSC' }];
    await expectCode(w.platform.records.update(ctx(), record.id, { expectedVersion: record.version, data: { ifsc: 'HDFC000000X' } }), 'validation_failed');
    expect(await w.platform.records.get(ctx(), record.id)).toMatchObject({ version: record.version, data: { ifsc: 'HDFC0000001', bankName: 'HDFC Bank' } });
  });

  it('looks up again on an update only when an input changes', async () => {
    const record = await account();
    calls.length = 0;
    const same = await w.platform.records.update(ctx(), record.id, { expectedVersion: record.version, data: { ifsc: 'HDFC0000001', notes: 'same code' } });
    const other = await w.platform.records.update(ctx(), record.id, { expectedVersion: same.record.version, data: { notes: 'no code' } });
    expect(calls).toEqual([]);
    expect(other.record.data).toMatchObject({ bankName: 'HDFC Bank', branch: 'Mumbai Fort', notes: 'no code' });

    answers = [bank('State Bank of India', 'Pune Camp')];
    const moved = await w.platform.records.update(ctx(), record.id, { expectedVersion: other.record.version, data: { ifsc: 'SBIN0000002' } });
    expect(calls.map((c) => c.url)).toEqual(['https://ifsc.test/SBIN0000002']);
    expect(moved.record.data).toMatchObject({ ifsc: 'SBIN0000002', bankName: 'State Bank of India', branch: 'Pune Camp' });
  });

  it('conflicts when someone else saves the record while its lookup is out', async () => {
    const record = await account();
    const meanwhile = (notes: string) => async () => {
      const current = await w.platform.records.get(ctx(), record.id);
      await w.platform.records.update(ctx(), record.id, { expectedVersion: current.version, data: { notes } });
      return bank('State Bank of India', 'Pune Camp');
    };
    answers = [meanwhile('first edit')];
    await expectCode(w.platform.records.update(ctx(), record.id, { expectedVersion: record.version, data: { ifsc: 'SBIN0000002' } }), 'conflict');
    const after = await w.platform.records.get(ctx(), record.id);
    expect(after).toMatchObject({ version: record.version + 1, data: { ifsc: 'HDFC0000001', notes: 'first edit' } });

    answers = [meanwhile('second edit')];
    const unversioned = { data: { ifsc: 'SBIN0000002' } } as unknown as { data: Record<string, unknown>; expectedVersion: number };
    await expectCode(w.platform.records.update(ctx(), record.id, unversioned), 'conflict');
    expect(await w.platform.records.get(ctx(), record.id)).toMatchObject({ version: record.version + 2, data: { ifsc: 'HDFC0000001', notes: 'second edit' } });
  });

  it('refuses action and script saves that change a lookup input', async () => {
    const record = await account();
    calls.length = 0;
    await publish('action', {
      key: 'setIfsc',
      recordType: 'bankAccount',
      label: 'Set IFSC',
      placement: ['panel'],
      steps: [{ type: 'setFields', values: { ifsc: "'SBIN0000003'" } }],
    });
    await publish('action', { key: 'setNotes', recordType: 'bankAccount', label: 'Set notes', placement: ['panel'], steps: [{ type: 'setFields', values: { notes: "'checked'" } }] });
    const err = await expectCode(w.platform.actions.run(ctx(), 'bankAccount', record.id, 'setIfsc', { input: {} }), 'validation_failed');
    expect(issuesOf(err)).toEqual([{ path: '/ifsc', message: expect.stringContaining("is looked up from 'ifsc'") }]);
    expect((await w.platform.actions.run(ctx(), 'bankAccount', record.id, 'setNotes', { input: {} })).record.data).toMatchObject({ notes: 'checked', ifsc: 'HDFC0000001' });

    await publish('recordType', { key: 'bankNote', label: 'Bank note', fields: [{ key: 'account', label: 'Account', type: 'reference', referenceType: 'bankAccount' }] });
    await w.platform.definitions.saveDraft(ctx(), 'script', {
      key: 'moveBank',
      recordType: 'bankNote',
      hook: 'afterSave',
      inputs: { related: [{ name: 'account', field: 'account', fields: ['ifsc'] }] },
      effects: { allow: ['records.update'] },
      code: `ctx.propose.update('bankAccount', ctx.inputs.account.id, ctx.inputs.account.version, { ifsc: 'SBIN0000004' });`,
    } as ScriptDef);
    await w.platform.definitions.publish(ctx(), 'script', 'moveBank');
    const scripted = await expectCode(w.platform.records.create(ctx(), 'bankNote', { account: record.id }), 'validation_failed');
    expect(JSON.stringify(issuesOf(scripted))).toContain('looked up from');
    const notes = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from record where type_key = 'bankNote'`));
    expect(notes[0]!.n).toBe(0);
    expect((await w.platform.records.get(ctx(), record.id)).data.ifsc).toBe('HDFC0000001');
    expect(calls).toEqual([]);
  });

  it('looks up each imported row when the import runs, but not when it is checked', async () => {
    const view = await w.platform.imports.upload(ctx(), 'bankAccount', [Buffer.from('Holder,IFSC\nMeena,ICIC0000005\n')], 'banks.csv');
    await w.platform.imports.setMapping(ctx(), view.id, {});
    expect(await w.platform.imports.check(ctx(), view.id)).toMatchObject({ rows: 1, valid: 1, invalid: 0, creates: 1 });
    expect(calls).toEqual([]);

    answers = [bank('ICICI Bank', 'Chennai Anna Salai')];
    await w.platform.imports.run(ctx(), view.id);
    await w.platform.jobs.runOnce();
    expect((await w.platform.imports.get(ctx(), view.id)).counts).toEqual({ created: 1, updated: 0, failed: 0 });
    expect(calls.map((c) => c.url)).toEqual(['https://ifsc.test/ICIC0000005']);
    const [imported] = (await w.platform.records.query(ctx(), 'bankAccount', { equals: { ifsc: 'ICIC0000005' } })).items;
    expect(imported!.data).toMatchObject({ holder: 'Meena', bankName: 'ICICI Bank', branch: 'Chennai Anna Salai' });
  });
});

describe('headers', () => {
  it('allow the app itself to ask for the device location', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(self)');
    await app.close();
    expect(admin.permissions).toEqual(['*']);
  });
});
