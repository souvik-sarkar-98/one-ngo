import type {
  ActionDef,
  ActionStep,
  AutomationDef,
  DefinitionBodies,
  DefinitionKind,
  FieldDef,
  ListViewDef,
  ListViewSection,
  PageDef,
  DataFeedDef,
  PostingRuleDef,
  ReceiptRuleDef,
  RecordGroupDef,
  RecordTypeDef,
  ReportDef,
  ReportGroupDef,
  ScriptDef,
  TemplateDef,
  ThemeDef,
  TranslationDef,
  WorkflowDef,
} from './types.js';

export interface DiffEntry {
  op: 'add' | 'remove' | 'change';
  /** JSON pointer: into the new body for additions and changes, into the old body for removals. */
  path: string;
  before?: unknown;
  after?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const idOf = (v: unknown): string | undefined => {
  if (!isObject(v)) return undefined;
  if (typeof v.key === 'string') return `key:${v.key}`;
  if (typeof v.id === 'string') return `id:${v.id}`;
  return undefined;
};
/** JSON with object keys sorted, so bodies read back from the database compare equal to the files they came from. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Structural diff; arrays of objects with a `key` or `id` are matched by it, other arrays compare whole. */
export function diffDefinitions(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (same(before, after)) return [];
  if (before === undefined) return [{ op: 'add', path: path || '/', after }];
  if (after === undefined) return [{ op: 'remove', path: path || '/', before }];
  if (isObject(before) && isObject(after)) {
    const out: DiffEntry[] = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) out.push(...diffDefinitions(before[k], after[k], `${path}/${k}`));
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every((i) => idOf(i))) {
    const out: DiffEntry[] = [];
    const oldIds = before.map(idOf);
    const newIds = after.map(idOf);
    before.forEach((item, i) => {
      if (!newIds.includes(oldIds[i])) out.push({ op: 'remove', path: `${path}/${i}`, before: item });
    });
    after.forEach((item, i) => {
      const j = oldIds.indexOf(newIds[i]);
      out.push(...diffDefinitions(j < 0 ? undefined : before[j], item, `${path}/${i}`));
    });
    const kept = oldIds.filter((x) => newIds.includes(x));
    if (!same(kept, newIds.filter((x) => oldIds.includes(x)))) out.push({ op: 'change', path: path || '/', before: oldIds, after: newIds });
    return out;
  }
  return [{ op: 'change', path: path || '/', before, after }];
}

/** Names the describer shows in place of keys. */
export interface DescribeLabels {
  recordType(key: string): string;
  field(recordType: string, key: string): string;
  template(key: string): string;
}

export const keyLabels: DescribeLabels = { recordType: (k) => k, field: (_t, k) => k, template: (k) => k };

const q = (s: string | undefined) => `'${s ?? ''}'`;
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function byId<T>(items: T[] | undefined, id: (t: T) => string): Map<string, T> {
  return new Map((items ?? []).map((i) => [id(i), i]));
}

/** Added, removed and kept items of two keyed lists. */
function matchUp<T>(before: T[] | undefined, after: T[] | undefined, id: (t: T) => string) {
  const b = byId(before, id);
  const a = byId(after, id);
  return {
    added: [...a.values()].filter((x) => !b.has(id(x))),
    removed: [...b.values()].filter((x) => !a.has(id(x))),
    kept: [...a.values()].filter((x) => b.has(id(x))).map((x) => [b.get(id(x))!, x] as const),
    reordered: !same(
      (before ?? []).map(id).filter((k) => a.has(k)),
      (after ?? []).map(id).filter((k) => b.has(k)),
    ),
  };
}

function stringsDiff(before: string[] | undefined, after: string[] | undefined) {
  const b = new Set(before ?? []);
  const a = new Set(after ?? []);
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
}

type Describer<T> = (before: T | undefined, after: T, labels: DescribeLabels, out: string[]) => Set<string>;

const TYPE_TEXT: Record<string, string> = {
  text: 'text',
  longText: 'long text',
  number: 'number',
  money: 'money',
  date: 'date',
  boolean: 'yes or no',
  choice: 'choice',
  multiChoice: 'several choices',
  email: 'email',
  phone: 'phone',
  file: 'file',
  location: 'location',
  signature: 'signature',
  richText: 'formatted text',
  person: 'person',
};

function typeText(f: FieldDef, labels: DescribeLabels): string {
  return f.type === 'reference' ? `reference to ${labels.recordType(f.referenceType ?? '')}` : TYPE_TEXT[f.type] ?? f.type;
}

function toggle(out: string[], before: unknown, after: unknown, on: string, off: string): void {
  if (!!before !== !!after) out.push(after ? on : off);
}

function exprChange(out: string[], before: string | undefined, after: string | undefined, set: (e: string) => string, cleared: string): void {
  if (before === after) return;
  out.push(after ? set(after) : cleared);
}

function describeField(b: FieldDef, a: FieldDef, type: RecordTypeDef, labels: DescribeLabels, out: string[]): void {
  const name = q(a.label);
  if (b.label !== a.label) out.push(`Renames the field ${q(b.label)} to ${name}`);
  if (b.type !== a.type || b.referenceType !== a.referenceType) out.push(`Changes ${name} from ${typeText(b, labels)} to ${typeText(a, labels)}`);
  toggle(out, b.required, a.required, `Makes ${name} required`, `Makes ${name} optional`);
  toggle(out, b.sensitive, a.sensitive, `Marks ${name} as sensitive`, `No longer treats ${name} as sensitive`);
  toggle(out, b.unique, a.unique, `Requires ${name} to be different on every record`, `Allows the same ${name} on several records`);
  toggle(out, b.searchable, a.searchable, `Makes ${name} searchable`, `Stops searching ${name}`);
  exprChange(out, b.calculated, a.calculated, (e) => `Calculates ${name} as ${e}`, `Stops calculating ${name}`);
  exprChange(out, b.visibleWhen, a.visibleWhen, (e) => `Shows ${name} only when ${e}`, `Always shows ${name}`);
  exprChange(out, b.editableWhen, a.editableWhen, (e) => `Lets people change ${name} only when ${e}`, `Lets people change ${name} at any time`);
  if (!same(b.copyFrom, a.copyFrom)) {
    if (!a.copyFrom) out.push(`Stops filling ${name} from another record`);
    else {
      const ref = type.fields.find((f) => f.key === a.copyFrom!.reference);
      const from = ref?.referenceType ?? '';
      out.push(`Fills ${name} from the chosen ${labels.recordType(from)}'s ${q(labels.field(from, a.copyFrom.field))}`);
    }
  }
  if (!same(b.follow, a.follow)) {
    if (!a.follow) out.push(`Stops ${name} following another field`);
    else {
      const via = type.fields.find((f) => f.key === a.follow!.via);
      const from = via?.type === 'person' ? 'account' : (via?.referenceType ?? '');
      out.push(`Keeps ${name} equal to ${from === 'account' ? `the account's ${q(a.follow.field)}` : `the chosen ${labels.recordType(from)}'s ${q(labels.field(from, a.follow.field))}`}`);
    }
  }
  if (!same(b.rollup, a.rollup)) {
    out.push(a.rollup ? `Keeps ${name} up to date from ${labels.recordType(a.rollup.recordType)} records` : `Stops keeping ${name} up to date from other records`);
  }
  const choices = matchUp(b.choices, a.choices, (c) => c.value);
  for (const c of choices.added) out.push(`Adds the choice ${q(c.label)} to ${name}`);
  for (const c of choices.removed) out.push(`Removes the choice ${q(c.label)} from ${name}`);
  for (const [x, y] of choices.kept) if (x.label !== y.label) out.push(`Renames the choice ${q(x.label)} to ${q(y.label)} in ${name}`);
  if (b.min !== a.min || b.max !== a.max || b.maxLength !== a.maxLength) out.push(`Changes the limits of ${name}`);
  if (b.pattern !== a.pattern || b.patternMessage !== a.patternMessage) out.push(`Changes the format ${name} must follow`);
  if (b.help !== a.help) out.push(`Changes the help text of ${name}`);
  if (b.placeholder !== a.placeholder) out.push(`Changes the placeholder of ${name}`);
  if (b.multiple !== a.multiple || !same(b.accept, a.accept) || b.maxSizeMb !== a.maxSizeMb) out.push(`Changes the files ${name} accepts`);
}

const describeRecordType: Describer<RecordTypeDef> = (b, a, labels, out) => {
  if (!b) {
    out.push(`Creates the record type ${q(a.label)} with ${a.fields.length} field${a.fields.length === 1 ? '' : 's'}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the record type ${q(b.label)} to ${q(a.label)}`);
  if (b.pluralLabel !== a.pluralLabel) out.push(`Calls several of them ${q(a.pluralLabel ?? a.label)}`);
  if (b.description !== a.description) out.push('Changes the description');
  if (b.titleField !== a.titleField) out.push(a.titleField ? `Shows ${q(labels.field(a.key, a.titleField))} as the title of each record` : 'Stops using a field as the title');
  if (!same(b.numbering, a.numbering)) out.push(a.numbering ? `Numbers new records as ${q(a.numbering.format)}` : 'Stops numbering new records');
  if ((b.visibility ?? 'organisation') !== (a.visibility ?? 'organisation')) {
    out.push(
      a.visibility === 'restricted'
        ? 'Lets people see only their own records and the ones shared with them'
        : 'Lets everyone who can see this record type see every record',
    );
  }
  if (!same(b.public, a.public)) out.push(a.public ? 'Changes what someone can do without signing in' : 'Turns off access without signing in');
  const fields = matchUp(b.fields, a.fields, (f) => f.key);
  for (const f of fields.added) out.push(`Adds the field ${q(f.label)} (${typeText(f, labels)})`);
  for (const f of fields.removed) out.push(`Removes the field ${q(f.label)}`);
  for (const [x, y] of fields.kept) describeField(x, y, a, labels, out);
  if (fields.reordered) out.push('Reorders the fields');
  const rules = matchUp(b.rules, a.rules, (r) => r.key);
  for (const r of rules.added) out.push(`Adds the rule ${q(r.message)}`);
  for (const r of rules.removed) out.push(`Removes the rule ${q(r.message)}`);
  for (const [x, y] of rules.kept) if (!same(x, y)) out.push(`Changes the rule ${q(y.message)}`);
  return new Set(['key', 'label', 'pluralLabel', 'description', 'titleField', 'numbering', 'visibility', 'public', 'fields', 'rules']);
};

const describeWorkflow: Describer<WorkflowDef> = (b, a, labels, out) => {
  const state = (wf: WorkflowDef, k: string) => q(wf.states.find((s) => s.key === k)?.label ?? k);
  const states = (wf: WorkflowDef, ks: string[]) => list(ks.map((k) => state(wf, k)));
  if (!b) {
    out.push(`Creates the workflow ${q(a.key)} for ${labels.recordType(a.recordType)} with ${a.states.length} states and ${a.transitions.length} steps`);
    return new Set(Object.keys(a));
  }
  if (b.initial !== a.initial) out.push(`New records start in ${state(a, a.initial)}`);
  if ((b.role ?? 'primary') !== (a.role ?? 'primary')) out.push(a.role === 'parallel' ? 'Runs beside the main workflow' : 'Becomes a main workflow');
  if (b.appliesWhen !== a.appliesWhen) out.push(a.appliesWhen ? `Applies to records where ${a.appliesWhen}` : 'Applies to every record');
  if (b.startsWhen !== a.startsWhen) out.push(a.startsWhen ? `Starts when ${a.startsWhen}` : 'Starts when a record is created');
  const s = matchUp(b.states, a.states, (x) => x.key);
  for (const x of s.added) out.push(`Adds the state ${q(x.label)}`);
  for (const x of s.removed) out.push(`Removes the state ${q(x.label)}`);
  for (const [x, y] of s.kept) {
    if (x.label !== y.label) out.push(`Renames the state ${q(x.label)} to ${q(y.label)}`);
    toggle(out, x.final, y.final, `Makes ${q(y.label)} a final state`, `Makes ${q(y.label)} no longer final`);
    toggle(out, x.locked, y.locked, `Locks records in ${q(y.label)}`, `Unlocks records in ${q(y.label)}`);
  }
  const t = matchUp(b.transitions, a.transitions, (x) => x.key);
  for (const x of t.added) out.push(`Adds the step ${q(x.label)} from ${states(a, x.from)} to ${state(a, x.to)}`);
  for (const x of t.removed) out.push(`Removes the step ${q(x.label)}`);
  for (const [x, y] of t.kept) {
    const name = q(y.label);
    if (x.label !== y.label) out.push(`Renames the step ${q(x.label)} to ${name}`);
    if (!same(x.from, y.from) || x.to !== y.to) out.push(`Changes the step ${name} to go from ${states(a, y.from)} to ${state(a, y.to)}`);
    const req = stringsDiff(x.requiredFields, y.requiredFields);
    for (const f of req.added) out.push(`Asks for ${q(labels.field(a.recordType, f))} in the step ${name}`);
    for (const f of req.removed) out.push(`No longer asks for ${q(labels.field(a.recordType, f))} in the step ${name}`);
    if (x.guard !== y.guard || x.guardMessage !== y.guardMessage) {
      out.push(!y.guard ? `Removes the condition from the step ${name}` : x.guard ? `Changes the condition of the step ${name}` : `Adds a condition to the step ${name}: ${y.guardMessage ?? y.guard}`);
    }
    if (x.permission !== y.permission) out.push(`Changes who can use the step ${name}`);
    if (!same(x.approval, y.approval)) {
      out.push(!y.approval ? `No longer needs approval for the step ${name}` : x.approval ? `Changes the approval for the step ${name}` : `Needs approval for the step ${name}`);
    }
  }
  if (t.reordered) out.push('Reorders the steps');
  return new Set(['key', 'recordType', 'initial', 'role', 'appliesWhen', 'startsWhen', 'states', 'transitions']);
};

const sectionId = (s: ListViewSection) => s.id ?? s.label;

const describeListView: Describer<ListViewDef> = (b, a, labels, out) => {
  const field = (k: string) => q(labels.field(a.recordType, k));
  if (!b) {
    out.push(`Creates the list ${q(a.label ?? a.key)} for ${labels.recordType(a.recordType)}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the list to ${q(a.label ?? a.key)}`);
  if (b.layout !== a.layout) out.push(`Shows records as ${a.layout === 'table' ? 'a table' : 'cards'} by default`);
  if (b.pageSize !== a.pageSize) out.push(`Shows ${a.pageSize ?? 'the default number of'} records at a time`);
  const chips = matchUp(b.chips, a.chips, (c) => c.id);
  for (const c of chips.added) out.push(`Adds the chip ${q(c.label)}`);
  for (const c of chips.removed) out.push(`Removes the chip ${q(c.label)}`);
  for (const [x, y] of chips.kept) {
    if (x.label !== y.label) out.push(`Renames the chip ${q(x.label)} to ${q(y.label)}`);
    const { label: _x, ...xs } = x;
    const { label: _y, ...ys } = y;
    if (!same(xs, ys)) out.push(`Changes which records the chip ${q(y.label)} shows`);
  }
  if (chips.reordered) out.push('Reorders the chips');
  if (b.defaultChip !== a.defaultChip) {
    out.push(a.defaultChip ? `Opens on the chip ${q(a.chips?.find((c) => c.id === a.defaultChip)?.label ?? a.defaultChip)}` : 'Opens on the first chip');
  }
  const filters = stringsDiff(b.filters, a.filters);
  for (const f of filters.added) out.push(`Adds the filter ${field(f)}`);
  for (const f of filters.removed) out.push(`Removes the filter ${field(f)}`);
  for (const [prop, what] of [
    ['columns', 'column'],
    ['compactColumns', 'tablet column'],
  ] as const) {
    const d = stringsDiff(b[prop], a[prop]);
    for (const f of d.added) out.push(`Adds the ${what} ${field(f)}`);
    for (const f of d.removed) out.push(`Removes the ${what} ${field(f)}`);
    if (!d.added.length && !d.removed.length && !same(b[prop], a[prop])) out.push(`Reorders the ${what}s`);
  }
  if (!same(b.row, a.row)) out.push('Changes what each row shows');
  const sections = matchUp(b.detail?.sections, a.detail?.sections, sectionId);
  for (const s of sections.added) out.push(`Adds the section ${q(s.label)}`);
  for (const s of sections.removed) out.push(`Removes the section ${q(s.label)}`);
  for (const [x, y] of sections.kept) {
    if (x.label !== y.label) out.push(`Renames the section ${q(x.label)} to ${q(y.label)}`);
    if ('fields' in x && 'fields' in y) {
      const d = stringsDiff(x.fields, y.fields);
      for (const f of d.added) out.push(`Shows ${field(f)} in the section ${q(y.label)}`);
      for (const f of d.removed) out.push(`No longer shows ${field(f)} in the section ${q(y.label)}`);
      if (!d.added.length && !d.removed.length && !same(x.fields, y.fields)) out.push(`Reorders the fields in the section ${q(y.label)}`);
    } else if (!same(x, y)) out.push(`Changes the related records in the section ${q(y.label)}`);
  }
  if (sections.reordered) out.push('Reorders the sections');
  if (!same(b.create, a.create)) out.push('Changes the form for new records');
  if (!same(b.edit, a.edit)) out.push('Changes the edit form');
  return new Set(['key', 'recordType', 'label', 'layout', 'pageSize', 'chips', 'defaultChip', 'filters', 'columns', 'compactColumns', 'row', 'detail', 'create', 'edit']);
};

const describeTemplate: Describer<TemplateDef> = (b, a, _labels, out) => {
  if (!b) {
    out.push(`Creates the template ${q(a.label ?? a.key)}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the template to ${q(a.label ?? a.key)}`);
  if (b.subject !== a.subject) out.push(`Changes the subject to "${a.subject}"`);
  if (b.body !== a.body) out.push('Changes the message');
  const html = (v?: string) => v?.trim() ?? '';
  if (html(b.html) !== html(a.html)) out.push(html(a.html) ? 'Changes the email HTML' : 'Removes the email HTML');
  if (!same(b.whatsapp, a.whatsapp)) out.push(a.whatsapp ? `Uses the WhatsApp template ${q(a.whatsapp.name)}` : 'Stops using a WhatsApp template');
  if ((b.kind ?? 'message') !== (a.kind ?? 'message')) out.push(a.kind === 'document' ? 'Prints as a document' : 'Sends as a message');
  return new Set(['key', 'label', 'subject', 'body', 'html', 'whatsapp', 'kind']);
};

function stepText(s: ActionStep, labels: DescribeLabels, recordType: string): string {
  switch (s.type) {
    case 'setFields':
      return `set ${list(Object.keys(s.values).map((k) => q(labels.field(recordType, k))))}`;
    case 'notify':
      return `send ${q(labels.template(s.template))}`;
    case 'createRecord':
      return `create a ${labels.recordType(s.recordType)}`;
    case 'transition':
      return `run the step ${q(s.transition)}`;
    case 'webhook':
      return `send to the connector ${q(s.connector)}`;
    case 'connector':
      return `call the connector ${q(s.connector)}`;
    case 'createPayment':
      return `ask for a ${s.provider} payment`;
    case 'openReceipt':
      return 'open the receipt';
    case 'report':
      return `open the report ${q(s.report)}`;
    case 'script':
      return `run the script ${q(s.script)}`;
  }
}

function describeSteps(b: ActionStep[], a: ActionStep[], labels: DescribeLabels, recordType: string, out: string[], noun: string): void {
  if (same(b, a)) return;
  const before = b.map(canonical);
  const after = a.map(canonical);
  const added = a.filter((_s, i) => !before.includes(after[i]!));
  const removed = b.filter((_s, i) => !after.includes(before[i]!));
  for (const s of added) out.push(`Adds the ${noun}: ${stepText(s, labels, recordType)}`);
  for (const s of removed) out.push(`Removes the ${noun}: ${stepText(s, labels, recordType)}`);
  if (!added.length && !removed.length) out.push(`Reorders the ${noun}s`);
}

function triggerText(t: AutomationDef['trigger']): string {
  switch (t.event) {
    case 'created':
      return 'a record is created';
    case 'updated':
      return 'a record is changed';
    case 'statusChanged':
      return `a record ${t.to ? `becomes ${q(t.to)}` : 'changes status'}${t.from ? ` from ${q(t.from)}` : ''}`;
    case 'schedule':
      return `on the schedule ${q(t.cron)}`;
  }
}

const describeAutomation: Describer<AutomationDef> = (b, a, labels, out) => {
  if (!b) {
    out.push(`Creates the automation ${q(a.label ?? a.key)} for ${labels.recordType(a.recordType)}: runs when ${triggerText(a.trigger)}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the automation to ${q(a.label ?? a.key)}`);
  if ((b.enabled ?? true) !== (a.enabled ?? true)) out.push(a.enabled === false ? 'Turns the automation off' : 'Turns the automation on');
  if (!same(b.trigger, a.trigger)) out.push(`Now runs when ${triggerText(a.trigger)}`);
  exprChange(out, b.condition, a.condition, (e) => `Runs only when ${e}`, 'Runs without a condition');
  describeSteps(b.actions, a.actions, labels, a.recordType, out, 'action');
  return new Set(['key', 'label', 'enabled', 'recordType', 'trigger', 'condition', 'actions']);
};

type Line = PostingRuleDef['lines'][number];
const lineText = (l: Line) => `${l.side} line ${l.side === 'debit' ? 'to' : 'from'} ${l.account ? q(l.account) : `the account from ${l.accountExpr}`}`;

const describePostingRule: Describer<PostingRuleDef> = (b, a, labels, out) => {
  if (!b) {
    out.push(`Creates the posting rule ${q(a.key)}: posts when a ${labels.recordType(a.recordType)} becomes ${q(a.whenStatus)}`);
    return new Set(Object.keys(a));
  }
  if (b.whenStatus !== a.whenStatus || b.workflow !== a.workflow) out.push(`Posts when a record becomes ${q(a.whenStatus)}`);
  exprChange(out, b.condition, a.condition, (e) => `Posts only when ${e}`, 'Posts without a condition');
  if (b.date !== a.date) out.push(`Dates the entry ${a.date}`);
  if (b.memo !== a.memo) out.push('Changes the memo');
  const before = b.lines.map(canonical);
  const after = a.lines.map(canonical);
  const added = a.lines.filter((_l, i) => !before.includes(after[i]!));
  const removed = b.lines.filter((_l, i) => !after.includes(before[i]!));
  for (const l of added) out.push(`Adds the ${lineText(l)} for ${l.amount}`);
  for (const l of removed) out.push(`Removes the ${lineText(l)}`);
  return new Set(['key', 'recordType', 'whenStatus', 'workflow', 'condition', 'date', 'memo', 'lines']);
};

const describeReceiptRule: Describer<ReceiptRuleDef> = (b, a, labels, out) => {
  if (!b) {
    out.push(`Creates the receipt rule ${q(a.key)}: issues a receipt when a ${labels.recordType(a.recordType)} becomes ${q(a.whenStatus)}`);
    return new Set(Object.keys(a));
  }
  if (b.whenStatus !== a.whenStatus || b.workflow !== a.workflow) out.push(`Issues the receipt when a record becomes ${q(a.whenStatus)}`);
  exprChange(out, b.condition, a.condition, (e) => `Issues receipts only when ${e}`, 'Issues receipts without a condition');
  if (b.series !== a.series) out.push(`Numbers receipts from the series ${q(a.series)}`);
  if (b.amount !== a.amount) out.push(`Receipts the amount ${a.amount}`);
  if (b.date !== a.date) out.push(`Dates receipts ${a.date}`);
  return new Set(['key', 'recordType', 'whenStatus', 'workflow', 'condition', 'series', 'amount', 'date']);
};

const describeScript: Describer<ScriptDef> = (b, a, labels, out) => {
  if (!b) {
    out.push(`Creates the script ${q(a.label ?? a.key)} that runs before a ${labels.recordType(a.recordType)} is saved`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the script to ${q(a.label ?? a.key)}`);
  if (b.code !== a.code) out.push('Changes the script code');
  if ((b.enabled ?? true) !== (a.enabled ?? true)) out.push(a.enabled === false ? 'Turns the script off' : 'Turns the script on');
  if (b.order !== a.order) out.push(`Runs the script in position ${a.order ?? 0}`);
  if (b.timeoutMs !== a.timeoutMs || b.memoryMb !== a.memoryMb) out.push('Changes the script limits');
  return new Set(['key', 'label', 'recordType', 'hook', 'code', 'enabled', 'order', 'timeoutMs', 'memoryMb']);
};

const THEME_TOKENS: Record<string, string> = {
  brand: 'brand colour',
  brandForeground: 'text colour on the brand colour',
  background: 'background colour',
  surface: 'surface colour',
  text: 'text colour',
  muted: 'muted text colour',
  line: 'line colour',
  radius: 'corner radius',
};

const describeTheme: Describer<ThemeDef> = (b, a, _labels, out) => {
  if (!b) out.push(`Creates the theme ${q(a.label ?? a.key)}`);
  else if (b.label !== a.label) out.push(`Renames the theme to ${q(a.label ?? a.key)}`);
  for (const [k, name] of Object.entries(THEME_TOKENS)) {
    const x = b?.[k as keyof ThemeDef];
    const y = a[k as keyof ThemeDef];
    if (b && x !== y) out.push(y === undefined ? `Uses the default ${name}` : x === undefined ? `Sets the ${name} to ${y}` : `Changes the ${name} from ${x} to ${y}`);
  }
  return new Set(['key', 'label', ...Object.keys(THEME_TOKENS)]);
};

const describeRecordGroup: Describer<RecordGroupDef> = (b, a, labels, out) => {
  if (!b) {
    out.push(`Creates the group ${q(a.label)} with ${list(a.recordTypes.map((k) => labels.recordType(k)))}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the group ${q(b.label)} to ${q(a.label)}`);
  if (b.order !== a.order) out.push(`Moves the group ${q(a.label)} to position ${a.order ?? 0}`);
  const d = stringsDiff(b.recordTypes, a.recordTypes);
  for (const k of d.added) out.push(`Adds ${labels.recordType(k)} to the group ${q(a.label)}`);
  for (const k of d.removed) out.push(`Moves ${labels.recordType(k)} out of the group ${q(a.label)}`);
  if (!d.added.length && !d.removed.length && !same(b.recordTypes, a.recordTypes)) out.push(`Reorders the group ${q(a.label)}`);
  return new Set(['key', 'label', 'order', 'recordTypes']);
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const describeTranslation: Describer<TranslationDef> = (b, a, _labels, out) => {
  if (!b) {
    out.push(`Adds the ${q(a.locale)} translation with ${plural(Object.keys(a.entries).length, 'text')}`);
    return new Set(Object.keys(a));
  }
  if (b.locale !== a.locale) out.push(`Changes the language from ${q(b.locale)} to ${q(a.locale)}`);
  const keys = new Set([...Object.keys(b.entries), ...Object.keys(a.entries)]);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const k of keys) {
    if (!(k in b.entries)) added++;
    else if (!(k in a.entries)) removed++;
    else if (b.entries[k] !== a.entries[k]) changed++;
  }
  if (added) out.push(`Translates ${plural(added, 'more text')}`);
  if (removed) out.push(`Removes ${plural(removed, 'translated text')}`);
  if (changed) out.push(`Changes ${plural(changed, 'translated text')}`);
  return new Set(['key', 'locale', 'entries']);
};

const PLACEMENT: Record<string, string> = { panel: 'the record panel', row: 'the row menu', bulk: 'the bulk bar' };

const describeAction: Describer<ActionDef> = (b, a, labels, out) => {
  if (!b) {
    out.push(`Creates the action ${q(a.label)} for ${labels.recordType(a.recordType)}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the action ${q(b.label)} to ${q(a.label)}`);
  if (!same(b.placement, a.placement)) out.push(`Shows the action on ${list(a.placement.map((p) => PLACEMENT[p] ?? p))}`);
  exprChange(out, b.when, a.when, (e) => `Offers the action only when ${e}`, 'Offers the action on every record');
  exprChange(out, b.confirm, a.confirm, (e) => `Asks "${e}" before running`, 'Runs without asking first');
  if (b.permission !== a.permission) out.push('Changes who can run the action');
  const form = matchUp(b.form?.fields, a.form?.fields, (f) => f.key);
  for (const f of form.added) out.push(`Asks for ${q(f.label)} when the action runs`);
  for (const f of form.removed) out.push(`No longer asks for ${q(f.label)} when the action runs`);
  for (const [x, y] of form.kept) if (!same(x, y)) out.push(`Changes the form field ${q(y.label)}`);
  describeSteps(b.steps, a.steps, labels, a.recordType, out, 'step');
  return new Set(['key', 'recordType', 'label', 'placement', 'when', 'confirm', 'permission', 'form', 'steps']);
};

const widgetName = (w: PageDef['widgets'][number]) => ('label' in w ? q(w.label) : 'record groups');

const describePage: Describer<PageDef> = (b, a, _labels, out) => {
  if (!b) {
    out.push(`Creates the page ${q(a.label)} with ${plural(a.widgets.length, 'widget')}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the page ${q(b.label)} to ${q(a.label)}`);
  if (!same(b.audience, a.audience)) out.push(a.audience?.length ? `Shows the page to ${list(a.audience.map(q))}` : 'Shows the page to everyone');
  const before = b.widgets.map(canonical);
  const after = a.widgets.map(canonical);
  const added = a.widgets.filter((_w, i) => !before.includes(after[i]!));
  const removed = b.widgets.filter((_w, i) => !after.includes(before[i]!));
  for (const w of added) out.push(`Adds the widget ${widgetName(w)}`);
  for (const w of removed) out.push(`Removes the widget ${widgetName(w)}`);
  if (!added.length && !removed.length && !same(before, after)) out.push('Reorders the widgets');
  return new Set(['key', 'label', 'audience', 'widgets']);
};

const describeReport: Describer<ReportDef> = (b, a, _labels, out) => {
  if (!b) {
    out.push(`Creates the report ${q(a.label)}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the report to ${q(a.label)}`);
  if (!same(b.audience, a.audience)) out.push('Changes who can run the report');
  if (!same(b.parameters, a.parameters)) out.push('Changes the values the report asks for');
  if (!same(b.datasets, a.datasets)) out.push('Changes the data the report reads');
  if (!same(b.calculations, a.calculations)) out.push('Changes the calculations');
  if (!same(b.shape, a.shape)) out.push(a.shape ? 'Changes the custom step' : 'Removes the custom step');
  if (!same(b.outputs, a.outputs)) out.push('Changes the PDF or Excel output');
  return new Set(['key', 'label', 'audience', 'parameters', 'datasets', 'calculations', 'shape', 'outputs']);
};

const describeReportGroup: Describer<ReportGroupDef> = (b, a, _labels, out) => {
  if (!b) {
    out.push(`Creates the report group ${q(a.label)} with ${list(a.reports.map(q))}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the report group ${q(b.label)} to ${q(a.label)}`);
  if (b.order !== a.order) out.push(`Moves the report group ${q(a.label)} to position ${a.order ?? 0}`);
  const d = stringsDiff(b.reports, a.reports);
  for (const k of d.added) out.push(`Adds the report ${q(k)} to the group ${q(a.label)}`);
  for (const k of d.removed) out.push(`Moves the report ${q(k)} out of the group ${q(a.label)}`);
  if (!d.added.length && !d.removed.length && !same(b.reports, a.reports)) out.push(`Reorders the report group ${q(a.label)}`);
  return new Set(['key', 'label', 'order', 'reports']);
};

const describeDataFeed: Describer<DataFeedDef> = (b, a, _labels, out) => {
  if (!b) {
    out.push(a.source === 'content' ? `Creates the data feed ${q(a.label)} with written text` : `Creates the data feed ${q(a.label)}`);
    return new Set(Object.keys(a));
  }
  if (b.label !== a.label) out.push(`Renames the data feed ${q(b.label)} to ${q(a.label)}`);
  if (b.source !== a.source) out.push(a.source === 'content' ? 'Returns written text' : 'Returns records');
  if (!same(b.recordType, a.recordType) && a.recordType) out.push(`Reads ${q(a.recordType)}`);
  if (!same(b.fields, a.fields)) out.push('Changes the fields a result shows');
  if (!same(b.statusIn, a.statusIn)) out.push('Changes which statuses are included');
  if (!same(b.entries, a.entries)) out.push('Changes the written text');
  return new Set(['key', 'label', 'description', 'source', 'recordType', 'fields', 'statusIn', 'search', 'sort', 'allowFilters', 'entries']);
};

const DESCRIBERS: { [K in DefinitionKind]: Describer<DefinitionBodies[K]> } = {
  recordType: describeRecordType,
  workflow: describeWorkflow,
  postingRule: describePostingRule,
  receiptRule: describeReceiptRule,
  script: describeScript,
  automation: describeAutomation,
  template: describeTemplate,
  theme: describeTheme,
  listView: describeListView,
  recordGroup: describeRecordGroup,
  translation: describeTranslation,
  action: describeAction,
  page: describePage,
  report: describeReport,
  reportGroup: describeReportGroup,
  dataFeed: describeDataFeed,
};

/** What changes for people, one plain sentence per change. */
export function describeChanges<K extends DefinitionKind>(
  kind: K,
  before: DefinitionBodies[K] | undefined,
  after: DefinitionBodies[K],
  labels: DescribeLabels = keyLabels,
): string[] {
  const out: string[] = [];
  const covered = DESCRIBERS[kind](before, after, labels, out);
  if (before) {
    const b = before as unknown as Record<string, unknown>;
    const a = after as unknown as Record<string, unknown>;
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!covered.has(k) && !same(b[k], a[k])) out.push(`Changes ${q(k)}`);
    }
  }
  return out;
}
