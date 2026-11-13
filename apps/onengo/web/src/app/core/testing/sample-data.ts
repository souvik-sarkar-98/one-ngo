import type { JsonSchema } from '../builder/schema-form';
import type {
  InboxNotification,
  ListViewDef,
  Receipt,
  RecordView,
  RuntimeDefinitions,
  RuntimeRecordType,
  RuntimeWorkflow,
} from '../models';

/** A person in the sample organisation. */
export interface SampleUser {
  id: string;
  displayName: string;
  email: string;
  password: string;
  roles: string[];
  /** Active when left out. */
  status?: 'active' | 'invited' | 'suspended';
}

/** An approval request waiting in the sample organisation. */
export interface SampleApproval {
  id: string;
  recordType: string;
  recordId: string;
  transition: string;
  requestedBy: string;
  approvalsNeeded: number;
  approvalsGiven: number;
  status: 'pending' | 'approved' | 'rejected';
  /** Values sent with the step, applied when it is approved. */
  data: Record<string, unknown>;
  createdAt: string;
}

/** Everything the in-memory gateway starts from. */
export interface SampleSeed {
  tenant: { id: string; key: string; name: string };
  users: SampleUser[];
  /** Roles with their labels; the users' role keys when left out. Admin holds everything unless permissions are given. */
  roles?: { key: string; label: string; permissions?: string[]; requireTwoStep?: boolean }[];
  /** The signed-in person. */
  me: string;
  locale: string;
  definitions: RuntimeDefinitions;
  records: { record: RecordView; owner: string }[];
  receipts: Record<string, Receipt[]>;
  approvals: SampleApproval[];
  notifications: (InboxNotification & { userId: string })[];
  /** Workflow steps that issue a receipt, by record type. */
  receiptSteps: Record<string, string[]>;
  /** Shipped screen text by locale, over English. */
  messages: Record<string, Record<string, string>>;
  /** The time of the first change; each later change is one minute on. */
  now: string;
  /** Definition schemas by kind, for the Builder's visual editor. */
  schemas?: Record<string, JsonSchema>;
}

export const donorType: RuntimeRecordType = {
  key: 'donor',
  label: 'Donor',
  pluralLabel: 'Donors',
  titleField: 'name',
  version: 1,
  canCreate: true,
  canUpdate: true,
  numbering: { sequence: 'donor', format: 'DNR/{seq:4}', reset: 'never' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, searchable: true },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'pan', label: 'PAN', type: 'text', sensitive: true },
    { key: 'city', label: 'City', type: 'text', searchable: true },
  ],
};

export const donationType: RuntimeRecordType = {
  key: 'donation',
  label: 'Donation',
  pluralLabel: 'Donations',
  titleField: 'donorName',
  version: 1,
  canCreate: true,
  canUpdate: true,
  numbering: { sequence: 'donation', format: 'DON/{fy}/{seq:5}', reset: 'fiscal_year' },
  fields: [
    { key: 'donor', label: 'Donor', type: 'reference', referenceType: 'donor', required: true },
    { key: 'donorName', label: 'Donor name', type: 'text', copyFrom: { reference: 'donor', field: 'name' }, searchable: true },
    { key: 'amount', label: 'Amount', type: 'money', required: true, min: 1, editableWhen: "status == 'raised'" },
    {
      key: 'method',
      label: 'Method',
      type: 'choice',
      choices: [
        { value: 'upi', label: 'UPI' },
        { value: 'cash', label: 'Cash' },
        { value: 'cheque', label: 'Cheque' },
        { value: 'bank', label: 'Bank transfer' },
      ],
      visibleWhen: "status == 'paid'",
    },
    { key: 'paidOn', label: 'Paid on', type: 'date', visibleWhen: "status == 'paid'" },
    {
      key: 'purpose',
      label: 'Purpose',
      type: 'choice',
      choices: [
        { value: 'general', label: 'General fund' },
        { value: 'education', label: 'Education' },
        { value: 'health', label: 'Health' },
      ],
    },
    { key: 'anonymous', label: 'Anonymous', type: 'boolean' },
    { key: 'notes', label: 'Notes', type: 'longText' },
  ],
};

export const donationWorkflow: RuntimeWorkflow = {
  key: 'donation',
  recordType: 'donation',
  initial: 'raised',
  states: [
    { key: 'raised', label: 'Raised' },
    { key: 'paid', label: 'Paid', final: true },
    { key: 'cancelled', label: 'Cancelled', final: true, locked: true },
  ],
  transitions: [
    { key: 'markPaid', label: 'Mark as paid', from: ['raised'], to: 'paid', requiredFields: ['method', 'paidOn'], allowed: true },
    { key: 'cancel', label: 'Cancel donation', from: ['raised'], to: 'cancelled', approval: { roles: ['treasurer'], count: 1 }, allowed: true },
  ],
};

export const donationsView: ListViewDef = {
  key: 'donations',
  recordType: 'donation',
  label: 'Donations',
  pageSize: 5,
  layout: 'cards',
  chips: [
    { id: 'outstanding', label: 'Outstanding', statusIn: ['raised'] },
    { id: 'paid', label: 'Paid', statusIn: ['paid'] },
    { id: 'mine', label: 'Mine', owner: 'me' },
    { id: 'all', label: 'All' },
  ],
  defaultChip: 'outstanding',
  filters: ['method', 'paidOn', 'amount', 'purpose', 'anonymous'],
  row: { title: 'donorName', subtitle: ['amount', 'purpose'], meta: 'number', badge: 'status' },
  columns: ['number', 'donorName', 'amount', 'purpose', 'status'],
  detail: {
    sections: [{ id: 'donation', label: 'Donation', fields: ['number', 'status', 'donorName', 'amount', 'purpose', 'method', 'paidOn', 'anonymous', 'notes'] }],
  },
  create: {
    steps: [
      { key: 'donor', label: 'Donor', fields: ['donor'] },
      { key: 'gift', label: 'Gift', fields: ['amount', 'purpose', 'notes'] },
    ],
  },
  edit: { fields: ['amount', 'purpose', 'notes'] },
};

export const donorsView: ListViewDef = {
  key: 'donors',
  recordType: 'donor',
  label: 'Donors',
  pageSize: 20,
  columns: ['number', 'name', 'city'],
  row: { title: 'name', subtitle: ['city'], meta: 'number' },
  detail: {
    sections: [
      { id: 'donor', label: 'Donor', fields: ['number', 'name', 'phone', 'email', 'city'] },
      { id: 'donations', label: 'Donations', related: { recordType: 'donation', field: 'donor', total: 'amount' } },
    ],
  },
};

const DONORS: [name: string, city: string, phone: string][] = [
  ['Meera Krishnan', 'Chennai', '9840012345'],
  ['Rahul Banerjee', 'Kolkata', '9830023456'],
  ['Sunita Patil', 'Pune', '9820034567'],
  ['Arjun Reddy', 'Hyderabad', '9848045678'],
  ['Fatima Sheikh', 'Mumbai', '9819056789'],
  ['Karan Mehta', 'Delhi', '9811067890'],
];

type DonationRow = [donor: number, amount: number, status: 'raised' | 'paid' | 'cancelled', purpose: string, owner: string, paid?: [method: string, on: string]];

const DONATIONS: DonationRow[] = [
  [1, 5000, 'paid', 'education', 'u1', ['upi', '2026-04-12']],
  [2, 1500, 'raised', 'general', 'u1'],
  [3, 25000, 'paid', 'health', 'u2', ['bank', '2026-05-03']],
  [4, 750, 'raised', 'general', 'u2'],
  [5, 100000, 'paid', 'education', 'u1', ['cheque', '2026-06-21']],
  [6, 2000, 'cancelled', 'general', 'u2'],
  [1, 3000, 'raised', 'health', 'u1'],
  [2, 12000, 'paid', 'general', 'u2', ['upi', '2026-08-15']],
  [3, 500, 'raised', 'education', 'u1'],
  [4, 60000, 'raised', 'health', 'u2'],
  [5, 1000, 'paid', 'general', 'u1', ['cash', '2026-09-30']],
  [6, 8000, 'raised', 'education', 'u1'],
];

const day = (n: number) => new Date(Date.UTC(2026, 3, 1 + n, 9, 0, 0)).toISOString();
const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** A small Donations organisation: six donors and twelve donations in every status, one waiting for approval. */
export function sampleSeed(): SampleSeed {
  const records: SampleSeed['records'] = DONORS.map(([name, city, phone], i) => ({
    owner: 'u1',
    record: {
      id: `donor-${i + 1}`,
      type: 'donor',
      number: `DNR/${pad(i + 1, 4)}`,
      status: null,
      version: 1,
      schemaVersion: 1,
      data: { name, city, phone, email: `${name.split(' ')[0]!.toLowerCase()}@example.org` },
      createdAt: day(i),
      updatedAt: day(i),
    },
  }));
  const receipts: Record<string, Receipt[]> = {};
  let receiptNo = 0;
  DONATIONS.forEach(([donor, amount, status, purpose, owner, paid], i) => {
    const id = `donation-${i + 1}`;
    const createdAt = day(i * 15);
    records.push({
      owner,
      record: {
        id,
        type: 'donation',
        number: `DON/2026-27/${pad(i + 1, 5)}`,
        status,
        workflow: 'donation',
        version: paid ? 2 : 1,
        schemaVersion: 1,
        data: {
          donor: `donor-${donor}`,
          donorName: DONORS[donor - 1]![0],
          amount,
          purpose,
          ...(paid ? { method: paid[0], paidOn: paid[1] } : {}),
          ...(i === 8 ? { anonymous: true } : {}),
        },
        createdAt,
        updatedAt: paid ? `${paid[1]}T12:00:00.000Z` : createdAt,
      },
    });
    if (paid) {
      receiptNo++;
      receipts[id] = [{ id: `receipt-${receiptNo}`, number: `RCPT/2026-27/${pad(receiptNo, 5)}`, amount: amount.toFixed(2), date: paid[1], status: 'issued', voidReason: null }];
    }
  });
  const definitions: RuntimeDefinitions = {
    locale: 'en',
    theme: null,
    recordTypes: [donorType, donationType],
    workflows: { donation: donationWorkflow },
    workflowSets: { donation: [donationWorkflow] },
    listViews: { donor: donorsView, donation: donationsView },
    recordGroups: [{ key: 'fundraising', label: 'Fundraising', recordTypes: ['donor', 'donation'] }],
    actions: {},
    pages: [],
  };
  return structuredClone({
    tenant: { id: 't1', key: 'seva', name: 'Seva Trust' },
    users: [
      { id: 'u1', displayName: 'Asha Rao', email: 'asha@example.org', password: 'correct horse battery', roles: ['admin'] },
      { id: 'u2', displayName: 'Vikram Iyer', email: 'vikram@example.org', password: 'treasurer of seva', roles: ['treasurer'] },
    ],
    me: 'u1',
    locale: 'en',
    definitions,
    records,
    receipts,
    approvals: [
      {
        id: 'approval-1',
        recordType: 'donation',
        recordId: 'donation-10',
        transition: 'cancel',
        requestedBy: 'u2',
        approvalsNeeded: 1,
        approvalsGiven: 0,
        status: 'pending',
        data: {},
        createdAt: '2026-10-18T11:30:00.000Z',
      },
    ],
    notifications: [
      {
        id: 'notification-1',
        userId: 'u1',
        subject: 'Approval needed: DON/2026-27/00010',
        body: 'Vikram Iyer asks to cancel this donation.',
        recordId: 'donation-10',
        readAt: null,
        createdAt: '2026-10-18T11:30:00.000Z',
      },
      {
        id: 'notification-2',
        userId: 'u1',
        subject: 'Receipt issued: RCPT/2026-27/00005',
        body: 'Fatima Sheikh, ₹1,000.00.',
        recordId: 'donation-11',
        readAt: '2026-09-30T13:00:00.000Z',
        createdAt: '2026-09-30T12:00:00.000Z',
      },
    ],
    receiptSteps: { donation: ['markPaid'] },
    messages: {},
    now: '2026-10-20T10:00:00.000Z',
  });
}
