import { describe, expect, it } from 'vitest';
import type { ListViewDef, RecordView } from '../models';
import { memoryGateway } from '../testing/memory-gateway';
import { donationsView, donationType, donationWorkflow, donorsView, donorType } from '../testing/sample-data';
import { listPreview, sampleRecords, visibleDraft } from './list-preview';
import * as ops from './ops/list-view';

async function realRecords(type: string): Promise<RecordView[]> {
  const g = memoryGateway();
  return (await g.records.query(type, { limit: 50 })).items;
}

describe('list view live preview', () => {
  it('draws the draft, not the published list view, over the records given', async () => {
    const records = await realRecords('donation');
    let draft: ListViewDef = ops.setRow(structuredClone(donationsView), { title: 'number', subtitle: ['purpose'], meta: 'amount' });
    draft = ops.setFieldList(draft, 'columns', ['donorName', 'amount']);
    const p = listPreview({ draft, subject: { type: donationType, workflows: [donationWorkflow] }, records });
    const { rows, total } = await p.rows('outstanding');
    expect(total).toBe(records.filter((r) => r.status === 'raised').length);
    expect(rows[0]!.title).toMatch(/^DON\//);
    expect(rows[0]!.subtitle).toMatch(/General fund|Education|Health/);
    expect(rows[0]!.cells.map((c) => c.key)).toEqual(['donorName', 'amount', 'number', 'purpose', 'status']);
    expect(rows.every((r) => r.actions.length === 0)).toBe(true);
    expect(p.gateway.calls.filter((c) => c.port !== 'records')).toEqual([]);

    const changed = listPreview({ draft: ops.toggleChipStatus(draft, 0, 'paid', true), subject: { type: donationType, workflows: [donationWorkflow] }, records });
    expect((await changed.rows('outstanding')).total).toBe(records.filter((r) => r.status !== 'cancelled').length);
  });

  it('shows the record panel sections of the draft, with related records and their total', async () => {
    const donors = await realRecords('donor');
    const donations = await realRecords('donation');
    const draft = ops.setSectionLabel(structuredClone(donorsView), 1, 'Gifts');
    const p = listPreview({
      draft,
      subject: { type: donorType },
      others: [{ type: donationType, workflows: [donationWorkflow], view: donationsView }],
      records: [...donors, ...donations],
    });
    const sections = await p.panel('donor-1');
    expect(sections.map((s) => s.title)).toEqual(['Donor', expect.stringMatching(/^Gifts · 2 · ₹/)]);
    expect(sections[0]).toMatchObject({ kind: 'fields', fields: expect.arrayContaining([{ label: 'Name', value: 'Meera Krishnan' }]) });
  });

  it('gives the create form as one page or as the draft steps', () => {
    const records = sampleRecords(donationType, donationWorkflow);
    const subject = { type: donationType, workflows: [donationWorkflow] };
    const steps = listPreview({ draft: donationsView, subject, records }).create();
    expect(steps.map((s) => [s.label, s.fields.map((f) => f.key)])).toEqual([
      ['Donor', ['donor']],
      ['Gift', ['amount', 'purpose', 'notes']],
    ]);
    const page = listPreview({ draft: ops.setCreateMode(donationsView, 'page'), subject, records }).create();
    expect(page).toHaveLength(1);
    expect(page[0]!.fields.map((f) => f.key)).toEqual(['donor', 'amount', 'purpose', 'notes']);
  });

  it('shows only the records that match a chip field condition', async () => {
    const records = sampleRecords(donationType, donationWorkflow).map((r, i) => ({
      ...r,
      data: { ...r.data, donorType: i % 2 === 0 ? 'guest' : 'member' },
    }));
    const draft: ListViewDef = {
      ...donationsView,
      chips: [...donationsView.chips, { id: 'guest', label: 'Guest', filters: { donorType: { eq: 'guest' } } }],
    };
    const { total } = await listPreview({ draft, subject: { type: donationType, workflows: [donationWorkflow] }, records }).rows('guest');
    expect(total).toBe(records.filter((r) => r.data.donorType === 'guest').length);
  });

  it('makes sample records in every state when there are no real ones', async () => {
    const records = sampleRecords(donationType, donationWorkflow);
    expect(records).toHaveLength(4);
    expect(new Set(records.map((r) => r.status))).toEqual(new Set(['raised', 'paid', 'cancelled']));
    expect(records[0]!.data).toMatchObject({ donorName: 'Asha Rao', amount: 1500 });
    expect(records[0]!.data).not.toHaveProperty('donor');
    const p = listPreview({ draft: donationsView, subject: { type: donationType, workflows: [donationWorkflow] }, records });
    expect((await p.rows('all')).total).toBe(4);
    expect((await p.panel(records[0]!.id))[0]).toMatchObject({ title: 'Donation' });
  });

  it('leaves out chips and sections the person previewed may not see', () => {
    let draft = ops.setChipPermission(structuredClone(donationsView), 1, 'donation:paid:read');
    draft = ops.setSectionPermission(ops.addSection(draft, 'fields', 'Notes'), 1, 'donation:notes:read');
    expect(visibleDraft(draft, ['record:donation:read']).chips!.map((c) => c.id)).toEqual(['outstanding', 'mine', 'all']);
    expect(visibleDraft(draft, ['record:donation:read']).detail!.sections).toHaveLength(1);
    expect(visibleDraft(draft, ['*'])).toEqual(draft);
    expect(visibleDraft(draft)).toBe(draft);
    const p = listPreview({ draft, subject: { type: donationType, workflows: [donationWorkflow] }, records: [], permissions: ['donation:notes:read'] });
    expect(p.spec.chips.map((c) => c.id)).toEqual(['outstanding', 'mine', 'all']);
    expect(p.spec.sections.map((s) => s.label)).toEqual(['Donation', 'Notes']);
  });
});
