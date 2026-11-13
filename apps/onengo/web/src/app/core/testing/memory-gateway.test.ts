import { describe, expect, it } from 'vitest';
import type { ListLayout, RecordView } from '../models';
import { ListSession } from '../records/list/list-session';
import { rowModel } from '../records/record/present';
import { RecordSession } from '../records/record/record-session';
import { resolveListSpec, type ListSpec } from '../records/spec';
import { parseListUrl } from '../records/list/url';
import { memoryGateway, sampleSeed } from './memory-gateway';

async function specFor(g: ReturnType<typeof memoryGateway>, type: string): Promise<ListSpec> {
  const defs = await g.auth.definitions();
  const t = defs.recordTypes.find((x) => x.key === type)!;
  return resolveListSpec(t, defs.workflows[type], defs.listViews?.[type], { workflows: defs.workflowSets?.[type], actions: defs.actions?.[type] });
}

/** A list session over the memory gateway with a fake address bar. */
async function listSession(view: ListLayout = 'cards') {
  const g = memoryGateway();
  const spec = await specFor(g, 'donation');
  let params: Record<string, string> = {};
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const s: ListSession = new ListSession(
    spec,
    g.records,
    {
      navigate: (next) => {
        params = Object.fromEntries(Object.entries({ ...params, ...next }).filter(([, v]) => v !== null)) as Record<string, string>;
        void s.fromUrl((n) => params[n] ?? null);
      },
    },
    { preferred: () => view, remember: () => undefined },
  );
  await s.fromUrl(() => null);
  const ids = () => s.rows.items.map((r) => r.id);
  return { g, s, spec, settle, ids };
}

async function recordSession() {
  const g = memoryGateway();
  const spec = await specFor(g, 'donation');
  const saved: { record: RecordView; created: boolean }[] = [];
  const failed: string[] = [];
  const s = new RecordSession(g.records, spec, () => ({ id: 'u1', roles: ['admin'] }), {
    saved: (record, created) => saved.push({ record, created }),
    failed: (m) => failed.push(m),
  });
  const state = (p: Record<string, string>) => parseListUrl((n) => p[n] ?? null, spec);
  return { g, s, spec, saved, failed, state };
}

describe('memory gateway drives the list session', () => {
  it('lists the default chip a page at a time, newest first, and stops at the total', async () => {
    const { s, settle, ids } = await listSession();
    expect(s.state.chip).toBe('outstanding');
    expect(s.rows).toMatchObject({ total: 6, hasMore: true, loading: false });
    expect(ids()).toEqual(['donation-12', 'donation-10', 'donation-9', 'donation-7', 'donation-4']);
    s.loadMore();
    await settle();
    expect(ids()).toHaveLength(6);
    expect(s.rows.hasMore).toBe(false);
  });

  it('applies chips, search, filters, and sort the way the server does', async () => {
    const { s, settle, ids } = await listSession('table');
    s.selectChip('paid');
    await settle();
    expect(s.rows.total).toBe(5);
    s.selectChip('mine');
    await settle();
    expect(s.rows.total).toBe(7);
    s.selectChip('all');
    s.search('meera');
    await settle();
    expect(ids()).toEqual(['donation-7', 'donation-1']);
    s.search('');
    s.applyFilters({ purpose: ['education'] });
    await settle();
    expect(s.rows.total).toBe(4);
    s.applyFilters({ amountFrom: '10000' });
    s.toggleSort('amount');
    await settle();
    expect(ids()).toEqual(['donation-8', 'donation-3', 'donation-10', 'donation-5']);
    s.toggleSort('amount');
    await settle();
    expect(ids()[0]).toBe('donation-5');
    s.applyFilters({ paidOnFrom: '2026-05-01', paidOnTo: '2026-08-31' });
    await settle();
    expect(ids()).toEqual(['donation-5', 'donation-3', 'donation-8']);
  });

  it('gives rows in Indian money format', async () => {
    const { s, spec, settle } = await listSession();
    s.selectChip('paid');
    await settle();
    const row = rowModel(spec, s.rows.items.find((r) => r.id === 'donation-5')!);
    expect(row).toMatchObject({ title: 'Fatima Sheikh', subtitle: '₹1,00,000.00 · Education', meta: 'DON/2026-27/00005', badge: { label: 'Paid' } });
  });
});

describe('memory gateway drives the record session', () => {
  it('opens, edits, and saves a record with a new version', async () => {
    const { g, s, saved, state } = await recordSession();
    await s.follow(state({ id: 'donation-2', panel: 'edit' }));
    expect(s.snapshot).toMatchObject({ loading: false, receipts: [], pending: null });
    expect(s.fields().map((f) => f.key)).toEqual(['amount', 'purpose', 'notes']);
    s.setValues({ ...s.snapshot.values, amount: '1750' });
    expect(s.isDirty(s.fields())).toBe(true);
    await s.save(s.fields());
    expect(s.snapshot.message).toBe('Your changes have been saved.');
    expect(saved.at(-1)).toMatchObject({ created: false, record: { id: 'donation-2', version: 2 } });
    expect(g.record('donation-2')!.data['amount']).toBe(1750);
  });

  it('runs a step that asks for fields and issues a receipt', async () => {
    const { g, s, state } = await recordSession();
    await s.follow(state({ id: 'donation-2', panel: 'step:markPaid' }));
    expect(s.fields().map((f) => f.key)).toEqual(['method', 'paidOn']);
    await s.step(s.currentStep()!, s.fields());
    expect(s.snapshot.errors).toEqual({ method: 'Method is required.', paidOn: 'Paid on is required.' });
    s.setValues({ ...s.snapshot.values, method: 'upi', paidOn: '2026-10-20' });
    await s.step(s.currentStep()!, s.fields());
    expect(s.snapshot.message).toBe('Mark as paid — receipt RCPT/2026-27/00006 issued.');
    expect(s.snapshot.record).toMatchObject({ status: 'paid', version: 2 });
    expect(s.snapshot.receipts.map((r) => r.amount)).toEqual(['1500.00']);
    expect(s.actions()!.edit).toBe(false);
    expect(g.record('donation-2')!.data).toMatchObject({ method: 'upi', paidOn: '2026-10-20' });
  });

  it('creates through the create steps; the server numbers it and copies the donor name', async () => {
    const { s, saved, state } = await recordSession();
    await s.follow(state({ create: 'new' }));
    expect(s.fields().map((f) => f.key)).toEqual(['donor']);
    expect(s.check(s.fields())).toBe(false);
    s.setValues({ ...s.snapshot.values, donor: 'donor-3' });
    expect(s.check(s.fields())).toBe(true);
    await s.follow(state({ create: 'new', createStep: '1' }));
    s.setValues({ ...s.snapshot.values, amount: '2500', purpose: 'health' });
    await s.create(s.fields());
    expect(saved.at(-1)).toMatchObject({ created: true, record: { number: 'DON/2026-27/00013', status: 'raised', data: { donorName: 'Sunita Patil', amount: 2500 } } });
    expect(s.snapshot.mode).toEqual({ kind: 'view' });
  });

  it('reports a version conflict and shows the latest record', async () => {
    const { g, s, state } = await recordSession();
    await s.follow(state({ id: 'donation-4', panel: 'edit' }));
    await g.records.update('donation', 'donation-4', { notes: 'Changed elsewhere' }, 1);
    s.setValues({ ...s.snapshot.values, amount: '900' });
    await s.save(s.fields());
    expect(s.snapshot.error).toMatch(/Someone else changed this record/);
    expect(s.snapshot.record).toMatchObject({ version: 2, data: { notes: 'Changed elsewhere', amount: 750 } });
  });

  it('sends a step for approval, and lets another person approve it', async () => {
    const { g, s, state } = await recordSession();
    await s.follow(state({ id: 'donation-7', panel: 'step:cancel' }));
    await s.step(s.currentStep()!, s.fields());
    expect(s.snapshot.message).toBe('"Cancel donation" has been sent for approval.');
    expect(s.snapshot.pending).toMatchObject({ transition: 'cancel', requestedBy: 'Asha Rao', canDecide: false });
    expect(g.record('donation-7')!.status).toBe('raised');

    await s.follow(state({ id: 'donation-10' }));
    expect(s.snapshot.pending).toMatchObject({ requestedBy: 'Vikram Iyer', approvalsGiven: 0, approvalsNeeded: 1, canDecide: true });
    await s.decide('approve');
    expect(s.snapshot.message).toBe('Approved and applied.');
    expect(s.snapshot.record!.status).toBe('cancelled');
  });

  it('loads related sections with their count and total, and reports records that cannot be opened', async () => {
    const g = memoryGateway();
    const spec = await specFor(g, 'donor');
    const failed: string[] = [];
    const s = new RecordSession(g.records, spec, () => ({ id: 'u1', roles: [] }), { saved: () => undefined, failed: (m) => failed.push(m) });
    await s.follow(parseListUrl((n) => (n === 'id' ? 'donor-1' : null), spec));
    expect(s.snapshot.related).toMatchObject([{ id: 'donations', count: 2, sum: 8000, error: '' }]);
    expect(s.snapshot.related[0]!.items.map((r) => r.id)).toEqual(['donation-7', 'donation-1']);
    await s.follow(parseListUrl((n) => (n === 'id' ? 'donor-99' : null), spec));
    expect(failed).toEqual(['This record does not exist or you cannot see it.']);
  });
});

describe('memory gateway: sign-in, inbox, builder', () => {
  it('signs in and out, and serves screen text with English fallback', async () => {
    const g = memoryGateway({ ...sampleSeed(), messages: { hi: { 'ui.common.save': 'HI-save' } } });
    await expect(g.auth.login({ tenant: 'seva', email: 'asha@example.org', password: 'wrong' })).rejects.toMatchObject({ code: 'invalid_credentials' });
    await g.auth.login({ tenant: 'seva', email: 'Vikram@example.org', password: 'treasurer of seva' });
    expect((await g.auth.me()).displayName).toBe('Vikram Iyer');
    const hi = await g.auth.messages('hi');
    expect(hi.locale).toBe('hi');
    expect(hi.messages['ui.common.save']).toBe('HI-save');
    expect(hi.messages['ui.common.cancel']).toBe('Cancel');
    await expect(g.auth.setLocale('xx')).rejects.toMatchObject({ code: 'invalid' });
    await g.auth.setLocale('ta');
    expect((await g.auth.messages()).locale).toBe('ta');
    expect((await g.auth.definitions()).locale).toBe('ta');
    await g.auth.logout();
    await expect(g.auth.me()).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('lists approvals and notifications for the signed-in person', async () => {
    const g = memoryGateway();
    expect((await g.inbox.approvals()).map((a) => [a.recordNumber, a.transitionLabel, a.requestedByName])).toEqual([['DON/2026-27/00010', 'Cancel donation', 'Vikram Iyer']]);
    expect(await g.inbox.notifications({ unreadOnly: true })).toHaveLength(1);
    await g.inbox.markRead('notification-1');
    expect(await g.inbox.notifications({ unreadOnly: true })).toHaveLength(0);
    expect(await g.inbox.decide('approval-1', 'reject', 'Keep it')).toEqual({ status: 'rejected' });
    expect(await g.inbox.decide('approval-1', 'approve')).toMatchObject({ status: 'stale' });
    expect(await g.inbox.approvals()).toEqual([]);
  });

  it('keeps drafts, publishes, patches shipped definitions, and rolls back', async () => {
    const g = memoryGateway();
    expect((await g.builder.catalogue()).map((c) => `${c.kind}/${c.key}/${c.owner}/v${c.publishedVersion}`)).toEqual([
      'recordType/donor/base/v1',
      'recordType/donation/base/v1',
      'workflow/donation/base/v1',
    ]);
    const detail = await g.builder.detail('recordType', 'donation');
    expect(detail.shipped).toMatchObject({ baseVersion: 1 });
    await g.builder.savePatch('recordType', 'donation', { fields: [{ key: 'amount', label: 'Gift amount' }] });
    expect((await g.builder.publishedRecordType('donation')).body.fields.find((f) => f.key === 'amount')!.label).toBe('Gift amount');
    expect((await g.auth.definitions()).recordTypes.find((t) => t.key === 'donation')!.version).toBe(2);

    await g.builder.saveDraft('recordType', 'volunteer', { key: 'volunteer', label: 'Volunteer', fields: [{ key: 'name', label: 'Name', type: 'text' }] });
    expect((await g.builder.detail('recordType', 'volunteer')).draft).toMatchObject({ version: 1 });
    await g.builder.publish('recordType', 'volunteer');
    await g.builder.saveDraft('recordType', 'volunteer', { key: 'volunteer', label: 'Volunteers', fields: [] });
    await g.builder.publish('recordType', 'volunteer');
    await g.builder.rollback('recordType', 'volunteer', 1);
    const v = await g.builder.detail('recordType', 'volunteer');
    expect(v.history.map((h) => [h.version, h.status])).toEqual([
      [3, 'published'],
      [2, 'superseded'],
      [1, 'superseded'],
    ]);
    expect(v.published!.body['label']).toBe('Volunteer');
    await expect(g.builder.detail('recordType', 'nothing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('gives the same answers to the same calls', async () => {
    const run = async () => {
      const g = memoryGateway();
      await g.records.create('donation', { donor: 'donor-2', amount: 999 });
      await g.records.transition('donation', 'donation-2', 'markPaid', { method: 'cash', paidOn: '2026-10-21' }, 1);
      return [await g.records.query('donation', { sort: { field: 'updatedAt', dir: 'desc' }, limit: 3 }), await g.records.receipts('donation', 'donation-2')];
    };
    expect(await run()).toEqual(await run());
  });
});
