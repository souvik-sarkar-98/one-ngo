import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { SCHEMA_DIR } from '../src/platform.js';
import { admin, clerk, completeIdentity, createWorld, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
const webRoot = mkdtempSync(join(tmpdir(), 'ngo-web-'));

beforeAll(async () => {
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>NGO</title><app-root></app-root>');
  writeFileSync(join(webRoot, 'main.js'), 'console.log(1)');
  writeFileSync(join(webRoot, 'main-L35VTJRS.js'), 'console.log(1)');
  writeFileSync(join(webRoot, 'ngsw-worker.js'), '');
  writeFileSync(join(webRoot, 'ngsw.json'), '{}');
  writeFileSync(join(webRoot, 'manifest.webmanifest'), '{}');
  mkdirSync(join(webRoot, 'media'));
  writeFileSync(join(webRoot, 'media', 'material-icons-LEZCGFVT.woff2'), '');
  mkdirSync(join(webRoot, 'icons'));
  writeFileSync(join(webRoot, 'icons', 'icon-192.png'), '');
  w = await createWorld();
  await completeIdentity(w, w.ngoA);
  app = buildServer(w.platform, { devAuth: true, webRoot, schemaDir: SCHEMA_DIR });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

const as = (actor = admin) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });

describe('app session endpoints', () => {
  it('returns the profile and capabilities', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/people/me', headers: as(clerk) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tenant: { key: 'asha', name: 'Asha Trust' },
      capabilities: { configure: false, publish: false, scripts: false },
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('names the roles the person holds, beside their keys', async () => {
    await w.platform.identity.upsertRole(w.as(w.ngoA), { key: 'treasury', label: 'Treasury', permissions: ['record:donation:read'] });
    const res = await app.inject({ method: 'GET', url: '/api/people/me', headers: as({ id: 't', roles: ['treasury'], permissions: ['record:donation:read'] }) });
    expect(res.json()).toMatchObject({ roles: ['treasury'], roleNames: ['Treasury'] });
  });

  it('returns only the record types the person may read, with allowed steps', async () => {
    const viewer = { id: 'v', roles: [], permissions: ['record:donation:read'] };
    const res = await app.inject({ method: 'GET', url: '/api/runtime/definitions', headers: as(viewer) });
    const body = res.json() as {
      recordTypes: { key: string; canCreate: boolean }[];
      workflows: Record<string, { transitions: { key: string; allowed: boolean }[] }>;
    };
    expect(body.recordTypes.map((t) => t.key)).toEqual(['donation']);
    expect(body.recordTypes[0]!.canCreate).toBe(false);
    expect(body.workflows.donation!.transitions.every((t) => !t.allowed)).toBe(true);

    const none = await app.inject({ method: 'GET', url: '/api/runtime/definitions', headers: as({ id: 'n', roles: [], permissions: [] }) });
    expect(none.json().recordTypes).toEqual([]);
  });

  it('returns receipts and pending approval for a record', async () => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Page', amount: 99 });
    await w.platform.records.transition(ctx, record.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn: today() } });
    const receipts = await app.inject({ method: 'GET', url: `/api/records/donation/${record.id}/receipts`, headers: as() });
    expect(receipts.json()).toHaveLength(1);
    const approval = await app.inject({ method: 'GET', url: `/api/records/donation/${record.id}/approval`, headers: as() });
    expect(approval.json()).toEqual({ pending: null });
  });
});

describe('builder endpoints', () => {
  const volunteer = {
    key: 'volunteer',
    label: 'Volunteer',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
  };

  it('drafts, publishes, lists, and rolls back a new record type', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/builder/definitions/recordType/volunteer/draft', headers: as(), payload: volunteer });
    expect(put.json()).toEqual({ version: 1 });
    const pub = await app.inject({ method: 'POST', url: '/api/builder/definitions/recordType/volunteer/publish', headers: as() });
    expect(pub.statusCode).toBe(200);

    await app.inject({
      method: 'PUT',
      url: '/api/builder/definitions/recordType/volunteer/draft',
      headers: as(),
      payload: { ...volunteer, fields: [...volunteer.fields, { key: 'phone', label: 'Phone', type: 'phone' }] },
    });
    const detail = await app.inject({ method: 'GET', url: '/api/builder/definitions/recordType/volunteer', headers: as() });
    expect(detail.json()).toMatchObject({ published: { version: 1 }, draft: { version: 2 } });

    const catalogue = await app.inject({ method: 'GET', url: '/api/builder/catalogue', headers: as() });
    expect(catalogue.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'recordType', key: 'volunteer', publishedVersion: 1, draftVersion: 2, owner: 'tenant', label: 'Volunteer' }),
        expect.objectContaining({ kind: 'recordType', key: 'donation', owner: 'base', moduleKey: 'donations' }),
      ]),
    );

    const discard = await app.inject({ method: 'POST', url: '/api/builder/definitions/recordType/volunteer/discard', headers: as() });
    expect(discard.statusCode).toBe(204);
    const rollback = await app.inject({
      method: 'POST',
      url: '/api/builder/definitions/recordType/volunteer/rollback',
      headers: as(),
      payload: { version: 1 },
    });
    expect(rollback.json()).toMatchObject({ version: 3 });
  });

  it('shows base and patch for shipped definitions, and applies a patch', async () => {
    const detail = await app.inject({ method: 'GET', url: '/api/builder/definitions/recordType/donation', headers: as() });
    expect(detail.json().shipped).toMatchObject({ baseVersion: 1, patch: null });
    const patched = await app.inject({
      method: 'PUT',
      url: '/api/builder/definitions/recordType/donation/patch',
      headers: as(),
      payload: { patch: { fields: [{ key: 'donorName', label: 'Supporter' }] } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().body.fields.find((f: { key: string }) => f.key === 'donorName').label).toBe('Supporter');
  });

  it('reports definition errors with field paths and blocks people without permission', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/builder/definitions/recordType/broken/draft',
      headers: as(),
      payload: { key: 'broken', label: 'Broken', fields: [{ key: 'x', label: 'X', type: 'colour' }] },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().issues[0].path).toBe('/fields/0/type');

    const mismatch = await app.inject({ method: 'PUT', url: '/api/builder/definitions/recordType/other/draft', headers: as(), payload: volunteer });
    expect(mismatch.statusCode).toBe(422);

    expect((await app.inject({ method: 'GET', url: '/api/builder/catalogue', headers: as(clerk) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/builder/definitions/nonsense/x', headers: as() })).statusCode).toBe(404);
  });

  it('serves definition schemas to the builder', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/builder/schemas/workflow', headers: as() });
    expect(res.json().$id).toBe('workflow');
  });
});

describe('web app hosting', () => {
  it('serves the app with security headers and falls back to index.html for app routes', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-security-policy']).toContain("script-src 'self'");
    expect(index.headers['x-frame-options']).toBe('DENY');

    const deep = await app.inject({ method: 'GET', url: '/records/donation/123' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<app-root>');

    expect((await app.inject({ method: 'GET', url: '/main.js' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/missing.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/nothing' })).statusCode).toBe(404);
  });

  it('makes the app shell files revalidate and caches hashed build output for a year', async () => {
    const cache = async (url: string) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      return res.headers['cache-control'];
    };
    for (const url of ['/', '/index.html', '/ngsw-worker.js', '/ngsw.json?ngsw-cache-bust=0.5', '/manifest.webmanifest', '/records/donation']) {
      expect(await cache(url), url).toBe('no-cache');
    }
    expect(await cache('/main-L35VTJRS.js')).toBe('public, max-age=31536000, immutable');
    expect(await cache('/media/material-icons-LEZCGFVT.woff2')).toBe('public, max-age=31536000, immutable');
    expect(await cache('/icons/icon-192.png')).toBe('public, max-age=3600');
    expect((await app.inject({ method: 'GET', url: '/manifest.webmanifest' })).headers['content-type']).toContain('application/manifest+json');
  });
});
