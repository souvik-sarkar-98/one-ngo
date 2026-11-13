export const DEFINITION_KINDS = [
  'recordType',
  'workflow',
  'postingRule',
  'receiptRule',
  'script',
  'automation',
  'template',
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
  | 'multiChoice'
  | 'file'
  | 'location'
  | 'signature'
  | 'richText'
  /** A member of the organisation, stored as their user id. */
  | 'person';

export type FileKind = 'image' | 'pdf' | 'document' | 'spreadsheet';

/** A number kept on a parent record from the records that point at it. */
export interface RollupDef {
  /** The child record type. */
  recordType: string;
  /** The child's reference field pointing at this record type. */
  reference: string;
  measure: 'count' | 'sum';
  /** Number or money field of the child to add up. */
  field?: string;
  /** Expression on the child; only matching children count. */
  where?: string;
}

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
  /** Same as readPermission record:<type>:sensitive, unless readPermission is set. */
  sensitive?: boolean;
  /** Whether erasing the record's data subject clears this field; by default text, contact, location, signature, file and sensitive fields. */
  personal?: boolean;
  /** Without it the value is masked and the field cannot be filtered, sorted, totalled or grouped by. */
  readPermission?: string;
  /** Without it the field is read-only. */
  editPermission?: string;
  searchable?: boolean;
  help?: string;
  /** Grey example text shown in an empty field. Not for boolean, multiple choice, file, location, signature or rich text fields. */
  placeholder?: string;
  /** Expression on the record being saved; when false the field is hidden and any submitted value is ignored. */
  visibleWhen?: string;
  /** Expression on the record as currently stored; when false the field cannot be changed. */
  editableWhen?: string;
  /** Filled from the record chosen in a reference field of this record type whenever that choice changes. */
  copyFrom?: { reference: string; field: string };
  /**
   * Kept equal to a source. `via` is a reference or person field on this record type.
   * A reference follows a field of the chosen record. A person follows an account field: `id`, `name` or `email`.
   */
  follow?: { via: string; field: string };
  /** No two records of the organisation may share a value. Blanks are allowed more than once. */
  unique?: boolean;
  /** Regular expression the whole value must match. */
  pattern?: string;
  /** Shown under the field when the pattern does not match. */
  patternMessage?: string;
  /** Read-only; kept up to date from child records. */
  rollup?: RollupDef;
  /** File fields: allow several files. */
  multiple?: boolean;
  /** File fields: accepted kinds of file. */
  accept?: FileKind[];
  /** File fields: largest file in megabytes. */
  maxSizeMb?: number;
  /** Location fields: false asks for the device location only, without typing coordinates. Default true. */
  typedCoordinates?: boolean;
  /** Signature fields: ask for the signer's typed name, for someone signing on another person's device. */
  typedName?: boolean;
}

/** Pseudo-fields a list view may show besides the record type's own fields. */
export const LIST_VIEW_PSEUDO_FIELDS = ['number', 'status', 'createdAt', 'updatedAt'] as const;

/**
 * A detail section shows either fields of the record, or the records of
 * another type that point at this one through a reference field.
 */
export type ListViewSection =
  | { id?: string; label: string; permission?: string; fields: string[] }
  | { id?: string; label: string; permission?: string; related: { recordType: string; field: string; total?: string } };

/** A named group of record types for menus and the home page. */
export interface RecordGroupDef {
  key: string;
  label: string;
  /** Lower comes first. */
  order?: number;
  recordTypes: string[];
}

/** A named group of reports on the Reports screen. A report in several groups shows in the first. */
export interface ReportGroupDef {
  key: string;
  label: string;
  /** Lower comes first. */
  order?: number;
  reports: string[];
}

/** Configures the list dashboard (chips, filters, rows, detail, create, edit) for a record type. */
export interface ListViewDef {
  key: string;
  recordType: string;
  label?: string;
  pageSize?: number;
  /** Default layout on wide screens; each person can switch and their choice is remembered. Phones always use cards. */
  layout?: 'cards' | 'table';
  /** Columns for the table layout. Defaults to the row title, subtitle, and meta fields. */
  columns?: string[];
  /** Columns for tablet-width tables. Defaults to the title, the first subtitle field, and the status. */
  compactColumns?: string[];
  chips?: {
    id: string;
    label: string;
    statusIn?: string[];
    /** States of another workflow of the record type. */
    workflowState?: { workflow: string; in: string[] };
    owner?: 'me';
    /** Records shared with the person or their roles, not their own. Restricted record types get this chip automatically. */
    shared?: boolean;
    /** Field filters, as in the list query; `me` in a person field's `in` is the signed-in person. */
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
    /** Columns on wide screens; phones always show one. Default 1. */
    columns?: 1 | 2 | 3;
    /** Fields that take a whole row. */
    fullWidth?: string[];
    presets?: { param: string; field: string }[];
    chips?: string[];
  };
  edit?: { fields?: string[]; chips?: string[]; columns?: 1 | 2 | 3; fullWidth?: string[] };
}

/** Search of existing records. Present means the search is on. */
export interface PublicCatalogueDef {
  /** What a result shows. */
  fields: string[];
  /** Which of those fields the search box matches. All of `fields` when omitted. */
  search?: string[];
  /** Only records in these statuses are listed. */
  statusIn: string[];
  /** A result can open this public form with this reference field filled. */
  request?: { recordType: string; field: string };
}

/** Public operations for one record type. Absent flags are off. */
export interface PublicAccessDef {
  /** Anyone can submit a new record. */
  create?: boolean;
  /** After submitting, the visitor gets a link to that submission. Requires create. */
  view?: boolean;
  /** That link can change the public fields. Requires view. */
  edit?: boolean;
  /** That link can delete the submission. Requires view. */
  delete?: boolean;
  /** Fields the public form shows and accepts. */
  fields?: string[];
  /** Shown when a submit does not issue a link. */
  thanks?: string;
  catalogue?: PublicCatalogueDef;
}

export interface RecordTypeDef {
  key: string;
  label: string;
  pluralLabel?: string;
  description?: string;
  numbering?: { sequence: string; format: string; reset?: 'fiscal_year' | 'never' };
  titleField?: string;
  /** Restricted: people see their own records, records shared with them, or all with record:<type>:read:all. */
  visibility?: 'organisation' | 'restricted';
  /**
   * What someone who has not signed in may do. Each flag is off unless it is set.
   * View, edit and delete apply only to the submission a secret link opens.
   * Catalogue is the only way a visitor searches records they did not submit.
   */
  public?: PublicAccessDef;
  fields: FieldDef[];
  rules?: { key: string; when?: string; expression: string; message: string; field?: string }[];
  /**
   * Values read from an http lookup connector. `inputs` are fields of this
   * record type sent to it; `map` links a field of this record type to a
   * binding name of the connector's responseMap (its key), not a JSON path.
   */
  lookups?: { key: string; connector: string; inputs: string[]; map: Record<string, string> }[];
}

export interface WorkflowDef {
  key: string;
  recordType: string;
  /** Primary workflows hold the record's status; parallel ones run beside it. Default primary. */
  role?: 'primary' | 'parallel';
  /** Primary only: which primary workflow a new record follows, when there are several. */
  appliesWhen?: string;
  /** Parallel only: starts at `initial` when this becomes true on a save; on create when absent. */
  startsWhen?: string;
  initial: string;
  states: { key: string; label: string; final?: boolean; locked?: boolean }[];
  transitions: {
    key: string;
    label: string;
    from: string[];
    to: string;
    guard?: string;
    guardMessage?: string;
    requiredFields?: string[];
    permission?: string;
    approval?: ApprovalDef;
  }[];
}

export interface ApprovalDef {
  /** Roles whose members may approve. */
  roles?: string[];
  /** Specific people (user ids) who may approve. */
  users?: string[];
  /** Distinct approvals needed. Defaults to 1. */
  count?: number;
  /** Optional expression; approval is needed only when true, e.g. "record.amount >= 50000". */
  when?: string;
}

export type RecipientDef = {
  roles?: string[];
  users?: string[];
  /** Expression returning an email address. */
  email?: string;
  /** Expression returning a phone number, for the sms and whatsapp channels. */
  phone?: string;
  /** The person who created the record. */
  creator?: boolean;
  /** With `field`: the person chosen in that person field of the record. */
  type?: 'personField';
  field?: string;
};

export type NotifyChannel = 'inApp' | 'email' | 'sms' | 'whatsapp';

export type AutomationAction =
  | { type: 'setFields'; values: Record<string, string> }
  | { type: 'notify'; template: string; to: RecipientDef; channels?: NotifyChannel[] }
  | { type: 'createRecord'; recordType: string; values: Record<string, string> }
  | { type: 'transition'; transition: string; values?: Record<string, string> }
  | { type: 'webhook'; connector: string; body?: Record<string, string> }
  /** Sends through an http connector in send mode; body values are expressions added to `record` for its templates. */
  | { type: 'connector'; connector: string; body?: Record<string, string> };

export interface AutomationDef {
  key: string;
  label?: string;
  enabled?: boolean;
  recordType: string;
  trigger:
    | { event: 'created' }
    | { event: 'updated' }
    | { event: 'statusChanged'; to?: string; from?: string; workflow?: string }
    | { event: 'schedule'; cron: string; status?: string };
  condition?: string;
  actions: AutomationAction[];
}

export interface TemplateDef {
  key: string;
  label?: string;
  /** `message` is email and notifications. `document` is a report page printed by the browser. Default message. */
  kind?: 'message' | 'document';
  /** `{{ expression }}` placeholders use the expression language. */
  subject: string;
  /** Plain message for in-app notifications, SMS, and the text part of an email. */
  body: string;
  /** HTML for the email channel. Placeholder values are escaped. Absent means the email is the plain body. */
  html?: string;
  /** An approved WhatsApp Business template sent instead of the body on the whatsapp channel. */
  whatsapp?: { name: string; language?: string; parameters?: string[] };
}

export interface PostingRuleDef {
  key: string;
  recordType: string;
  whenStatus: string;
  /** Workflow whose state `whenStatus` names; default the primary. */
  workflow?: string;
  condition?: string;
  date: string;
  memo?: string;
  lines: { side: 'debit' | 'credit'; account?: string; accountExpr?: string; amount: string; fund?: string }[];
}

/** One printed line. `field` reads that field; `value` is an expression. A field wins when both are set. */
export interface ReceiptLayoutRow {
  label: string;
  field?: string;
  value?: string;
}

/** Printed only when the issuer snapshot holds a registration of this type, for example `80g`. */
export interface ReceiptClause {
  registration: string;
  /** `{{ }}` placeholders. `registration` is the matching registration. */
  text: string;
}

/**
 * Wording for the receipt a rule issues. Resolved once, when the receipt is
 * issued, and kept with it. The issuer block, number, date, signature and void
 * stamp stay in the print view.
 */
export interface ReceiptLayout {
  /** Default: the series label. May use `{{ }}` placeholders. */
  title?: string;
  /** Acknowledgement under the title. May use `{{ }}` placeholders. */
  statement?: string;
  /** Line above the signature. May use `{{ }}` placeholders. */
  thanks?: string;
  /** Printed in this order. Default: the record's filled-in printable fields. */
  rows?: ReceiptLayoutRow[];
  clauses?: ReceiptClause[];
}

export interface ReceiptRuleDef {
  key: string;
  recordType: string;
  whenStatus: string;
  /** Workflow whose state `whenStatus` names; default the primary. */
  workflow?: string;
  condition?: string;
  series: string;
  amount: string;
  date: string;
  layout?: ReceiptLayout;
}

export type ScriptEffectType = 'ledger.propose' | 'records.create' | 'records.update' | 'notify' | 'connector.call';

export interface ScriptDef {
  key: string;
  label?: string;
  recordType: string;
  hook: 'beforeSave' | 'validate' | 'afterSave' | 'workflowGuard' | 'customButton' | 'reportShape';
  order?: number;
  enabled?: boolean;
  timeoutMs?: number;
  memoryMb?: number;
  /** Role whose permissions read the inputs and apply the effects instead of the person saving. */
  runAs?: string;
  inputs?: {
    related?: { name: string; field: string; fields: string[] }[];
    lookups?: { name: string; recordType: string; match: Record<string, string>; fields: string[]; limit?: number }[];
    settings?: string[];
    balances?: { accounts?: string[]; funds?: string[] };
  };
  effects?: {
    allow: ScriptEffectType[];
    accounts?: string[];
    maxTotalAmount?: string | number;
    connectors?: string[];
    /** Named fixed recipients from the organisation settings. */
    recipients?: string[];
    maxEffects?: number;
  };
  code: string;
}

/** Colours and radius an organisation may publish. Values are tokens, not a stylesheet. */
export interface ThemeDef {
  key: string;
  label?: string;
  brand?: string;
  brandForeground?: string;
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  line?: string;
  /** Corner radius, for example "6px". */
  radius?: string;
}

/**
 * Labels and messages in one language. Entry keys are stable paths such as
 * `recordType.donation.fields.amount.label`, or `ui.*` for screen text.
 */
export interface TranslationDef {
  key: string;
  locale: string;
  entries: Record<string, string>;
}

/** A field on an action's small form; its value is available as `input.<key>`. */
export type ActionField = Pick<
  FieldDef,
  'key' | 'label' | 'type' | 'required' | 'choices' | 'referenceType' | 'min' | 'max' | 'maxLength' | 'help' | 'placeholder'
>;

export type ActionStep =
  | AutomationAction
  | {
      type: 'createPayment';
      provider: 'upi' | 'razorpay' | 'cashfree';
      amount: string;
      account: string;
      /** The workflow step run when the payment arrives, and the fields it fills. */
      onPaid: { transition: string; fields?: { paidOn?: string; reference?: string; method?: string }; methodValue?: string };
    }
  | { type: 'openReceipt' }
  /** Runs a custom-button script on the record and saves what it returns. */
  | { type: 'script'; script: string }
  /** Opens a report. `params` are expressions; the record's id is passed as `record`. */
  | { type: 'report'; report: string; params?: Record<string, string> };

/** A button on the record panel, the row menu, or the bulk bar that runs steps on a record. */
export interface ActionDef {
  key: string;
  recordType: string;
  label: string;
  placement: ('panel' | 'row' | 'bulk')[];
  /** Expression; the action is offered only when true. */
  when?: string;
  /** Defaults to record:<type>:action:<key>. */
  permission?: string;
  confirm?: string;
  form?: { fields: ActionField[]; columns?: 1 | 2 | 3; fullWidth?: string[] };
  steps: ActionStep[];
}

export interface FieldFilter {
  in?: (string | number | boolean)[];
  eq?: string | number | boolean | null;
  from?: string | number | null;
  to?: string | number | null;
  /** Location fields: within `km` of a point. */
  near?: { lat: number; lng: number; km: number };
}

/** Which records a widget counts: a chip of the record type's list view, filters, or only the person's own. */
export interface ViewRef {
  chip?: string;
  filters?: Record<string, FieldFilter>;
  owner?: 'me';
}

/** A link on a page; hidden without its permission. */
export interface PageLink {
  label: string;
  to: string;
  permission?: string;
}

/** Every widget may need a permission besides the page audience; it is hidden without it. */
export type Widget = { permission?: string } & (
  | { type: 'groups' }
  | { type: 'stat'; label: string; recordType: string; view?: ViewRef; measure: 'count' | 'sum'; field?: string }
  | {
      type: 'chart';
      label: string;
      recordType: string;
      view?: ViewRef;
      measure: 'count' | 'sum';
      field?: string;
      groupBy: { field: string } | { period: 'day' | 'week' | 'month' | 'financialYear'; dateField: string };
      chart: 'bar' | 'line';
    }
  | { type: 'list'; label: string; listView: string; view?: ViewRef; limit: number }
  | { type: 'links'; label: string; items: PageLink[] }
);

/** A screen of widgets. The page whose key is `home` is the Home screen; every other page opens from the navigation. */
export interface PageDef {
  key: string;
  label: string;
  /** Roles; empty means everyone. */
  audience?: string[];
  widgets: Widget[];
}

/** A value the person running a report fills in. It is available as `params.<key>`. */
export interface ReportParameter {
  key: string;
  label: string;
  type: 'text' | 'number' | 'money' | 'date' | 'boolean' | 'choice';
  required?: boolean;
  choices?: { value: string; label: string }[];
}

/** A filter value written as an expression over `params`. */
export interface ReportFilter {
  eq?: string;
  from?: string;
  to?: string;
}

export interface ReportQueryDataset {
  key: string;
  label?: string;
  source: 'query';
  recordType: string;
  /** Expressions over `params`. A blank result leaves that filter out. */
  filters?: Record<string, ReportFilter>;
  statusIn?: string[];
  sort?: { field: string; dir?: 'asc' | 'desc' };
  fields: string[];
  limit?: number;
  /** Reference fields whose chosen records are loaded beside the row. */
  related?: { field: string; fields: string[] }[];
}

export interface ReportAggregateDataset {
  key: string;
  label?: string;
  source: 'aggregate';
  recordType: string;
  measure: 'count' | 'sum';
  field?: string;
  groupBy?: { field: string } | { period: 'day' | 'week' | 'month' | 'financialYear'; dateField: string };
  filters?: Record<string, ReportFilter>;
  statusIn?: string[];
}

export interface ReportLedgerDataset {
  key: string;
  label?: string;
  source: 'ledger';
  /** Ledger account codes. Empty means none. */
  accounts?: string[];
  /** Fund codes. Empty means none. */
  funds?: string[];
  /** Expression for the date the balances are taken to. Default today. */
  asOf?: string;
}

export type ReportDataset = ReportQueryDataset | ReportAggregateDataset | ReportLedgerDataset;

export interface ReportCalculation {
  key: string;
  label?: string;
  /** Expression over `params`, `datasets` and earlier `calculations`. */
  expression: string;
}

export interface ReportColumn {
  field: string;
  header?: string;
  format?: 'text' | 'number' | 'money' | 'date' | 'percent';
  /** A totals row adds this column. */
  total?: boolean;
}

/** A report: parameters, datasets, calculations, an optional custom step, and PDF and Excel output. */
export interface ReportDef {
  key: string;
  label: string;
  /** Roles that may run it, besides holding `report:<key>:run`. Empty means anyone with that permission. */
  audience?: string[];
  parameters?: ReportParameter[];
  datasets: ReportDataset[];
  calculations?: ReportCalculation[];
  /** A sandboxed script, or a provider a module registered in code. */
  shape?: { script: string } | { provider: string };
  outputs?: {
    pdf?: { template: string; pageSize?: 'A4' | 'Letter'; orientation?: 'portrait' | 'landscape' };
    excel?: { sheets: { dataset: string; columns?: ReportColumn[] }[] };
  };
}

/** One piece of text a content data feed returns. */
export interface DataFeedEntry {
  key: string;
  label: string;
  text: string;
}

/**
 * A named read an external app calls with a key bound to this feed.
 * `records` returns a fixed query. `content` returns the text the admin wrote.
 */
export interface DataFeedDef {
  key: string;
  label: string;
  description?: string;
  source: 'records' | 'content';
  recordType?: string;
  /** Fields a records result includes. */
  fields?: string[];
  /** Only records in these statuses. Required for a records feed. */
  statusIn?: string[];
  /** Which of `fields` a search matches. */
  search?: string[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  /** Fields the caller may filter with an exact value. */
  allowFilters?: string[];
  entries?: DataFeedEntry[];
}

export interface DefinitionBodies {
  recordType: RecordTypeDef;
  workflow: WorkflowDef;
  postingRule: PostingRuleDef;
  receiptRule: ReceiptRuleDef;
  script: ScriptDef;
  automation: AutomationDef;
  template: TemplateDef;
  theme: ThemeDef;
  listView: ListViewDef;
  recordGroup: RecordGroupDef;
  translation: TranslationDef;
  action: ActionDef;
  page: PageDef;
  report: ReportDef;
  reportGroup: ReportGroupDef;
  dataFeed: DataFeedDef;
}

export interface PublishedDefinition<K extends DefinitionKind = DefinitionKind> {
  kind: K;
  key: string;
  version: number;
  /** Version of the product base layer, when the definition extends one. */
  baseVersion: number | null;
  owner: 'base' | 'tenant';
  body: DefinitionBodies[K];
}

export interface ModuleManifest {
  key: string;
  version: string;
  label: string;
  description?: string;
  engine: string;
  dependsOn?: string[];
  definitions: string[];
  setup?: {
    accounts?: { code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense' }[];
    receiptSeries?: { key: string; prefix: string; label: string; reset?: 'fiscal_year' | 'never' }[];
    roles?: { key: string; label: string; permissions: string[]; requireTwoStep?: boolean }[];
  };
}
