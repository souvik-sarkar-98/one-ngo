import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { checkCrossReferences, type DefinitionLookup } from '../src/runtime/definitions/cross-refs.js';
import type { DefinitionBodies, DefinitionKind, FieldDef, RecordTypeDef, WorkflowDef } from '../src/runtime/definitions/types.js';
import { admin, createWorld, expectCode, type TestWorld } from './helpers.js';

const text = (key: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key, type: 'text', ...extra });

function look(over: {
  types?: RecordTypeDef[];
  workflows?: WorkflowDef[];
  posting?: { recordType: string }[];
  receipts?: { recordType: string }[];
} = {}): DefinitionLookup {
  const types = over.types ?? [];
  const workflows = over.workflows ?? [];
  return {
    recordType: (key) => types.find((t) => t.key === key),
    workflowFor: (recordType) => workflows.find((w) => w.recordType === recordType),
    workflowsFor: (recordType) => workflows.filter((w) => w.recordType === recordType),
    template: () => undefined,
    definition: () => undefined,
    all: ((kind: string) => {
      if (kind === 'postingRule') return over.posting ?? [];
      if (kind === 'receiptRule') return over.receipts ?? [];
      return [];
    }) as DefinitionLookup['all'],
    accountCodes: null,
    receiptSeries: null,
    roles: null,
    connectors: null,
  };
}

function type(key: string, fields: FieldDef[], access?: RecordTypeDef['public']): RecordTypeDef {
  return { key, label: key, fields, ...(access ? { public: access } : {}) };
}

function problems(body: RecordTypeDef, lookup?: DefinitionLookup): string {
  return checkCrossReferences('recordType', body, lookup ?? look({ types: [body] }))
    .map((i) => `${i.path} ${i.message}`)
    .join(' | ');
}

const flow: WorkflowDef = {
  key: 'bookFlow',
  recordType: 'book',
  initial: 'available',
  states: [
    { key: 'available', label: 'Available' },
    { key: 'lent', label: 'Lent', final: true },
  ],
  transitions: [{ key: 'lend', label: 'Lend', from: ['available'], to: 'lent' }],
};

describe('public record type publish rules', () => {
  const comment = text('comment', { required: true });

  it('refuses view without create, and edit or delete without view', () => {
    expect(problems(type('note', [comment], { view: true, fields: ['comment'] }))).toContain('/public/view');
    expect(problems(type('note', [comment], { create: true, edit: true, fields: ['comment'] }))).toContain('/public/edit');
    expect(problems(type('note', [comment], { create: true, delete: true, fields: ['comment'] }))).toContain('/public/delete');
  });

  it('refuses person, file, signature, sensitive, calculated, and lookup-input fields', () => {
    const cases: FieldDef[] = [
      { key: 'who', label: 'Who', type: 'person' },
      { key: 'scan', label: 'Scan', type: 'file' },
      { key: 'sign', label: 'Sign', type: 'signature' },
      text('secret', { sensitive: true }),
      text('total', { calculated: '1' }),
      text('copied', { follow: { via: 'who', field: 'name' } }),
      text('count', { rollup: { recordType: 'note', reference: 'parent', measure: 'count' } }),
    ];
    for (const field of cases) {
      const messages = problems(type('note', [comment, field], { create: true, fields: ['comment', field.key] }));
      expect(messages, field.key).toMatch(/cannot be public|cannot be entered/);
    }
    const city = text('city');
    const withLookup = type('note', [comment, city], { create: true, fields: ['comment', 'city'] });
    withLookup.lookups = [{ key: 'pin', connector: 'places', inputs: ['city'], map: {} }];
    expect(problems(withLookup)).toContain('sent to a lookup');
  });

  it('accepts one reference to a catalogue and refuses a second or a type without one', () => {
    const book = type('book', [text('title')], { catalogue: { fields: ['title'], statusIn: ['available'] } });
    const request = type('request', [comment, { key: 'book', label: 'Book', type: 'reference', referenceType: 'book', required: true }], {
      create: true,
      fields: ['comment', 'book'],
    });
    expect(problems(request, look({ types: [book, request], workflows: [flow] }))).toBe('');
    const shelf = type('shelf', [text('name')]);
    const loose = type('request', [comment, { key: 'book', label: 'Book', type: 'reference', referenceType: 'shelf', required: true }], {
      create: true,
      fields: ['comment', 'book'],
    });
    expect(problems(loose, look({ types: [shelf, loose] }))).toContain('public catalogue');
    const two = type(
      'request',
      [comment, { key: 'book', label: 'Book', type: 'reference', referenceType: 'book' }, { key: 'other', label: 'Other', type: 'reference', referenceType: 'book' }],
      { create: true, fields: ['comment', 'book', 'other'] },
    );
    expect(problems(two, look({ types: [book, two], workflows: [flow] }))).toContain('one catalogue record');
  });

  it('refuses a public block on a type that posts or issues a receipt, and a catalogue without a real status', () => {
    const note = type('note', [comment], { create: true, fields: ['comment'] });
    expect(problems(note, look({ types: [note], posting: [{ recordType: 'note' }] }))).toContain('cannot be public');
    expect(problems(note, look({ types: [note], receipts: [{ recordType: 'note' }] }))).toContain('cannot be public');
    const book = type('book', [text('title')], { catalogue: { fields: ['title'], statusIn: [] } });
    expect(problems(book, look({ types: [book], workflows: [flow] }))).toContain('/public/catalogue/statusIn');
    const missing = type('book', [text('title')], { catalogue: { fields: ['title'], statusIn: ['missing'] } });
    expect(problems(missing, look({ types: [missing], workflows: [flow] }))).toContain("state 'missing'");
  });
});

let w: TestWorld;
let app: ReturnType<typeof buildServer>;

const book: RecordTypeDef = {
  key: 'book',
  label: 'Book',
  pluralLabel: 'Books',
  fields: [text('title', { required: true }), text('author'), text('secret')],
};
const requestFields: FieldDef[] = [
  text('note', { required: true }),
  { key: 'book', label: 'Book', type: 'reference', referenceType: 'book', required: true },
];
const request: RecordTypeDef = {
  key: 'request',
  label: 'Request',
  fields: requestFields,
  public: { create: true, view: true, edit: true, delete: true, fields: ['note', 'book'] },
};
const survey: RecordTypeDef = {
  key: 'survey',
  label: 'Survey',
  fields: [text('comment', { required: true })],
  public: { create: true, fields: ['comment'], thanks: 'Thanks for the feedback.' },
};
const answer: RecordTypeDef = {
  key: 'answer',
  label: 'Answer',
  fields: [text('comment', { required: true })],
  public: { create: true, view: true, fields: ['comment'] },
};
const requestFlow: WorkflowDef = {
  key: 'requestFlow',
  recordType: 'request',
  initial: 'open',
  states: [
    { key: 'open', label: 'Open' },
    { key: 'closed', label: 'Closed', final: true },
  ],
  transitions: [{ key: 'close', label: 'Close', from: ['open'], to: 'closed' }],
};

async function publish<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K], tenant = w.ngoA): Promise<void> {
  const ctx = w.as(tenant);
  await w.platform.definitions.saveDraft(ctx, kind, body);
  await w.platform.definitions.publish(ctx, kind, body.key);
}

async function publishIssues<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<string> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, kind, body);
  const err = await expectCode(w.platform.definitions.publish(ctx, kind, body.key), 'definition_invalid');
  await w.platform.definitions.discardDraft(ctx, kind, body.key);
  return (err as unknown as { issues: { path: string; message: string }[] }).issues.map((i) => i.message).join(' | ');
}

beforeAll(async () => {
  w = await createWorld();
  app = buildServer(w.platform, { devAuth: true, organisationLookupLimit: 10_000, rateLimits: { api: 10_000 } });
  await publish('recordType', book);
  await publish('workflow', flow);
  await publish('recordType', {
    ...book,
    public: { catalogue: { fields: ['title', 'author'], search: ['title'], statusIn: ['available'] } },
  });
  await publish('recordType', request);
  await publish('workflow', requestFlow);
  await publish('recordType', {
    ...book,
    public: { catalogue: { fields: ['title', 'author'], search: ['title'], statusIn: ['available'], request: { recordType: 'request', field: 'book' } } },
  });
  await publish('recordType', survey);
  await publish('recordType', answer);
});
afterAll(async () => {
  await app.close();
  await w.close();
});

const staff = () => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(admin) });

function tokenOf(path: string): string {
  return path.replace('/f/', '');
}

describe('public forms', () => {
  it('refuses a public block once the type posts to the books', async () => {
    const slip: RecordTypeDef = {
      key: 'slip',
      label: 'Slip',
      fields: [
        { key: 'amount', label: 'Amount', type: 'money', required: true },
        { key: 'paidOn', label: 'Paid on', type: 'date', required: true },
      ],
    };
    await publish('recordType', slip);
    await publish('workflow', {
      key: 'slipFlow',
      recordType: 'slip',
      initial: 'open',
      states: [
        { key: 'open', label: 'Open' },
        { key: 'paid', label: 'Paid' },
      ],
      transitions: [{ key: 'pay', label: 'Pay', from: ['open'], to: 'paid' }],
    });
    await publish('postingRule', {
      key: 'slipPaid',
      recordType: 'slip',
      whenStatus: 'paid',
      date: 'record.paidOn',
      memo: "'Slip ' + record.number",
      lines: [
        { side: 'debit', account: 'CASH', amount: 'record.amount' },
        { side: 'credit', account: 'DONATION_INCOME', amount: 'record.amount' },
      ],
    });
    const messages = await publishIssues('recordType', { ...slip, public: { create: true, fields: ['amount', 'paidOn'] } });
    expect(messages).toContain('cannot be public');
  });

  it('stores only public fields and returns thanks when view is off', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/public/forms/asha/survey', payload: { comment: 'hello', status: 'closed', owner: 'x' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ thanks: 'Thanks for the feedback.' });
    const { items } = await w.platform.records.query(w.as(w.ngoA), 'survey', { equals: { comment: 'hello' } });
    expect(items).toHaveLength(1);
    expect(items[0]!.data).toEqual({ comment: 'hello' });
    expect(items[0]!.data).not.toHaveProperty('status');
    for (const call of [
      ['GET', '/api/public/records/not-a-real-token-value-at-all'],
      ['PATCH', '/api/public/records/not-a-real-token-value-at-all'],
      ['DELETE', '/api/public/records/not-a-real-token-value-at-all'],
    ] as const) {
      const denied = await app.inject({ method: call[0], url: call[1], payload: call[0] === 'PATCH' ? { values: {}, expectedVersion: 1 } : undefined });
      expect(denied.statusCode, call.join(' ')).toBe(404);
      expect(denied.json()).toMatchObject({ message: 'Not found.' });
    }
  });

  it('reads a view-only submission and refuses edit and delete', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/public/forms/asha/answer', payload: { comment: 'seen' } });
    expect(created.statusCode).toBe(201);
    const path = (created.json() as { path: string }).path;
    expect(path).toMatch(/^\/f\/[A-Za-z0-9_-]{20,}$/);
    const opened = await app.inject({ method: 'GET', url: `/api/public/records/${tokenOf(path)}` });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ label: 'Answer', edit: false, delete: false, display: { comment: 'seen' } });
    expect(opened.json()).not.toHaveProperty('values');
    expect(opened.json()).not.toHaveProperty('id');
    const patch = await app.inject({ method: 'PATCH', url: `/api/public/records/${tokenOf(path)}`, payload: { values: { comment: 'changed' }, expectedVersion: 1 } });
    const del = await app.inject({ method: 'DELETE', url: `/api/public/records/${tokenOf(path)}?version=1` });
    expect(patch.statusCode).toBe(404);
    expect(del.statusCode).toBe(404);
    expect(patch.json()).toMatchObject({ message: 'Not found.' });
    expect(del.json()).toMatchObject({ message: 'Not found.' });
  });

  it('searches only catalogue fields and statuses, and a request can name one of those books', async () => {
    const kept = await w.platform.records.create(w.as(w.ngoA), 'book', { title: 'Gitanjali', author: 'Tagore', secret: 'shelf 3' });
    const gone = await w.platform.records.create(w.as(w.ngoA), 'book', { title: 'Gitanjali notes', author: 'Other', secret: 'no' });
    await w.platform.records.transition(w.as(w.ngoA), gone.record.id, 'lend', { expectedVersion: gone.record.version });
    const page = await app.inject({ method: 'GET', url: '/api/public/catalogue/asha/book?q=Gitanjali' });
    expect(page.statusCode).toBe(200);
    const body = page.json() as { fields: { key: string }[]; items: { id: string; values: Record<string, string>; requestPath: string | null }[] };
    expect(body.fields.map((f) => f.key)).toEqual(['title', 'author']);
    expect(body.items.map((item) => item.id)).toEqual([kept.record.id]);
    expect(body.items[0]!.values).toEqual({ title: 'Gitanjali', author: 'Tagore' });
    expect(body.items[0]!.values).not.toHaveProperty('secret');
    expect(body.items[0]!.requestPath).toBe(`/o/asha/f/request?book=${encodeURIComponent(kept.record.id)}`);
    const bookForm = await app.inject({ method: 'POST', url: '/api/public/forms/asha/book', payload: { title: 'New' } });
    expect(bookForm.statusCode).toBe(404);

    const submitted = await app.inject({
      method: 'POST',
      url: '/api/public/forms/asha/request',
      payload: { note: 'Please hold it', book: kept.record.id, secret: 'no', status: 'closed' },
    });
    expect(submitted.statusCode).toBe(201);
    const path = (submitted.json() as { path: string }).path;
    const opened = await app.inject({ method: 'GET', url: `/api/public/records/${tokenOf(path)}` });
    expect(opened.json()).toMatchObject({ edit: true, delete: true, display: { note: 'Please hold it', book: 'Gitanjali · Tagore' }, values: { book: kept.record.id } });
    const outside = await app.inject({
      method: 'POST',
      url: '/api/public/forms/asha/request',
      payload: { note: 'That one', book: gone.record.id },
    });
    expect(outside.statusCode).toBe(422);
    expect(JSON.stringify(outside.json())).toContain('choose a record from the list');
  });

  it('edits and deletes through the link, and a final state refuses both', async () => {
    const kept = await w.platform.records.create(w.as(w.ngoA), 'book', { title: 'Pather Panchali', author: 'Bandopadhyay' });
    const submitted = await app.inject({ method: 'POST', url: '/api/public/forms/asha/request', payload: { note: 'One copy', book: kept.record.id } });
    const path = (submitted.json() as { path: string }).path;
    const opened = await app.inject({ method: 'GET', url: `/api/public/records/${tokenOf(path)}` });
    const version = (opened.json() as { version: number }).version;
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/public/records/${tokenOf(path)}`,
      payload: { values: { note: 'Two copies' }, expectedVersion: version },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ display: { note: 'Two copies' } });

    const again = await app.inject({ method: 'POST', url: '/api/public/forms/asha/request', payload: { note: 'Lock me', book: kept.record.id } });
    const lockedPath = (again.json() as { path: string }).path;
    const { items } = await w.platform.records.query(w.as(w.ngoA), 'request', { equals: { note: 'Lock me' } });
    await w.platform.records.transition(w.as(w.ngoA), items[0]!.id, 'close', { expectedVersion: items[0]!.version });
    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/public/records/${tokenOf(lockedPath)}`,
      payload: { values: { note: 'Later' }, expectedVersion: items[0]!.version + 1 },
    });
    const refusedDelete = await app.inject({ method: 'DELETE', url: `/api/public/records/${tokenOf(lockedPath)}?version=${items[0]!.version + 1}` });
    expect(refused.json().code).toBe('rule_violation');
    expect(refusedDelete.json().code).toBe('rule_violation');

    const versionNow = (changed.json() as { version: number }).version;
    const removed = await app.inject({ method: 'DELETE', url: `/api/public/records/${tokenOf(path)}?version=${versionNow}` });
    expect(removed.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: `/api/public/records/${tokenOf(path)}` });
    expect(after.statusCode).toBe(404);
    expect(after.json()).toMatchObject({ message: 'Not found.' });
  });

  it('gives staff the link and treats another organisation, a revoked link and a random token as not found', async () => {
    await publish('recordType', survey, w.ngoB);
    const other = await app.inject({ method: 'POST', url: '/api/public/forms/bodhi/survey', payload: { comment: 'elsewhere' } });
    expect(other.json()).toEqual({ thanks: 'Thanks for the feedback.' });
    const { items: theirs } = await w.platform.records.query(w.as(w.ngoB), 'survey', { equals: { comment: 'elsewhere' } });
    const foreign = await app.inject({ method: 'GET', url: `/api/records/survey/${theirs[0]!.id}/public-link`, headers: staff() });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ message: 'Not found.' });

    const submitted = await app.inject({ method: 'POST', url: '/api/public/forms/asha/answer', payload: { comment: 'revoke me' } });
    const path = (submitted.json() as { path: string }).path;
    const { items } = await w.platform.records.query(w.as(w.ngoA), 'answer', { equals: { comment: 'revoke me' } });
    const link = await app.inject({ method: 'GET', url: `/api/records/answer/${items[0]!.id}/public-link`, headers: staff() });
    expect(link.statusCode).toBe(200);
    expect(link.json()).toEqual({ path });
    const revoked = await app.inject({ method: 'DELETE', url: `/api/records/answer/${items[0]!.id}/public-link`, headers: staff() });
    expect(revoked.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/api/public/records/${tokenOf(path)}` });
    const random = await app.inject({ method: 'GET', url: '/api/public/records/abcdefghijklmnopqrstuvwxyz012345' });
    expect(gone.statusCode).toBe(404);
    expect(random.statusCode).toBe(404);
    expect(gone.json()).toEqual(random.json());
  });

  it('still refuses a signed-out caller on the staff record API', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/records/survey', payload: { data: { comment: 'no' } } });
    expect([401, 403]).toContain(res.statusCode);
  });
});
