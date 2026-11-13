import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrganisationView } from '../src/application/organisations/organisation-service.js';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { admin, clerk, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

let w: TestWorld;
let app: FastifyInstance;

const member: Actor = { id: 'member-1', roles: [], permissions: [] };

function png(seed = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4), Buffer.alloc(8, seed)]);
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: Method, url: string, payload?: unknown, actor: Actor = admin, tenant = w.ngoA) =>
  app.inject({
    method,
    url,
    headers: { 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor), ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const anonymous = (url: string, server = app) => server.inject({ method: 'GET', url });

const PROFILE = {
  contact: { email: 'Office@Asha.org', phone: '+91 22 4000 0000', website: 'https://asha.org' },
  address: { line1: '4 Marine Drive', city: 'Mumbai', state: 'Maharashtra', postalCode: '400002', country: 'IN' },
  timezone: 'Asia/Kolkata',
};

beforeAll(async () => {
  w = await createWorld();
  app = buildServer(w.platform, { devAuth: true, organisationLookupLimit: 10_000, rateLimits: { api: 100_000, auth: 100_000 } });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

describe('organisation identity in settings', () => {
  it('keeps the legal name apart from the display name, with the code read-only', async () => {
    expect((await call('PUT', '/api/admin/settings', { legalName: '   ' })).statusCode).toBe(422);
    const res = await call('PUT', '/api/admin/settings', { legalName: 'Asha  Charitable   Trust' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ code: 'asha', name: 'Asha Trust', legalName: 'Asha Charitable Trust' });
    expect((await call('PUT', '/api/admin/settings', { code: 'other' })).statusCode).toBe(400);
    const audit = (await call('GET', '/api/admin/audit?area=organisation')).json() as { items: { action: string; before: unknown; after: unknown }[] };
    expect(audit.items[0]).toMatchObject({ action: 'settings.changed', before: { legalName: null }, after: { legalName: 'Asha Charitable Trust' } });
  });

  it('saves contact details, a structured address and the time zone, validated by field', async () => {
    const bad = await call('PUT', '/api/admin/organisation/profile', { contact: { email: 'nope', website: 'ftp://x' }, address: { ...PROFILE.address, country: 'India' }, timezone: 'Nowhere/City' });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { issues: { path: string }[] }).issues.map((i) => i.path).sort()).toEqual(['address.country', 'contact.email', 'contact.website', 'timezone']);
    expect((await call('PUT', '/api/admin/organisation/profile', { address: { line1: 'x' } })).statusCode).toBe(400);
    expect((await call('PUT', '/api/admin/organisation/profile', { region: 'us-east1' })).statusCode).toBe(400);

    const res = await call('PUT', '/api/admin/organisation/profile', PROFILE);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      code: 'asha',
      contact: { email: 'office@asha.org', phone: '+91 22 4000 0000', website: 'https://asha.org' },
      address: { line1: '4 Marine Drive', line2: null, city: 'Mumbai', state: 'Maharashtra', postalCode: '400002', country: 'IN' },
      timezone: 'Asia/Kolkata',
    });
    const cleared = (await call('PUT', '/api/admin/organisation/profile', { contact: { phone: '' } })).json() as OrganisationView;
    expect(cleared.contact).toEqual({ email: 'office@asha.org', phone: null, website: 'https://asha.org' });
    expect((await call('PUT', '/api/admin/organisation/profile', PROFILE, clerk)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/organisation', undefined, clerk)).statusCode).toBe(403);
  });

  it('keeps several registrations, unique by type and number within the organisation', async () => {
    const add = await call('POST', '/api/admin/organisation/registrations', { type: '80G', number: ' aaatc1234f / 80g ', issuingAuthority: 'Income Tax Department', issuedOn: '2024-04-01', expiresOn: '2029-03-31' });
    expect(add.statusCode, add.body).toBe(201);
    const first = add.json() as { id: string; type: string; number: string };
    expect(first).toMatchObject({ type: '80g', number: 'AAATC1234F / 80G' });
    expect((await call('POST', '/api/admin/organisation/registrations', { type: '80g', number: 'AAATC1234F / 80g' })).statusCode).toBe(409);
    const second = (await call('POST', '/api/admin/organisation/registrations', { type: '12a', number: 'AAATC1234FE20214' })).json() as { id: string };
    expect((await call('POST', '/api/admin/organisation/registrations', { type: '12a', number: 'X', expiresOn: '2020-01-01', issuedOn: '2021-01-01' })).statusCode).toBe(422);
    expect((await call('PUT', `/api/admin/organisation/registrations/${second.id}`, { type: '80g', number: 'aaatc1234f / 80G' })).statusCode).toBe(409);
    const updated = await call('PUT', `/api/admin/organisation/registrations/${second.id}`, { type: '12a', number: 'AAATC1234FE20215', notes: 'Renewed' });
    expect(updated.json()).toMatchObject({ number: 'AAATC1234FE20215', notes: 'Renewed' });
    const tmp = (await call('POST', '/api/admin/organisation/registrations', { type: 'csr-1', number: 'CSR00001' })).json() as { id: string };
    expect((await call('DELETE', `/api/admin/organisation/registrations/${tmp.id}`)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/admin/organisation/registrations/${tmp.id}`)).statusCode).toBe(404);
    // The same registration may belong to another organisation.
    expect((await call('POST', '/api/admin/organisation/registrations', { type: '80g', number: 'AAATC1234F / 80G' }, admin, w.ngoB)).statusCode).toBe(201);
    const view = (await call('GET', '/api/admin/organisation')).json() as OrganisationView;
    expect(view.registrations.map((r) => [r.type, r.number])).toEqual([
      ['12a', 'AAATC1234FE20215'],
      ['80g', 'AAATC1234F / 80G'],
    ]);
    expect((await call('DELETE', `/api/admin/organisation/registrations/${first.id}`, undefined, admin, w.ngoB)).statusCode).toBe(404);
  });
});

describe('the organisation logo', () => {
  let firstLogoFile = '';

  it('stores an image through the file store and serves it to members of this organisation only', async () => {
    expect((await call('PUT', '/api/admin/organisation/logo', Buffer.from('just text'))).statusCode).toBe(422);
    expect((await call('PUT', '/api/admin/organisation/logo', png(), clerk)).statusCode).toBe(403);
    const res = await call('PUT', '/api/admin/organisation/logo', png(1));
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as OrganisationView).logo).toMatchObject({ url: '/api/organisation/logo?v=1', version: 1 });
    const logo = await call('GET', '/api/organisation/logo', undefined, member);
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.rawPayload.equals(png(1))).toBe(true);
    expect((await call('GET', '/api/organisation/logo', undefined, member, w.ngoB)).statusCode).toBe(404);
    expect((await call('GET', '/api/organisation', undefined, member)).json()).toEqual({ code: 'asha', displayName: 'Asha Trust', logoUrl: '/api/organisation/logo?v=1' });
    const [row] = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ file_id: string }>(`select file_id from tenant_asset where kind = 'logo'`));
    firstLogoFile = row!.file_id;
    expect((await call('GET', `/api/organisation/logos/${firstLogoFile}`, undefined, member, w.ngoB)).statusCode).toBe(404);
    expect((await call('GET', `/api/files/${firstLogoFile}`, undefined, member)).statusCode).toBe(404);
  });

  it('is never removed as an unlinked upload, nor is a replaced logo an issued receipt keeps', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Kept Logo', amount: 10 });
    await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 10, recordId: record.id }));
    expect(((await call('PUT', '/api/admin/organisation/logo', png(2))).json() as OrganisationView).logo!.version).toBe(2);
    expect(((await call('PUT', '/api/admin/organisation/logo', png(3))).json() as OrganisationView).logo!.version).toBe(3);
    await w.platform.db.asSystem((tx) => tx.query(`update file_object set created_at = now() - interval '3 days' where tenant_id = $1`, [w.ngoA]));
    expect(await w.platform.files.tenantsWithStaleUploads()).toContain(w.ngoA);
    await w.platform.files.cleanup(w.ngoA, 100);
    const files = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ id: string; deleted: boolean; current: boolean; kept: boolean }>(
      `select f.id, f.deleted_at is not null as deleted,
              exists (select 1 from tenant_asset a where a.file_id = f.id) as current,
              exists (select 1 from receipt_issuer r where r.logo_file_id = f.id) as kept
         from file_object f where f.mime = 'image/png'`,
    ));
    expect(files.filter((f) => f.current || f.kept).every((f) => !f.deleted)).toBe(true);
    expect(files.filter((f) => !f.current && !f.kept).every((f) => f.deleted)).toBe(true);
    expect(files.find((f) => f.id === firstLogoFile)).toMatchObject({ kept: true, deleted: false });
    expect(files.filter((f) => f.deleted)).toHaveLength(1);
    expect(await w.platform.files.tenantsWithStaleUploads()).not.toContain(w.ngoA);
    expect((await call('GET', `/api/organisation/logos/${firstLogoFile}`, undefined, member)).rawPayload.equals(png(1))).toBe(true);
  });

  it('can be removed', async () => {
    expect((await call('DELETE', '/api/admin/organisation/logo', undefined, admin, w.ngoB)).statusCode).toBe(404);
    const res = await call('PUT', '/api/admin/organisation/logo', png(4), admin, w.ngoB);
    expect(res.statusCode).toBe(200);
    expect((await call('DELETE', '/api/admin/organisation/logo', undefined, admin, w.ngoB)).statusCode).toBe(204);
    expect((await call('GET', '/api/organisation', undefined, member, w.ngoB)).json()).toMatchObject({ logoUrl: null });
  });
});

describe('receipt issuer snapshot', () => {
  it('keeps the issuer of an issued receipt when the organisation identity changes later', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Snapshot', amount: 250 });
    const receipt = await w.platform.db.withTenant(w.ngoA, (tx) =>
      w.platform.receipts.issue(asTx(tx), admin, {
        seriesKey: 'donation-receipt',
        date: today(),
        amount: 250,
        recordId: record.id,
        // A kept wording, so receipt_content has a row when isolation and export are checked.
        content: { ruleKey: '', title: 'Donation acknowledgement', statement: null, rows: [], clauses: [], thanks: 'Thank you for your generous support.' },
      }),
    );
    const before = await w.platform.printView.receipt(w.as(w.ngoA), receipt.id);
    expect(before.issuerSource).toBe('issued');
    expect(before.organisation).toEqual({ name: 'Asha Trust' });
    expect(before.issuer).toMatchObject({
      displayName: 'Asha Trust',
      legalName: 'Asha Charitable Trust',
      address: { line1: '4 Marine Drive', city: 'Mumbai', country: 'IN' },
      contact: { email: 'office@asha.org' },
      registrations: [
        { type: '12a', number: 'AAATC1234FE20215' },
        { type: '80g', number: 'AAATC1234F / 80G', issuingAuthority: 'Income Tax Department' },
      ],
      logo: { version: 3 },
    });
    const oldLogo = before.issuer.logoUrl!;

    await call('PUT', '/api/admin/settings', { name: 'Asha Foundation', legalName: 'Asha Foundation Trust' });
    await call('PUT', '/api/admin/organisation/profile', { ...PROFILE, address: { ...PROFILE.address, line1: '9 New Street' } });
    const view = (await call('GET', '/api/admin/organisation')).json() as OrganisationView;
    for (const r of view.registrations) await call('DELETE', `/api/admin/organisation/registrations/${r.id}`);
    await call('PUT', '/api/admin/organisation/logo', png(5));

    const after = await w.platform.printView.receipt(w.as(w.ngoA), receipt.id);
    expect(after.issuer).toEqual(before.issuer);
    expect(after.organisation).toEqual({ name: 'Asha Trust' });
    expect((await call('GET', oldLogo, undefined, member)).rawPayload.equals(png(3))).toBe(true);

    const later = (await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Later', amount: 5 })).record;
    const next = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 5, recordId: later.id }));
    const fresh = await w.platform.printView.receipt(w.as(w.ngoA), next.id);
    expect(fresh.issuer).toMatchObject({ displayName: 'Asha Foundation', legalName: 'Asha Foundation Trust', address: { line1: '9 New Street' }, registrations: [], logo: { version: 4 } });
    await call('PUT', '/api/admin/settings', { name: 'Asha Trust' });
  });

  it('cannot be changed or deleted, nor read across organisations', async () => {
    await expect(w.platform.db.asSystem((tx) => tx.query(`update receipt_issuer set issuer = '{}'`))).rejects.toThrow(/cannot be changed/);
    await expect(w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`delete from receipt_issuer`))).rejects.toThrow(/permission denied/);
    const rows = await w.platform.db.withTenant(w.ngoB, (tx) => tx.query(`select * from receipt_issuer`));
    expect(rows).toEqual([]);
  });

  it('falls back to the current identity for a receipt issued before snapshots were kept', async () => {
    await completeIdentity(w, w.ngoB, 'Bodhi Society Trust');
    const { record } = await w.platform.records.create(w.as(w.ngoB), 'donation', { donorName: 'Old receipt', amount: 30 });
    const receipt = await w.platform.db.withTenant(w.ngoB, (tx) => w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 30, recordId: record.id }));
    await w.platform.db.asSystem(async (tx) => {
      await tx.query(`alter table receipt_issuer disable trigger receipt_issuer_immutable`);
      await tx.query(`delete from receipt_issuer where receipt_id = $1`, [receipt.id]);
      await tx.query(`alter table receipt_issuer enable trigger receipt_issuer_immutable`);
    });
    const view = await w.platform.printView.receipt(w.as(w.ngoB), receipt.id);
    expect(view).toMatchObject({ issuerSource: 'current', organisation: { name: 'Bodhi Society' }, issuer: { displayName: 'Bodhi Society' } });
  });
});

describe('setup checklist', () => {
  it('lists what is left, and completes once the administrator confirms identity and receipts', async () => {
    const start = (await call('GET', '/api/admin/organisation/setup')).json() as { complete: boolean; items: { key: string; done: boolean; required: boolean; detail?: string }[] };
    expect(start.complete).toBe(false);
    expect(Object.fromEntries(start.items.map((i) => [i.key, i.done]))).toEqual({
      identity: false,
      registrations: false,
      fiscalYear: true,
      receiptSeries: false,
      operationalRole: false,
      email: true,
      payments: false,
    });
    expect(start.items.find((i) => i.key === 'email')).toMatchObject({ required: false, detail: 'installation' });
    await call('POST', '/api/admin/organisation/registrations', { type: '80g', number: 'NEW-80G-1' });
    await call('POST', '/api/admin/people', { email: 'fin@asha.org', displayName: 'Fin', roles: ['finance'] });
    expect((await call('POST', '/api/admin/organisation/setup/identity/confirm', {}, clerk)).statusCode).toBe(403);
    expect((await call('POST', '/api/admin/organisation/setup/payments/confirm', {})).statusCode).toBe(404);
    await call('POST', '/api/admin/organisation/setup/identity/confirm', {});
    const done = (await call('POST', '/api/admin/organisation/setup/receiptSeries/confirm', {})).json() as { complete: boolean; completedAt: string | null };
    expect(done.complete).toBe(true);
    expect(done.completedAt).toEqual(expect.any(String));
  });

  it("counts an enabled http email sender as the organisation's own email", async () => {
    const email = async () =>
      ((await call('GET', '/api/admin/organisation/setup', undefined, admin, w.ngoB)).json() as { items: { key: string; detail?: string }[] }).items.find((i) => i.key === 'email');
    expect(await email()).toMatchObject({ detail: 'installation' });
    const config = { mode: 'send', method: 'POST', url: 'https://mail.example.org/send', emailSender: true };
    await w.platform.db.withTenant(w.ngoB, (tx) =>
      tx.query(`insert into connector (tenant_id, key, type, config, enabled) values (app_tenant(), 'mailer', 'http', $1, true)`, [JSON.stringify(config)]),
    );
    expect(await email()).toMatchObject({ detail: 'organisation' });
    await w.platform.db.withTenant(w.ngoB, (tx) => tx.query(`update connector set config = $1 where key = 'mailer'`, [JSON.stringify({ ...config, emailSender: false })]));
    expect(await email()).toMatchObject({ detail: 'installation' });
  });
});

describe('organisation-specific sign-in', () => {
  it('resolves an active organisation to its display name, same-origin logo and sign-in providers, and nothing more', async () => {
    const res = await anonymous('/api/auth/organisations/ASHA');
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'displayName', 'logoUrl', 'providers', 'theme']);
    expect(body).toMatchObject({ code: 'asha', displayName: 'Asha Trust', logoUrl: expect.stringMatching(/^\/api\/auth\/organisations\/asha\/logo\?v=\d+$/), providers: [], theme: null });
    expect(res.body).not.toMatch(/Charitable|Foundation Trust|Marine|80G|office@/i);
    const manifest = await anonymous('/api/auth/organisations/asha/manifest.webmanifest');
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toMatch(/application\/manifest\+json/);
    expect(manifest.json()).toMatchObject({
      name: 'Asha Trust',
      id: '/o/asha/',
      start_url: '/o/asha/sign-in',
      scope: '/',
      theme_color: '#1f5f8b',
      background_color: '#f5f7fa',
      icons: [
        { src: `${(body.logoUrl as string).replace('/logo?', '/icon/192?')}&i=2`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${(body.logoUrl as string).replace('/logo?', '/icon/512?')}&i=2`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `${(body.logoUrl as string).replace('/logo?', '/icon/512?')}&i=2`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: `${(body.logoUrl as string).replace('/logo?', '/icon/180?')}&i=2`, sizes: '180x180', type: 'image/png' },
      ],
    });
    const logo = await anonymous(body.logoUrl as string);
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
  });

  it('returns only the published theme colours, and paints them on the install manifest', async () => {
    const stored = { brand: '#112233', brandForeground: '#ffffff', background: '  ', label: 'Secret label', legalName: 'Asha Foundation Trust' };
    await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query(
        `insert into definition (tenant_id, module_key, kind, key, version, status, body, checksum)
         values (app_tenant(), 'platform', 'theme', 'organisation', 1, 'draft', $1::jsonb, 'theme-1')`,
        [JSON.stringify(stored)],
      ),
    );
    try {
      expect(((await anonymous('/api/auth/organisations/asha')).json() as { theme: unknown }).theme).toBeNull();
      await w.platform.db.withTenant(w.ngoA, (tx) =>
        tx.query(`update definition set status = 'published', published_at = now() where kind = 'theme' and key = 'organisation' and version = 1`),
      );
      const after = (await anonymous('/api/auth/organisations/asha')).json() as { theme: unknown };
      expect(after.theme).toEqual({ brand: '#112233', brandForeground: '#ffffff' });
      expect(JSON.stringify(after.theme)).not.toMatch(/Secret|Foundation|legalName|label/);
      const manifest = await anonymous('/api/auth/organisations/asha/manifest.webmanifest');
      expect(manifest.json()).toMatchObject({ theme_color: '#112233', background_color: '#f5f7fa', start_url: '/o/asha/sign-in' });
      expect(manifest.body).not.toMatch(/Secret|Foundation|Charitable|office@/);
    } finally {
      await w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`update definition set status = 'superseded' where kind = 'theme' and key = 'organisation' and status <> 'superseded'`));
    }
  });

  it('answers unknown and every inactive organisation the same way', async () => {
    const unknown = await anonymous('/api/auth/organisations/nobody-here');
    expect(unknown.statusCode).toBe(404);
    const unknownManifest = await anonymous('/api/auth/organisations/nobody-here/manifest.webmanifest');
    expect([unknownManifest.statusCode, unknownManifest.json()]).toEqual([404, unknown.json()]);
    for (const status of ['provisioning', 'provisioning_failed', 'suspended', 'closed']) {
      await w.platform.db.asSystem((tx) => tx.query(`update tenant set status = $1 where id = $2`, [status, w.ngoA]));
      const res = await anonymous('/api/auth/organisations/asha');
      expect([res.statusCode, res.json()], status).toEqual([404, unknown.json()]);
      const logo = await anonymous('/api/auth/organisations/asha/logo');
      expect([logo.statusCode, logo.json()], status).toEqual([404, unknown.json()]);
      const manifest = await anonymous('/api/auth/organisations/asha/manifest.webmanifest');
      expect([manifest.statusCode, manifest.json()], status).toEqual([404, unknown.json()]);
    }
    await w.platform.db.asSystem((tx) => tx.query(`update tenant set status = 'active' where id = $1`, [w.ngoA]));
    for (const odd of ['%27%20or%201%3D1', 'a'.repeat(80), '..%2F..%2Fetc']) expect((await anonymous(`/api/auth/organisations/${odd}`)).statusCode).toBe(404);
  });

  // The lookups spend the ordinary API budget, so one person moving through the app does not use up
  // the sign-in one (DEF-32); their own tighter per-address limit is what slows guessing codes.
  it('is rate-limited by its own per-address limit', async () => {
    const limited = buildServer(w.platform, { organisationLookupLimit: 3 });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await anonymous('/api/auth/organisations/asha', limited)).statusCode);
      expect(codes).toEqual([200, 200, 200, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('isolation of organisation data', () => {
  it('keeps profiles, registrations, logos and issuer snapshots inside their organisation', async () => {
    for (const table of ['organisation_profile', 'organisation_registration', 'tenant_asset', 'receipt_issuer', 'receipt_content']) {
      const own = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ tenant_id: string }>(`select tenant_id from ${table}`));
      expect(own.length, table).toBeGreaterThan(0);
      expect(own.every((r) => r.tenant_id === w.ngoA), table).toBe(true);
      const other = await w.platform.db.withTenant(w.ngoB, (tx) => tx.query<{ tenant_id: string }>(`select tenant_id from ${table} where tenant_id = $1`, [w.ngoA]));
      expect(other, table).toEqual([]);
    }
    await expect(
      w.platform.db.withTenant(w.ngoB, (tx) => tx.query(`insert into organisation_registration (tenant_id, type, number, created_by) values ($1, 'pan', 'X', 'me')`, [w.ngoA])),
    ).rejects.toThrow(/row-level security/);
    await expect(w.platform.db.withTenant(w.ngoB, (tx) => tx.query(`update organisation_profile set email = 'x@y.z' where tenant_id = $1 returning 1`, [w.ngoA]))).resolves.toEqual([]);
  });

  it('exports the organisation’s identity with the rest of its data', async () => {
    const lines: string[] = [];
    await w.platform.exportTenant(w.ngoA, (l) => void lines.push(l));
    const tables = new Set(lines.map((l) => (JSON.parse(l) as { table: string }).table));
    for (const t of ['organisation_profile', 'organisation_registration', 'tenant_asset', 'receipt_issuer', 'receipt_content']) expect(tables.has(t), t).toBe(true);
    expect(JSON.parse(lines[0]!).row).toMatchObject({ key: 'asha', legal_name: 'Asha Foundation Trust' });
  });

  it('refuses cross-organisation settings calls through the service as well', async () => {
    await expectCode(w.platform.organisation.removeRegistration(w.as(w.ngoB), '00000000-0000-4000-8000-000000000001'), 'not_found');
    await expectCode(w.platform.organisation.keptLogo(w.as(w.ngoB), 'not-a-uuid'), 'not_found');
  });
});

describe('authorised signatory and public receipt link', () => {
  const signatoryOf = (body: OrganisationView) => body.signatory;

  it('saves the name and designation, and keeps them off the sign-in page', async () => {
    expect((await call('PUT', '/api/admin/organisation/signatory', { name: ' ', designation: 'Treasurer' })).statusCode).toBe(422);
    expect((await call('PUT', '/api/admin/organisation/signatory', { name: 'Meera Shah', designation: 'Treasurer' }, clerk)).statusCode).toBe(403);
    const saved = await call('PUT', '/api/admin/organisation/signatory', { name: '  Meera   Shah ', designation: 'Treasurer' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(signatoryOf(saved.json() as OrganisationView)).toMatchObject({ name: 'Meera Shah', designation: 'Treasurer', image: null });
    const branding = (await anonymous('/api/auth/organisations/asha')).json() as Record<string, unknown>;
    expect(Object.keys(branding).sort()).toEqual(['code', 'displayName', 'logoUrl', 'providers', 'theme']);
    expect(JSON.stringify(branding)).not.toMatch(/Meera|Treasurer/);
  });

  it('stores a PNG signature and refuses anything else', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);
    expect((await call('PUT', '/api/admin/organisation/signatory/image', jpeg)).statusCode).toBe(422);
    expect((await call('PUT', '/api/admin/organisation/signatory/image', Buffer.concat([png(6), Buffer.alloc(200 * 1024)]))).statusCode).toBe(422);
    expect((await call('PUT', '/api/admin/organisation/signatory/image', png(7), clerk)).statusCode).toBe(403);
    const res = await call('PUT', '/api/admin/organisation/signatory/image', png(7));
    expect(res.statusCode, res.body).toBe(200);
    const image = signatoryOf(res.json() as OrganisationView)!.image!;
    expect(image.url).toMatch(/^\/api\/organisation\/signatories\/[0-9a-f-]+\?v=1$/);
    const fileId = image.url.split('/').pop()!.split('?')[0]!;
    expect((await call('GET', `/api/organisation/signatories/${fileId}`, undefined, member)).statusCode).toBe(403);
    const fetched = await call('GET', `/api/organisation/signatories/${fileId}`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.headers['x-content-type-options']).toBe('nosniff');
    expect(fetched.rawPayload.equals(png(7))).toBe(true);
    expect((await call('GET', `/api/organisation/signatories/${fileId}`, undefined, admin, w.ngoB)).statusCode).toBe(404);
  });

  it('keeps the signatory a receipt was issued with, and opens only that receipt from its public link', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Public Donor', amount: 80 });
    const receipt = await w.platform.db.withTenant(w.ngoA, (tx) =>
      w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 80, recordId: record.id }),
    );
    const issued = await w.platform.printView.receipt(w.as(w.ngoA), receipt.id);
    expect(issued.issuer.signatory).toMatchObject({ name: 'Meera Shah', designation: 'Treasurer' });
    expect(issued.publicLink).toBeNull();
    const firstFile = issued.issuer.signatory!.file!.fileId;

    await call('PUT', '/api/admin/organisation/signatory', { name: 'Later Name', designation: 'Secretary' });
    await call('PUT', '/api/admin/organisation/signatory/image', png(8));
    const reprint = await w.platform.printView.receipt(w.as(w.ngoA), receipt.id);
    expect(reprint.issuer).toEqual(issued.issuer);
    expect(issued.issuer.signatoryImageUrl).toBe(`/api/organisation/signatories/${firstFile}?receipt=${receipt.id}`);
    expect((await call('GET', issued.issuer.signatoryImageUrl!, undefined, clerk)).rawPayload.equals(png(7))).toBe(true);
    expect((await call('GET', issued.issuer.signatoryImageUrl!, undefined, member)).statusCode).toBe(403);
    const current = (await call('GET', '/api/admin/organisation')).json() as OrganisationView;
    const currentFile = current.signatory!.image!.url.split('/').pop()!.split('?')[0]!;
    expect((await call('GET', `/api/organisation/signatories/${currentFile}?receipt=${receipt.id}`, undefined, clerk)).statusCode).toBe(404);

    const reader: Actor = { id: 'reader-1', roles: ['viewer'], permissions: ['record:donation:read'] };
    const printer: Actor = { ...clerk, permissions: [...clerk.permissions, 'record:donation:action:printReceipt'] };
    expect((await call('POST', `/api/print/receipt/${receipt.id}/link`, undefined, member)).statusCode).toBe(403);
    expect((await call('POST', `/api/print/receipt/${receipt.id}/link`, undefined, reader)).statusCode).toBe(403);
    expect((await call('DELETE', `/api/print/receipt/${receipt.id}/link`, undefined, reader)).statusCode).toBe(403);
    expect((await call('POST', `/api/print/receipt/${receipt.id}/link`, undefined, admin, w.ngoB)).statusCode).toBe(404);
    const created = await call('POST', `/api/print/receipt/${receipt.id}/link`, undefined, printer);
    expect(created.statusCode, created.body).toBe(200);
    const path = (created.json() as { path: string }).path;
    expect(path).toMatch(/^\/r\/[A-Za-z0-9_-]{20,}$/);
    expect((await call('POST', `/api/print/receipt/${receipt.id}/link`)).json()).toEqual({ path });
    expect((await call('GET', `/api/print/receipt/${receipt.id}`)).json()).toMatchObject({ publicLink: path });
    expect((await call('GET', `/api/print/receipt/${receipt.id}`, undefined, reader)).statusCode).toBe(403);

    const token = path.slice(3);
    const pub = await anonymous(`/api/public/receipts/${token}`);
    expect(pub.statusCode).toBe(200);
    const body = pub.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['amount', 'content', 'date', 'donor', 'fields', 'hasLogo', 'hasSignature', 'issuer', 'issuerSource', 'number', 'recordNumber', 'recordTypeLabel', 'signatory', 'status', 'title', 'voidReason']);
    expect(body['content']).toBeNull();
    expect(body).toMatchObject({
      title: 'Donation acknowledgement',
      status: 'issued',
      voidReason: null,
      donor: { label: 'Donor name', value: 'Public Donor' },
      recordTypeLabel: 'Donation',
      hasLogo: true,
      hasSignature: true,
      signatory: { name: 'Meera Shah', designation: 'Treasurer' },
    });
    const labels = (body['fields'] as { label: string }[]).map((f) => f.label);
    expect(labels).not.toContain('Donor');
    expect(labels).not.toContain('Donor PAN');
    const published = JSON.stringify(body);
    expect(published).not.toContain(record.id);
    expect(published).not.toContain(receipt.id);
    expect(published).not.toContain(firstFile);
    const logo = await anonymous(`/api/public/receipts/${token}/logo`);
    const signature = await anonymous(`/api/public/receipts/${token}/signature`);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(signature.headers['x-content-type-options']).toBe('nosniff');
    expect(signature.headers['content-disposition']).toBe('inline; filename="signature"');
    expect(signature.rawPayload.equals(png(7))).toBe(true);

    await call('PUT', '/api/admin/organisation/logo', png(9));
    expect((await anonymous(`/api/public/receipts/${token}/signature`)).rawPayload.equals(png(7))).toBe(true);
    expect((await anonymous(`/api/public/receipts/${token}`)).json()).toMatchObject({ signatory: { name: 'Meera Shah', designation: 'Treasurer' } });

    await w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`update record set data = jsonb_set(data, '{donorName}', '"enc:v1:hidden"') where id = $1`, [record.id]));
    expect((await anonymous(`/api/public/receipts/${token}`)).json()).toMatchObject({ donor: null });

    await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.void(asTx(tx), admin, receipt.id, 'Entered twice'));
    expect((await anonymous(`/api/public/receipts/${token}`)).json()).toMatchObject({ status: 'void', voidReason: 'Entered twice', signatory: { name: 'Meera Shah' } });

    const unknown = await anonymous('/api/public/receipts/not-a-real-token-value');
    expect((await anonymous(`/api/public/receipts/${receipt.id}`)).json()).toEqual(unknown.json());
    expect((await call('DELETE', `/api/print/receipt/${receipt.id}/link`)).statusCode).toBe(204);
    const revoked = await anonymous(`/api/public/receipts/${token}`);
    expect([revoked.statusCode, revoked.json()]).toEqual([404, unknown.json()]);
    expect((await anonymous(`/api/public/receipts/${token}/logo`)).json()).toEqual(unknown.json());
    const again = await call('POST', `/api/print/receipt/${receipt.id}/link`);
    expect(again.json()).not.toEqual({ path });
    expect((await anonymous(`/api/public/receipts/${token}`)).statusCode).toBe(404);

    await w.platform.db.asSystem((tx) => tx.query(`update file_object set created_at = now() - interval '3 days' where tenant_id = $1`, [w.ngoA]));
    await w.platform.files.cleanup(w.ngoA, 100);
    const kept = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ deleted: boolean }>(`select deleted_at is not null as deleted from file_object where id = $1`, [firstFile]),
    );
    expect(kept[0]).toEqual({ deleted: false });
    const other = await w.platform.db.withTenant(w.ngoB, (tx) => tx.query(`select * from receipt_link`));
    expect(other).toEqual([]);
  });

  it('shares the organisation lookup limit', async () => {
    const limited = buildServer(w.platform, { organisationLookupLimit: 2 });
    try {
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await anonymous('/api/public/receipts/not-a-real-token-value', limited)).statusCode);
      expect(codes).toEqual([404, 404, 429]);
    } finally {
      await limited.close();
    }
  });
});
