import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { admin, completeIdentity, createWorld, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
let memberId: string;
beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await completeIdentity(w, w.ngoA);
  app = buildServer(w.platform, { devAuth: true, rateLimits: { auth: 1000 } });
  const added = await send('POST', '/api/admin/people', { email: 'contract.member@example.org', displayName: 'Contract Member', roles: [] });
  expect(added.statusCode).toBe(201);
  memberId = added.json().userId;
});
afterAll(async () => {
  await app.close();
  await w.close();
});

type Method = 'POST' | 'PUT' | 'PATCH';
const headers = () => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(admin) });
/** `:member` in the address stands for a member of the organisation. */
const send = (method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url: url.replace(':member', memberId),
    headers: headers(),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const ID = '00000000-0000-4000-8000-000000000000';

interface Contract {
  method: Method;
  url: string;
  valid: Record<string, unknown>;
  /** A required field, as a path into `valid`; absent when every field is optional. */
  required?: string[];
  mistyped: [string[], unknown];
}

const CONTRACTS: Contract[] = [
  { method: 'POST', url: '/api/auth/login', valid: { tenant: 'asha', email: 'a@example.org', password: 'pw' }, required: ['password'], mistyped: [['totpCode'], 123456] },
  { method: 'POST', url: '/api/auth/email-code/request', valid: { tenant: 'asha', email: 'a@example.org' }, required: ['email'], mistyped: [['tenant'], ['asha']] },
  {
    method: 'POST',
    url: '/api/auth/email-code/verify',
    valid: { tenant: 'asha', email: 'a@example.org', code: '123456' },
    required: ['code'],
    mistyped: [['code'], 123456],
  },
  { method: 'POST', url: '/api/auth/password-reset/request', valid: { tenant: 'asha', email: 'a@example.org' }, required: ['tenant'], mistyped: [['email'], null] },
  { method: 'POST', url: '/api/auth/password-reset/complete', valid: { token: 't', password: 'pw' }, required: ['token'], mistyped: [['password'], 42] },
  { method: 'POST', url: '/api/auth/two-step/complete', valid: { ticket: 't', totpCode: '123456' }, required: ['totpCode'], mistyped: [['ticket'], {}] },
  { method: 'POST', url: '/api/auth/two-step/begin', valid: { password: 'pw', totpCode: '123456' }, mistyped: [['password'], 7] },
  { method: 'POST', url: '/api/auth/two-step/confirm', valid: { code: '123456' }, required: ['code'], mistyped: [['code'], 123456] },
  { method: 'POST', url: '/api/admin/api-keys', valid: { name: 'Contract', role: 'finance' }, required: ['name'], mistyped: [['name'], 7] },
  { method: 'POST', url: '/api/admin/roles', valid: { key: 'contract', label: 'Contract' }, required: ['label'], mistyped: [['permissions'], 'record:donor:read'] },
  { method: 'PUT', url: '/api/admin/roles/finance', valid: { label: 'Finance' }, mistyped: [['requireTwoStep'], 'yes'] },
  { method: 'POST', url: '/api/admin/roles/finance/members', valid: { userIds: [ID] }, required: ['userIds'], mistyped: [['userIds', '0'], 5] },
  {
    method: 'POST',
    url: '/api/admin/people',
    valid: { email: 'x@example.org', displayName: 'X', roles: [], invite: false },
    required: ['email'],
    mistyped: [['invite'], 'yes'],
  },
  { method: 'PUT', url: '/api/admin/people/:member/roles', valid: { roles: [] }, required: ['roles'], mistyped: [['roles'], 'finance'] },
  { method: 'PUT', url: '/api/admin/settings', valid: { name: 'Asha Trust' }, mistyped: [['financialYearStartMonth'], 4.5] },
  {
    method: 'POST',
    url: '/api/approvals/query',
    valid: { search: 'x', sort: { field: 'waiting', dir: 'asc' }, limit: 10 },
    required: ['sort', 'field'],
    mistyped: [['limit'], '10'],
  },
  { method: 'POST', url: `/api/approvals/${ID}/decision`, valid: { decision: 'approve' }, required: ['decision'], mistyped: [['decision'], 'maybe'] },
  { method: 'POST', url: '/api/money/accounts', valid: { key: 'petty', name: 'Petty cash', kind: 'cash' }, required: ['kind'], mistyped: [['kind'], 'vault'] },
  {
    method: 'POST',
    url: '/api/money/transfers',
    valid: { from: 'a', to: 'b', amount: '10.00', date: '2026-04-01' },
    required: ['date'],
    mistyped: [['amount'], true],
  },
  {
    method: 'POST',
    url: '/api/payments',
    valid: { recordId: ID, action: 'payNow', input: {} },
    required: ['action'],
    mistyped: [['input'], 'x'],
  },
  { method: 'POST', url: `/api/payments/${ID}/confirm`, valid: { paidOn: '2026-04-01' }, required: ['paidOn'], mistyped: [['bankReference'], 99] },
  {
    method: 'POST',
    url: '/api/payments/statement-match',
    valid: { lines: [{ date: '2026-04-01', amount: 100, description: 'UPI' }] },
    required: ['lines', '0', 'description'],
    mistyped: [['lines'], {}],
  },
];

/** Fixed envelopes around configured data: the envelope is checked here, what is inside by the published definitions. */
const ENVELOPES: Contract[] = [
  {
    method: 'PATCH',
    url: `/api/records/donation/${ID}`,
    valid: { data: { donorName: 'X' }, expectedVersion: 1 },
    required: ['expectedVersion'],
    mistyped: [['data'], []],
  },
  {
    method: 'POST',
    url: `/api/records/donation/${ID}/transitions/markPaid`,
    valid: { data: { method: 'cash' }, expectedVersion: 1 },
    required: ['expectedVersion'],
    mistyped: [['expectedVersion'], '1'],
  },
  { method: 'POST', url: `/api/records/donation/${ID}/actions/printReceipt`, valid: { input: {}, expectedVersion: 1 }, mistyped: [['expectedVersion'], 1.5] },
  {
    method: 'POST',
    url: '/api/records/donation/query',
    valid: { statusIn: ['raised'], filters: { amount: { from: 10, to: null } }, sort: { field: 'amount', dir: 'asc' }, sum: ['amount'], limit: 10 },
    required: ['sort', 'field'],
    mistyped: [['filters', 'amount', 'from'], true],
  },
  {
    method: 'POST',
    url: '/api/records/donation/aggregate',
    valid: { measure: 'sum', field: 'amount', groupBy: { period: 'month', dateField: 'createdAt' } },
    required: ['measure'],
    mistyped: [['groupBy', 'period'], 'year'],
  },
  {
    method: 'POST',
    url: '/api/records/donation/bulk',
    valid: { ids: [ID], operation: { type: 'step', step: 'markPaid', data: {} } },
    required: ['operation', 'step'],
    mistyped: [['operation', 'data'], 'cash'],
  },
  { method: 'PUT', url: '/api/builder/definitions/recordType/donation/patch', valid: { patch: { label: 'Gift' } }, required: ['patch'], mistyped: [['patch'], 'x'] },
  { method: 'POST', url: '/api/builder/definitions/recordType/donation/rollback', valid: { version: 1 }, required: ['version'], mistyped: [['version'], '1'] },
];

/** A copy of `body` with the value at `path` replaced, or removed when `value` is undefined. */
function at(body: Record<string, unknown>, path: string[], value?: unknown): Record<string, unknown> {
  const copy = structuredClone(body);
  let node = copy as Record<string, unknown>;
  for (const k of path.slice(0, -1)) node = node[k] as Record<string, unknown>;
  if (value === undefined) delete node[path.at(-1)!];
  else node[path.at(-1)!] = value;
  return copy;
}

const pointer = (path: string[]) => `/${path.join('/')}`;

async function expectBadRequest(c: Contract, payload: unknown, path: string, message: string) {
  const res = await send(c.method, c.url, payload);
  expect(res.statusCode, `${c.method} ${c.url} ${JSON.stringify(payload)}`).toBe(400);
  const body = res.json();
  expect(body).toMatchObject({ code: 'bad_request', message: 'The request is not valid.' });
  expect(body.issues).toContainEqual({ path, message: expect.stringMatching(message) });
}

function describeContract(c: Contract) {
  describe(`${c.method} ${c.url}`, () => {
    if (c.required) {
      it('answers 400 when a required field is missing', async () => {
        await expectBadRequest(c, at(c.valid, c.required!), pointer(c.required!), '^is required$');
      });
    }
    it('answers 400 when a field has the wrong type', async () => {
      const [path, value] = c.mistyped;
      await expectBadRequest(c, at(c.valid, path, value), pointer(path), '^must be');
    });
    it('answers 400 for a field that is not part of the request', async () => {
      await expectBadRequest(c, { ...c.valid, extra: 1 }, '/extra', '^is not allowed$');
    });
  });
}

describe('fixed-route request contracts', () => {
  for (const c of CONTRACTS) describeContract(c);

  it('answers 400 when the body is missing or not an object', async () => {
    for (const payload of [undefined, [], '"text"']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/api-keys',
        headers: { ...headers(), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined ? {} : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
      });
      expect(res.statusCode, String(payload)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad_request', issues: [{ path: '/', message: 'must be object' }] });
    }
  });

  it('answers 400 for a payment request that names its own amount, provider or paid step', async () => {
    for (const extra of [{ amount: 1 }, { provider: 'upi_direct' }, { onPaid: { transition: 'markPaid' } }, { upiAccountKey: 'main' }]) {
      const res = await send('POST', '/api/payments', { recordId: ID, action: 'payNow', ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.json().issues).toContainEqual({ path: `/${Object.keys(extra)[0]}`, message: 'is not allowed' });
    }
  });

  it('refuses null for an optional field instead of reading it as absent', async () => {
    const res = await send('PUT', '/api/admin/settings', { name: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toEqual([{ path: '/name', message: 'must be string' }]);
  });

  it('reports every wrong part at once', async () => {
    const res = await send('POST', '/api/admin/roles', { label: 3, colour: 'red' });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toEqual(
      expect.arrayContaining([
        { path: '/key', message: 'is required' },
        { path: '/label', message: 'must be string' },
        { path: '/colour', message: 'is not allowed' },
      ]),
    );
  });

  it('still answers malformed JSON with the plain bad_request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/api-keys',
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 'bad_request', message: 'The request is not valid.' });
  });
});

describe('valid input the platform refuses stays 422', () => {
  const refused: [string, 'POST' | 'PUT', string, Record<string, unknown>, string | null][] = [
    ['an API key name with symbols', 'POST', '/api/admin/api-keys', { name: 'bad/name', role: 'finance' }, '/name'],
    ['a role key with spaces', 'POST', '/api/admin/roles', { key: 'Bad Key', label: 'Bad' }, 'key'],
    ['an unknown permission', 'PUT', '/api/admin/roles/finance', { permissions: ['not a permission'] }, 'permissions'],
    ['a user id that is not a member', 'POST', '/api/admin/roles/finance/members', { userIds: [ID] }, 'userIds'],
    ['an invalid email', 'POST', '/api/admin/people', { email: 'not-an-email', displayName: 'X' }, 'email'],
    ['an unknown role', 'PUT', '/api/admin/people/:member/roles', { roles: ['ghost'] }, 'roles'],
    ['a thirteenth month', 'PUT', '/api/admin/settings', { financialYearStartMonth: 13 }, 'financialYearStartMonth'],
    ['an unknown sort field', 'POST', '/api/approvals/query', { sort: { field: 'colour' } }, null],
    ['an account key with capitals', 'POST', '/api/money/accounts', { key: 'Petty', name: 'Petty cash', kind: 'cash' }, null],
    ['an amount that is not a number', 'POST', '/api/money/transfers', { from: 'a', to: 'b', amount: 'ten', date: '2026-04-01' }, null],
  ];
  for (const [what, method, url, payload, path] of refused) {
    it(`refuses ${what}`, async () => {
      const res = await send(method, url, payload);
      expect(res.statusCode, res.body).toBe(422);
      const body = res.json();
      expect(body.code).toBe('validation_failed');
      if (path) expect(body.issues).toContainEqual(expect.objectContaining({ path }));
    });
  }
});

describe('envelopes around configured data', () => {
  for (const c of ENVELOPES) describeContract(c);

  it('answers 400 when a new record or a draft is not an object, or a draft has no key', async () => {
    const created = await send('POST', '/api/records/donation', []);
    expect(created.statusCode).toBe(400);
    expect(created.json().issues).toEqual([{ path: '/', message: 'must be object' }]);
    const keyless = await send('PUT', '/api/builder/definitions/recordType/memo/draft', { label: 'Memo' });
    expect(keyless.statusCode).toBe(400);
    expect(keyless.json().issues).toEqual([{ path: '/key', message: 'is required' }]);
    const mistyped = await send('PUT', '/api/builder/definitions/recordType/memo/draft', { key: 7 });
    expect(mistyped.statusCode).toBe(400);
    expect(mistyped.json().issues).toEqual([{ path: '/key', message: 'must be string' }]);
  });

  it('answers 400 for a bulk request with neither or both of ids and query', async () => {
    const neither = await send('POST', '/api/records/donation/bulk', { operation: { type: 'export' } });
    expect(neither.statusCode).toBe(400);
    expect(neither.json().issues).toEqual(
      expect.arrayContaining([
        { path: '/ids', message: 'is required' },
        { path: '/query', message: 'is required' },
      ]),
    );
    const both = await send('POST', '/api/records/donation/bulk', { ids: [ID], query: {}, operation: { type: 'export' } });
    expect(both.statusCode).toBe(400);
  });

  it('answers 400 for a filter condition that is not part of the query', async () => {
    const res = await send('POST', '/api/records/donation/query', { filters: { amount: { above: 10 } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toEqual([{ path: '/filters/amount/above', message: 'is not allowed' }]);
  });

  it('leaves the contents to the published definitions, which answer 422', async () => {
    const created = await send('POST', '/api/records/donation', { donorName: 'Inside', amount: 100 });
    const id = created.json().record.id;
    const refused: [string, Method, string, Record<string, unknown>, string][] = [
      ['an unknown record field', 'POST', '/api/records/donation', { donorName: 'X', amount: 100, colour: 'red' }, '/colour'],
      ['a wrong value inside data', 'PATCH', `/api/records/donation/${id}`, { data: { donorName: 42 }, expectedVersion: 1 }, '/donorName'],
      ['an empty bulk selection', 'POST', '/api/records/donation/bulk', { ids: [], operation: { type: 'edit', values: { donorName: 'Y' } } }, '/ids'],
      ['a draft whose key differs from the address', 'PUT', '/api/builder/definitions/recordType/memo/draft', { key: 'other' }, ''],
    ];
    for (const [what, method, url, payload, path] of refused) {
      const res = await send(method, url, payload);
      expect(res.statusCode, `${what}: ${res.body}`).toBe(422);
      if (path) expect(res.json().issues, what).toContainEqual(expect.objectContaining({ path }));
    }
  });

  it('accepts a record field published after start-up', async () => {
    const before = await send('POST', '/api/records/donation', { donorName: 'Later', amount: 100, campaignNote: 'Diwali' });
    expect(before.statusCode).toBe(422);
    expect(before.json().issues).toContainEqual(expect.objectContaining({ path: '/campaignNote' }));

    const patched = await send('PUT', '/api/builder/definitions/recordType/donation/patch', {
      patch: { fields: [{ key: 'campaignNote', label: 'Campaign note', type: 'text' }] },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const created = await send('POST', '/api/records/donation', { donorName: 'Later', amount: 100, campaignNote: 'Diwali' });
    expect(created.statusCode, created.body).toBe(201);
    const { id, version } = created.json().record;
    const updated = await send('PATCH', `/api/records/donation/${id}`, { data: { campaignNote: 'Holi' }, expectedVersion: version });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().record.data.campaignNote).toBe('Holi');
    const found = await send('POST', '/api/records/donation/query', { filters: { campaignNote: { in: ['Holi'] } } });
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json().items.map((r: { id: string }) => r.id)).toEqual([id]);
  });
});

describe('ActionResult.open', () => {
  it('is a string in the OpenAPI document and in the answer', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/api/openapi.json', headers: headers() })).json();
    const action = doc.paths['/api/records/donation/{id}/actions/printReceipt'].post;
    expect(action.responses['200'].content['application/json'].schema.properties.open).toMatchObject({ type: 'string' });
    expect(doc.components.schemas.Error.properties.issues.items.required).toEqual(['path', 'message']);
    expect(Object.keys(action.responses)).toContain('400');

    const created = await send('POST', '/api/records/donation', { donorName: 'Open', amount: 100 });
    const id = created.json().record.id;
    const paid = await send('POST', `/api/records/donation/${id}/transitions/markPaid`, { expectedVersion: 1, data: { method: 'cash', paidOn: today() } });
    expect(paid.statusCode, paid.body).toBe(200);
    const ran = await send('POST', `/api/records/donation/${id}/actions/printReceipt`, {});
    expect(ran.statusCode, ran.body).toBe(200);
    expect(typeof ran.json().open).toBe('string');
    expect(ran.json().open).toMatch(/^\/print\/receipt\//);
  });
});
