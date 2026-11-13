import { checkPattern } from './field-pattern.js';
import { checkExpression } from '../expressions/expression.js';
import type { FieldIssue } from '@onengo/kernel/errors';
import { checkCron } from './cron.js';
import { checkDeclaredInputs, HOOK_TAKES_EFFECTS } from './script-inputs.js';
import { checkTemplate } from './template.js';
import { checkDocumentTemplate } from './document-template.js';
import { REGISTRATION_TYPE } from '../../domain/organisations/organisation.js';
import type {
  ActionDef,
  ActionStep,
  AutomationDef,
  DataFeedDef,
  DefinitionBodies,
  TemplateDef,
  DefinitionKind,
  FieldDef,
  ListViewDef,
  PageDef,
  PostingRuleDef,
  ReceiptRuleDef,
  RecordGroupDef,
  RecordTypeDef,
  ReportDef,
  ReportGroupDef,
  ScriptDef,
  TranslationDef,
  ViewRef,
  WorkflowDef,
} from './types.js';
import { LIST_VIEW_PSEUDO_FIELDS } from './types.js';
import { explicitPermissions, generatedPermissions, isKnownPermission } from './permission-usage.js';
import { translationTargetExists } from './translation-paths.js';
import { isPrimary } from './workflows.js';
import type { ConnectorFact } from './ports/definition-store.js';

export interface DefinitionLookup {
  recordType(key: string): RecordTypeDef | undefined;
  /** The record type's primary workflow (the first, when there are several). */
  workflowFor(recordType: string): WorkflowDef | undefined;
  /** Every workflow of the record type, primary ones first. */
  workflowsFor(recordType: string): WorkflowDef[];
  template(key: string): TemplateDef | undefined;
  definition<K extends DefinitionKind>(kind: K, key: string): DefinitionBodies[K] | undefined;
  all<K extends DefinitionKind>(kind: K): DefinitionBodies[K][];
  accountCodes: ReadonlySet<string> | null;
  receiptSeries: ReadonlySet<string> | null;
  /** Role keys of the organisation; null when not known. */
  roles: ReadonlySet<string> | null;
  /** Webhook and http connectors of the organisation, by key; null when not known. */
  connectors: ReadonlyMap<string, ConnectorFact> | null;
  /** Every permission granted by the organisation's roles; null when not known. */
  rolePermissions?: readonly string[] | null;
  /** Names of the organisation's fixed recipients; null when not known. */
  namedRecipients?: ReadonlySet<string> | null;
}

function expr(issues: FieldIssue[], path: string, source: string | undefined): void {
  if (source === undefined) return;
  const err = checkExpression(source);
  if (err) issues.push({ path, message: `expression error: ${err}` });
}

/** How a definition may use a connector: a webhook, or an http connector in send or lookup mode. */
type ConnectorUse = 'webhook' | ConnectorFact['mode'];

const CONNECTOR_USE_NOUN: Record<ConnectorUse, string> = {
  webhook: 'webhook connector',
  send: 'http connector in send mode',
  lookup: 'http connector in lookup mode',
};

/** Why connector `key` cannot be used as one of `uses`, or undefined when it can or the connectors are not known. */
function connectorProblem(lookup: DefinitionLookup, key: string, uses: ConnectorUse[]): string | undefined {
  if (!lookup.connectors) return undefined;
  const wanted = uses.map((u) => CONNECTOR_USE_NOUN[u]).join(' or ');
  const c = lookup.connectors.get(key);
  if (!c) return `${wanted} '${key}' does not exist`;
  const use: ConnectorUse = c.type === 'webhook' ? 'webhook' : c.mode;
  return uses.includes(use) ? undefined : `connector '${key}' is a ${CONNECTOR_USE_NOUN[use]}; choose a ${wanted}`;
}

function needType(issues: FieldIssue[], lookup: DefinitionLookup, key: string): RecordTypeDef | undefined {
  const t = lookup.recordType(key);
  if (!t) issues.push({ path: '/recordType', message: `record type '${key}' is not published` });
  return t;
}

const TEXTUAL = new Set(['text', 'longText']);

const ACCOUNT_FIELDS = new Set(['id', 'name', 'email']);

function checkFollow(def: RecordTypeDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const fields = new Map(def.fields.map((f) => [f.key, f]));
  def.fields.forEach((f, i) => {
    if (!f.follow) return;
    const at = `/fields/${i}/follow`;
    if (f.calculated || f.rollup || f.copyFrom) issues.push({ path: at, message: 'a field that follows a source cannot also be calculated, a rollup, or copied' });
    const via = fields.get(f.follow.via);
    if (!via || (via.type !== 'reference' && via.type !== 'person')) {
      issues.push({ path: `${at}/via`, message: `'${f.follow.via}' is not a reference or person field of this record type` });
      return;
    }
    if (via.type === 'person') {
      if (!ACCOUNT_FIELDS.has(f.follow.field)) issues.push({ path: `${at}/field`, message: 'an account field is id, name or email' });
      else if (f.follow.field === 'email' && f.type !== 'email') issues.push({ path: `${at}/field`, message: 'email follows onto an email field' });
      else if (f.follow.field !== 'email' && !TEXTUAL.has(f.type)) issues.push({ path: `${at}/field`, message: 'id and name follow onto a text field' });
      return;
    }
    const target = via.referenceType === def.key ? def : lookup.recordType(via.referenceType ?? '');
    if (!target) {
      issues.push({ path: `${at}/via`, message: `record type '${via.referenceType}' is not published` });
      return;
    }
    const source = target.fields.find((x) => x.key === f.follow!.field);
    if (!source) issues.push({ path: `${at}/field`, message: `'${target.key}' has no field '${f.follow.field}'` });
    else if (source.type !== f.type && !(TEXTUAL.has(source.type) && TEXTUAL.has(f.type))) {
      issues.push({ path: `${at}/field`, message: `'${source.key}' is ${source.type} but this field is ${f.type}` });
    }
  });
}

function checkCopies(def: RecordTypeDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const fields = new Map(def.fields.map((f) => [f.key, f]));
  def.fields.forEach((f, i) => {
    if (!f.copyFrom) return;
    const at = `/fields/${i}/copyFrom`;
    if (f.calculated) issues.push({ path: at, message: 'calculated fields cannot also be copied' });
    if (f.type === 'person') issues.push({ path: at, message: 'person fields cannot be copied from another record' });
    const ref = fields.get(f.copyFrom.reference);
    if (!ref || ref.type !== 'reference') {
      issues.push({ path: `${at}/reference`, message: `'${f.copyFrom.reference}' is not a reference field of this record type` });
      return;
    }
    const target = ref.referenceType === def.key ? def : lookup.recordType(ref.referenceType ?? '');
    if (!target) {
      issues.push({ path: `${at}/reference`, message: `record type '${ref.referenceType}' is not published` });
      return;
    }
    const source = target.fields.find((x) => x.key === f.copyFrom!.field);
    if (!source) issues.push({ path: `${at}/field`, message: `'${target.key}' has no field '${f.copyFrom.field}'` });
    else if (source.type !== f.type && !(TEXTUAL.has(source.type) && TEXTUAL.has(f.type))) {
      issues.push({ path: `${at}/field`, message: `'${source.key}' is ${source.type} but this field is ${f.type}` });
    }
  });
}

const UNIQUE_FIELD_TYPES = new Set(['text', 'email', 'phone', 'number', 'person']);
const FILE_OPTIONS = ['multiple', 'accept', 'maxSizeMb'] as const;
/** Fields that show no empty-box text: a tick, a choice list, a file, a drawing, a map or formatted text. */
const NO_PLACEHOLDER_TYPES: ReadonlySet<FieldDef['type']> = new Set(['boolean', 'multiChoice', 'file', 'location', 'signature', 'richText']);

/** A form's full-width fields must be on that form; a form without a list of fields takes any field. */
function checkFullWidth(layout: { fullWidth?: string[] } | undefined, onForm: Set<string> | undefined, at: string, issues: FieldIssue[]): void {
  layout?.fullWidth?.forEach((k, i) => {
    if (onForm && !onForm.has(k)) issues.push({ path: `${at}/fullWidth/${i}`, message: `'${k}' is not on this form` });
  });
}

function checkRollup(def: RecordTypeDef, f: FieldDef, at: string, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const r = f.rollup!;
  if (f.type !== 'number' && f.type !== 'money') issues.push({ path: at, message: 'rollups must be number or money fields' });
  if (f.calculated || f.copyFrom || f.follow) issues.push({ path: at, message: 'rollups cannot also be calculated, copied or followed' });
  expr(issues, `${at}/where`, r.where);
  const child = r.recordType === def.key ? def : lookup.recordType(r.recordType);
  if (!child) {
    issues.push({ path: `${at}/recordType`, message: `record type '${r.recordType}' is not published` });
    return;
  }
  const ref = child.fields.find((x) => x.key === r.reference);
  if (!ref || ref.type !== 'reference' || ref.referenceType !== def.key) {
    issues.push({ path: `${at}/reference`, message: `'${r.reference}' is not a reference to '${def.key}' on '${child.key}'` });
  }
  if (r.measure === 'sum') {
    const source = r.field ? child.fields.find((x) => x.key === r.field) : undefined;
    if (!source || !['number', 'money'].includes(source.type)) {
      issues.push({ path: `${at}/field`, message: `'${r.field ?? ''}' is not a number or money field of '${child.key}'` });
    }
  }
}

function checkRecordType(def: RecordTypeDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  checkCopies(def, issues, lookup);
  checkFollow(def, issues, lookup);
  const seen = new Set<string>();
  def.fields.forEach((f, i) => {
    if (seen.has(f.key)) issues.push({ path: `/fields/${i}/key`, message: `duplicate field '${f.key}'` });
    seen.add(f.key);
    if ((f.type === 'choice' || f.type === 'multiChoice') && !f.choices?.length) {
      issues.push({ path: `/fields/${i}/choices`, message: 'choice fields need at least one choice' });
    }
    if (f.unique && !UNIQUE_FIELD_TYPES.has(f.type)) {
      issues.push({ path: `/fields/${i}/unique`, message: 'only text, email, phone and number fields can be unique' });
    }
    if (f.unique && (f.calculated || f.rollup || f.follow)) {
      issues.push({ path: `/fields/${i}/unique`, message: 'calculated fields cannot be unique' });
    }
    if (f.pattern !== undefined) {
      if (f.type !== 'text') issues.push({ path: `/fields/${i}/pattern`, message: 'only text fields can have a pattern' });
      const problem = checkPattern(f.pattern);
      if (problem) issues.push({ path: `/fields/${i}/pattern`, message: problem });
    }
    if (f.patternMessage && f.pattern === undefined) {
      issues.push({ path: `/fields/${i}/patternMessage`, message: 'a pattern message needs a pattern' });
    }
    if (f.placeholder !== undefined && NO_PLACEHOLDER_TYPES.has(f.type)) {
      issues.push({ path: `/fields/${i}/placeholder`, message: `${f.type} fields cannot have a placeholder` });
    }
    for (const option of FILE_OPTIONS) {
      if (f[option] !== undefined && f.type !== 'file') issues.push({ path: `/fields/${i}/${option}`, message: 'only file fields have this option' });
    }
    if (f.typedCoordinates !== undefined && f.type !== 'location') issues.push({ path: `/fields/${i}/typedCoordinates`, message: 'only location fields have this option' });
    if (f.typedName !== undefined && f.type !== 'signature') issues.push({ path: `/fields/${i}/typedName`, message: 'only signature fields have this option' });
    if (f.rollup) checkRollup(def, f, `/fields/${i}/rollup`, issues, lookup);
    if (f.type === 'reference' && !f.referenceType) {
      issues.push({ path: `/fields/${i}/referenceType`, message: 'reference fields need a referenceType' });
    }
    expr(issues, `/fields/${i}/calculated`, f.calculated);
    expr(issues, `/fields/${i}/visibleWhen`, f.visibleWhen);
    expr(issues, `/fields/${i}/editableWhen`, f.editableWhen);
    if (f.calculated && (f.visibleWhen || f.editableWhen)) {
      issues.push({ path: `/fields/${i}`, message: 'calculated fields cannot have visibleWhen or editableWhen' });
    }
    if (f.editPermission && (f.calculated || f.rollup || f.follow)) {
      issues.push({ path: `/fields/${i}/editPermission`, message: 'calculated, rollup and followed fields cannot be changed, so they have no edit permission' });
    }
    if (f.sensitive && f.readPermission && f.readPermission !== `record:${def.key}:sensitive`) {
      issues.push({
        path: `/fields/${i}/readPermission`,
        message: `a sensitive field needs record:${def.key}:sensitive to be seen; turn sensitive off to use '${f.readPermission}'`,
      });
    }
  });
  if (def.titleField && !seen.has(def.titleField)) {
    issues.push({ path: '/titleField', message: `unknown field '${def.titleField}'` });
  }
  def.rules?.forEach((r, i) => {
    expr(issues, `/rules/${i}/expression`, r.expression);
    expr(issues, `/rules/${i}/when`, r.when);
  });
  checkLookups(def, issues, lookup);
  checkPublic(def, issues, lookup);
}

const PUBLIC_VALUE_TYPES = new Set(['text', 'longText', 'number', 'money', 'date', 'boolean', 'choice', 'multiChoice', 'email', 'phone', 'location', 'richText']);

/** Why a field cannot be shown or accepted on a public form, or undefined when it can. */
function publicFieldProblem(def: RecordTypeDef, key: string, displayOnly: boolean): string | undefined {
  const f = def.fields.find((field) => field.key === key);
  if (!f) return `unknown field '${key}'`;
  if (f.sensitive || f.readPermission) return `'${key}' is hidden from some people and cannot be public`;
  if (f.type === 'person' || f.type === 'file' || f.type === 'signature') return `'${key}' cannot be public`;
  if (f.type === 'reference') return displayOnly ? `'${key}' cannot be shown in a catalogue` : undefined;
  if (!PUBLIC_VALUE_TYPES.has(f.type)) return `'${key}' cannot be public`;
  if (!displayOnly && (f.calculated || f.rollup || f.follow)) return `'${key}' is filled automatically and cannot be entered`;
  if (!displayOnly && f.editPermission) return `'${key}' can only be changed by someone with a permission`;
  if (!displayOnly && def.lookups?.some((lookup) => lookup.inputs.includes(key))) return `'${key}' is sent to a lookup and cannot be entered by a visitor`;
  return undefined;
}

/** Public catalogue, create, view, edit and delete. Each is a setting; view, edit and delete stay on the visitor's own link. */
function checkPublic(def: RecordTypeDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const pub = def.public;
  if (!pub) return;
  if (pub.view && !pub.create) issues.push({ path: '/public/view', message: 'view needs create, because that is when the link is issued' });
  if (pub.edit && !pub.view) issues.push({ path: '/public/edit', message: 'edit needs view, because the link is the only public handle' });
  if (pub.delete && !pub.view) issues.push({ path: '/public/delete', message: 'delete needs view, because the link is the only public handle' });
  const open = !!(pub.catalogue || pub.create || pub.view || pub.edit || pub.delete);
  const posts = lookup.all('postingRule').some((r) => r.recordType === def.key) || lookup.all('receiptRule').some((r) => r.recordType === def.key);
  if (open && posts) issues.push({ path: '/public', message: 'a record type that posts to the books or issues a receipt cannot be public' });

  const form = !!(pub.create || pub.view || pub.edit || pub.delete);
  if (form && !pub.fields?.length) issues.push({ path: '/public/fields', message: 'choose at least one field' });
  let references = 0;
  pub.fields?.forEach((key, i) => {
    const problem = publicFieldProblem(def, key, false);
    const field = def.fields.find((f) => f.key === key);
    if (problem) issues.push({ path: `/public/fields/${i}`, message: problem });
    else if (field?.type === 'reference') {
      references += 1;
      const target = field.referenceType ? lookup.recordType(field.referenceType) : undefined;
      if (!target?.public?.catalogue) issues.push({ path: `/public/fields/${i}`, message: `'${key}' must point at a record type with a public catalogue` });
    }
  });
  if (references > 1) issues.push({ path: '/public/fields', message: 'a public form can name one catalogue record' });
  if (pub.create) {
    def.fields.forEach((f) => {
      if (!f.required || f.calculated || f.rollup || f.follow) return;
      if (!pub.fields?.includes(f.key)) issues.push({ path: '/public/fields', message: `'${f.key}' is required, so the public form must include it` });
    });
  }

  const catalogue = pub.catalogue;
  if (!catalogue) return;
  const states = new Set(lookup.workflowsFor(def.key).flatMap((w) => w.states.map((s) => s.key)));
  if (!catalogue.statusIn.length) issues.push({ path: '/public/catalogue/statusIn', message: 'choose at least one status, so the catalogue cannot list every record' });
  catalogue.statusIn.forEach((status, i) => {
    if (!states.has(status)) issues.push({ path: `/public/catalogue/statusIn/${i}`, message: `no workflow of '${def.key}' has state '${status}'` });
  });
  catalogue.fields.forEach((key, i) => {
    const problem = publicFieldProblem(def, key, true);
    if (problem) issues.push({ path: `/public/catalogue/fields/${i}`, message: problem });
  });
  const shown = new Set(catalogue.fields);
  catalogue.search?.forEach((key, i) => {
    if (!shown.has(key)) issues.push({ path: `/public/catalogue/search/${i}`, message: `'${key}' is not one of the fields a result shows` });
  });
  const request = catalogue.request;
  if (!request) return;
  const target = lookup.recordType(request.recordType);
  if (!target) issues.push({ path: '/public/catalogue/request/recordType', message: `record type '${request.recordType}' is not published` });
  else if (!target.public?.create) issues.push({ path: '/public/catalogue/request/recordType', message: `'${request.recordType}' does not accept a public form` });
  else {
    const field = target.fields.find((f) => f.key === request.field);
    const listed = target.public?.fields?.includes(request.field);
    if (!field || field.type !== 'reference' || field.referenceType !== def.key || !listed) {
      issues.push({ path: '/public/catalogue/request/field', message: `'${request.field}' must be a public reference from '${request.recordType}' to '${def.key}'` });
    }
  }
}

/** Each lookup calls an http lookup connector with fields of the type and fills editable, non-money fields. */
function checkLookups(def: RecordTypeDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const fields = new Map(def.fields.map((f) => [f.key, f]));
  const keys = new Set<string>();
  def.lookups?.forEach((l, i) => {
    const at = `/lookups/${i}`;
    if (keys.has(l.key)) issues.push({ path: `${at}/key`, message: `duplicate lookup '${l.key}'` });
    keys.add(l.key);
    const problem = l.connector ? connectorProblem(lookup, l.connector, ['lookup']) : 'choose a connector';
    if (problem) issues.push({ path: `${at}/connector`, message: problem });
    l.inputs.forEach((k, j) => {
      if (!fields.has(k)) issues.push({ path: `${at}/inputs/${j}`, message: `unknown field '${k}'` });
    });
    for (const k of Object.keys(l.map)) {
      const f = fields.get(k);
      if (!f) issues.push({ path: `${at}/map/${k}`, message: `unknown field '${k}'` });
      else if (f.calculated || f.rollup || f.follow) issues.push({ path: `${at}/map/${k}`, message: `'${k}' is filled automatically and cannot be filled by a lookup` });
      else if (f.type === 'money') issues.push({ path: `${at}/map/${k}`, message: `money field '${k}' cannot be filled by a lookup` });
    }
  });
}

/** The named workflow of a record type, or its primary one. Reports an issue when the name does not resolve. */
function workflowNamed(
  issues: FieldIssue[],
  path: string,
  lookup: DefinitionLookup,
  recordType: string,
  key: string | undefined,
): WorkflowDef | undefined {
  if (key === undefined) return lookup.workflowFor(recordType);
  const wf = lookup.workflowsFor(recordType).find((w) => w.key === key);
  if (!wf) issues.push({ path, message: `record type '${recordType}' has no workflow '${key}'` });
  return wf;
}

function checkWorkflowSet(def: WorkflowDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const primary = isPrimary(def);
  if (!primary && def.appliesWhen !== undefined) issues.push({ path: '/appliesWhen', message: 'parallel workflows use startsWhen, not appliesWhen' });
  if (primary && def.startsWhen !== undefined) issues.push({ path: '/startsWhen', message: 'primary workflows use appliesWhen, not startsWhen' });
  expr(issues, '/appliesWhen', def.appliesWhen);
  expr(issues, '/startsWhen', def.startsWhen);

  const others = lookup.workflowsFor(def.recordType).filter((w) => w.key !== def.key);
  const fallback = others.find((w) => isPrimary(w) && w.appliesWhen === undefined);
  if (primary && def.appliesWhen === undefined && fallback) {
    issues.push({ path: '/appliesWhen', message: `workflow '${fallback.key}' already applies to every record; say which records follow this one` });
  }
  const taken = new Map(others.flatMap((w) => w.transitions.map((t) => [t.key, w.key] as const)));
  def.transitions.forEach((t, i) => {
    const owner = taken.get(t.key);
    if (owner) issues.push({ path: `/transitions/${i}/key`, message: `step '${t.key}' is already used by workflow '${owner}'` });
  });
}

function checkWorkflow(def: WorkflowDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  checkWorkflowSet(def, issues, lookup);
  const type = needType(issues, lookup, def.recordType);
  const states = new Set(def.states.map((s) => s.key));
  if (states.size !== def.states.length) issues.push({ path: '/states', message: 'duplicate state keys' });
  if (!states.has(def.initial)) issues.push({ path: '/initial', message: `unknown state '${def.initial}'` });
  const fields = new Set(type?.fields.map((f) => f.key) ?? []);
  const keys = new Set<string>();
  def.transitions.forEach((t, i) => {
    if (keys.has(t.key)) issues.push({ path: `/transitions/${i}/key`, message: `duplicate transition '${t.key}'` });
    keys.add(t.key);
    for (const f of t.from) if (!states.has(f)) issues.push({ path: `/transitions/${i}/from`, message: `unknown state '${f}'` });
    if (!states.has(t.to)) issues.push({ path: `/transitions/${i}/to`, message: `unknown state '${t.to}'` });
    for (const f of t.requiredFields ?? []) {
      if (type && !fields.has(f)) issues.push({ path: `/transitions/${i}/requiredFields`, message: `unknown field '${f}'` });
    }
    expr(issues, `/transitions/${i}/guard`, t.guard);
    if (t.approval) {
      if (!t.approval.roles?.length && !t.approval.users?.length) {
        issues.push({ path: `/transitions/${i}/approval`, message: 'approval needs at least one role or person' });
      }
      expr(issues, `/transitions/${i}/approval/when`, t.approval.when);
    }
  });
}

function checkTemplateDef(def: TemplateDef, issues: FieldIssue[]): void {
  for (const e of checkTemplate(def.subject)) issues.push({ path: '/subject', message: e });
  for (const e of checkTemplate(def.body)) issues.push({ path: '/body', message: e });
  if ((def.kind ?? 'message') === 'document') {
    if (!def.html?.trim()) issues.push({ path: '/html', message: 'a document template needs HTML' });
    else for (const e of checkDocumentTemplate(def.html)) issues.push({ path: '/html', message: e });
  } else if (def.html) {
    for (const e of checkTemplate(def.html)) issues.push({ path: '/html', message: e });
  }
  def.whatsapp?.parameters?.forEach((p, i) => expr(issues, `/whatsapp/parameters/${i}`, p));
}

function checkAutomation(def: AutomationDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const type = needType(issues, lookup, def.recordType);
  const t = def.trigger;
  const wf = workflowNamed(issues, '/trigger/workflow', lookup, def.recordType, 'workflow' in t ? t.workflow : undefined);
  const states = new Set(wf?.states.map((s) => s.key) ?? []);
  if (t.event === 'schedule') {
    if (!t.cron) issues.push({ path: '/trigger/cron', message: 'schedule triggers need a cron expression' });
    else {
      const err = checkCron(t.cron);
      if (err) issues.push({ path: '/trigger/cron', message: err });
    }
  }
  for (const s of [('to' in t ? t.to : undefined), ('from' in t ? t.from : undefined), ('status' in t ? t.status : undefined)]) {
    if (s && !states.has(s)) issues.push({ path: '/trigger', message: `unknown status '${s}'` });
  }
  expr(issues, '/condition', def.condition);
  checkSteps(def.actions, '/actions', def.recordType, type, issues, lookup);
}

/** Steps shared by automations and record actions. */
function checkSteps(
  steps: ActionStep[],
  base: string,
  recordType: string,
  type: RecordTypeDef | undefined,
  issues: FieldIssue[],
  lookup: DefinitionLookup,
): void {
  const stepKeys = new Set(lookup.workflowsFor(recordType).flatMap((w) => w.transitions.map((t) => t.key)));
  const writable = (target: RecordTypeDef | undefined, key: string) => {
    const f = target?.fields.find((x) => x.key === key);
    return !!f && !f.calculated && !f.rollup;
  };
  steps.forEach((a, i) => {
    const at = `${base}/${i}`;
    switch (a.type) {
      case 'setFields':
      case 'transition':
      case 'createRecord': {
        const target = a.type === 'createRecord' ? lookup.recordType(a.recordType) : type;
        if (a.type === 'createRecord' && !target) issues.push({ path: `${at}/recordType`, message: `record type '${a.recordType}' is not published` });
        if (a.type === 'transition' && !stepKeys.has(a.transition)) {
          issues.push({ path: `${at}/transition`, message: `workflow has no step '${a.transition}'` });
        }
        for (const [k, v] of Object.entries(a.values ?? {})) {
          if (target && !writable(target, k)) issues.push({ path: `${at}/values/${k}`, message: `'${k}' is not a writable field` });
          expr(issues, `${at}/values/${k}`, v);
        }
        if (a.type === 'setFields' && !Object.keys(a.values ?? {}).length) issues.push({ path: `${at}/values`, message: 'set at least one field' });
        break;
      }
      case 'notify': {
        if (!lookup.template(a.template)) issues.push({ path: `${at}/template`, message: `template '${a.template}' is not published` });
        const to = a.to ?? {};
        if (!to.roles?.length && !to.users?.length && !to.email && !to.phone && !to.creator && !to.field) {
          issues.push({ path: `${at}/to`, message: 'choose at least one recipient' });
        }
        if (to.field !== undefined && type && type.fields.find((f) => f.key === to.field)?.type !== 'person') {
          issues.push({ path: `${at}/to/field`, message: `'${to.field}' is not a person field of this record type` });
        }
        expr(issues, `${at}/to/email`, to.email);
        expr(issues, `${at}/to/phone`, to.phone);
        const phoneChannels = (a.channels ?? []).filter((c) => c === 'sms' || c === 'whatsapp');
        if (phoneChannels.length && !to.phone && !to.field) {
          issues.push({ path: `${at}/to/phone`, message: `${phoneChannels.join(' and ')} need a phone recipient` });
        }
        break;
      }
      case 'webhook':
      case 'connector': {
        const problem = a.connector ? connectorProblem(lookup, a.connector, a.type === 'webhook' ? ['webhook'] : ['send']) : 'choose a connector';
        if (problem) issues.push({ path: `${at}/connector`, message: problem });
        for (const [k, v] of Object.entries(a.body ?? {})) expr(issues, `${at}/body/${k}`, v);
        break;
      }
      case 'createPayment':
        if (!a.provider) issues.push({ path: `${at}/provider`, message: 'choose a payment provider' });
        if (!a.account) issues.push({ path: `${at}/account`, message: 'choose the account that receives the payment' });
        if (!a.amount) issues.push({ path: `${at}/amount`, message: 'say how much to ask for' });
        expr(issues, `${at}/amount`, a.amount);
        if (!a.onPaid?.transition) issues.push({ path: `${at}/onPaid`, message: 'choose the step to run when the payment arrives' });
        else if (!stepKeys.has(a.onPaid.transition)) {
          issues.push({ path: `${at}/onPaid/transition`, message: `workflow has no step '${a.onPaid.transition}'` });
        }
        for (const [k, f] of Object.entries(a.onPaid?.fields ?? {})) {
          if (f && type && !writable(type, f)) issues.push({ path: `${at}/onPaid/fields/${k}`, message: `'${f}' is not a writable field` });
        }
        break;
      case 'openReceipt':
        if (!lookup.all('receiptRule').some((r) => r.recordType === recordType)) {
          issues.push({ path: at, message: `record type '${recordType}' has no receipt rule` });
        }
        break;
      case 'report': {
        const report = a.report ? lookup.definition('report', a.report) : undefined;
        if (!report) issues.push({ path: `${at}/report`, message: `report '${a.report ?? ''}' is not published` });
        for (const [k, exprText] of Object.entries(a.params ?? {})) expr(issues, `${at}/params/${k}`, exprText);
        break;
      }
      case 'script': {
        const script = a.script ? lookup.definition('script', a.script) : undefined;
        if (!script) issues.push({ path: `${at}/script`, message: `script '${a.script ?? ''}' is not published` });
        else if (script.hook !== 'customButton' || script.recordType !== recordType) {
          issues.push({ path: `${at}/script`, message: `script '${a.script}' is not a custom-button script of '${recordType}'` });
        }
        break;
      }
    }
  });
}

/**
 * A script's declared inputs and effects: every reference resolves, every
 * declared effect type is allowed on the hook, and journals declare their
 * accounts and ceiling.
 */
function checkScript(def: ScriptDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const type = needType(issues, lookup, def.recordType);
  issues.push(...checkDeclaredInputs(def.inputs));
  if (def.runAs && lookup.roles && !lookup.roles.has(def.runAs)) issues.push({ path: '/runAs', message: `role '${def.runAs}' does not exist` });
  def.inputs?.related?.forEach((r, i) => {
    const at = `/inputs/related/${i}`;
    const f = type?.fields.find((x) => x.key === r.field);
    if (type && f?.type !== 'reference') {
      issues.push({ path: `${at}/field`, message: `'${r.field}' is not a reference field of '${def.recordType}'` });
      return;
    }
    const target = f?.referenceType ? lookup.recordType(f.referenceType) : undefined;
    if (!target) return;
    r.fields.forEach((k, j) => {
      if (!target.fields.some((x) => x.key === k)) issues.push({ path: `${at}/fields/${j}`, message: `'${target.key}' has no field '${k}'` });
    });
  });
  def.inputs?.lookups?.forEach((l, i) => {
    const at = `/inputs/lookups/${i}`;
    const target = lookup.recordType(l.recordType);
    if (!target) {
      issues.push({ path: `${at}/recordType`, message: `record type '${l.recordType}' is not published` });
      return;
    }
    for (const [theirs, ours] of Object.entries(l.match)) {
      const f = target.fields.find((x) => x.key === theirs);
      if (!f) issues.push({ path: `${at}/match/${theirs}`, message: `'${target.key}' has no field '${theirs}'` });
      else if (f.sensitive || !FILTERABLE_FIELD_TYPES.has(f.type)) issues.push({ path: `${at}/match/${theirs}`, message: `'${theirs}' cannot be matched on` });
      if (type && !type.fields.some((x) => x.key === ours)) issues.push({ path: `${at}/match/${theirs}`, message: `'${def.recordType}' has no field '${ours}'` });
    }
    l.fields.forEach((k, j) => {
      if (!target.fields.some((x) => x.key === k)) issues.push({ path: `${at}/fields/${j}`, message: `'${target.key}' has no field '${k}'` });
    });
  });
  def.inputs?.balances?.accounts?.forEach((c, i) => {
    if (lookup.accountCodes && !lookup.accountCodes.has(c)) issues.push({ path: `/inputs/balances/accounts/${i}`, message: `ledger account '${c}' does not exist` });
  });

  const e = def.effects;
  if (!e) return;
  if (e.allow.length && !HOOK_TAKES_EFFECTS[def.hook]) issues.push({ path: '/effects/allow', message: `the ${def.hook} hook cannot propose effects` });
  if (e.allow.includes('ledger.propose')) {
    if (!e.accounts?.length) issues.push({ path: '/effects/accounts', message: 'declare the ledger accounts journals may use' });
    if (e.maxTotalAmount === undefined) issues.push({ path: '/effects/maxTotalAmount', message: 'declare the most one run may post' });
  }
  e.accounts?.forEach((c, i) => {
    if (lookup.accountCodes && !lookup.accountCodes.has(c)) issues.push({ path: `/effects/accounts/${i}`, message: `ledger account '${c}' does not exist` });
  });
  e.connectors?.forEach((c, i) => {
    const problem = connectorProblem(lookup, c, ['webhook', 'send']);
    if (problem) issues.push({ path: `/effects/connectors/${i}`, message: problem });
  });
  e.recipients?.forEach((r, i) => {
    if (lookup.namedRecipients && !lookup.namedRecipients.has(r)) issues.push({ path: `/effects/recipients/${i}`, message: `named recipient '${r}' is not in the organisation settings` });
  });
  if (e.connectors?.length && !e.allow.includes('connector.call')) issues.push({ path: '/effects/connectors', message: "connectors need 'connector.call' in allow" });
  if (e.recipients?.length && !e.allow.includes('notify')) issues.push({ path: '/effects/recipients', message: "named recipients need 'notify' in allow" });
}

function checkAction(def: ActionDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const type = needType(issues, lookup, def.recordType);
  expr(issues, '/when', def.when);
  const keys = new Set<string>();
  def.form?.fields.forEach((f, i) => {
    const at = `/form/fields/${i}`;
    if (keys.has(f.key)) issues.push({ path: `${at}/key`, message: `duplicate field '${f.key}'` });
    keys.add(f.key);
    if (f.type === 'choice' && !f.choices?.length) issues.push({ path: `${at}/choices`, message: 'choice fields need at least one choice' });
    if (f.placeholder !== undefined && NO_PLACEHOLDER_TYPES.has(f.type)) issues.push({ path: `${at}/placeholder`, message: `${f.type} fields cannot have a placeholder` });
    if (f.type === 'reference' && !lookup.recordType(f.referenceType ?? '')) {
      issues.push({ path: `${at}/referenceType`, message: `record type '${f.referenceType ?? ''}' is not published` });
    }
  });
  checkFullWidth(def.form, def.form ? new Set(def.form.fields.map((f) => f.key)) : undefined, '/form', issues);
  checkSteps(def.steps, '/steps', def.recordType, type, issues, lookup);
}

const GROUPABLE_FIELD_TYPES = new Set(['choice', 'boolean', 'reference']);

function checkPage(def: PageDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  def.audience?.forEach((r, i) => {
    if (lookup.roles && !lookup.roles.has(r)) issues.push({ path: `/audience/${i}`, message: `role '${r}' does not exist` });
  });

  const listViews = lookup.all('listView');
  const checkView = (at: string, recordType: string, type: RecordTypeDef, view: ViewRef | undefined, chips?: Set<string>) => {
    if (!view) return;
    const known = chips ?? new Set(listViews.filter((v) => v.recordType === recordType).flatMap((v) => v.chips?.map((c) => c.id) ?? []));
    if (view.chip && !known.has(view.chip)) issues.push({ path: `${at}/view/chip`, message: `unknown chip '${view.chip}'` });
    for (const k of Object.keys(view.filters ?? {})) {
      const f = type.fields.find((x) => x.key === k);
      if (!f) issues.push({ path: `${at}/view/filters/${k}`, message: `unknown field '${k}'` });
      else if (f.sensitive) issues.push({ path: `${at}/view/filters/${k}`, message: `sensitive field '${k}' cannot be filtered` });
      else if (!FILTERABLE_FIELD_TYPES.has(f.type)) issues.push({ path: `${at}/view/filters/${k}`, message: `'${k}' (${f.type}) cannot be filtered` });
    }
  };

  def.widgets.forEach((w, i) => {
    const at = `/widgets/${i}`;
    switch (w.type) {
      case 'stat':
      case 'chart': {
        const type = lookup.recordType(w.recordType);
        if (!type) {
          issues.push({ path: `${at}/recordType`, message: `record type '${w.recordType}' is not published` });
          return;
        }
        const field = (k: string) => type.fields.find((f) => f.key === k);
        if (w.measure === 'sum') {
          const f = w.field ? field(w.field) : undefined;
          if (!w.field) issues.push({ path: `${at}/field`, message: 'choose a number or money field to total' });
          else if (!f || !['number', 'money'].includes(f.type)) issues.push({ path: `${at}/field`, message: `'${w.field}' is not a number or money field` });
          else if (f.sensitive) issues.push({ path: `${at}/field`, message: `sensitive field '${w.field}' cannot be totalled` });
        }
        if (w.type === 'chart') {
          if ('field' in w.groupBy) {
            const f = field(w.groupBy.field);
            if (!f || !GROUPABLE_FIELD_TYPES.has(f.type) || f.sensitive) {
              issues.push({ path: `${at}/groupBy/field`, message: `'${w.groupBy.field}' cannot be grouped by; use a choice, yes/no or reference field` });
            }
          } else {
            const k = w.groupBy.dateField;
            if (k !== 'createdAt' && k !== 'updatedAt' && field(k)?.type !== 'date') {
              issues.push({ path: `${at}/groupBy/dateField`, message: `'${k}' is not a date field` });
            }
          }
        }
        checkView(at, w.recordType, type, w.view);
        break;
      }
      case 'list': {
        const view = lookup.definition('listView', w.listView);
        if (!view) {
          issues.push({ path: `${at}/listView`, message: `list view '${w.listView}' is not published` });
          return;
        }
        const type = lookup.recordType(view.recordType);
        if (type) checkView(at, view.recordType, type, w.view, new Set(view.chips?.map((c) => c.id) ?? []));
        break;
      }
      case 'links':
      case 'groups':
        break;
    }
  });
}

function checkTranslation(def: TranslationDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const clash = lookup.all('translation').find((t) => t.key !== def.key && t.locale === def.locale);
  if (clash) issues.push({ path: '/locale', message: `translation '${clash.key}' already covers '${def.locale}'` });
}

/** Problems that do not block publishing but are shown in the Builder. */
export function checkWarnings<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K], lookup: DefinitionLookup): FieldIssue[] {
  const warnings: FieldIssue[] = [];
  if (kind === 'translation') {
    for (const path of Object.keys((body as TranslationDef).entries)) {
      if (!translationTargetExists(path, (k, key) => lookup.definition(k, key))) {
        warnings.push({ path: `/entries/${path}`, message: `nothing at '${path}' to translate any more` });
      }
    }
  }
  if (lookup.rolePermissions) {
    const generated = generatedPermissions({ recordTypes: lookup.all('recordType'), workflows: lookup.all('workflow'), actions: lookup.all('action'), reports: lookup.all('report') });
    for (const { path, permission } of explicitPermissions(kind, body)) {
      if (!isKnownPermission(permission, generated, lookup.rolePermissions)) {
        warnings.push({ path, message: `'${permission}' is not a generated permission and no role has it yet` });
      }
    }
  }
  if (kind === 'listView') maskedListWarnings(body as ListViewDef, lookup, warnings);
  if (kind === 'page') maskedWidgetWarnings(body as PageDef, lookup, warnings);
  return warnings;
}

/** A field with its own read permission (not sensitive, which is refused) as a column or filter: masked or refused for some people. */
function protectedField(type: RecordTypeDef | undefined, key: string): FieldDef | undefined {
  const f = type?.fields.find((x) => x.key === key);
  return f && !f.sensitive && f.readPermission ? f : undefined;
}

function maskedListWarnings(def: ListViewDef, lookup: DefinitionLookup, warnings: FieldIssue[]): void {
  const type = lookup.recordType(def.recordType);
  for (const prop of ['columns', 'compactColumns', 'filters'] as const) {
    def[prop]?.forEach((k, i) => {
      const f = protectedField(type, k);
      if (!f) return;
      const what = prop === 'filters' ? 'cannot filter by it' : 'see it masked';
      warnings.push({ path: `/${prop}/${i}`, message: `'${k}' needs '${f.readPermission}' to be seen; people without it ${what}` });
    });
  }
}

function maskedWidgetWarnings(def: PageDef, lookup: DefinitionLookup, warnings: FieldIssue[]): void {
  def.widgets.forEach((w, i) => {
    if (w.type !== 'stat' && w.type !== 'chart') return;
    const type = lookup.recordType(w.recordType);
    const used = [w.field, w.type === 'chart' && 'field' in w.groupBy ? w.groupBy.field : undefined, ...Object.keys(w.view?.filters ?? {})];
    for (const k of new Set(used.filter((x): x is string => !!x))) {
      const f = protectedField(type, k);
      if (f && f.readPermission !== w.permission) {
        warnings.push({ path: `/widgets/${i}`, message: `'${k}' needs '${f.readPermission}' to be seen; people without it get an error instead of this widget` });
      }
    }
  });
}

function checkStatus(issues: FieldIssue[], lookup: DefinitionLookup, recordType: string, status: string, workflow?: string): void {
  const wf = workflowNamed(issues, '/workflow', lookup, recordType, workflow);
  if (!wf) {
    if (workflow === undefined) issues.push({ path: '/whenStatus', message: `record type '${recordType}' has no workflow` });
  } else if (!wf.states.some((s) => s.key === status)) {
    issues.push({ path: '/whenStatus', message: `workflow '${wf.key}' has no state '${status}'` });
  }
}

function checkPostingRule(def: PostingRuleDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  needType(issues, lookup, def.recordType);
  checkStatus(issues, lookup, def.recordType, def.whenStatus, def.workflow);
  expr(issues, '/condition', def.condition);
  expr(issues, '/date', def.date);
  expr(issues, '/memo', def.memo);
  if (!def.lines.some((l) => l.side === 'debit') || !def.lines.some((l) => l.side === 'credit')) {
    issues.push({ path: '/lines', message: 'needs at least one debit and one credit line' });
  }
  def.lines.forEach((l, i) => {
    expr(issues, `/lines/${i}/amount`, l.amount);
    expr(issues, `/lines/${i}/accountExpr`, l.accountExpr);
    expr(issues, `/lines/${i}/fund`, l.fund);
    if (l.account && lookup.accountCodes && !lookup.accountCodes.has(l.account)) {
      issues.push({ path: `/lines/${i}/account`, message: `ledger account '${l.account}' does not exist` });
    }
  });
}

/** A receipt is shown to anyone with the link, so these fields cannot be named on a row. */
const UNPRINTABLE = new Set(['longText', 'richText', 'reference', 'file', 'signature']);

function templateAt(issues: FieldIssue[], path: string, text: string | undefined): void {
  if (!text) return;
  for (const e of checkTemplate(text)) issues.push({ path, message: e });
}

function checkReceiptRule(def: ReceiptRuleDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const type = needType(issues, lookup, def.recordType);
  checkStatus(issues, lookup, def.recordType, def.whenStatus, def.workflow);
  expr(issues, '/condition', def.condition);
  expr(issues, '/amount', def.amount);
  expr(issues, '/date', def.date);
  if (lookup.receiptSeries && !lookup.receiptSeries.has(def.series)) {
    issues.push({ path: '/series', message: `receipt series '${def.series}' does not exist` });
  }
  const layout = def.layout;
  if (!layout) return;
  templateAt(issues, '/layout/title', layout.title);
  templateAt(issues, '/layout/statement', layout.statement);
  templateAt(issues, '/layout/thanks', layout.thanks);
  layout.rows?.forEach((row, i) => {
    const at = `/layout/rows/${i}`;
    templateAt(issues, `${at}/label`, row.label);
    templateAt(issues, `${at}/value`, row.value);
    expr(issues, `${at}/value`, row.value);
    if (!row.field && !row.value) issues.push({ path: at, message: 'a row needs a field or a value' });
    if (!row.field) return;
    const field = type?.fields.find((f) => f.key === row.field);
    if (!field) issues.push({ path: `${at}/field`, message: `record type '${def.recordType}' has no field '${row.field}'` });
    else if (field.sensitive || field.readPermission || UNPRINTABLE.has(field.type)) {
      issues.push({ path: `${at}/field`, message: `'${row.field}' cannot be printed on a receipt` });
    }
  });
  layout.clauses?.forEach((clause, i) => {
    if (!REGISTRATION_TYPE.test(clause.registration)) {
      issues.push({ path: `/layout/clauses/${i}/registration`, message: 'Use lowercase letters, digits, - or _ for the registration type, e.g. 80g.' });
    }
    templateAt(issues, `/layout/clauses/${i}/text`, clause.text);
  });
}

export function checkCrossReferences<K extends DefinitionKind>(
  kind: K,
  body: DefinitionBodies[K],
  lookup: DefinitionLookup,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  switch (kind) {
    case 'recordType':
      checkRecordType(body as RecordTypeDef, issues, lookup);
      break;
    case 'workflow':
      checkWorkflow(body as WorkflowDef, issues, lookup);
      break;
    case 'postingRule':
      checkPostingRule(body as PostingRuleDef, issues, lookup);
      break;
    case 'receiptRule':
      checkReceiptRule(body as ReceiptRuleDef, issues, lookup);
      break;
    case 'script':
      checkScript(body as ScriptDef, issues, lookup);
      break;
    case 'automation':
      checkAutomation(body as AutomationDef, issues, lookup);
      break;
    case 'template':
      checkTemplateDef(body as TemplateDef, issues);
      break;
    case 'theme':
      break;
    case 'listView':
      checkListView(body as ListViewDef, issues, lookup);
      break;
    case 'recordGroup':
      (body as RecordGroupDef).recordTypes.forEach((k, i) => {
        if (!lookup.recordType(k)) issues.push({ path: `/recordTypes/${i}`, message: `record type '${k}' is not published` });
      });
      break;
    case 'translation':
      checkTranslation(body as TranslationDef, issues, lookup);
      break;
    case 'action':
      checkAction(body as ActionDef, issues, lookup);
      break;
    case 'page':
      checkPage(body as PageDef, issues, lookup);
      break;
    case 'report':
      checkReport(body as ReportDef, issues, lookup);
      break;
    case 'reportGroup':
      (body as ReportGroupDef).reports.forEach((k, i) => {
        if (!lookup.definition('report', k)) issues.push({ path: `/reports/${i}`, message: `report '${k}' is not published` });
      });
      break;
    case 'dataFeed':
      checkDataFeed(body as DataFeedDef, issues, lookup);
      break;
  }
  return issues;
}

const SORTABLE_FEED_FIELDS = new Set(['text', 'number', 'money', 'date', 'boolean', 'choice', 'email', 'phone']);

/** A records feed lists only safe fields of one record type. A content feed is text and nothing else. */
function checkDataFeed(def: DataFeedDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const recordSettings = [def.recordType, def.fields, def.statusIn, def.search, def.sort, def.allowFilters].some((v) => v !== undefined);
  if (def.source === 'content') {
    if (recordSettings) issues.push({ path: '/source', message: 'a content feed has entries only' });
    if (!def.entries?.length) issues.push({ path: '/entries', message: 'add at least one entry' });
    const keys = new Set<string>();
    def.entries?.forEach((entry, i) => {
      if (keys.has(entry.key)) issues.push({ path: `/entries/${i}/key`, message: `duplicate entry '${entry.key}'` });
      keys.add(entry.key);
    });
    return;
  }
  if (def.entries?.length) issues.push({ path: '/entries', message: 'a records feed has no entries' });
  const type = def.recordType ? needType(issues, lookup, def.recordType) : undefined;
  if (!def.recordType) issues.push({ path: '/recordType', message: 'choose a record type' });
  if (!type) return;
  const states = new Set(lookup.workflowsFor(type.key).flatMap((w) => w.states.map((s) => s.key)));
  if (!def.statusIn?.length) issues.push({ path: '/statusIn', message: 'choose at least one status, so the feed cannot list every record' });
  def.statusIn?.forEach((status, i) => {
    if (!states.has(status)) issues.push({ path: `/statusIn/${i}`, message: `no workflow of '${type.key}' has state '${status}'` });
  });
  if (!def.fields?.length) issues.push({ path: '/fields', message: 'choose at least one field' });
  def.fields?.forEach((key, i) => {
    const problem = publicFieldProblem(type, key, true);
    if (problem) issues.push({ path: `/fields/${i}`, message: problem });
  });
  const shown = new Set(def.fields ?? []);
  const subset = (keys: string[] | undefined, path: string) => {
    keys?.forEach((key, i) => {
      if (!shown.has(key)) issues.push({ path: `${path}/${i}`, message: `'${key}' is not one of the fields a result shows` });
    });
  };
  subset(def.search, '/search');
  subset(def.allowFilters, '/allowFilters');
  def.allowFilters?.forEach((key, i) => {
    const field = type.fields.find((f) => f.key === key);
    if (field && !FILTERABLE_FIELD_TYPES.has(field.type)) issues.push({ path: `/allowFilters/${i}`, message: `'${key}' cannot be filtered` });
  });
  if (def.sort) {
    if (!shown.has(def.sort.field)) issues.push({ path: '/sort/field', message: `'${def.sort.field}' is not one of the fields a result shows` });
    const field = type.fields.find((f) => f.key === def.sort!.field);
    if (field && !SORTABLE_FEED_FIELDS.has(field.type)) issues.push({ path: '/sort/field', message: `'${def.sort.field}' cannot be sorted` });
  }
}

/** Field types the list query can filter on. */
export const FILTERABLE_FIELD_TYPES = new Set(['choice', 'boolean', 'date', 'number', 'money', 'reference', 'text', 'email', 'phone', 'person']);

function checkReport(def: ReportDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const keys = new Set<string>();
  def.parameters?.forEach((p, i) => {
    if (keys.has(p.key)) issues.push({ path: `/parameters/${i}/key`, message: `duplicate parameter '${p.key}'` });
    keys.add(p.key);
    if (p.type === 'choice' && !p.choices?.length) issues.push({ path: `/parameters/${i}/choices`, message: 'choice parameters need at least one choice' });
  });
  const datasets = new Set<string>();
  def.datasets.forEach((d, i) => {
    const at = `/datasets/${i}`;
    if (datasets.has(d.key)) issues.push({ path: `${at}/key`, message: `duplicate dataset '${d.key}'` });
    datasets.add(d.key);
    if (d.source !== 'ledger') {
      const type = lookup.recordType(d.recordType);
      if (!type) issues.push({ path: `${at}/recordType`, message: `record type '${d.recordType}' is not published` });
      else if (d.source === 'query') {
        d.fields.forEach((k, j) => {
          if (!type.fields.some((f) => f.key === k)) issues.push({ path: `${at}/fields/${j}`, message: `unknown field '${k}'` });
        });
        d.related?.forEach((r, j) => {
          const f = type.fields.find((x) => x.key === r.field);
          if (f?.type !== 'reference') issues.push({ path: `${at}/related/${j}/field`, message: `'${r.field}' is not a reference field` });
        });
      } else if (d.measure === 'sum') {
        const f = type.fields.find((x) => x.key === d.field);
        if (!f || (f.type !== 'number' && f.type !== 'money')) issues.push({ path: `${at}/field`, message: 'sum needs a number or money field' });
      }
    }
    for (const [field, filter] of Object.entries(d.source === 'ledger' ? {} : (d.filters ?? {}))) {
      for (const [op, exprText] of Object.entries(filter)) if (exprText) expr(issues, `${at}/filters/${field}/${op}`, exprText);
    }
    if (d.source === 'ledger' && d.asOf) expr(issues, `${at}/asOf`, d.asOf);
  });
  const calcs = new Set<string>();
  def.calculations?.forEach((c, i) => {
    if (calcs.has(c.key)) issues.push({ path: `/calculations/${i}/key`, message: `duplicate calculation '${c.key}'` });
    calcs.add(c.key);
    expr(issues, `/calculations/${i}/expression`, c.expression);
  });
  if (def.shape && 'script' in def.shape) {
    const script = lookup.definition('script', def.shape.script);
    if (!script) issues.push({ path: '/shape/script', message: `script '${def.shape.script}' is not published` });
    else if (script.hook !== 'reportShape') issues.push({ path: '/shape/script', message: `'${def.shape.script}' is not a report shape script` });
  }
  const pdf = def.outputs?.pdf;
  if (pdf) {
    const template = lookup.template(pdf.template);
    if (!template) issues.push({ path: '/outputs/pdf/template', message: `template '${pdf.template}' is not published` });
    else if ((template.kind ?? 'message') !== 'document') issues.push({ path: '/outputs/pdf/template', message: `'${pdf.template}' is not a document template` });
  }
  def.outputs?.excel?.sheets.forEach((s, i) => {
    if (!datasets.has(s.dataset)) issues.push({ path: `/outputs/excel/sheets/${i}/dataset`, message: `unknown dataset '${s.dataset}'` });
  });
}

function checkListView(def: ListViewDef, issues: FieldIssue[], lookup: DefinitionLookup): void {
  const type = needType(issues, lookup, def.recordType);
  if (!type) return;
  const fields = new Map(type.fields.map((f) => [f.key, f]));
  const states = new Set(lookup.workflowFor(def.recordType)?.states.map((s) => s.key) ?? []);
  const showable = (key: string) => fields.has(key) || (LIST_VIEW_PSEUDO_FIELDS as readonly string[]).includes(key);
  const needShowable = (path: string, key: string) => {
    if (!showable(key)) issues.push({ path, message: `unknown field '${key}'` });
  };
  const needWritable = (path: string, key: string) => {
    const f = fields.get(key);
    if (!f) issues.push({ path, message: `unknown field '${key}'` });
    else if (f.calculated) issues.push({ path, message: `'${key}' is calculated and cannot be entered` });
    else if (f.rollup) issues.push({ path, message: `'${key}' is kept up to date automatically and cannot be entered` });
  };

  const chipIds = new Set<string>();
  def.chips?.forEach((c, i) => {
    if (chipIds.has(c.id)) issues.push({ path: `/chips/${i}/id`, message: `duplicate chip '${c.id}'` });
    chipIds.add(c.id);
    for (const s of c.statusIn ?? []) {
      if (!states.has(s)) issues.push({ path: `/chips/${i}/statusIn`, message: `unknown status '${s}'` });
    }
    if (c.workflowState) {
      const wf = workflowNamed(issues, `/chips/${i}/workflowState/workflow`, lookup, def.recordType, c.workflowState.workflow);
      for (const s of wf ? c.workflowState.in : []) {
        if (!wf!.states.some((x) => x.key === s)) issues.push({ path: `/chips/${i}/workflowState/in`, message: `workflow '${wf!.key}' has no state '${s}'` });
      }
    }
    for (const k of Object.keys(c.filters ?? {})) {
      const f = fields.get(k);
      if (!f) issues.push({ path: `/chips/${i}/filters/${k}`, message: `unknown field '${k}'` });
      else if (f.sensitive) issues.push({ path: `/chips/${i}/filters/${k}`, message: `sensitive field '${k}' cannot be filtered` });
      else if (!FILTERABLE_FIELD_TYPES.has(f.type)) issues.push({ path: `/chips/${i}/filters/${k}`, message: `'${k}' (${f.type}) cannot be filtered` });
    }
  });
  if (def.defaultChip && !chipIds.has(def.defaultChip)) {
    issues.push({ path: '/defaultChip', message: `unknown chip '${def.defaultChip}'` });
  }
  const needChip = (path: string, id: string) => {
    if (!chipIds.has(id)) issues.push({ path, message: `unknown chip '${id}'` });
  };

  def.filters?.forEach((key, i) => {
    const f = fields.get(key);
    if (!f) issues.push({ path: `/filters/${i}`, message: `unknown field '${key}'` });
    else if (f.sensitive) issues.push({ path: `/filters/${i}`, message: `sensitive field '${key}' cannot be filtered` });
    else if (!FILTERABLE_FIELD_TYPES.has(f.type)) issues.push({ path: `/filters/${i}`, message: `'${key}' (${f.type}) cannot be filtered` });
  });

  for (const prop of ['columns', 'compactColumns'] as const) {
    def[prop]?.forEach((k, i) => {
      needShowable(`/${prop}/${i}`, k);
      if (fields.get(k)?.sensitive) issues.push({ path: `/${prop}/${i}`, message: `sensitive field '${k}' cannot be a column` });
    });
  }
  if (def.row?.title) needShowable('/row/title', def.row.title);
  if (def.row?.meta) needShowable('/row/meta', def.row.meta);
  if (def.row?.badge) needShowable('/row/badge', def.row.badge);
  def.row?.subtitle?.forEach((k, i) => needShowable(`/row/subtitle/${i}`, k));
  def.detail?.sections.forEach((s, i) => {
    if ('fields' in s) return s.fields.forEach((k, j) => needShowable(`/detail/sections/${i}/fields/${j}`, k));
    const at = `/detail/sections/${i}/related`;
    const other = lookup.recordType(s.related.recordType);
    if (!other) return issues.push({ path: `${at}/recordType`, message: `record type '${s.related.recordType}' is not published` });
    const ref = other.fields.find((f) => f.key === s.related.field);
    if (!ref || ref.type !== 'reference' || ref.referenceType !== def.recordType) {
      issues.push({ path: `${at}/field`, message: `'${s.related.field}' is not a reference to '${def.recordType}' on '${other.key}'` });
    }
    const total = s.related.total ? other.fields.find((f) => f.key === s.related.total) : undefined;
    if (s.related.total && (!total || !['number', 'money'].includes(total.type))) {
      issues.push({ path: `${at}/total`, message: `'${s.related.total}' is not a number or money field of '${other.key}'` });
    }
  });

  if (def.create?.fields && def.create.steps) issues.push({ path: '/create', message: 'use either fields or steps, not both' });
  def.create?.fields?.forEach((k, i) => needWritable(`/create/fields/${i}`, k));
  const stepKeys = new Set<string>();
  def.create?.steps?.forEach((s, i) => {
    if (stepKeys.has(s.key)) issues.push({ path: `/create/steps/${i}/key`, message: `duplicate step '${s.key}'` });
    stepKeys.add(s.key);
    s.fields.forEach((k, j) => needWritable(`/create/steps/${i}/fields/${j}`, k));
  });
  def.create?.presets?.forEach((p, i) => needWritable(`/create/presets/${i}/field`, p.field));
  def.create?.chips?.forEach((c, i) => needChip(`/create/chips/${i}`, c));
  def.edit?.fields?.forEach((k, i) => needWritable(`/edit/fields/${i}`, k));
  const createOnForm = def.create?.fields || def.create?.steps ? new Set([...(def.create.fields ?? []), ...(def.create.steps ?? []).flatMap((s) => s.fields)]) : undefined;
  checkFullWidth(def.create, createOnForm, '/create', issues);
  checkFullWidth(def.edit, def.edit?.fields ? new Set(def.edit.fields) : undefined, '/edit', issues);
  def.edit?.chips?.forEach((c, i) => needChip(`/edit/chips/${i}`, c));
}
