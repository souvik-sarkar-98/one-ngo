import { describe, expect, it } from 'vitest';
import { projectDefinitions, sampleNumber, type GuideDefinitions } from './project';
import type { GuideChapter, StageScreen } from './model';

/** A trimmed copy of the signed-in definition for Demo Foundation: two record types, one workflow, actions and one page. */
const defs: GuideDefinitions = {
  theme: { brand: '#738a1e' },
  recordGroups: [{ key: 'fundraising', label: 'Fundraising', recordTypes: ['donor', 'donation'] }],
  recordTypes: [
    {
      key: 'donor',
      label: 'Donor',
      pluralLabel: 'Donors',
      description: 'People and organisations who give, with their totals.',
      titleField: 'name',
      numbering: { format: 'DNR/{seq:5}' },
      canCreate: true,
      canUpdate: true,
      fields: [
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
        { key: 'pan', label: 'PAN', sensitive: true },
        { key: 'city', label: 'City' },
        { key: 'totalGiven', label: 'Total given', rollup: {} },
      ],
    },
    {
      key: 'donation',
      label: 'Donation',
      pluralLabel: 'Donations',
      titleField: 'donorName',
      numbering: { format: 'DON/{fy}/{seq:5}' },
      canCreate: true,
      canUpdate: true,
      fields: [
        { key: 'donor', label: 'Donor' },
        { key: 'donorName', label: 'Donor name' },
        { key: 'donorPan', label: 'Donor PAN', sensitive: true },
        { key: 'amount', label: 'Amount' },
        { key: 'method', label: 'Payment method' },
        { key: 'paidOn', label: 'Paid on' },
        { key: 'fee', label: 'Processing fee' },
        { key: 'notes', label: 'Notes' },
      ],
    },
  ],
  workflows: {
    donation: {
      key: 'donation',
      recordType: 'donation',
      initial: 'raised',
      states: [
        { key: 'raised', label: 'Raised' },
        { key: 'paid', label: 'Paid' },
        { key: 'cancelled', label: 'Cancelled' },
      ],
      transitions: [
        { key: 'markPaid', label: 'Mark as paid', from: ['raised'], requiredFields: ['method', 'paidOn'], allowed: true },
        { key: 'cancel', label: 'Cancel', from: ['raised'], allowed: true },
      ],
    },
  },
  listViews: {
    donor: {
      key: 'donors',
      label: 'Donors',
      chips: [{ id: 'all', label: 'All' }],
      defaultChip: 'all',
      columns: ['name', 'email', 'phone', 'city'],
      filters: ['city'],
      create: { fields: ['name', 'email', 'phone', 'pan', 'city'] },
      edit: { fields: ['name', 'email', 'phone', 'pan', 'city'] },
      detail: {
        sections: [
          { id: 'donor', label: 'Donor', fields: ['name', 'email', 'phone', 'pan', 'city', 'totalGiven'] },
          { id: 'donations', label: 'Donations', related: { recordType: 'donation', field: 'donor' } },
        ],
      },
    },
    donation: {
      key: 'donations',
      label: 'Donations',
      chips: [
        { id: 'mine', label: 'Mine' },
        { id: 'outstanding', label: 'Outstanding' },
        { id: 'closed', label: 'Closed' },
      ],
      defaultChip: 'outstanding',
      columns: ['number', 'donorName', 'amount', 'method', 'paidOn', 'status'],
      filters: ['method', 'paidOn', 'amount'],
      create: { chips: ['outstanding'], steps: [
        { key: 'donor', label: 'Donor', fields: ['donor', 'donorName', 'donorPan'] },
        { key: 'details', label: 'Details', fields: ['amount', 'fee', 'notes'] },
      ] },
      detail: {
        sections: [
          { id: 'donation', label: 'Donation', fields: ['number', 'amount', 'fee'] },
          { id: 'donor', label: 'Donor', fields: ['donorName', 'donorPan'] },
        ],
      },
    },
  },
  actions: {
    donation: [
      { key: 'payNow', label: 'Pay now', when: "status == 'raised'", placement: ['panel'], allowed: true },
      { key: 'printReceipt', label: 'Print receipt', when: "status == 'paid'", placement: ['panel', 'row'], allowed: true },
      {
        key: 'sendReminder',
        label: 'Send reminder',
        when: "status == 'raised' and not isEmpty(record.donorEmail)",
        confirm: 'Send a payment reminder to the donor by email?',
        placement: ['panel', 'row', 'bulk'],
        allowed: true,
      },
    ],
  },
  pages: [
    {
      key: 'demo',
      label: 'demo',
      widgets: [
        { type: 'chart', label: 'Chart', field: 'amount', measure: 'sum', chart: 'bar' },
        { type: 'list', label: 'Number', listView: 'donations' },
      ],
    },
  ],
};

function chapter(id: string): GuideChapter {
  const found = projectDefinitions(defs)?.chapters.find((item) => item.id === id);
  if (!found) throw new Error(`No chapter ${id}`);
  return found;
}

/** Every line label and value drawn on a screen, for checking what appears. */
function drawn(screen: StageScreen): string {
  const lines = (screen.kind === 'panel' ? [...screen.lines, ...(screen.sections ?? []).flatMap((section) => section.lines)] : []).map(
    (line) => `${line.label} ${line.value}`,
  );
  return [JSON.stringify(screen), ...lines].join(' ');
}

describe('sample numbers', () => {
  it('fills the fiscal year and the sequence with a first-record sample', () => {
    expect(sampleNumber('DON/{fy}/{seq:5}')).toBe('DON/2026-27/00001');
    expect(sampleNumber('DNR/{seq:5}')).toBe('DNR/00001');
    expect(sampleNumber(undefined)).toBe('');
  });
});

describe('projectDefinitions', () => {
  it('produces no records section for a definition without record types', () => {
    expect(projectDefinitions({ recordTypes: [], workflows: {} })).toBeNull();
  });

  it('lists the record groups in definition order, with Donors before Donations', () => {
    const overview = chapter('groups');
    const screen = overview.steps[0]!.screen;
    expect(screen).toEqual(expect.objectContaining({ kind: 'home', groups: [{ name: 'Fundraising', types: ['Donors', 'Donations'] }] }));
    expect(overview.steps[0]!.highlight).toBe('nav:records');
  });

  it('opens a type list on its default chip and outlines that chip', () => {
    const list = chapter('donation').steps[0]!;
    expect(list.highlight).toBe('chip:Outstanding');
    expect(list.screen).toEqual(expect.objectContaining({ kind: 'list', chip: 'Outstanding', chips: ['Mine', 'Outstanding', 'Closed'] }));
  });

  it('shows one placeholder row numbered from the format with the initial status', () => {
    const list = chapter('donation').steps[0]!.screen;
    expect(list.kind === 'list' && list.rows).toEqual([expect.objectContaining({ meta: 'DON/2026-27/00001', status: 'Raised' })]);
  });

  it('offers Mark as paid from the initial state, asking for the required fields', () => {
    const step = chapter('donation').steps.find((item) => item.highlight === 'action:Mark as paid');
    expect(step?.screen).toEqual(
      expect.objectContaining({
        kind: 'panel',
        primary: 'Mark as paid',
        sections: [{ label: 'Required', lines: [{ label: 'Payment method', value: '' }, { label: 'Paid on', value: '' }] }],
      }),
    );
  });

  it('shows Pay now while the status is Raised, and Print receipt only once Paid', () => {
    const pay = chapter('donation').steps.find((item) => item.highlight === 'action:Pay now');
    const print = chapter('donation').steps.find((item) => item.highlight === 'action:Print receipt');
    expect(pay?.screen.kind === 'panel' && pay.screen.sections?.[0]?.lines[0]).toEqual({ label: 'Status', value: 'Raised' });
    expect(print?.screen.kind === 'panel' && print.screen.sections?.[0]?.lines[0]).toEqual({ label: 'Status', value: 'Paid' });
  });

  it('adds the send-reminder confirm line and a bulk step when placement includes bulk', () => {
    const steps = chapter('donation').steps.filter((item) => item.highlight === 'action:Send reminder');
    expect(steps.some((item) => item.screen.kind === 'panel' && item.screen.confirm?.startsWith('Send a payment reminder'))).toBe(true);
    expect(steps.some((item) => item.screen.kind === 'list' && item.screen.bulk?.includes('Send reminder'))).toBe(true);
  });

  it('outlines + on the list, then the create form steps', () => {
    const donation = chapter('donation');
    expect(donation.steps.some((item) => item.highlight === 'fab')).toBe(true);
    expect(donation.steps.some((item) => item.highlight === 'action:Next')).toBe(true);
    expect(donation.steps.some((item) => item.highlight === 'action:Create')).toBe(true);
  });

  it('draws the donor create form, and + on the donations list only where creating is offered', () => {
    const donor = chapter('donor');
    expect(donor.steps.some((item) => item.highlight === 'action:Create')).toBe(true);
    const list = chapter('donation').steps.find((item) => item.highlight === 'fab')?.screen;
    expect(list?.kind === 'list' && list.fab).toBe(true);
  });

  it('never draws a sensitive field such as PAN', () => {
    const everything = projectDefinitions(defs)!.chapters.flatMap((item: GuideChapter) => item.steps.map((step) => drawn(step.screen)));
    for (const text of everything) {
      expect(text).not.toMatch(/\bPAN\b/);
      expect(text).not.toMatch(/Donor PAN/);
    }
  });

  it('draws the page widgets from their labels and list views, without values', () => {
    const page = chapter('pages').steps[0]!.screen;
    expect(page).toEqual(
      expect.objectContaining({
        kind: 'home',
        greeting: 'demo',
        groups: [
          { name: 'Chart', types: ['Bar chart of amount'] },
          { name: 'Number', types: ['Short list from Donations'] },
        ],
      }),
    );
  });

  it('draws the related Donations section of a donor', () => {
    const open = chapter('donor').steps.find((item) => item.highlight === 'row')?.screen;
    expect(open?.kind === 'panel' && open.sections?.some((section) => section.label === 'Donations')).toBe(true);
  });
});
