import { describe, expect, it } from 'vitest';
import { availableActions, createRecord, runStep, saveEdit } from './record/actions';
import { changedOnly, fieldModels, fromFormValues, missingRequired, toFormValues } from './record/forms';
import { preferredLayout, rememberLayout } from './list/layout';
import { detailSections, filterPills, rowModel } from './record/present';
import { criteriaToFilters, queryBody } from './list/query';
import { parseListUrl } from './list/url';
import { canCreateOn, resolveListSpec } from './spec';
import { donationType, donationsView, donationWorkflow, fakeGateway, paramsOf, record } from './gateway/testing';

const spec = resolveListSpec(donationType, donationWorkflow, donationsView);
const viewer = { id: 'u1', roles: [] };

describe('list spec', () => {
  it('generates a sensible list when no view is published', () => {
    const s = resolveListSpec(donationType, donationWorkflow);
    expect(s.chips.map((c) => c.id)).toEqual(['all', 'raised', 'paid']);
    expect(s.defaultChip).toBe('all');
    expect(s.filters.map((f) => f.field.key)).toEqual(['method', 'paidOn', 'anonymous']);
    expect(s.row.title).toBe('donorName');
    expect(s.sections[0]!.fields.slice(0, 2)).toEqual(['number', 'status']);
    expect(s.columns).toEqual(['number', 'donorName', 'amount', 'netAmount', 'status']);
  });

  it('uses the view columns without sensitive fields, and only sorts on real fields', () => {
    const s = resolveListSpec(donationType, donationWorkflow, { ...donationsView, columns: ['number', 'donorPan', 'amount', 'amount', 'bogus'] });
    expect(s.columns).toEqual(['number', 'amount', 'bogus']);
    expect(s.sortable).toEqual(['number', 'amount']);
    expect(spec.filters.map((f) => `${f.field.key}:${f.kind}`)).toEqual(['method:list', 'paidOn:dateRange', 'amount:range', 'anonymous:flag']);
  });

  it('allows create only on the configured chips', () => {
    expect(canCreateOn(spec, 'outstanding')).toBe(true);
    expect(canCreateOn(spec, 'mine')).toBe(false);
  });

  it('keeps a chip field condition and sends it with the list query', () => {
    const view = {
      ...donationsView,
      chips: [...donationsView.chips, { id: 'guest', label: 'Guest', filters: { donorType: { eq: 'guest' } } }],
    };
    const s = resolveListSpec(donationType, donationWorkflow, view);
    expect(s.chips.find((c) => c.id === 'guest')?.filters).toEqual({ donorType: { eq: 'guest' } });
    const state = parseListUrl(paramsOf({ chip: 'guest', method: 'upi' }), s);
    expect(queryBody(s, state, 0, 20).filters).toEqual({ donorType: { eq: 'guest' }, method: { in: ['upi'] } });
  });
});

describe('presentation', () => {
  it('builds rows with title, subtitle, meta, status badge, and table cells', () => {
    expect(rowModel(spec, record())).toMatchObject({
      title: 'Asha',
      subtitle: '₹1,500.00',
      meta: 'DON/2026-27/00001',
      badge: { label: 'Raised', tone: 'warning' },
      cells: [
        { key: 'number', label: 'Number', value: 'DON/2026-27/00001' },
        { key: 'donorName', label: 'Donor name', value: 'Asha' },
        { key: 'amount', label: 'Amount', value: '₹1,500.00' },
        { key: 'status', label: 'Status', value: 'Raised' },
      ],
    });
    expect(rowModel(spec, record({ status: 'paid' })).badge!.tone).toBe('success');
  });

  it('hides fields that are not visible in this state and lists receipts', () => {
    const s = detailSections(spec, record(), [{ id: 'rc', number: 'RCPT/1', amount: '1500.00', date: '2026-10-20', status: 'issued', voidReason: null }], viewer);
    expect(s.map((x) => x.id)).toEqual(['details', 'receipts']);
    expect(s[0]!.kind === 'fields' && s[0]!.fields.map((f) => f.label)).not.toContain('Method');
    expect(detailSections(spec, record({ status: 'paid' }), [], viewer)[0]).toMatchObject({ fields: expect.arrayContaining([{ label: 'Method', value: '—' }]) });
  });

  it('describes applied filters and converts them for the query', () => {
    const c = { method: ['upi', 'cash'], paidOnFrom: '2026-04-01', paidOnTo: '2026-04-30', amountFrom: '100', anonymous: false };
    expect(filterPills(spec.filters, c).map((p) => p.label)).toEqual(['Method: UPI, Cash', 'Paid on: 01 Apr 2026 – 30 Apr 2026', 'Amount: ₹100.00 – …', 'Anonymous: No']);
    expect(criteriaToFilters(spec.filters, c)).toEqual({
      method: { in: ['upi', 'cash'] },
      paidOn: { from: '2026-04-01', to: '2026-04-30' },
      amount: { from: 100, to: null },
      anonymous: { eq: false },
    });
  });
});

describe('forms follow field conditions', () => {
  it('hides fields whose visibleWhen is false and locks fields whose editableWhen is false', () => {
    const raised = fieldModels(donationType, ['donorName', 'amount', 'method', 'netAmount'], { donorName: 'A' }, 'raised', viewer);
    expect(raised.map((f) => f.key)).toEqual(['donorName', 'amount']);
    expect(raised.find((f) => f.key === 'amount')!.readOnly).toBe(false);
    const paid = fieldModels(donationType, ['amount', 'method', 'netAmount'], {}, 'paid', viewer, { calculated: true });
    expect(paid.map((f) => [f.key, f.readOnly])).toEqual([
      ['amount', true],
      ['method', false],
      ['netAmount', true],
    ]);
  });

  it('shows the fields a lookup fills as read only, and leaves its inputs editable', () => {
    const type = { ...donationType, lookups: [{ key: 'donor', connector: 'crm', inputs: ['donorName'], map: { method: 'method' } }] };
    const fields = fieldModels(type, ['donorName', 'method'], {}, 'paid', viewer);
    expect(fields.map((f) => [f.key, f.readOnly, f.help])).toEqual([
      ['donorName', false, undefined],
      ['method', true, 'Filled from the crm lookup.'],
    ]);
  });

  it('converts values both ways, sends only changes, and checks required fields', () => {
    expect(toFormValues(donationType, { amount: 250, anonymous: null }).amount).toBe('250');
    expect(fromFormValues(donationType, { amount: '250', donorName: ' Asha ', method: '', netAmount: '9', anonymous: true })).toEqual({
      amount: 250,
      donorName: 'Asha',
      method: null,
      anonymous: true,
    });
    expect(changedOnly({ donorName: 'Asha', amount: 250 }, { donorName: 'Asha', amount: 300, anonymous: false })).toEqual({ amount: 300 });
    const fields = fieldModels(donationType, ['donorName', 'amount'], {}, 'raised', viewer);
    expect(missingRequired(fields, { donorName: ' ', amount: '5' })).toEqual({ donorName: 'Donor name is required.' });
  });
});

describe('actions', () => {
  it('offers edit on the configured chips and the allowed steps for the state', () => {
    expect(availableActions(spec, record(), 'outstanding')).toEqual({
      edit: true,
      steps: [{ key: 'markPaid', label: 'Mark as paid', fields: ['method', 'paidOn'], approval: false, primary: true }],
    });
    expect(availableActions(spec, record(), 'mine').edit).toBe(false);
    expect(availableActions(spec, record({ status: 'paid' }), 'outstanding')).toEqual({ edit: false, steps: [] });
    expect(availableActions(spec, record()).edit).toBe(true);
  });

  it('sends only changed fields with the record version', async () => {
    const { gateway, calls } = fakeGateway();
    await saveEdit(gateway, spec, record(), { donorName: 'Asha S', amount: '1500', method: 'upi' }, ['donorName', 'amount']);
    expect(calls.at(-1)).toEqual({ op: 'update', args: ['donation', 'r1', { donorName: 'Asha S' }, 3] });
    const step = availableActions(spec, record()).steps[0]!;
    const res = await runStep(gateway, spec, record(), step, { method: 'upi', paidOn: '2026-10-21', donorName: 'Asha' }, step.fields);
    expect(calls.at(-1)).toEqual({ op: 'transition', args: ['donation', 'r1', 'markPaid', { method: 'upi', paidOn: '2026-10-21' }, 3] });
    expect(res.message).toBe('Mark as paid completed successfully.');
    await createRecord(gateway, spec, { donorName: 'New', amount: '75', method: '', anonymous: false }, spec.createKeys);
    expect(calls.at(-1)).toEqual({ op: 'create', args: ['donation', { donorName: 'New', amount: 75 }] });
  });
});

describe('layout choice', () => {
  it('remembers each person’s wide-screen layout per record type, falling back to the view default, then the table', () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(preferredLayout('demo', 'donation', undefined, store)).toBe('table');
    expect(preferredLayout('demo', 'donation', 'cards', store)).toBe('cards');
    rememberLayout('demo', 'donation', 'table', store);
    expect(preferredLayout('demo', 'donation', 'cards', store)).toBe('table');
    expect(preferredLayout('demo', 'shift', 'cards', store)).toBe('cards');
    expect(resolveListSpec(donationType, donationWorkflow).layout).toBe('table');
    expect(resolveListSpec(donationType, donationWorkflow, undefined, { startingLayout: 'cards' }).layout).toBe('cards');
    expect(resolveListSpec(donationType, donationWorkflow, { ...donationsView, layout: 'table' }, { startingLayout: 'cards' }).layout).toBe('table');
  });
});
