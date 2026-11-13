import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { DataFeedDef } from '../src/runtime/definitions/types.js';
import { admin, createWorld, expectCode, type TestWorld } from './helpers.js';

const PUBLIC = 'https://public.example';
const STAFF_SITE = 'https://staff.example';
const BODHI_SITE = 'https://bodhi.example';
const INVALID = { code: 'forbidden', message: 'This API key is not valid.', issues: [] };

const gifts: DataFeedDef = {
  key: 'gifts',
  label: 'Gifts',
  source: 'records',
  recordType: 'donation',
  fields: ['donorName', 'amount'],
  statusIn: ['raised'],
  search: ['donorName'],
  sort: { field: 'amount', direction: 'desc' },
  allowFilters: ['donorName'],
};

const hours: DataFeedDef = {
  key: 'hours',
  label: 'Hours',
  source: 'content',
  entries: [{ key: 'open', label: 'Open', text: 'Nine to five' }],
};

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
let giftsToken = '';
let hoursToken = '';
let revokedToken = '';
let staffToken = '';
let bodhiToken = '';

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, {
    devAuth: true,
    corsOrigins: [STAFF_SITE],
    rateLimits: { api: 1000 },
    organisationLookupLimit: 1000,
  });
  await publish(w.ngoA, gifts);
  await publish(w.ngoA, hours);
  await publish(w.ngoB, { ...hours, key: 'note', label: 'Note' });
  const asha = w.as(w.ngoA);
  const [giftsKey, hoursKey, doomed, staff, bodhi] = await Promise.all([
    w.platform.apiKeys.create(asha, { name: 'Gifts site', feed: 'gifts' }),
    w.platform.apiKeys.create(asha, { name: 'Hours site', feed: 'hours' }),
    w.platform.apiKeys.create(asha, { name: 'Old gifts', feed: 'gifts' }),
    w.platform.apiKeys.create(asha, { name: 'Finance sync', role: 'finance' }),
    w.platform.apiKeys.create(w.as(w.ngoB), { name: 'Bodhi note', feed: 'note' }),
  ]);
  giftsToken = giftsKey.token;
  hoursToken = hoursKey.token;
  revokedToken = doomed.token;
  staffToken = staff.token;
  bodhiToken = bodhi.token;
  await w.platform.apiKeys.revoke(asha, doomed.id);
  await w.platform.administration.saveSettings(asha, { corsOrigins: [PUBLIC] });
  await w.platform.administration.saveSettings(w.as(w.ngoB), { corsOrigins: [BODHI_SITE] });
  const ashaAdmin = w.as(w.ngoA);
  const big = await w.platform.records.create(ashaAdmin, 'donation', { donorName: 'Asha', donorPan: 'ABCDE1234F', amount: 200 });
  await w.platform.records.create(ashaAdmin, 'donation', { donorName: 'Ravi', amount: 50 });
  const gone = await w.platform.records.create(ashaAdmin, 'donation', { donorName: 'Gone', amount: 10 });
  await w.platform.records.transition(ashaAdmin, gone.record.id, 'cancel', { expectedVersion: gone.record.version });
  expect(big.record.id).toBeTruthy();
});

afterAll(async () => {
  await app.close();
  await w.close();
});

async function publish(tenant: string, body: DataFeedDef): Promise<void> {
  const ctx = w.as(tenant);
  await w.platform.definitions.saveDraft(ctx, 'dataFeed', body);
  await w.platform.definitions.publish(ctx, 'dataFeed', body.key);
}

function call(method: 'GET' | 'OPTIONS', url: string, token?: string, origin?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `ApiKey ${token}`;
  if (origin) headers.origin = origin;
  return app.inject({ method, url, headers });
}

describe('keyed data feed', () => {
  it('refuses to publish a feed that names a sensitive field, or an origin of * or with a path', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'dataFeed', { ...gifts, key: 'leaky', fields: ['donorPan', 'amount'] });
    const err = await expectCode(w.platform.definitions.publish(ctx, 'dataFeed', 'leaky'), 'definition_invalid');
    expect((err as { issues?: { message: string }[] }).issues?.map((issue) => issue.message).join(' ')).toContain('donorPan');
    await w.platform.definitions.discardDraft(ctx, 'dataFeed', 'leaky');
    await expectCode(w.platform.administration.saveSettings(ctx, { corsOrigins: ['*'] }), 'validation_failed');
    await expectCode(w.platform.administration.saveSettings(ctx, { corsOrigins: ['https://public.example/gifts'] }), 'validation_failed');
  });

  it('returns the published fields, typed, and only the feed statuses', async () => {
    const res = await call('GET', '/api/data/asha/gifts', giftsToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const body = res.json();
    expect(body).toMatchObject({
      key: 'gifts',
      label: 'Gifts',
      source: 'records',
      fields: [
        { key: 'donorName', type: 'text' },
        { key: 'amount', type: 'money' },
      ],
      total: 2,
    });
    expect(body.items.map((item: { values: { donorName: string; amount: number } }) => item.values)).toEqual([
      { donorName: 'Asha', amount: 200 },
      { donorName: 'Ravi', amount: 50 },
    ]);
    expect(JSON.stringify(body)).not.toContain('donorPan');
    expect(JSON.stringify(body)).not.toContain('ABCDE1234F');
    expect(body.items[0].values.amount).toBe(200);
  });

  it('searches and filters only the fields the feed allows, and will not widen the statuses', async () => {
    const found = await call('GET', '/api/data/asha/gifts?q=asha', giftsToken);
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json().items.map((item: { values: { donorName: string } }) => item.values.donorName)).toEqual(['Asha']);

    const filtered = await call('GET', '/api/data/asha/gifts?filter.donorName=Ravi', giftsToken);
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().items[0].values).toEqual({ donorName: 'Ravi', amount: 50 });

    for (const query of ['filter.amount=200', 'filter.donorPan=ABCDE1234F', 'statusIn=cancelled', 'fields=donorPan']) {
      const res = await call('GET', `/api/data/asha/gifts?${query}`, giftsToken);
      expect(res.statusCode, query).toBe(422);
    }
  });

  it('returns written text for a content feed and ignores no record query', async () => {
    const res = await call('GET', '/api/data/asha/hours', hoursToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      key: 'hours',
      label: 'Hours',
      source: 'content',
      entries: [{ key: 'open', label: 'Open', text: 'Nine to five' }],
    });
    expect((await call('GET', '/api/data/asha/hours?q=nine', hoursToken)).statusCode).toBe(422);
  });

  it('refuses a staff key, a key for another feed, a revoked key and a missing key with the same answer', async () => {
    for (const token of [staffToken, hoursToken, revokedToken, undefined]) {
      const res = await call('GET', '/api/data/asha/gifts', token);
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json()).toEqual(INVALID);
    }
    const staffRoute = await app.inject({ method: 'GET', url: '/api/admin/api-keys', headers: { authorization: `ApiKey ${giftsToken}` } });
    expect(staffRoute.statusCode).toBe(403);
    expect(staffRoute.json().message).toBe(INVALID.message);
  });

  it('answers an unknown organisation or feed with 404', async () => {
    expect((await call('GET', '/api/data/missing/gifts', giftsToken)).statusCode).toBe(404);
    expect((await call('GET', '/api/data/asha/missing', giftsToken)).statusCode).toBe(404);
  });

  it('lets a listed origin preflight and read, and refuses every other origin', async () => {
    const preflight = await call('OPTIONS', '/api/data/asha/gifts', undefined, PUBLIC);
    expect(preflight.statusCode, preflight.body).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(PUBLIC);
    expect(preflight.headers['access-control-allow-methods']).toBe('GET');
    expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toBe('authorization');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    expect(String(preflight.headers.vary).toLowerCase()).toContain('origin');

    const read = await call('GET', '/api/data/asha/gifts', giftsToken, PUBLIC);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers['access-control-allow-origin']).toBe(PUBLIC);
    expect(read.json().total).toBe(2);

    for (const origin of ['https://evil.example', STAFF_SITE, BODHI_SITE]) {
      const res = await call('GET', '/api/data/asha/gifts', giftsToken, origin);
      expect(res.statusCode, origin).toBe(403);
      expect(res.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
    const otherOrg = await call('OPTIONS', '/api/data/asha/gifts', undefined, 'https://evil.example');
    expect(otherOrg.statusCode).toBe(403);
    expect(otherOrg.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a key from another organisation even when the origin is listed, and still tells that origin', async () => {
    const res = await call('GET', '/api/data/asha/gifts', bodhiToken, PUBLIC);
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json()).toEqual(INVALID);
    expect(res.headers['access-control-allow-origin']).toBe(PUBLIC);
  });
});
