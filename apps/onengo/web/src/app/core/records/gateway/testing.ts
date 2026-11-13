import type { ListViewDef, RecordQueryBody, RecordView, RuntimeRecordType, RuntimeWorkflow } from '../../models';
import type { RecordsGateway } from './gateway';

/** Shared fixtures for the records tests. */
export const donationType: RuntimeRecordType = {
  key: 'donation',
  label: 'Donation',
  pluralLabel: 'Donations',
  titleField: 'donorName',
  version: 1,
  canCreate: true,
  canUpdate: true,
  numbering: { sequence: 'donation', format: 'DON/{fy}/{seq:5}' },
  fields: [
    { key: 'donorName', label: 'Donor name', type: 'text', required: true },
    { key: 'donorPan', label: 'PAN', type: 'text', sensitive: true },
    { key: 'amount', label: 'Amount', type: 'money', required: true, editableWhen: "status == 'raised'" },
    {
      key: 'method',
      label: 'Method',
      type: 'choice',
      choices: [
        { value: 'upi', label: 'UPI' },
        { value: 'cash', label: 'Cash' },
      ],
      visibleWhen: "status == 'paid'",
    },
    { key: 'paidOn', label: 'Paid on', type: 'date', visibleWhen: "status == 'paid'" },
    { key: 'anonymous', label: 'Anonymous', type: 'boolean' },
    { key: 'netAmount', label: 'Net', type: 'money', calculated: 'record.amount' },
  ],
};

export const donationWorkflow: RuntimeWorkflow = {
  key: 'donation',
  recordType: 'donation',
  initial: 'raised',
  states: [
    { key: 'raised', label: 'Raised' },
    { key: 'paid', label: 'Paid', final: true },
  ],
  transitions: [
    { key: 'markPaid', label: 'Mark as paid', from: ['raised'], to: 'paid', requiredFields: ['method', 'paidOn'], allowed: true },
    { key: 'hidden', label: 'Not allowed', from: ['raised'], to: 'paid', allowed: false },
  ],
};

export const donationsView: ListViewDef = {
  key: 'donations',
  recordType: 'donation',
  pageSize: 12,
  chips: [
    { id: 'mine', label: 'Mine', owner: 'me' },
    { id: 'outstanding', label: 'Outstanding', statusIn: ['raised'] },
  ],
  defaultChip: 'outstanding',
  filters: ['method', 'paidOn', 'amount', 'anonymous', 'donorPan'],
  row: { title: 'donorName', subtitle: ['amount'], meta: 'number', badge: 'status' },
  columns: ['number', 'donorName', 'amount', 'status'],
  create: {
    steps: [
      { key: 'donor', label: 'Donor', fields: ['donorName'] },
      { key: 'details', label: 'Details', fields: ['amount', 'method'] },
    ],
    chips: ['outstanding'],
  },
  edit: { fields: ['donorName', 'amount', 'method'], chips: ['outstanding'] },
};

export const record = (over: Partial<RecordView> = {}): RecordView => ({
  id: 'r1',
  type: 'donation',
  number: 'DON/2026-27/00001',
  status: 'raised',
  version: 3,
  schemaVersion: 1,
  data: { donorName: 'Asha', amount: 1500 },
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
  ...over,
});

export interface Call {
  op: string;
  args: unknown[];
}

/** A gateway that records calls and serves `total` numbered records. */
export function fakeGateway(total = 41) {
  const calls: Call[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const gateway: RecordsGateway = {
    query: async (t, body: RecordQueryBody) => {
      calls.push({ op: 'query', args: [t, body] });
      if (hold) await new Promise<void>((r) => (release = r));
      const offset = body.offset ?? 0;
      const n = Math.max(0, Math.min(body.limit ?? 20, total - offset));
      return { items: Array.from({ length: n }, (_, i) => record({ id: `r${offset + i + 1}` })), total };
    },
    get: async (_t, id) => record({ id }),
    create: async (t, data) => {
      calls.push({ op: 'create', args: [t, data] });
      return { record: record({ id: 'new', data }), receipts: [], journalEntryIds: [] };
    },
    update: async (t, id, data, v) => {
      calls.push({ op: 'update', args: [t, id, data, v] });
      return { record: record({ data: { ...record().data, ...data }, version: v + 1 }), receipts: [], journalEntryIds: [] };
    },
    transition: async (t, id, step, data, v) => {
      calls.push({ op: 'transition', args: [t, id, step, data, v] });
      return { record: record({ status: 'paid', data: { ...record().data, ...data }, version: v + 1 }), receipts: [], journalEntryIds: [] };
    },
    runAction: async (t, id, action, input, v) => {
      calls.push({ op: 'runAction', args: [t, id, action, input, v] });
      return { record: record({ id, version: v + 1 }), message: `${action}: done.`, ...(action === 'print' ? { open: '/print/receipt/rc' } : {}) };
    },
    receipts: async () => [{ id: 'rc', number: 'RCPT/1', amount: '1500.00', date: '2026-10-20', status: 'issued', voidReason: null }],
    createReceiptLink: async (id) => ({ path: `/r/${id}` }),
    revokeReceiptLink: async () => undefined,
    printReceipt: async (id) => ({
      receipt: { id, number: 'RCPT/1', amount: '1500.00', date: '2026-10-20', status: 'issued', voidReason: null, seriesKey: 'donation', recordId: 'r1' },
      series: { key: 'donation', label: 'Donation receipt', prefix: 'RCPT' },
      record: record(),
      recordType: { key: 'donation', label: 'Donation', titleField: 'donorName' },
      organisation: { name: 'Demo Foundation' },
    }),
    pendingApproval: async () => null,
    decide: async () => ({ status: 'approved' }),
  };
  return {
    gateway,
    calls,
    /** Makes queries wait until `resume` is called. */
    holdQueries: () => {
      hold = true;
    },
    resume: () => {
      hold = false;
      release?.();
    },
  };
}

/** Parameters from a query-string-like map. */
export const paramsOf = (p: Record<string, string | null>) => (name: string) => p[name] ?? null;
