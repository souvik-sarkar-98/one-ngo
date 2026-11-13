import { analyseExpression } from '../expressions/expression.js';
import type {
  ActionStep,
  DefinitionBodies,
  DefinitionKind,
  ListViewDef,
  ViewRef,
  WorkflowDef,
} from './types.js';
import { isPrimary } from './workflows.js';

export interface Usage {
  kind: DefinitionKind;
  key: string;
  label: string | null;
  /** Where in that definition, as a JSON pointer. */
  path: string;
  /** What the use is, in a few words: "filter", "required field of the step 'Mark as paid'". */
  what: string;
}

export type AnyDefinition = { [K in DefinitionKind]: { kind: K; key: string; body: DefinitionBodies[K] } }[DefinitionKind];

export interface UsageTarget {
  kind: DefinitionKind;
  key: string;
  /** A field of a record type, or a state or step of a workflow, or a chip of a list view. */
  field?: string;
}

const PLACEHOLDER = /\{\{\s*([\s\S]+?)\s*\}\}/g;

/** Whether an expression reads `record.<field>` or `previous.<field>`. */
export function mentionsField(source: string | undefined, field: string): boolean {
  if (!source) return false;
  try {
    return analyseExpression(source).variables.some((v) => (v.path[0] === 'record' || v.path[0] === 'previous') && v.path[1] === field);
  } catch {
    return new RegExp(`\\b(record|previous)\\.${field.replace(/[^A-Za-z0-9_]/g, '')}\\b`).test(source);
  }
}

export function templateMentionsField(text: string, field: string): boolean {
  return [...text.matchAll(PLACEHOLDER)].some((m) => mentionsField(m[1], field));
}

/** Field names a script reaches literally: `.field`, `['field']`, `"field"`. */
export function scriptMentionsField(code: string, field: string): boolean {
  const f = field.replace(/[^A-Za-z0-9_]/g, '');
  return new RegExp(`\\.\\s*${f}\\b|\\[\\s*(['"\`])${f}\\1\\s*\\]|(['"\`])${f}\\2`).test(code);
}

const labelOf = (d: AnyDefinition): string | null => {
  const b = d.body as { label?: string };
  return typeof b.label === 'string' ? b.label : null;
};

class Collector {
  readonly out: Usage[] = [];
  add(d: AnyDefinition, path: string, what: string): void {
    this.out.push({ kind: d.kind, key: d.key, label: labelOf(d), path, what });
  }
}

function stepsUse(c: Collector, d: AnyDefinition, steps: ActionStep[], base: string, ownType: string, target: string, field: string | undefined): void {
  steps.forEach((s, i) => {
    const at = `${base}/${i}`;
    const values = 'values' in s ? (s.values ?? {}) : {};
    const sameType = s.type === 'createRecord' ? s.recordType === target : ownType === target;
    if (s.type === 'createRecord' && s.recordType === target && !field) c.add(d, `${at}/recordType`, `creates a record`);
    if (!field) return;
    for (const [k, expr] of Object.entries(values)) {
      if (sameType && k === field) c.add(d, `${at}/values/${k}`, 'sets the field');
      else if (ownType === target && mentionsField(expr, field)) c.add(d, `${at}/values/${k}`, 'expression');
    }
    if (ownType !== target) return;
    if (s.type === 'notify' && (mentionsField(s.to?.email, field) || mentionsField(s.to?.phone, field))) c.add(d, `${at}/to`, 'recipient');
    if (s.type === 'webhook' || s.type === 'connector') for (const [k, v] of Object.entries(s.body ?? {})) if (mentionsField(v, field)) c.add(d, `${at}/body/${k}`, 'expression');
    if (s.type === 'createPayment') {
      if (mentionsField(s.amount, field)) c.add(d, `${at}/amount`, 'payment amount');
      for (const [k, f] of Object.entries(s.onPaid?.fields ?? {})) if (f === field) c.add(d, `${at}/onPaid/fields/${k}`, 'filled when paid');
    }
  });
}

function viewUses(c: Collector, d: AnyDefinition, view: ViewRef | undefined, at: string, field: string): void {
  for (const k of Object.keys(view?.filters ?? {})) if (k === field) c.add(d, `${at}/view/filters/${k}`, 'widget filter');
}

function recordTypeUsages(defs: AnyDefinition[], type: string, field: string | undefined): Usage[] {
  const c = new Collector();
  const linkedTemplates = new Set<string>();
  for (const d of defs) {
    switch (d.kind) {
      case 'recordType': {
        const t = d.body;
        t.fields.forEach((f, i) => {
          const at = `/fields/${i}`;
          if (t.key === type && field && f.key !== field) {
            if (mentionsField(f.calculated, field)) c.add(d, `${at}/calculated`, `calculation of '${f.label}'`);
            if (mentionsField(f.visibleWhen, field)) c.add(d, `${at}/visibleWhen`, `condition of '${f.label}'`);
            if (mentionsField(f.editableWhen, field)) c.add(d, `${at}/editableWhen`, `condition of '${f.label}'`);
            if (f.copyFrom?.reference === field) c.add(d, `${at}/copyFrom`, `'${f.label}' is copied through it`);
            if (f.follow?.via === field) c.add(d, `${at}/follow`, `'${f.label}' follows through it`);
          }
          if (f.type === 'reference' && f.referenceType === type && !field && t.key !== type) c.add(d, at, `reference field '${f.label}'`);
          if (f.copyFrom && field) {
            const ref = t.fields.find((x) => x.key === f.copyFrom!.reference);
            if (ref?.referenceType === type && f.copyFrom.field === field) c.add(d, `${at}/copyFrom`, `'${f.label}' is copied from it`);
          }
          if (f.follow && field) {
            const via = t.fields.find((x) => x.key === f.follow!.via);
            if (via?.type === 'reference' && via.referenceType === type && f.follow.field === field) c.add(d, `${at}/follow`, `'${f.label}' follows it`);
          }
          if (f.rollup?.recordType === type) {
            const r = f.rollup;
            if (!field) c.add(d, `${at}/rollup`, `rollup '${f.label}'`);
            else if (r.reference === field || r.field === field || mentionsField(r.where, field)) c.add(d, `${at}/rollup`, `rollup '${f.label}'`);
          }
        });
        if (t.key === type && field) {
          if (t.titleField === field) c.add(d, '/titleField', 'title');
          t.rules?.forEach((r, i) => {
            if (mentionsField(r.expression, field) || mentionsField(r.when, field)) c.add(d, `/rules/${i}`, `rule '${r.message}'`);
          });
          t.lookups?.forEach((l, i) => {
            l.inputs.forEach((k, j) => k === field && c.add(d, `/lookups/${i}/inputs/${j}`, `sent to the lookup '${l.key}'`));
            if (Object.hasOwn(l.map, field)) c.add(d, `/lookups/${i}/map/${field}`, `filled by the lookup '${l.key}'`);
          });
        }
        break;
      }
      case 'workflow': {
        const w = d.body;
        if (w.recordType !== type) break;
        if (!field) {
          c.add(d, '/recordType', 'workflow');
          break;
        }
        if (mentionsField(w.appliesWhen, field)) c.add(d, '/appliesWhen', 'which records follow it');
        if (mentionsField(w.startsWhen, field)) c.add(d, '/startsWhen', 'when it starts');
        w.transitions.forEach((t, i) => {
          if (t.requiredFields?.includes(field)) c.add(d, `/transitions/${i}/requiredFields`, `required field of the step '${t.label}'`);
          if (mentionsField(t.guard, field)) c.add(d, `/transitions/${i}/guard`, `condition of the step '${t.label}'`);
          if (mentionsField(t.approval?.when, field)) c.add(d, `/transitions/${i}/approval/when`, `approval of the step '${t.label}'`);
        });
        break;
      }
      case 'listView': {
        const v = d.body;
        v.detail?.sections.forEach((s, i) => {
          if (!('related' in s) || s.related.recordType !== type) return;
          if (!field) c.add(d, `/detail/sections/${i}/related`, `related section '${s.label}'`);
          else if (s.related.field === field || s.related.total === field) c.add(d, `/detail/sections/${i}/related`, `related section '${s.label}'`);
        });
        if (v.recordType !== type) break;
        if (!field) {
          c.add(d, '/recordType', 'list view');
          break;
        }
        listViewFieldUses(c, d, v, field);
        break;
      }
      case 'automation':
      case 'action': {
        const own = d.body.recordType;
        const steps = d.kind === 'automation' ? d.body.actions : d.body.steps;
        const base = d.kind === 'automation' ? '/actions' : '/steps';
        if (own === type) {
          for (const s of steps) if (s.type === 'notify') linkedTemplates.add(s.template);
          if (!field) c.add(d, '/recordType', d.kind);
          else if (d.kind === 'automation' && mentionsField(d.body.condition, field)) c.add(d, '/condition', 'condition');
          else if (d.kind === 'action' && mentionsField(d.body.when, field)) c.add(d, '/when', 'when it is offered');
        }
        stepsUse(c, d, steps, base, own, type, field);
        break;
      }
      case 'postingRule': {
        const r = d.body;
        if (r.recordType !== type) break;
        if (!field) c.add(d, '/recordType', 'posting rule');
        else {
          for (const k of ['condition', 'date', 'memo'] as const) if (mentionsField(r[k], field)) c.add(d, `/${k}`, k);
          r.lines.forEach((l, i) => {
            if ([l.amount, l.accountExpr, l.fund].some((e) => mentionsField(e, field))) c.add(d, `/lines/${i}`, `${l.side} line`);
          });
        }
        break;
      }
      case 'receiptRule': {
        const r = d.body;
        if (r.recordType !== type) break;
        if (!field) c.add(d, '/recordType', 'receipt rule');
        else for (const k of ['condition', 'amount', 'date'] as const) if (mentionsField(r[k], field)) c.add(d, `/${k}`, k);
        break;
      }
      case 'script': {
        const s = d.body;
        if (s.recordType !== type) break;
        if (!field) c.add(d, '/recordType', 'script');
        else if (scriptMentionsField(s.code, field)) c.add(d, '/code', 'script code');
        break;
      }
      case 'page': {
        d.body.widgets.forEach((w, i) => {
          const at = `/widgets/${i}`;
          if (w.type === 'stat' || w.type === 'chart') {
            if (w.recordType !== type) return;
            if (!field) return c.add(d, `${at}/recordType`, `widget '${w.label}'`);
            if (w.field === field) c.add(d, `${at}/field`, `widget '${w.label}'`);
            if (w.type === 'chart' && ('field' in w.groupBy ? w.groupBy.field : w.groupBy.dateField) === field) c.add(d, `${at}/groupBy`, `widget '${w.label}'`);
            viewUses(c, d, w.view, at, field);
          } else if (w.type === 'list') {
            const lv = defs.find((x) => x.kind === 'listView' && x.key === w.listView)?.body as ListViewDef | undefined;
            if (lv?.recordType !== type || !field) return;
            viewUses(c, d, w.view, at, field);
          }
        });
        break;
      }
      case 'recordGroup': {
        const i = d.body.recordTypes.indexOf(type);
        if (i >= 0 && !field) c.add(d, `/recordTypes/${i}`, 'record group');
        break;
      }
      case 'translation': {
        const prefix = field ? `recordType.${type}.fields.${field}.` : `recordType.${type}.`;
        if (Object.keys(d.body.entries).some((k) => k.startsWith(prefix))) c.add(d, '/entries', 'translated texts');
        break;
      }
      case 'template':
      case 'theme':
      case 'report':
      case 'reportGroup':
        break;
      case 'dataFeed': {
        const f = d.body;
        if (f.source !== 'records' || f.recordType !== type) break;
        if (!field) c.add(d, '/recordType', 'data feed');
        else if (f.fields?.includes(field)) c.add(d, '/fields', 'shown field');
        break;
      }
    }
  }
  if (field) {
    for (const d of defs) {
      if (d.kind !== 'template' || !linkedTemplates.has(d.key)) continue;
      if (templateMentionsField(d.body.subject, field)) c.add(d, '/subject', 'placeholder');
      if (templateMentionsField(d.body.body, field)) c.add(d, '/body', 'placeholder');
      if (d.body.html && templateMentionsField(d.body.html, field)) c.add(d, '/html', 'placeholder');
    }
  }
  return c.out;
}

function listViewFieldUses(c: Collector, d: AnyDefinition, v: ListViewDef, field: string): void {
  for (const prop of ['columns', 'compactColumns', 'filters'] as const) {
    v[prop]?.forEach((k, i) => {
      if (k === field) c.add(d, `/${prop}/${i}`, prop === 'filters' ? 'filter' : prop === 'columns' ? 'column' : 'tablet column');
    });
  }
  for (const k of ['title', 'meta', 'badge'] as const) if (v.row?.[k] === field) c.add(d, `/row/${k}`, `row ${k}`);
  v.row?.subtitle?.forEach((k, i) => k === field && c.add(d, `/row/subtitle/${i}`, 'row subtitle'));
  v.detail?.sections.forEach((s, i) => {
    if ('fields' in s) s.fields.forEach((k, j) => k === field && c.add(d, `/detail/sections/${i}/fields/${j}`, `section '${s.label}'`));
  });
  v.create?.fields?.forEach((k, i) => k === field && c.add(d, `/create/fields/${i}`, 'create form'));
  v.create?.steps?.forEach((s, i) => s.fields.forEach((k, j) => k === field && c.add(d, `/create/steps/${i}/fields/${j}`, `create step '${s.label}'`)));
  v.create?.presets?.forEach((p, i) => p.field === field && c.add(d, `/create/presets/${i}`, 'prefill from a link'));
  v.edit?.fields?.forEach((k, i) => k === field && c.add(d, `/edit/fields/${i}`, 'edit form'));
}

function workflowUsages(defs: AnyDefinition[], key: string, field: string | undefined): Usage[] {
  const c = new Collector();
  const wf = defs.find((d) => d.kind === 'workflow' && d.key === key)?.body as WorkflowDef | undefined;
  if (!wf) return [];
  const type = wf.recordType;
  const firstPrimary = defs.find((d) => d.kind === 'workflow' && d.body.recordType === type && isPrimary(d.body))?.key;
  const names = (workflow: string | undefined) => workflow === key || (workflow === undefined && firstPrimary === key);
  const isState = field !== undefined && wf.states.some((s) => s.key === field);
  const isStep = field !== undefined && wf.transitions.some((t) => t.key === field);
  for (const d of defs) {
    switch (d.kind) {
      case 'listView': {
        if (d.body.recordType !== type) break;
        d.body.chips?.forEach((ch, i) => {
          if (ch.workflowState?.workflow === key && (!field || ch.workflowState.in.includes(field))) c.add(d, `/chips/${i}/workflowState`, `chip '${ch.label}'`);
          if (isState && names(undefined) && ch.statusIn?.includes(field!)) c.add(d, `/chips/${i}/statusIn`, `chip '${ch.label}'`);
        });
        break;
      }
      case 'postingRule':
      case 'receiptRule': {
        const r = d.body;
        if (r.recordType !== type) break;
        if (!field && r.workflow === key) c.add(d, '/workflow', d.kind === 'postingRule' ? 'posting rule' : 'receipt rule');
        if (isState && names(r.workflow) && r.whenStatus === field) c.add(d, '/whenStatus', 'when it fires');
        break;
      }
      case 'automation': {
        const a = d.body;
        if (a.recordType === type) {
          const t = a.trigger;
          if (!field && 'workflow' in t && t.workflow === key) c.add(d, '/trigger/workflow', 'trigger');
          if (isState && names('workflow' in t ? t.workflow : undefined)) {
            for (const s of ['to' in t ? t.to : undefined, 'from' in t ? t.from : undefined, 'status' in t ? t.status : undefined]) {
              if (s === field) c.add(d, '/trigger', 'trigger');
            }
          }
        }
        if (isStep && a.recordType === type) stepKeyUses(c, d, a.actions, '/actions', field!);
        break;
      }
      case 'action':
        if (isStep && d.body.recordType === type) stepKeyUses(c, d, d.body.steps, '/steps', field!);
        break;
      default:
        break;
    }
  }
  return c.out;
}

function stepKeyUses(c: Collector, d: AnyDefinition, steps: ActionStep[], base: string, step: string): void {
  steps.forEach((s, i) => {
    if (s.type === 'transition' && s.transition === step) c.add(d, `${base}/${i}/transition`, 'runs the step');
    if (s.type === 'createPayment' && s.onPaid?.transition === step) c.add(d, `${base}/${i}/onPaid/transition`, 'runs the step when paid');
  });
}

/** What uses a definition, or one field, state, step or chip of it, among `defs`. */
export function findUsages(defs: AnyDefinition[], target: UsageTarget): Usage[] {
  const others = target.field === undefined ? defs.filter((d) => !(d.kind === target.kind && d.key === target.key)) : defs;
  switch (target.kind) {
    case 'recordType':
      return recordTypeUsages(others, target.key, target.field);
    case 'workflow':
      return workflowUsages(defs, target.key, target.field).filter((u) => !(u.kind === 'workflow' && u.key === target.key));
    case 'template': {
      const c = new Collector();
      for (const d of others) {
        if (d.kind !== 'automation' && d.kind !== 'action') continue;
        const steps = d.kind === 'automation' ? d.body.actions : d.body.steps;
        const base = d.kind === 'automation' ? '/actions' : '/steps';
        steps.forEach((s, i) => s.type === 'notify' && s.template === target.key && c.add(d, `${base}/${i}/template`, 'sends it'));
      }
      return c.out;
    }
    case 'listView': {
      const c = new Collector();
      const lv = defs.find((d) => d.kind === 'listView' && d.key === target.key)?.body as ListViewDef | undefined;
      for (const d of defs) {
        if (d.kind === 'page') {
          d.body.widgets.forEach((w, i) => {
            const mine = w.type === 'list' ? w.listView === target.key : (w.type === 'stat' || w.type === 'chart') && !!lv && w.recordType === lv.recordType;
            if (!mine) return;
            if (!target.field && w.type === 'list') c.add(d, `/widgets/${i}/listView`, `widget '${w.label}'`);
            if (target.field && 'view' in w && w.view?.chip === target.field) c.add(d, `/widgets/${i}/view/chip`, `widget '${w.label}'`);
          });
        }
        if (d.kind === 'listView' && d.key === target.key && target.field) {
          if (d.body.defaultChip === target.field) c.add(d, '/defaultChip', 'default chip');
          d.body.create?.chips?.forEach((ch, i) => ch === target.field && c.add(d, `/create/chips/${i}`, 'create form chips'));
          d.body.edit?.chips?.forEach((ch, i) => ch === target.field && c.add(d, `/edit/chips/${i}`, 'edit form chips'));
        }
      }
      return c.out;
    }
    case 'receiptRule': {
      const c = new Collector();
      const rule = defs.find((d) => d.kind === 'receiptRule' && d.key === target.key);
      if (!rule || rule.kind !== 'receiptRule') return [];
      for (const d of others) {
        if (d.kind !== 'action' || d.body.recordType !== rule.body.recordType) continue;
        d.body.steps.forEach((s, i) => s.type === 'openReceipt' && c.add(d, `/steps/${i}`, 'opens the receipt'));
      }
      return c.out;
    }
    case 'report': {
      const c = new Collector();
      for (const d of others) {
        if (d.kind !== 'reportGroup') continue;
        const i = d.body.reports.indexOf(target.key);
        if (i >= 0) c.add(d, `/reports/${i}`, 'report group');
      }
      return c.out;
    }
    default:
      return [];
  }
}
