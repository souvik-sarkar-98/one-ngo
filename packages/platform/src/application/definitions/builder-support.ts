import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyseExpression, compileExpression, ExpressionError, type ValueType } from '../../runtime/expressions/expression.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { definitionInvalid, forbidden, notFound, ruleViolation, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { can, demand } from '../../domain/permissions.js';
import { checksum } from '../../runtime/definitions/definition-service.js';
import { describeChanges, diffDefinitions, same, type DescribeLabels } from '../../runtime/definitions/describe.js';
import { applyExtensionPatch, stalePatchPaths } from '../../runtime/definitions/merge.js';
import { byInstallOrder, loadModulePackage, moduleContents, publishModulePackage, type ModuleContent } from '../../runtime/definitions/package-loader.js';
import { renderEmailHtml, renderTemplate } from '../../runtime/definitions/template.js';
import { DocumentTemplateError, renderDocumentHtml } from '../../runtime/definitions/document-template.js';
import {
  DEFINITION_KINDS,
  type DefinitionBodies,
  type DefinitionKind,
  type FieldType,
  type ListViewDef,
  type ModuleManifest,
  type PostingRuleDef,
  type RecordTypeDef,
  type ScriptDef,
  type TemplateDef,
  type WorkflowDef,
} from '../../runtime/definitions/types.js';
import { findUsages, type AnyDefinition, type Usage } from '../../runtime/definitions/usages.js';
import { isPrimary } from '../../runtime/definitions/workflows.js';
import type { Tx } from '../../domain/ports/transaction.js';
import type { IdentityService } from '../identity/identity-service.js';
import type { NotificationService } from '../notifications/notification-service.js';
import type { BuilderStore } from './ports/builder-store.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import type { IndexManager } from '../../runtime/definitions/index-manager.js';
import type { SchemaRegistry } from '../../runtime/definitions/schema-registry.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { ScriptSandbox } from '../../runtime/scripts/sandbox.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import { adminOnlyParts, SCRIPT_ADMIN_PERMISSION } from '../../runtime/definitions/script-inputs.js';
import { ScriptFailure, TRY_IT_MAX_TIMEOUT_MS } from '../../runtime/scripts/sandbox.js';
import type { ScriptEffect } from '../../runtime/scripts/effects.js';
import { policyOf } from '../../runtime/records/save/script-run.js';

type Body = Record<string, unknown>;

const obj = (v: unknown): Body | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
function whatsappOf(v: unknown): TemplateDef['whatsapp'] | undefined {
  const o = obj(v);
  if (!o || typeof o.name !== 'string' || !o.name) return undefined;
  const parameters = Array.isArray(o.parameters) ? o.parameters.filter((p): p is string => typeof p === 'string') : undefined;
  return {
    name: o.name,
    ...(typeof o.language === 'string' && o.language ? { language: o.language } : {}),
    ...(parameters?.length ? { parameters } : {}),
  };
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type ExpressionContext = 'record' | 'action' | 'automation' | 'template' | 'posting';

const RECORD_ROOTS = ['record', 'previous', 'status', 'previousStatus', 'workflow', 'states', 'user'];
const ROOTS: Record<ExpressionContext, string[]> = {
  record: RECORD_ROOTS,
  posting: RECORD_ROOTS,
  action: [...RECORD_ROOTS, 'input'],
  template: [...RECORD_ROOTS, 'input'],
  automation: ['record', 'status', 'previousStatus'],
};
/** Besides its fields, `record` carries these in actions, automations, posting rules and templates. */
const RECORD_EXTRAS = ['id', 'number'];

const FIELD_VALUE: Partial<Record<FieldType, ValueType>> = {
  number: 'number',
  money: 'number',
  date: 'date',
  boolean: 'boolean',
  multiChoice: 'list',
  file: 'list',
  location: 'object',
  signature: 'object',
};

const KIND_NOUN: Record<DefinitionKind, string> = {
  recordType: 'record type',
  workflow: 'workflow',
  postingRule: 'posting rule',
  receiptRule: 'receipt rule',
  script: 'script',
  automation: 'automation',
  template: 'template',
  theme: 'theme',
  listView: 'list',
  recordGroup: 'record group',
  translation: 'translation',
  action: 'action',
  page: 'page',
  report: 'report',
  reportGroup: 'report group',
  dataFeed: 'data feed',
};

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The nearest candidate, when it is close enough to be a likely typo. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

function valueTypeOf(v: unknown): ValueType {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'date' : 'text';
  return Array.isArray(v) ? 'list' : 'object';
}

export interface ExpressionCheck {
  ok: boolean;
  error?: string;
  position?: number;
  suggestion?: string;
  resultType?: ValueType;
}

/** The services Builder support uses; the platform's bundle satisfies it, but support never sees the bundle. */
export interface BuilderSupportServices {
  transactions: TransactionManager;
  builderStore: BuilderStore;
  schemas: SchemaRegistry;
  definitions: DefinitionService;
  records: RecordService;
  sandbox: ScriptSandbox;
  identity: Pick<IdentityService, 'profile'>;
  notifications: Pick<NotificationService, 'sendImmediateEmail'>;
  indexes: IndexManager;
}

/** Check, try and review work for the Builder screens. Nothing here saves a definition or a record. */
export class BuilderSupport {
  constructor(
    private readonly p: BuilderSupportServices,
    /** The shipped modules directory (modules/ at the server root). */
    private readonly modulesDir: string,
  ) {}

  // ---------------------------------------------------------- definitions

  /** Schema, cross-reference and impact problems of the draft, or of the body sent (a whole body or `{ patch }`). */
  async check(ctx: TenantContext, kind: DefinitionKind, key: string, body: unknown): Promise<{ errors: FieldIssue[]; warnings: FieldIssue[] }> {
    demand(ctx.actor, 'config:read');
    const sent = obj(body);
    const published = await this.p.definitions.get(ctx.tenantId, kind, key);
    let target: unknown;
    if (sent && 'patch' in sent) {
      const shipped = await this.p.definitions.baseAndPatch(ctx, kind, key);
      if (!shipped) throw notFound(`${kind} '${key}' is not a shipped definition.`);
      target = applyExtensionPatch(shipped.base, sent.patch);
    } else if (sent && Object.keys(sent).length) {
      if (sent.key !== key) throw validationFailed('The key in the body must match the address.');
      target = sent;
    } else {
      target = (await this.p.definitions.getDraft(ctx, kind, key))?.body ?? published?.body;
      if (!target) throw notFound(`No draft for ${kind} '${key}'.`);
    }
    const { errors, warnings } = await this.p.definitions.check(ctx, kind, target);
    const valid = !this.p.schemas.validate(kind, target).length;
    const impact = valid && published ? await this.impact(ctx, kind, published.body, target as DefinitionBodies[DefinitionKind]) : [];
    return { errors, warnings: [...warnings, ...impact] };
  }

  /** The draft against the published version, or the published version against the module's. */
  async changes(ctx: TenantContext, kind: DefinitionKind, key: string, against = 'published') {
    demand(ctx.actor, 'config:read');
    if (against !== 'published' && against !== 'module') throw validationFailed("against must be 'published' or 'module'.");
    const published = await this.p.definitions.get(ctx.tenantId, kind, key);
    let before: DefinitionBodies[DefinitionKind] | undefined;
    let after: DefinitionBodies[DefinitionKind];
    let from: { version: number; module: boolean } | null;
    let to: { version: number | null; draft: boolean };
    if (against === 'module') {
      const shipped = await this.p.definitions.baseAndPatch(ctx, kind, key);
      if (!shipped) throw notFound(`${kind} '${key}' does not come from a module.`);
      before = shipped.base;
      after = published?.body ?? shipped.base;
      from = { version: shipped.baseVersion, module: true };
      to = { version: published?.version ?? null, draft: false };
    } else {
      const draft = await this.p.definitions.getDraft(ctx, kind, key);
      const current = draft?.body ?? published?.body;
      if (!current) throw notFound('Definition not found.');
      after = current;
      before = draft ? published?.body : current;
      from = published ? { version: published.version, module: false } : null;
      to = { version: draft?.version ?? published!.version, draft: !!draft };
    }
    const all = await this.published(ctx.tenantId);
    const labels = this.labels(all, kind === 'recordType' ? (after as RecordTypeDef) : undefined);
    const valid = !this.p.schemas.validate(kind, after).length;
    const warnings = against === 'published' && before && valid && !same(before, after) ? await this.impact(ctx, kind, before, after, all) : [];
    return {
      kind,
      key,
      against,
      from,
      to,
      diff: diffDefinitions(before, after),
      lines: valid ? describeChanges(kind, before, after, labels) : [],
      warnings,
    };
  }

  async usages(ctx: TenantContext, kind: DefinitionKind, key: string, field?: string): Promise<{ kind: DefinitionKind; key: string; field: string | null; usages: Usage[] }> {
    demand(ctx.actor, 'config:read');
    const usages = findUsages(await this.published(ctx.tenantId), { kind, key, field });
    return { kind, key, field: field ?? null, usages };
  }

  /** The counter value the next record numbered from `sequence` gets today, with the financial year and period, without using it up. */
  async nextNumber(ctx: TenantContext, sequence: string, reset?: 'fiscal_year' | 'never'): Promise<{ next: number; fy: string; period: string }> {
    demand(ctx.actor, 'config:read');
    return this.p.transactions.withTenant(ctx.tenantId, (tx) => this.p.builderStore.nextNumber(tx, sequence, reset));
  }

  /** Filters and sorts of a record type's published list views that are still being indexed, or over the index cap. */
  async indexWarnings(ctx: TenantContext, recordType: string): Promise<{ pending: string[]; notIndexed: string[] }> {
    demand(ctx.actor, 'config:read');
    if (!/^[a-z][a-zA-Z0-9_-]{0,62}$/.test(recordType)) throw validationFailed('Not a record type key.');
    return this.p.indexes.warnings(ctx.tenantId, recordType);
  }

  /** What publishing `after` over `before` does to records, shared links and other definitions. */
  private async impact<K extends DefinitionKind>(
    ctx: TenantContext,
    kind: K,
    before: DefinitionBodies[K],
    after: DefinitionBodies[K],
    all?: AnyDefinition[],
  ): Promise<FieldIssue[]> {
    const published = all ?? (await this.published(ctx.tenantId));
    const proposed = published.map((d) => (d.kind === kind && d.key === after.key ? ({ ...d, body: after } as AnyDefinition) : d));
    const out: FieldIssue[] = [];
    const store = this.p.builderStore;
    const read = <T>(fn: (tx: Tx) => Promise<T>) => this.p.transactions.withTenant(ctx.tenantId, fn);
    const usedBy = (us: Usage[]) =>
      `${us
        .slice(0, 5)
        .map((u) => `the ${KIND_NOUN[u.kind]} '${u.label ?? u.key}' (${u.what})`)
        .join(', ')}${us.length > 5 ? ` and ${us.length - 5} more` : ''}`;
    const records = (n: number) => plural(n, 'record');
    const have = (n: number) => (n === 1 ? 'has' : 'have');

    if (kind === 'recordType') {
      const b = before as RecordTypeDef;
      const a = after as RecordTypeDef;
      const valueCount = (field: string, present: boolean) => read((tx) => store.countWithValue(tx, a.key, field, present));
      for (const f of b.fields) {
        const g = a.fields.find((x) => x.key === f.key);
        if (!g) {
          const us = findUsages(proposed, { kind: 'recordType', key: a.key, field: f.key });
          if (us.length) out.push({ path: '/fields', message: `'${f.label}' is removed but is still used by ${usedBy(us)}.` });
          for (const u of us.filter((x) => x.kind === 'listView' && x.what === 'filter')) {
            out.push({ path: '/fields', message: `'${f.label}' is a filter in the list '${u.label ?? u.key}'; shared links that filter on it will stop filtering.` });
          }
          const n = await valueCount(f.key, true);
          if (n) out.push({ path: '/fields', message: `${records(n)} ${have(n)} a value for '${f.label}'; the values are kept but no longer shown.` });
          continue;
        }
        const i = a.fields.indexOf(g);
        if (g.type !== f.type) {
          const n = await valueCount(f.key, true);
          if (n) out.push({ path: `/fields/${i}/type`, message: `${records(n)} ${have(n)} a value for '${g.label}' that may not fit the new type.` });
        }
        if (g.required && !f.required && !g.calculated && !g.rollup) {
          const n = await valueCount(f.key, false);
          if (n) out.push({ path: `/fields/${i}/required`, message: `${records(n)} ${have(n)} no '${g.label}'; they need one the next time they are saved.` });
        }
      }
    }

    if (kind === 'workflow') {
      const b = before as WorkflowDef;
      const a = after as WorkflowDef;
      const defaultPrimary = published.find((d) => d.kind === 'workflow' && d.body.recordType === a.recordType && isPrimary(d.body))?.key ?? a.key;
      for (const s of b.states) {
        if (a.states.some((x) => x.key === s.key)) continue;
        const n = isPrimary(a)
          ? await read((tx) => store.countInPrimaryState(tx, a.recordType, s.key, a.key, defaultPrimary))
          : await read((tx) => store.countInParallelState(tx, a.recordType, a.key, s.key));
        if (n) out.push({ path: '/states', message: `${records(n)} ${n === 1 ? 'is' : 'are'} in '${s.label}'; the workflow will no longer have that state.` });
        const us = findUsages(published, { kind: 'workflow', key: a.key, field: s.key });
        if (us.length) out.push({ path: '/states', message: `The state '${s.label}' is removed but is still used by ${usedBy(us)}.` });
      }
      for (const t of b.transitions) {
        if (a.transitions.some((x) => x.key === t.key)) continue;
        const us = findUsages(published, { kind: 'workflow', key: a.key, field: t.key });
        if (us.length) out.push({ path: '/transitions', message: `The step '${t.label}' is removed but is still used by ${usedBy(us)}.` });
      }
    }

    if (kind === 'listView') {
      const b = before as ListViewDef;
      const a = after as ListViewDef;
      const labels = this.labels(published);
      const opens = a.defaultChip ? `'${a.chips?.find((c) => c.id === a.defaultChip)?.label ?? a.defaultChip}'` : 'the first chip';
      for (const c of b.chips ?? []) {
        if (a.chips?.some((x) => x.id === c.id)) continue;
        out.push({ path: '/chips', message: `Shared links that open the chip '${c.label}' will open ${opens} instead.` });
        const us = findUsages(published, { kind: 'listView', key: a.key, field: c.id }).filter((u) => u.kind !== 'listView');
        if (us.length) out.push({ path: '/chips', message: `The chip '${c.label}' is removed but is still used by ${usedBy(us)}.` });
      }
      for (const f of b.filters ?? []) {
        if (a.filters?.includes(f)) continue;
        out.push({ path: '/filters', message: `Shared links that filter on '${labels.field(a.recordType, f)}' will no longer filter on it.` });
      }
    }
    return out;
  }

  // ---------------------------------------------------------- expressions

  async checkExpression(ctx: TenantContext, body: unknown): Promise<ExpressionCheck> {
    demand(ctx.actor, 'config:read');
    const b = obj(body) ?? {};
    if (typeof b.source !== 'string') throw validationFailed('Send the expression as source.');
    const context = (str(b.context) ?? 'record') as ExpressionContext;
    if (!Object.hasOwn(ROOTS, context)) throw validationFailed(`context must be one of ${Object.keys(ROOTS).join(', ')}.`);
    const typeKey = str(b.recordType);
    const type = typeKey ? (await this.p.definitions.get(ctx.tenantId, 'recordType', typeKey))?.body : undefined;
    if (typeKey && !type) throw notFound(`Record type '${typeKey}' is not published.`);
    const fields = new Map(type?.fields.map((f) => [f.key, f]) ?? []);
    const workflows = type ? (await this.p.definitions.workflowsFor(ctx.tenantId, type.key)).map((w) => w.key) : [];
    const input = Array.isArray(b.input) ? b.input.map(String) : undefined;

    const typeOf = (path: string[]): ValueType => {
      const [root, name] = path;
      if (path.length === 1) return root === 'status' || root === 'previousStatus' || root === 'workflow' ? 'text' : root === 'user' || root === 'record' ? 'object' : 'unknown';
      if (path.length > 2) return 'unknown';
      if (root === 'record' || root === 'previous') {
        if (RECORD_EXTRAS.includes(name!) && !fields.has(name!)) return 'text';
        const f = fields.get(name!);
        return f ? (FIELD_VALUE[f.type] ?? 'text') : 'unknown';
      }
      if (root === 'states') return 'text';
      if (root === 'user') return name === 'roles' ? 'list' : name === 'id' ? 'text' : 'unknown';
      return 'unknown';
    };

    let info;
    try {
      info = analyseExpression(b.source, typeOf);
    } catch (e) {
      if (e instanceof ExpressionError) return { ok: false, error: e.message, position: e.position };
      throw e;
    }
    const unknown = (message: string, word: string, candidates: readonly string[], position: number): ExpressionCheck => {
      const suggestion = closest(word, candidates);
      return { ok: false, error: suggestion ? `${message} Did you mean '${suggestion}'?` : message, position, ...(suggestion ? { suggestion } : {}) };
    };
    const roots = ROOTS[context];
    for (const v of info.variables) {
      const [root, name] = v.path as [string, string | undefined];
      if (!roots.includes(root)) return unknown(`Unknown name '${root}'.`, root, roots, v.position);
      if (name === undefined) continue;
      const at = v.position + root.length + 1;
      if ((root === 'record' || root === 'previous') && type && !fields.has(name) && !RECORD_EXTRAS.includes(name)) {
        return unknown(`${type.label} has no field '${name}'.`, name, [...fields.keys()], at);
      }
      if (root === 'states' && type && !workflows.includes(name)) return unknown(`${type.label} has no workflow '${name}'.`, name, workflows, at);
      if (root === 'user' && name !== 'id' && name !== 'roles') return unknown(`'user' has no '${name}'.`, name, ['id', 'roles'], at);
      if (root === 'input' && input && !input.includes(name)) return unknown(`The form has no field '${name}'.`, name, input, at);
    }
    return { ok: true, resultType: info.resultType };
  }

  async tryExpression(ctx: TenantContext, body: unknown) {
    demand(ctx.actor, 'config:read');
    const b = obj(body) ?? {};
    if (typeof b.source !== 'string') throw validationFailed('Send the expression as source.');
    const scope = await this.scope(ctx, b);
    try {
      const value = compileExpression(b.source).evaluate(scope);
      return { ok: true, value, resultType: valueTypeOf(value) };
    } catch (e) {
      if (e instanceof ExpressionError) return { ok: false, error: e.message, position: e.position };
      throw e;
    }
  }

  /** Published template HTML a document template may include by key. */
  private async partials(ctx: TenantContext): Promise<(name: string) => string | undefined> {
    const templates = await this.p.definitions.list(ctx.tenantId, 'template');
    const html = new Map(templates.flatMap((t) => (t.body.html ? [[t.key, t.body.html] as const] : [])));
    return (name) => html.get(name);
  }

  /**
   * The scope an expression sees: a real record (read permission and visibility
   * checked, sensitive values masked as for the person) or sample values.
   */
  private async scope(ctx: TenantContext, b: Body, recordType = str(b.recordType)): Promise<Record<string, unknown>> {
    const sample = obj(b.sample) ?? {};
    const user = { id: ctx.actor.id, roles: [...ctx.actor.roles] };
    const input = obj(sample.input) ?? {};
    const recordId = str(b.recordId);
    if (recordId) {
      const r = await this.p.records.get(ctx, recordId);
      if (recordType && r.type !== recordType) throw notFound('Record not found.');
      return {
        record: { ...r.data, id: r.id, number: r.number },
        previous: {},
        status: r.status,
        previousStatus: null,
        workflow: r.workflow,
        states: { ...r.states, ...(r.workflow ? { [r.workflow]: r.status } : {}) },
        user,
        input,
      };
    }
    return {
      record: obj(sample.record) ?? {},
      previous: obj(sample.previous) ?? {},
      status: str(sample.status) ?? null,
      previousStatus: str(sample.previousStatus) ?? null,
      workflow: str(sample.workflow) ?? null,
      states: obj(sample.states) ?? {},
      user,
      input,
    };
  }

  // ------------------------------------------------------------ templates

  async previewTemplate(ctx: TenantContext, body: unknown): Promise<{
    subject: string;
    body: string;
    html?: string;
    whatsapp?: { name: string; language: string; parameters: string[] };
  }> {
    demand(ctx.actor, 'config:read');
    const b = obj(body) ?? {};
    const drafted = typeof b.subject === 'string' || typeof b.body === 'string' || typeof b.html === 'string' || obj(b.whatsapp);
    let template: Pick<TemplateDef, 'subject' | 'body' | 'html' | 'whatsapp' | 'kind'>;
    if (drafted) {
      const whatsapp = whatsappOf(b.whatsapp);
      template = {
        kind: b.kind === 'document' ? 'document' : 'message',
        subject: String(b.subject ?? ''),
        body: String(b.body ?? ''),
        ...(typeof b.html === 'string' ? { html: b.html } : {}),
        ...(whatsapp ? { whatsapp } : {}),
      };
    } else {
      const key = str(b.key);
      if (!key) throw validationFailed('Send the template key, or its subject and message.');
      const found = await this.current(ctx, 'template', key, b.from);
      if (!found) throw notFound(`Template '${key}' not found.`);
      template = found;
    }
    const scope = await this.scope(ctx, b);
    const document = template.kind === 'document';
    const issues: FieldIssue[] = [];
    const fill = (text: string, path: string) => {
      try {
        return renderTemplate(text, scope);
      } catch (e) {
        if (!(e instanceof ExpressionError)) throw e;
        issues.push({ path, message: e.message });
        return '';
      }
    };
    const subject = fill(template.subject, '/subject').slice(0, 200);
    const text = fill(template.body, '/body');
    let html = '';
    if (template.html?.trim()) {
      try {
        html = document ? renderDocumentHtml(template.html, scope, await this.partials(ctx)) : renderEmailHtml(template.html, scope);
      } catch (e) {
        if (!(e instanceof ExpressionError) && !(e instanceof DocumentTemplateError)) throw e;
        issues.push({ path: '/html', message: e.message });
      }
    }
    let whatsapp: { name: string; language: string; parameters: string[] } | undefined;
    if (template.whatsapp?.name) {
      const parameters: string[] = [];
      for (const [i, p] of (template.whatsapp.parameters ?? []).entries()) {
        if (!p.trim()) {
          parameters.push('');
          continue;
        }
        try {
          parameters.push(String(compileExpression(p).evaluate(scope) ?? ''));
        } catch (e) {
          if (!(e instanceof ExpressionError)) throw e;
          issues.push({ path: `/whatsapp/parameters/${i}`, message: e.message });
          parameters.push('');
        }
      }
      whatsapp = { name: template.whatsapp.name, language: template.whatsapp.language || 'en', parameters };
    }
    if (issues.length) throw validationFailed('The template cannot be filled in with this record.', issues);
    return { subject, body: text, ...(html ? { html } : {}), ...(whatsapp ? { whatsapp } : {}) };
  }

  /** Sends the filled-in template to the signed-in person through the organisation's email. */
  async testTemplate(ctx: TenantContext, body: unknown): Promise<{ sentTo: string; subject: string; body: string; html?: string }> {
    const rendered = await this.previewTemplate(ctx, body);
    const { email } = await this.p.identity.profile(ctx);
    if (!email) throw validationFailed('Your account has no email address to send the test to.');
    const subject = `Test: ${rendered.subject}`.slice(0, 200);
    await this.p.notifications.sendImmediateEmail(ctx.tenantId, email, subject, rendered.body, rendered.html);
    return { sentTo: email, subject, body: rendered.body, ...(rendered.html ? { html: rendered.html } : {}) };
  }

  // -------------------------------------------------------------- scripts

  async tryScript(ctx: TenantContext, body: unknown) {
    demand(ctx.actor, 'config:script:publish');
    const b = obj(body) ?? {};
    const key = str(b.key);
    const def = key ? await this.current(ctx, 'script', key, b.from) : undefined;
    if (key && !def) throw notFound(`Script '${key}' not found.`);
    const code = typeof b.code === 'string' ? b.code : def?.code;
    if (!code) throw validationFailed('Send the script code.');
    if (code.length > 20000) throw validationFailed('Scripts can be at most 20,000 characters.');
    const recordType = def?.recordType ?? str(b.recordType);
    if (!recordType) throw validationFailed('Say which record type the script is for.');
    const limit = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v as number)) : undefined);
    const timeoutMs = limit(b.timeoutMs ?? def?.timeoutMs, 10, TRY_IT_MAX_TIMEOUT_MS);
    const memoryMb = limit(b.memoryMb ?? def?.memoryMb, 1, 32);

    const sample = obj(b.sample) ?? {};
    let record: Record<string, unknown>;
    let status: string | null;
    const recordId = str(b.recordId);
    if (recordId) {
      const r = await this.p.records.get(ctx, recordId);
      if (r.type !== recordType) throw notFound('Record not found.');
      record = { ...r.data };
      status = r.status;
    } else {
      record = { ...(obj(sample.record) ?? {}) };
      status = str(sample.status) ?? null;
    }
    const previous = obj(sample.previous) ?? (recordId ? { ...record } : null);
    const hooks = ['beforeSave', 'validate', 'afterSave', 'workflowGuard', 'customButton'] as const;
    const asked = str(b.hook);
    const hook: ScriptDef['hook'] = def?.hook ?? (hooks.find((h) => h === asked) ?? 'beforeSave');
    const shape: ScriptDef = { ...(def ?? { key: key ?? 'try', recordType, hook, code }), code, hook };
    if (!def) {
      for (const prop of ['inputs', 'effects', 'runAs'] as const) if (b[prop] !== undefined) (shape as unknown as Body)[prop] = b[prop];
      const issues = this.p.schemas.validate('script', shape);
      if (issues.length) throw definitionInvalid('The script is not valid.', issues);
    }
    const adminParts = adminOnlyParts(shape);
    if (adminParts.length && !can(ctx.actor, SCRIPT_ADMIN_PERMISSION)) {
      throw forbidden(`Only an organisation administrator can try a script that ${adminParts.includes('runAs') ? 'runs as a role' : 'reads ledger balances'}.`);
    }
    try {
      const inputs = shape.inputs ? await this.p.records.previewScriptInputs(ctx, shape, record) : undefined;
      const out = await this.p.sandbox.run({
        hook,
        code,
        record,
        previous,
        status,
        recordType,
        user: { id: ctx.actor.id, roles: [...ctx.actor.roles] },
        inputs,
        extra: recordId ? { id: recordId } : undefined,
        timeoutMs,
        memoryMb,
        tenantId: ctx.tenantId,
        trial: true,
      });
      const after = out.output.record ?? record;
      const changed = [...new Set([...Object.keys(record), ...Object.keys(after)])]
        .filter((k) => !same(record[k], after[k]))
        .map((field) => ({ field, before: record[field] ?? null, after: after[field] ?? null }));
      const checked = this.p.sandbox.checkEffects(out.output, policyOf(shape, hook, { id: recordId ?? null, type: recordType }));
      const issues = [...checked.issues, ...(checked.issues.length ? [] : await this.effectIssues(ctx, checked.effects))];
      return {
        ok: true,
        hook,
        record: after,
        changed,
        effects: checked.effects,
        issues,
        ...(inputs ? { inputs } : {}),
        logs: out.logs,
        durationMs: out.durationMs,
      };
    } catch (e) {
      if (e instanceof ScriptFailure) return { ok: false, code: e.code, error: e.message, logs: e.logs, durationMs: e.durationMs };
      throw e;
    }
  }

  /** What the owning engines would refuse, judged without writing: inactive accounts, unpublished templates and record types. */
  private async effectIssues(ctx: TenantContext, effects: ScriptEffect[]): Promise<FieldIssue[]> {
    if (!effects.length) return [];
    const issues: FieldIssue[] = [];
    const active = new Set(await this.p.transactions.withTenant(ctx.tenantId, (tx) => this.p.builderStore.activeAccountCodes(tx), { readOnly: true }));
    const connectors = effects.some((e) => e.type === 'connector.call') ? await this.p.definitions.connectors(ctx.tenantId) : new Map();
    for (const [i, e] of effects.entries()) {
      const at = `/effects/${i}`;
      if (e.type === 'ledger.propose') {
        e.lines.forEach((l, j) => {
          if (!active.has(l.account)) issues.push({ path: `${at}/lines/${j}/account`, message: `ledger account '${l.account}' does not exist or is inactive` });
        });
      } else if (e.type === 'notify') {
        if (!(await this.p.definitions.get(ctx.tenantId, 'template', e.template))) issues.push({ path: `${at}/template`, message: `template '${e.template}' is not published` });
      } else if (e.type === 'records.create' || e.type === 'records.update') {
        if (!(await this.p.definitions.get(ctx.tenantId, 'recordType', e.recordType))) issues.push({ path: `${at}/recordType`, message: `record type '${e.recordType}' is not published` });
      } else if (e.type === 'connector.call') {
        const c = connectors.get(e.connector);
        if (!c) issues.push({ path: `${at}/connector`, message: `webhook or http connector '${e.connector}' does not exist` });
        else if (c.type === 'http' && c.mode === 'lookup') issues.push({ path: `${at}/connector`, message: `connector '${e.connector}' is a lookup and cannot be called by a script` });
      }
    }
    return issues;
  }

  // -------------------------------------------------------- posting rules

  /** Works out the journal lines a posting rule would make, without posting. */
  async tryPostingRule(ctx: TenantContext, body: unknown) {
    demand(ctx.actor, 'config:read');
    const b = obj(body) ?? {};
    let rule: PostingRuleDef | undefined;
    if (obj(b.rule)) {
      const issues = this.p.schemas.validate('postingRule', b.rule);
      if (issues.length) throw definitionInvalid('The posting rule is not valid.', issues);
      rule = b.rule as unknown as PostingRuleDef;
    } else {
      const key = str(b.key);
      if (!key) throw validationFailed('Send the posting rule, or its key.');
      rule = await this.current(ctx, 'postingRule', key, b.from);
      if (!rule) throw notFound(`Posting rule '${key}' not found.`);
    }
    const scope = await this.scope(ctx, b, rule.recordType);
    const errors: FieldIssue[] = [];
    const ev = (source: string, path: string): unknown => {
      try {
        return compileExpression(source).evaluate(scope);
      } catch (e) {
        if (!(e instanceof ExpressionError)) throw e;
        errors.push({ path, message: e.message });
        return null;
      }
    };
    let applies = true;
    if (rule.condition) {
      try {
        applies = compileExpression(rule.condition).test(scope);
      } catch (e) {
        if (!(e instanceof ExpressionError)) throw e;
        errors.push({ path: '/condition', message: e.message });
      }
    }
    const date = ev(rule.date, '/date');
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push({ path: '/date', message: `The date must be a date such as 2026-04-01, not ${JSON.stringify(date)}.` });
    const memo = rule.memo ? ev(rule.memo, '/memo') : null;
    const codes = new Set(await this.p.transactions.withTenant(ctx.tenantId, (tx) => this.p.builderStore.activeAccountCodes(tx)));
    let debit = 0;
    let credit = 0;
    const lines = rule.lines.map((l, i) => {
      const amount = ev(l.amount, `/lines/${i}/amount`);
      const account = l.account ?? (l.accountExpr ? ev(l.accountExpr, `/lines/${i}/accountExpr`) : null);
      const fund = l.fund ? ev(l.fund, `/lines/${i}/fund`) : null;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        errors.push({ path: `/lines/${i}/amount`, message: `The amount must be a number of zero or more, not ${JSON.stringify(amount)}.` });
      } else if (l.side === 'debit') debit += Math.round(amount * 100);
      else credit += Math.round(amount * 100);
      if (typeof account !== 'string' || !codes.has(account)) {
        errors.push({ path: `/lines/${i}/${l.account ? 'account' : 'accountExpr'}`, message: `Ledger account '${String(account)}' does not exist.` });
      }
      return { side: l.side, account, amount, fund };
    });
    return { applies, whenStatus: rule.whenStatus, date, memo, lines, debit: debit / 100, credit: credit / 100, balanced: debit === credit, errors };
  }

  // -------------------------------------------------------------- modules

  async modules(ctx: TenantContext) {
    demand(ctx.actor, 'config:read');
    const rows = await this.moduleRows(ctx);
    const shipped = this.shipped();
    const out = await Promise.all(
      shipped.map(async (m) => {
        const r = rows.find((x) => x.module_key === m.key);
        return {
          key: m.key,
          label: m.label,
          description: m.description ?? null,
          version: m.version,
          installedVersion: r?.module_version ?? null,
          enabled: r?.enabled ?? false,
          dependsOn: m.dependsOn ?? [],
          definitions: r?.enabled ? await this.installedContents(ctx.tenantId, m.key) : await moduleContents(this.moduleDir(m.key), m),
          updateAvailable: !!r && r.module_version !== m.version,
        };
      }),
    );
    for (const r of rows) {
      if (shipped.some((m) => m.key === r.module_key)) continue;
      out.push({
        key: r.module_key,
        label: r.module_key,
        description: null,
        version: r.module_version,
        installedVersion: r.module_version,
        enabled: r.enabled,
        dependsOn: [],
        definitions: await this.installedContents(ctx.tenantId, r.module_key),
        updateAvailable: false,
      });
    }
    return out;
  }

  /** Turns a module on, or brings it up to the shipped version. */
  async enableModule(ctx: TenantContext, key: string) {
    demand(ctx.actor, 'config:modules');
    const pkg = await loadModulePackage(this.moduleDir(key), this.p.schemas);
    const enabled = new Set((await this.moduleRows(ctx)).filter((r) => r.enabled).map((r) => r.module_key));
    const missing = (pkg.manifest.dependsOn ?? []).filter((d) => !enabled.has(d));
    if (missing.length) throw ruleViolation(`Turn on ${missing.map((m) => `'${m}'`).join(' and ')} first.`);
    await publishModulePackage(this.p.definitions, pkg);
    const result = await this.p.definitions.enableModule(ctx, pkg.manifest);
    return { key, version: pkg.manifest.version, enabled: true, ...result };
  }

  /** Turns a module off, unless the organisation's own definitions or another module still need it. */
  async disableModule(ctx: TenantContext, key: string) {
    demand(ctx.actor, 'config:modules');
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(key)) throw notFound('Unknown module.');
    const enabled = new Set((await this.moduleRows(ctx)).filter((r) => r.enabled).map((r) => r.module_key));
    const dependents = this.shipped().filter((m) => m.key !== key && enabled.has(m.key) && m.dependsOn?.includes(key));
    if (dependents.length) throw ruleViolation(`Turn off ${dependents.map((m) => `'${m.label}'`).join(' and ')} first; ${dependents.length === 1 ? 'it needs' : 'they need'} this module.`);
    const owned = await this.p.definitions.moduleDefinitions(ctx.tenantId, key);
    const mine = new Set(owned.map((o) => `${o.kind}|${o.key}`));
    const outside = (await this.published(ctx.tenantId)).filter((d) => !mine.has(`${d.kind}|${d.key}`));
    const issues: FieldIssue[] = owned.flatMap((o) =>
      findUsages(outside, { kind: o.kind, key: o.key })
        .filter((u) => u.kind !== 'translation')
        .map((u) => ({ path: `${u.kind}:${u.key}${u.path}`, message: `the ${KIND_NOUN[u.kind]} '${u.label ?? u.key}' uses the ${KIND_NOUN[o.kind]} '${o.key}' (${u.what})` })),
    );
    if (issues.length) throw definitionInvalid(`Module '${key}' is still in use. Change or remove these first.`, issues);
    const result = await this.p.definitions.disableModule(ctx, key);
    return { key, enabled: false, ...result };
  }

  /**
   * What updating to the shipped version would change, and the organisation's
   * own changes that would no longer apply or would no longer pass the checks.
   */
  async updateReview(ctx: TenantContext, key: string) {
    demand(ctx.actor, 'config:read');
    const pkg = await loadModulePackage(this.moduleDir(key), this.p.schemas);
    const row = (await this.moduleRows(ctx)).find((r) => r.module_key === key);
    const state = await this.p.definitions.moduleUpdateState(ctx.tenantId, key);
    const patchOf = (kind: string, k: string) => state.patches.find((p) => p.kind === kind && p.key === k)?.patch;
    const oldBase = (kind: string, k: string) => {
      const cur = state.current.find((c) => c.kind === kind && c.key === k);
      return cur ? state.bases.find((b) => b.kind === kind && b.key === k && b.version === cur.base_version)?.body : undefined;
    };
    const labels = this.labels(await this.published(ctx.tenantId));
    const definitions: { kind: DefinitionKind; key: string; status: 'new' | 'changed' | 'unchanged' | 'removed'; patched: boolean; lines: string[] }[] = [];
    const conflicts: { kind: DefinitionKind; key: string; path: string; message: string }[] = [];
    const effective: { kind: DefinitionKind; body: DefinitionBodies[DefinitionKind] }[] = [];
    for (const d of pkg.definitions) {
      const before = oldBase(d.kind, d.body.key) as DefinitionBodies[DefinitionKind] | undefined;
      const patch = patchOf(d.kind, d.body.key);
      const status = before === undefined ? 'new' : checksum(before) === checksum(d.body) ? 'unchanged' : 'changed';
      definitions.push({
        kind: d.kind,
        key: d.body.key,
        status,
        patched: patch !== undefined,
        lines: status === 'unchanged' ? [] : describeChanges(d.kind, before, d.body, labels),
      });
      if (patch !== undefined && before !== undefined) {
        for (const s of stalePatchPaths(before, d.body, patch)) conflicts.push({ kind: d.kind, key: d.body.key, path: s.path, message: `The organisation's change ${s.message}.` });
      }
      effective.push({ kind: d.kind, body: patch === undefined ? d.body : applyExtensionPatch(d.body, patch) });
    }
    for (const c of state.current) {
      if (pkg.definitions.some((d) => d.kind === c.kind && d.body.key === c.key)) continue;
      const patched = patchOf(c.kind, c.key) !== undefined;
      definitions.push({ kind: c.kind, key: c.key, status: 'removed', patched, lines: [] });
      if (patched) conflicts.push({ kind: c.kind, key: c.key, path: '/', message: 'The organisation changed this, but the new version of the module no longer has it.' });
    }
    const setup = pkg.manifest.setup;
    const created = new Set([...(setup?.accounts ?? []).map((a) => a.code), ...(setup?.receiptSeries ?? []).map((s) => s.key), ...(setup?.roles ?? []).map((r) => r.key)]);
    const createdOnUpdate = (message: string) => [...created].some((x) => message.includes(`'${x}' does not exist`));
    for (const e of effective) {
      const { errors } = await this.p.definitions.check(ctx, e.kind, e.body, effective);
      for (const i of errors) if (!createdOnUpdate(i.message)) conflicts.push({ kind: e.kind, key: e.body.key, path: i.path, message: i.message });
    }
    return {
      key,
      label: pkg.manifest.label,
      installedVersion: row?.module_version ?? null,
      version: pkg.manifest.version,
      enabled: row?.enabled ?? false,
      definitions,
      conflicts,
      canUpdate: conflicts.length === 0,
    };
  }

  // -------------------------------------------------------------- helpers

  private moduleDir(key: string): string {
    const dir = join(this.modulesDir, key);
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(key) || !existsSync(join(dir, 'module.json'))) throw notFound(`Unknown module '${key}'.`);
    return dir;
  }

  /** The definitions a turned-on module put in the organisation. A kind this version no longer knows is left out. */
  private async installedContents(tenantId: string, key: string): Promise<ModuleContent[]> {
    const owned = await this.p.definitions.moduleDefinitions(tenantId, key);
    return owned
      .filter((o) => (DEFINITION_KINDS as readonly string[]).includes(o.kind))
      .map((o) => ({ kind: o.kind, key: o.key }))
      .sort(byInstallOrder);
  }

  private shipped(): ModuleManifest[] {
    if (!existsSync(this.modulesDir)) return [];
    return readdirSync(this.modulesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(this.modulesDir, e.name, 'module.json')))
      .map((e) => JSON.parse(readFileSync(join(this.modulesDir, e.name, 'module.json'), 'utf8')) as ModuleManifest)
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  private moduleRows(ctx: TenantContext) {
    return this.p.definitions.moduleStates(ctx.tenantId);
  }

  /** The draft when there is one (unless `from` is 'published'), else the published body. */
  private async current<K extends DefinitionKind>(ctx: TenantContext, kind: K, key: string, from: unknown): Promise<DefinitionBodies[K] | undefined> {
    const draft = from === 'published' ? undefined : await this.p.definitions.getDraft(ctx, kind, key);
    return draft?.body ?? (await this.p.definitions.get(ctx.tenantId, kind, key))?.body;
  }

  private async published(tenantId: string): Promise<AnyDefinition[]> {
    const out: AnyDefinition[] = [];
    for (const kind of DEFINITION_KINDS) {
      for (const d of await this.p.definitions.list(tenantId, kind)) out.push({ kind, key: d.key, body: d.body } as AnyDefinition);
    }
    return out;
  }

  private labels(defs: AnyDefinition[], extra?: RecordTypeDef): DescribeLabels {
    const types = new Map(defs.filter((d) => d.kind === 'recordType').map((d) => [d.key, d.body as RecordTypeDef]));
    if (extra?.fields) types.set(extra.key, extra);
    return {
      recordType: (k) => types.get(k)?.label ?? k,
      field: (t, k) => types.get(t)?.fields.find((f) => f.key === k)?.label ?? k,
      template: (k) => (defs.find((d) => d.kind === 'template' && d.key === k)?.body as TemplateDef | undefined)?.label ?? k,
    };
  }
}
