import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { loadModulePackage, publishModulePackage } from '../src/runtime/definitions/package-loader.js';
import type { ListViewDef } from '../src/runtime/definitions/types.js';
import { admin, clerk, createWorld, currentFiscalYear, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

const worlds: TestWorld[] = [];
afterAll(() => Promise.all(worlds.map((w) => w.close())));
const world = async (donations = true) => {
  const w = await createWorld({ donations });
  worlds.push(w);
  return w;
};

describe('Donations module 0.2.3', () => {
  it('installs donors, the Fundraising group, three actions and the rollups', async () => {
    const w = await world();
    const keys = async (kind: Parameters<TestWorld['platform']['definitions']['list']>[1]) =>
      (await w.platform.definitions.list(w.ngoA, kind)).map((d) => d.key).sort();
    expect(await keys('recordType')).toEqual(['donation', 'donor']);
    expect(await keys('listView')).toEqual(['donations', 'donors']);
    expect(await keys('recordGroup')).toEqual(['fundraising']);
    expect(await keys('action')).toEqual(['payNow', 'printReceipt', 'sendReminder']);
    expect(await keys('template')).toEqual(['donationReminder', 'donationSummary', 'donationThanks']);
    expect(await keys('report')).toEqual(['donationRegister', 'donationSummary']);
    expect(await keys('reportGroup')).toEqual(['fundraising']);
    const donor = (await w.platform.definitions.get(w.ngoA, 'recordType', 'donor'))!.body;
    expect(donor.fields.filter((f) => f.rollup).map((f) => f.key)).toEqual(['totalGiven', 'donationCount']);
    expect(donor.fields.find((f) => f.key === 'pan')).toMatchObject({ unique: true, sensitive: true, pattern: '[A-Z]{5}[0-9]{4}[A-Z]' });

    const app = buildServer(w.platform, { devAuth: true });
    const viewer = { id: 'viewer-1', roles: ['viewer'], permissions: ['record:donor:read', 'record:donation:read'] };
    const res = await app.inject({
      method: 'GET',
      url: '/api/runtime/definitions',
      headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(viewer) },
    });
    const body = res.json();
    expect(body.recordGroups).toEqual([{ key: 'fundraising', label: 'Fundraising', recordTypes: ['donor', 'donation'] }]);
    expect((body.listViews.donor as ListViewDef).detail!.sections[1]).toEqual({
      id: 'donations',
      label: 'Donations',
      related: { recordType: 'donation', field: 'donor', total: 'amount' },
    });
    await app.close();
  });

  it('publishes each report as its one format and lists the file on the report', async () => {
    const w = await world();
    const listed = await w.platform.reports.list(w.as(w.ngoA, admin));
    expect([...listed].sort((a, b) => a.key.localeCompare(b.key)).map((r) => [r.key, r.format, r.group?.key])).toEqual([
      ['donationRegister', 'excel', 'fundraising'],
      ['donationSummary', 'pdf', 'fundraising'],
    ]);
    const params = { from: '2026-11-01', to: '2026-11-30' };
    const preview = await w.platform.reports.preview(w.as(w.ngoA, admin), 'donationSummary', params);
    expect(preview.format).toBe('pdf');
    expect((await w.platform.reports.report(w.as(w.ngoA, admin), 'donationSummary')).published).toEqual([]);

    const published = await w.platform.reports.publish(w.as(w.ngoA, admin), 'donationSummary', { params });
    expect(published.format).toBe('pdf');
    const finance = { id: 'fin-2', roles: ['finance'], permissions: ['report:donationSummary:run'] };
    const page = await w.platform.reports.report(w.as(w.ngoA, finance), 'donationSummary');
    expect(page.report).toMatchObject({ key: 'donationSummary', format: 'pdf', group: { key: 'fundraising' } });
    expect(page.published.map((r) => [r.id, r.format, r.params])).toEqual([[published.id, 'pdf', params]]);
    const opened = await w.platform.reports.getPublished(w.as(w.ngoA, finance), published.id);
    expect(opened.title).toContain('Donation summary');
    expect(opened.html).toContain('Donation summary');

    const sheet = await w.platform.reports.publish(w.as(w.ngoA, admin), 'donationRegister', { params });
    expect(sheet.format).toBe('excel');
    expect((await w.platform.reports.getPublished(w.as(w.ngoA, admin), sheet.id)).html).toContain('Donation register');
    const file = await w.platform.reports.downloadPublished(w.as(w.ngoA, admin), sheet.id);
    expect(file.fileName).toContain('Donation register');
    expect(file.bytes.subarray(0, 2).toString()).toBe('PK');

    const viewer = { id: 'viewer-1', roles: ['viewer'], permissions: ['record:donation:read'] };
    await expect(w.platform.reports.report(w.as(w.ngoA, viewer), 'donationSummary')).rejects.toThrow();
    await expect(w.platform.reports.getPublished(w.as(w.ngoA, viewer), published.id)).rejects.toThrow();
    await expect(w.platform.reports.downloadPublished(w.as(w.ngoA, finance), sheet.id)).rejects.toThrow();
  });

  it('fills a donation with the chosen donor’s details', async () => {
    const w = await world();
    const finance = { id: 'fin-1', roles: ['finance'], permissions: ['record:donor:*', 'record:donation:*'] };
    const donor = await w.platform.records.create(w.as(w.ngoA, finance), 'donor', { name: 'Kavya Rao', email: 'kavya@example.org', pan: 'ABCDE1234F' });
    expect(donor.record.number).toBe('DNR/00001');
    const { record } = await w.platform.records.create(w.as(w.ngoA, finance), 'donation', { donor: donor.record.id, amount: 500 });
    expect(record.data).toMatchObject({ donorName: 'Kavya Rao', donorEmail: 'kavya@example.org', donorPan: 'ABCDE1234F' });
  });

  it('upgrades from 0.1.0, keeping donations, organisation changes and role access', async () => {
    const w = await world(false);
    const old = await loadModulePackage(join(import.meta.dirname, 'fixtures', 'donations-0.1.0'), w.platform.schemas);
    expect(old.manifest.version).toBe('0.1.0');
    await publishModulePackage(w.platform.definitions, old);
    await w.platform.definitions.enableModule(w.as(w.ngoA), old.manifest);
    await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.openFiscalYear(asTx(tx), admin, currentFiscalYear()));

    const before = await w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'Typed In', donorEmail: 'typed@example.org', amount: 250 });
    await w.platform.definitions.setExtensionPatch(w.as(w.ngoA), 'listView', 'donations', { label: 'Gifts' });

    const pkg = await w.platform.publishShippedModule('donations');
    expect(pkg.manifest.version).toBe('0.2.3');
    const { materialised } = await w.platform.definitions.enableModule(w.as(w.ngoA), pkg.manifest);
    expect(materialised).toEqual(expect.arrayContaining(['recordType|donor', 'recordType|donation', 'listView|donations', 'action|payNow']));

    const kept = await w.platform.records.get(w.as(w.ngoA, clerk), before.record.id);
    expect(kept.data).toMatchObject({ donorName: 'Typed In', donorEmail: 'typed@example.org', amount: 250 });
    expect(kept.data).not.toHaveProperty('donor');
    const view = (await w.platform.definitions.get(w.ngoA, 'listView', 'donations'))!.body;
    expect(view.label).toBe('Gifts');
    expect(view.create!.presets).toEqual([{ param: 'donor', field: 'donor' }]);

    const [finance] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ permissions: string[]; version: string }>(
        `select r.permissions, m.module_version as version from role r, tenant_module m
          where r.key = 'finance' and m.module_key = 'donations'`,
      ),
    );
    expect(finance!.permissions).toContain('record:donor:*');
    expect(finance!.version).toBe('0.2.3');

    const edited = await w.platform.records.update(w.as(w.ngoA, clerk), before.record.id, { expectedVersion: 1, data: { notes: 'Still editable' } });
    expect(edited.record.data.donorName).toBe('Typed In');
  });

  it('upgrades from 0.2.0, giving Viewer and Finance the people directory and leaving customised roles alone', async () => {
    const w = await world(false);
    const old = await loadModulePackage(join(import.meta.dirname, 'fixtures', 'donations-0.2.0'), w.platform.schemas);
    expect(old.manifest.version).toBe('0.2.0');
    await publishModulePackage(w.platform.definitions, old);
    for (const tenant of [w.ngoA, w.ngoB]) await w.platform.definitions.enableModule(w.as(tenant), old.manifest);
    const rolesOf = (tenant: string) =>
      w.platform.db.withTenant(tenant, (tx) => tx.query<{ key: string; permissions: string[] }>(`select key, permissions from role order by key`));
    expect((await rolesOf(w.ngoA)).some((r) => r.permissions.includes('people:read'))).toBe(false);
    await w.platform.db.withTenant(w.ngoB, (tx) => tx.query(`update role set permissions = '{record:donation:read}', customised = true where key = 'viewer'`));

    const pkg = await w.platform.publishShippedModule('donations');
    expect(pkg.manifest.version).toBe('0.2.3');
    for (const tenant of [w.ngoA, w.ngoB]) await w.platform.definitions.enableModule(w.as(tenant), pkg.manifest);

    const a = await rolesOf(w.ngoA);
    expect(a.find((r) => r.key === 'viewer')!.permissions).toEqual(['record:donor:read', 'record:donation:read', 'people:read']);
    expect(a.find((r) => r.key === 'finance')!.permissions).toContain('people:read');
    const b = await rolesOf(w.ngoB);
    expect(b.find((r) => r.key === 'viewer')!.permissions).toEqual(['record:donation:read']);
    expect(b.find((r) => r.key === 'finance')!.permissions).toContain('people:read');
  });

  it('keeps an organisation’s own changes to a role on re-sync', async () => {
    const w = await world();
    await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query(`update role set permissions = '{record:donation:read}', customised = true where key = 'viewer'`),
    );
    await w.platform.definitions.enableModule(w.as(w.ngoA), (await w.platform.publishShippedModule('donations')).manifest);
    const [viewer] = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ permissions: string[] }>(`select permissions from role where key = 'viewer'`));
    expect(viewer!.permissions).toEqual(['record:donation:read']);
  });
});
