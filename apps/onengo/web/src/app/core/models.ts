export type FieldType =
  | 'text'
  | 'longText'
  | 'number'
  | 'money'
  | 'date'
  | 'boolean'
  | 'choice'
  | 'email'
  | 'phone'
  | 'reference'
  /** A member of the organisation, stored as their user id; records arrive with `{ id, name }`. */
  | 'person'
  | 'multiChoice'
  | 'file'
  | 'location'
  | 'signature'
  | 'richText';

export type FileKind = 'image' | 'pdf' | 'document' | 'spreadsheet';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  choices?: { value: string; label: string }[];
  referenceType?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  calculated?: string;
  sensitive?: boolean;
  searchable?: boolean;
  help?: string;
  /** Grey example text shown in an empty field. */
  placeholder?: string;
  visibleWhen?: string;
  editableWhen?: string;
  /** Filled from the record chosen in a reference field of this record type whenever that choice changes. */
  copyFrom?: { reference: string; field: string };
  unique?: boolean;
  /** Regular expression the whole value must match; `patternMessage` is shown when it does not. */
  pattern?: string;
  patternMessage?: string;
  /** Kept up to date by the server from child records; read-only like calculated fields. */
  rollup?: { recordType: string; reference: string; measure: 'count' | 'sum'; field?: string; where?: string };
  /** File fields: several files, the accepted kinds and the largest file in megabytes. */
  multiple?: boolean;
  accept?: FileKind[];
  maxSizeMb?: number;
  /** Location fields: false when people must use the device location and may not type coordinates. */
  typedCoordinates?: boolean;
  /** Signature fields: ask for the signer's typed name. */
  typedName?: boolean;
}

export type ListLayout = 'cards' | 'table';

/** How many columns a form uses on wide screens; phones always use one. */
export type FormColumns = 1 | 2 | 3;

/** A form's wide-screen layout: its column count and the fields that take a whole row. */
export interface FormLayout {
  columns: FormColumns;
  fullWidth: string[];
}

export interface FieldSectionDef {
  id?: string;
  label: string;
  /** Shown only to people with this permission. */
  permission?: string;
  fields: string[];
}

/** The records of another type that point at this one through `field`; `total` is a number or money field to add up. */
export interface RelatedSectionDef {
  id?: string;
  label: string;
  permission?: string;
  related: { recordType: string; field: string; total?: string };
}

export type ListViewSection = FieldSectionDef | RelatedSectionDef;

/** Mirrors the server's listView definition kind. */
export interface ListViewDef {
  key: string;
  recordType: string;
  label?: string;
  pageSize?: number;
  layout?: ListLayout;
  columns?: string[];
  compactColumns?: string[];
  chips?: {
    id: string;
    label: string;
    statusIn?: string[];
    workflowState?: { workflow: string; in: string[] };
    owner?: 'me';
    shared?: boolean;
    /** Fixed field condition for this chip, for example `{ donorType: { eq: 'guest' } }`. */
    filters?: Record<string, FieldFilter>;
    permission?: string;
  }[];
  defaultChip?: string;
  filters?: string[];
  row?: { title?: string; subtitle?: string[]; meta?: string; badge?: string };
  detail?: { sections: ListViewSection[] };
  create?: {
    fields?: string[];
    steps?: { key: string; label: string; fields: string[] }[];
    columns?: FormColumns;
    fullWidth?: string[];
    presets?: { param: string; field: string }[];
    chips?: string[];
  };
  edit?: { fields?: string[]; chips?: string[]; columns?: FormColumns; fullWidth?: string[] };
}

export interface FieldFilter {
  in?: (string | number | boolean)[];
  eq?: string | number | boolean | null;
  from?: string | number | null;
  to?: string | number | null;
}

export interface RecordQueryBody {
  statusIn?: string[];
  owner?: 'me';
  /** Only records shared with the person or one of their roles. */
  sharedWithMe?: true;
  search?: string;
  filters?: Record<string, FieldFilter>;
  sort?: { field: string; dir: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  /** Number or money fields to add up over every matching record. */
  sum?: string[];
}

export interface QueryResult {
  items: RecordView[];
  total: number;
  sums?: Record<string, number>;
}

export interface RecordTypeBody {
  key: string;
  label: string;
  pluralLabel?: string;
  description?: string;
  numbering?: { sequence: string; format: string; reset?: 'fiscal_year' | 'never' };
  titleField?: string;
  /** `restricted`: people see their own records, records shared with them, and all only with record:<type>:read:all. */
  visibility?: 'organisation' | 'restricted';
  fields: FieldDef[];
  rules?: { key: string; when?: string; expression: string; message: string }[];
  /** Values an http connector looks up while the record saves: `map` is field → the connector's answer value. */
  lookups?: { key: string; connector: string; inputs: string[]; map: Record<string, string> }[];
}

export interface ApprovalDef {
  roles?: string[];
  users?: string[];
  count?: number;
  when?: string;
}

export interface TransitionDef {
  key: string;
  label: string;
  from: string[];
  to: string;
  guard?: string;
  guardMessage?: string;
  requiredFields?: string[];
  permission?: string;
  approval?: ApprovalDef;
}

export interface WorkflowBody {
  key: string;
  recordType: string;
  /** Primary workflows hold the record's status; parallel ones run beside it. Default primary. */
  role?: 'primary' | 'parallel';
  appliesWhen?: string;
  startsWhen?: string;
  initial: string;
  states: { key: string; label: string; final?: boolean; locked?: boolean }[];
  transitions: TransitionDef[];
}

export interface RuntimeRecordType extends RecordTypeBody {
  version: number;
  canCreate: boolean;
  canUpdate: boolean;
}

export interface RuntimeWorkflow extends WorkflowBody {
  transitions: (TransitionDef & { allowed: boolean })[];
}

export interface ThemeTokens {
  key: string;
  label?: string;
  brand?: string;
  brandForeground?: string;
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  line?: string;
  radius?: string;
}

/** Record types for menus and Home, already limited to what the person can read; types in no group come last. */
export interface RuntimeRecordGroup {
  key: string;
  label: string;
  recordTypes: string[];
}

export type ActionPlacement = 'panel' | 'row' | 'bulk';

/** A field on an action's small form; its value is available to the action as `input.<key>`. */
export type ActionField = Pick<FieldDef, 'key' | 'label' | 'type' | 'required' | 'choices' | 'referenceType' | 'min' | 'max' | 'maxLength' | 'help' | 'placeholder'>;

/** A configured record action. Step settings stay on the server; only each step's kind is sent. */
export interface RuntimeAction {
  key: string;
  recordType: string;
  label: string;
  placement: ActionPlacement[];
  when?: string;
  permission?: string;
  confirm?: string;
  form?: { fields: ActionField[]; columns?: FormColumns; fullWidth?: string[] };
  steps: { type: string }[];
  allowed: boolean;
}

export interface WidgetView {
  chip?: string;
  filters?: Record<string, FieldFilter>;
  owner?: 'me';
}

/** `index` is the widget's place in the published page, sent back when asking for its counts. */
export type PageWidget = { index?: number; permission?: string } & (
  | { type: 'groups' }
  | { type: 'stat'; label: string; recordType: string; view?: WidgetView; measure: 'count' | 'sum'; field?: string }
  | {
      type: 'chart';
      label: string;
      recordType: string;
      view?: WidgetView;
      measure: 'count' | 'sum';
      field?: string;
      groupBy: { field: string } | { period: 'day' | 'week' | 'month' | 'financialYear'; dateField: string };
      chart: 'bar' | 'line';
    }
  | { type: 'list'; label: string; listView: string; view?: WidgetView; limit: number }
  | { type: 'links'; label: string; items: { label: string; to: string; permission?: string }[] }
);

export interface PageDef {
  key: string;
  label: string;
  audience?: string[];
  widgets: PageWidget[];
}

export interface RuntimeDefinitions {
  locale?: string;
  theme: ThemeTokens | null;
  recordTypes: RuntimeRecordType[];
  /** The primary workflow per record type. */
  workflows: Record<string, RuntimeWorkflow>;
  /** Every workflow per record type, primary first. */
  workflowSets?: Record<string, RuntimeWorkflow[]>;
  /** List view per record type; missing types get a generated default. */
  listViews?: Record<string, ListViewDef>;
  recordGroups?: RuntimeRecordGroup[];
  /** Configured record actions per record type. */
  actions?: Record<string, RuntimeAction[]>;
  pages?: PageDef[];
  /** The published navigation order. Absent, the shell uses its default destinations. `icons` overrides a destination's own icon. */
  navigation?: { items: string[]; icons?: Record<string, string> };
  /** Where a wide-screen list opens before a person chooses. Absent, lists open as a table. */
  listLayout?: ListLayout;
}

export interface Me {
  userId: string;
  displayName: string;
  email: string | null;
  twoStepEnabled: boolean;
  tenant: { id: string; key: string; name: string; logo?: string | null };
  roles: string[];
  /** The same roles by name, in the same order, for the profile to show. */
  roleNames?: string[];
  permissions: string[];
  capabilities: {
    configure: boolean;
    publish: boolean;
    scripts: boolean;
    money: boolean;
    /** `people:read`: the read-only directory. */
    peopleDirectory?: boolean;
    /** `members:manage`. */
    people?: boolean;
    roles?: boolean;
    connectors?: boolean;
    apiKeys?: boolean;
    jobs?: boolean;
    audit?: boolean;
    settings?: boolean;
    /** `data:migrate`: bring in CSV files of another system. */
    migration?: boolean;
    /** `data:migrate:books`: the opening journal and receipt numbers of a migration. */
    migrationBooks?: boolean;
  };
  locale?: string;
}

export interface RecordView {
  id: string;
  type: string;
  number: string | null;
  status: string | null;
  version: number;
  schemaVersion: number;
  data: Record<string, unknown>;
  /** The primary workflow the record follows. */
  workflow?: string | null;
  /** States of parallel workflows that have started, by workflow key. */
  states?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  /** Reference fields holding a readable record, by field key, with that record's label. */
  references?: Record<string, { id: string; label: string }>;
  /** Set on records of restricted types the person may share. */
  canShare?: true;
}

export interface Receipt {
  id: string;
  number: string;
  amount: string;
  date: string;
  status: 'issued' | 'void';
  voidReason: string | null;
}

export interface SaveResult {
  record: RecordView;
  receipts: Receipt[];
  journalEntryIds: string[];
  approvalRequestId?: string;
}

/** The result of a configured action; `open` is where the app goes next, such as the print view or a payment link. */
export interface ActionRunResult {
  record: RecordView;
  message: string;
  open?: string;
}

/** What the receipt print view shows, as the server sends it. */
export interface ReceiptPrint {
  receipt: Receipt & { seriesKey: string; recordId: string | null };
  series: { key: string; label: string; prefix: string };
  record: RecordView;
  recordType: { key: string; label: string; titleField: string | null };
  organisation: { name: string };
  /** Who issued the receipt, as kept when it was issued; `logoUrl` is same-origin and needs the sign-in. */
  issuer?: ReceiptIssuer;
  /** `issued`: the identity kept with the receipt; `current`: the receipt predates kept identities. */
  issuerSource?: 'issued' | 'current';
  /** Set when this receipt has a live public link. */
  publicLink?: string | null;
  /** Wording kept when the receipt was issued. Absent on older receipts. */
  content?: { title: string; statement: string | null; rows: { label: string; value: string }[]; clauses: string[]; thanks: string } | null;
}

export interface ReceiptIssuer {
  displayName: string;
  legalName: string | null;
  contact: { email: string | null; phone: string | null; website: string | null };
  address: { line1: string; line2: string | null; city: string; state: string | null; postalCode: string; country: string } | null;
  /** Those in force on the receipt date. */
  registrations: { type: string; number: string; issuingAuthority: string | null }[];
  logoUrl: string | null;
  signatory?: { name: string | null; designation: string | null; file?: { fileId: string; version: number } | null } | null;
  signatoryImageUrl?: string | null;
}

export interface PendingApproval {
  id: string;
  transition: string;
  requestedBy: string;
  approvalsGiven: number;
  approvalsNeeded: number;
  canDecide: boolean;
}

export interface ApprovalItem {
  id: string;
  recordId: string;
  recordType: string;
  recordNumber: string | null;
  transitionLabel: string;
  requestedByName: string | null;
  approvalsNeeded: number;
  approvalsGiven: number;
  createdAt: string;
}

/** One approval request waiting for the person, with only the fields every workflow has. */
export interface ApprovalRow {
  id: string;
  recordId: string;
  recordType: string;
  recordTypeLabel: string;
  recordNumber: string | null;
  recordTitle: string;
  step: string;
  stepLabel: string;
  fromStatusLabel: string;
  toStatusLabel: string;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  approvalsGiven: number;
  approvalsNeeded: number;
}

export type ApprovalSortField = 'waiting' | 'record' | 'type' | 'step' | 'requestedBy';

export interface ApprovalQueryBody {
  search?: string;
  filters?: { type?: string[]; step?: string[]; requestedBy?: string[] };
  /** `waiting` descending (the default) puts the longest waiting first. */
  sort?: { field: ApprovalSortField; dir: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

export interface InboxNotification {
  id: string;
  subject: string;
  body: string;
  recordId: string | null;
  /** An address in the app (or a file download) the notification points at. */
  link?: string | null;
  readAt: string | null;
  createdAt: string;
}

export const DEFINITION_KINDS = [
  'recordType',
  'workflow',
  'automation',
  'template',
  'postingRule',
  'receiptRule',
  'script',
  'theme',
  'listView',
  'recordGroup',
  'translation',
  'action',
  'page',
  'report',
  'reportGroup',
  'dataFeed',
] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export interface CatalogueItem {
  kind: DefinitionKind;
  key: string;
  label: string | null;
  publishedVersion: number | null;
  draftVersion: number | null;
  owner: 'base' | 'tenant';
  moduleKey: string | null;
}

export interface BuilderDetail {
  kind: DefinitionKind;
  key: string;
  published: { version: number; owner: 'base' | 'tenant'; baseVersion: number | null; body: Record<string, unknown> } | null;
  draft: { version: number; body: Record<string, unknown> } | null;
  history: { version: number; status: string; base_version: number | null; published_at: string | null }[];
  shipped: { baseVersion: number; base: Record<string, unknown>; patch: unknown } | null;
}

export interface Issue {
  path: string;
  message: string;
}
