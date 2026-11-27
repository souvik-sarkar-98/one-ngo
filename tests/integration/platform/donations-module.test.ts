import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../../apps/onengo/server/src/http/server.js';
import type { ListViewDef } from '../../../packages/platform/src/runtime/definitions/types.js';
import { admin, createWorld, type TestWorld } from '../../support/platform/helpers.js';

const worlds: TestWorld[] = [];
afterAll(() => Promise.all(worlds.map((w) => w.close())));
const world = async (donations = true) => {
  const w = await createWorld({ donations });
  worlds.push(w);
  return w;
};

describe('Donations module 0.4.4', () => {
  it('installs donors, the Fundraising group, three actions and the rollups', async () => {
    const w = await world();
    const keys = async (kind: Parameters<TestWorld['platform']['definitions']['list']>[1]) =>
      (await w.platform.definitions.list(w.ngoA, kind)).map((d) => d.key).sort();
    expect(await keys('recordType')).toEqual(['donation', 'donor']);
    expect(await keys('listView')).toEqual(['donations', 'donors']);
    expect(await keys('recordGroup')).toEqual(['fundraising']);
    expect(await keys('action')).toEqual(['payNow', 'printReceipt', 'sendReminder']);
    expect(await keys('template')).toEqual(['donationReminder', 'donationSummary', 'donationThanks', 'donorMonthlyDonation']);
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

    await w.platform.organisation.addSignatory(w.as(w.ngoA, admin), { name: 'Meera Shah', designation: 'Treasurer' });
    // No signatory is chosen for reports yet, so a report prints no signature block.
    const unsigned = await w.platform.reports.preview(w.as(w.ngoA, admin), 'donationSummary', params);
    expect(unsigned.html).not.toContain('Authorised signatory');
    expect(unsigned.html).not.toContain('Meera Shah');
    const listedSignatories = await w.platform.organisation.addSignatory(w.as(w.ngoA, admin), { name: 'Arun Das', designation: 'Secretary' });
    const ids = listedSignatories.signatories.map((signatory) => signatory.id);
    await w.platform.organisation.setDocumentSignatories(w.as(w.ngoA, admin), 'report:donationSummary', { signatories: ids });
    const signedPreview = await w.platform.reports.preview(w.as(w.ngoA, admin), 'donationSummary', params);
    expect(signedPreview.html).toContain('Meera Shah');
    expect(signedPreview.html).toContain('Arun Das');
    const signed = await w.platform.reports.publish(w.as(w.ngoA, admin), 'donationSummary', { params });
    await w.platform.organisation.setDocumentSignatories(w.as(w.ngoA, admin), 'report:donationSummary', { signatories: [ids.at(-1)!] });
    const kept = await w.platform.reports.getPublished(w.as(w.ngoA, finance), signed.id);
    expect(kept.html).toContain('Meera Shah');
    expect(kept.html).toContain('Arun Das');

    // A report prints only its own set; another report's set does not reach it.
    await w.platform.organisation.setDocumentSignatories(w.as(w.ngoA, admin), 'report:donationSummary', { signatories: [ids[1]!] });
    await w.platform.organisation.setDocumentSignatories(w.as(w.ngoA, admin), 'report:donationRegister', { signatories: [ids[0]!] });
    const typed = await w.platform.reports.preview(w.as(w.ngoA, admin), 'donationSummary', params);
    expect(typed.html).toContain('Arun Das');
    expect(typed.html).not.toContain('Meera Shah');
    await w.platform.organisation.setDocumentSignatories(w.as(w.ngoA, admin), 'report:donationSummary', { signatories: [] });
    expect((await w.platform.reports.preview(w.as(w.ngoA, admin), 'donationSummary', params)).html).not.toContain('Authorised signatory');

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
