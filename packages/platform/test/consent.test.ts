import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { admin, clerk, createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
let donorId: string;
let memberId: string;
const officer: Actor = { id: 'officer-1', roles: ['privacy'], permissions: ['privacy:consent:read', 'privacy:consent:record'] };
const reader: Actor = { id: 'reader-1', roles: ['privacy'], permissions: ['privacy:consent:read'] };

const headers = (actor: Actor, tenantId = w.ngoA) => ({ 'x-dev-tenant': tenantId, 'x-dev-actor': JSON.stringify(actor) });
const post = (url: string, payload: unknown, actor: Actor = officer, tenantId?: string) =>
  app.inject({ method: 'POST', url, headers: headers(actor, tenantId), payload: payload as object });
const read = (kind: string, id: string, actor: Actor = officer, tenantId?: string) =>
  app.inject({ method: 'GET', url: `/api/privacy/consents?subjectKind=${kind}&subjectId=${id}`, headers: headers(actor, tenantId) });

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  donorId = (await w.platform.records.create(w.as(w.ngoA), 'donor', { name: 'Consent Donor', email: 'consent.donor@example.org' })).record.id;
  memberId = (await w.platform.people.add(w.as(w.ngoA), { email: 'consent.member@example.org', displayName: 'Consent Member', roles: [] })).userId;
});
afterAll(async () => {
  await app.close();
  await w.close();
});

describe('consent records', () => {
  it('keeps an append-only history per subject and purpose, and answers the current consent', async () => {
    const valid = { subjectKind: 'record', subjectId: donorId, purpose: 'newsletter', state: 'granted', source: 'form' };
    const first = await post('/api/privacy/consents', valid);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ purpose: 'newsletter', state: 'granted', source: 'form', recordedBy: officer.id });
    expect((await post('/api/privacy/consents', { ...valid, state: 'withdrawn', source: 'email' })).statusCode).toBe(201);
    expect((await post('/api/privacy/consents', { ...valid, purpose: 'donation.receipts', source: 'paper' })).statusCode).toBe(201);

    const res = await read('record', donorId, reader);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ subjectKind: 'record', subjectId: donorId, erased: false });
    expect(body.current.map((c: { purpose: string; state: string }) => [c.purpose, c.state])).toEqual([
      ['donation.receipts', 'granted'],
      ['newsletter', 'withdrawn'],
    ]);
    expect(body.history.map((c: { state: string }) => c.state)).toEqual(['granted', 'withdrawn', 'granted']);
  });

  it('records consent for members, within their organisation only', async () => {
    expect((await post('/api/privacy/consents', { subjectKind: 'member', subjectId: memberId, purpose: 'photos', state: 'granted', source: 'in_person' })).statusCode).toBe(201);
    expect((await read('member', memberId)).json().current).toHaveLength(1);
    expect((await read('member', memberId, officer, w.ngoB)).json()).toMatchObject({ current: [], history: [] });
    const elsewhere = await post('/api/privacy/consents', { subjectKind: 'record', subjectId: donorId, purpose: 'newsletter', state: 'granted', source: 'form' }, officer, w.ngoB);
    expect(elsewhere.statusCode).toBe(422);
  });

  it('needs privacy:consent:record to record and privacy:consent:read to read', async () => {
    expect((await post('/api/privacy/consents', { subjectKind: 'record', subjectId: donorId, purpose: 'newsletter', state: 'granted', source: 'form' }, reader)).statusCode).toBe(403);
    expect((await read('record', donorId, clerk)).statusCode).toBe(403);
  });

  it('answers 400 for a malformed body and 422 for a refused one', async () => {
    const valid = { subjectKind: 'record', subjectId: donorId, purpose: 'newsletter', state: 'granted', source: 'form' };
    const { purpose: _p, ...missing } = valid;
    for (const bad of [missing, { ...valid, state: 'maybe' }, { ...valid, purpose: 7 }, { ...valid, note: 'x' }, { ...valid, source: 'erasure' }, { ...valid, subjectKind: 'donor' }]) {
      const res = await post('/api/privacy/consents', bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    for (const refused of [
      { ...valid, purpose: 'News Letter' },
      { ...valid, subjectId: '00000000-0000-4000-8000-000000000000' },
      { ...valid, subjectId: 'not-an-id' },
    ]) {
      const res = await post('/api/privacy/consents', refused);
      expect(res.statusCode, JSON.stringify(refused)).toBe(422);
      expect(res.json()).toHaveProperty('issues');
    }
    expect((await read('donor', donorId)).statusCode).toBe(422);
  });
});

describe('erasure route', () => {
  it('answers 400 for a malformed body, 403 without privacy:erase, 422 when refused, then 201 and 200', async () => {
    for (const bad of [{ subjectKind: 'member' }, { subjectKind: 'member', subjectId: memberId, reason: 'because' }, { subjectKind: 'member', subjectId: memberId, extra: 1 }, { subjectKind: 'member', subjectId: memberId, reason: null }]) {
      expect((await post('/api/privacy/erasures', bad, admin)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await post('/api/privacy/erasures', { subjectKind: 'member', subjectId: memberId }, officer)).statusCode).toBe(403);
    const active = await post('/api/privacy/erasures', { subjectKind: 'member', subjectId: memberId }, admin);
    expect(active.statusCode).toBe(422);
    expect(active.json().message).toMatch(/Suspend/);

    const first = await post('/api/privacy/erasures', { subjectKind: 'record', subjectId: donorId }, admin);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ alreadyErased: false, summary: { consentsWithdrawn: ['donation.receipts'] } });
    const again = await post('/api/privacy/erasures', { subjectKind: 'record', subjectId: donorId }, admin);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, alreadyErased: true });
    expect((await read('record', donorId)).json()).toMatchObject({ erased: true });
  });
});
