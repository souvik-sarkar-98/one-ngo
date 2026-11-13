import { compileExpression } from '../../server';
import { t } from '../../i18n/i18n';
import type { ActionPlacement, FieldDef, PendingApproval, Receipt, RecordView, RuntimeAction, RuntimeWorkflow, SaveResult } from '../../models';
import { changedOnly, fromFormValues, type FormValues, type Viewer } from './forms';
import type { RecordsGateway } from '../gateway/gateway';
import { isLocked, workflowName } from './present';
import type { ListSpec } from '../spec';
import type { PanelMode } from '../list/url';

export interface StepAction {
  key: string;
  label: string;
  /** Fields the step asks for before it runs. */
  fields: string[];
  approval: boolean;
  /** Steps back to the start state are secondary. */
  primary: boolean;
}

export interface AvailableActions {
  edit: boolean;
  steps: StepAction[];
}

/** What a person can do with a record right now. `chip` is the list chip it was opened from, when there is one. */
export function availableActions(spec: ListSpec, record: RecordView, chip?: string): AvailableActions {
  const edit = spec.type.canUpdate && !isLocked(spec, record) && (chip === undefined || !spec.editChips || spec.editChips.includes(chip));
  const steps = (spec.workflow?.transitions ?? [])
    .filter((t) => t.allowed && !!record.status && t.from.includes(record.status))
    .map((t) => ({ key: t.key, label: t.label, fields: t.requiredFields ?? [], approval: !!t.approval, primary: t.to !== spec.workflow?.initial }));
  return { edit, steps };
}

/** The per-row menu, the same in every layout: edit, then the allowed workflow steps. */
export function rowActions(spec: ListSpec, record: RecordView, chip: string): { id: string; label: string; panel: PanelMode }[] {
  const a = availableActions(spec, record, chip);
  return [
    ...(a.edit ? [{ id: 'edit', label: t('ui.common.edit'), panel: { kind: 'edit' } as PanelMode }] : []),
    ...a.steps.map((s) => ({ id: `step:${s.key}`, label: s.label, panel: { kind: 'step', step: s.key } as PanelMode })),
  ];
}

/** Whether rows can have menu actions at all. */
export function hasRowActions(spec: ListSpec): boolean {
  return (
    spec.type.canUpdate ||
    spec.workflows.some((w) => w.transitions.some((t) => t.allowed)) ||
    spec.actions.some((a) => a.allowed && a.placement.includes('row'))
  );
}

/** The allowed steps of one workflow the record is in. */
export interface WorkflowSteps {
  workflow: string;
  primary: boolean;
  steps: StepAction[];
}

export interface RecordActions {
  edit: boolean;
  /** The workflow the record follows first, then the parallel workflows it has started; only those with steps. */
  workflows: WorkflowSteps[];
  /** Configured actions the person may run on the record now. */
  actions: RuntimeAction[];
}

/** The workflows a record is in, primary first, each with the state the record has in it. */
function workflowStates(spec: ListSpec, record: RecordView): { workflow: RuntimeWorkflow; state: string | null; primary: boolean }[] {
  const primary = spec.workflows.find((w) => w.key === record.workflow) ?? spec.workflow;
  return [
    ...(primary ? [{ workflow: primary, state: record.status, primary: true }] : []),
    ...spec.workflows
      .filter((w) => w.role === 'parallel' && record.states?.[w.key] !== undefined)
      .map((w) => ({ workflow: w, state: record.states![w.key]!, primary: false })),
  ];
}

/** The scope the server judges an action's `when` in; the action's own form values are not known yet. */
function actionScope(record: RecordView, viewer: Viewer): Record<string, unknown> {
  return {
    record: { ...record.data, id: record.id, number: record.number },
    previous: {},
    status: record.status,
    previousStatus: null,
    workflow: record.workflow ?? null,
    states: { ...(record.states ?? {}), ...(record.workflow ? { [record.workflow]: record.status } : {}) },
    user: viewer,
    input: {},
  };
}

/** Whether a configured action is offered. A `when` that cannot be judged here is left to the server. */
export function actionOffered(action: RuntimeAction, record: RecordView, viewer: Viewer): boolean {
  if (!action.allowed) return false;
  if (!action.when) return true;
  try {
    return compileExpression(action.when).test(actionScope(record, viewer));
  } catch {
    return true;
  }
}

/** Everything a person can do with a record: edit, the allowed steps of each of its workflows, and the configured actions. */
export function recordActions(spec: ListSpec, record: RecordView, viewer: Viewer, chip?: string): RecordActions {
  const workflows = workflowStates(spec, record)
    .map(({ workflow: w, state, primary }) => ({
      workflow: w.key,
      primary,
      steps: w.transitions
        .filter((t) => t.allowed && !!state && t.from.includes(state))
        .map((t) => ({ key: t.key, label: t.label, fields: t.requiredFields ?? [], approval: !!t.approval, primary: t.to !== w.initial })),
    }))
    .filter((w) => w.steps.length);
  return {
    edit: availableActions(spec, record, chip).edit,
    workflows,
    actions: spec.actions.filter((a) => actionOffered(a, record, viewer)),
  };
}

export interface MenuEntry {
  id: string;
  label: string;
  /** Starts a new group, drawn after a divider. */
  divider?: boolean;
}

/**
 * A menu of the record's actions for one place. The panel footer shows the
 * steps, then the configured actions, then Edit; the row menu keeps Edit first
 * and puts the configured actions after a divider.
 */
export function actionMenu(a: RecordActions, placement: Exclude<ActionPlacement, 'bulk'>): MenuEntry[] {
  const edit = a.edit ? [{ id: 'edit', label: t('ui.common.edit') }] : [];
  const steps = a.workflows.flatMap((w) => w.steps.map((s) => ({ id: `step:${s.key}`, label: s.label })));
  const configured: MenuEntry[] = a.actions.filter((x) => x.placement.includes(placement)).map((x) => ({ id: `action:${x.key}`, label: x.label }));
  if (placement === 'panel') return [...steps, ...configured, ...edit];
  const before = [...edit, ...steps];
  if (before.length && configured.length) configured[0] = { ...configured[0]!, divider: true };
  return [...before, ...configured];
}

/** One group of step buttons in the panel footer; `label` names the workflow when the record is in more than one. */
export interface FooterGroup {
  workflow: string;
  label: string | null;
  steps: StepAction[];
}

/** The panel footer's steps, grouped by workflow, primary first. */
export function footerGroups(spec: ListSpec, a: RecordActions): FooterGroup[] {
  const named = a.workflows.length > 1;
  return a.workflows.map((w) => ({
    workflow: w.workflow,
    label: named ? workflowName(spec.workflows.find((x) => x.key === w.workflow) ?? { key: w.workflow }) : null,
    steps: w.steps,
  }));
}

/** Configured actions placed in the panel footer, after the steps. */
export function panelActions(a: RecordActions): RuntimeAction[] {
  return a.actions.filter((x) => x.placement.includes('panel'));
}

/** Whether an action opens in the panel first: to ask for its fields or to confirm. Others run at once. */
export function actionNeedsPanel(action: RuntimeAction): boolean {
  return !!action.form?.fields.length || !!action.confirm;
}

/** Whether the action panel shows the confirmation now: after the form, or at once when there is no form. */
export function showsConfirmation(action: RuntimeAction, confirming: boolean): boolean {
  return !!action.confirm && (confirming || !action.form?.fields.length);
}

/** An action's small form as a set of fields. */
export function actionForm(action: RuntimeAction | undefined): { fields: FieldDef[] } {
  return { fields: action?.form?.fields ?? [] };
}

/** Where an action's `open` leads: a screen of the app, a link handled outside it (UPI, a payment page), or nowhere the app can show. */
export function openTarget(open: string | undefined): { kind: 'app' | 'external'; url: string } | null {
  if (!open) return null;
  if (open.startsWith('/print/')) return { kind: 'app', url: open };
  if (/^(upi:|https:\/\/)/i.test(open)) return { kind: 'external', url: open };
  return null;
}

export interface ActionResult {
  record: RecordView;
  receipts: Receipt[];
  message: string;
  open?: string;
}

/** Saves edits: only changed values of the given fields are sent, with the version they were made against. */
export async function saveEdit(gateway: RecordsGateway, spec: ListSpec, record: RecordView, values: FormValues, keys: string[]): Promise<ActionResult> {
  const data = changedOnly(record.data, fromFormValues(spec.type, values, keys));
  const res = await gateway.update(spec.type.key, record.id, data, record.version);
  return { record: res.record, receipts: res.receipts, message: t('ui.records.savedMessage') };
}

export async function runStep(
  gateway: RecordsGateway,
  spec: ListSpec,
  record: RecordView,
  step: StepAction,
  values: FormValues,
  keys: string[],
): Promise<ActionResult> {
  const data = changedOnly(record.data, fromFormValues(spec.type, values, keys));
  const res = await gateway.transition(spec.type.key, record.id, step.key, data, record.version);
  return { record: res.record, receipts: res.receipts, message: stepMessage(step, res) };
}

/** Runs a configured action with its form values, against the version the person saw. The server judges `when` and permission again. */
export async function runAction(gateway: RecordsGateway, spec: ListSpec, record: RecordView, action: RuntimeAction, values: FormValues): Promise<ActionResult> {
  const form = actionForm(action);
  const input = fromFormValues(form, values, form.fields.map((f) => f.key));
  for (const k of Object.keys(input)) if (input[k] === null) delete input[k];
  const res = await gateway.runAction(spec.type.key, record.id, action.key, input, record.version);
  return { record: res.record, receipts: [], message: res.message, ...(res.open ? { open: res.open } : {}) };
}

export function stepMessage(step: Pick<StepAction, 'label'>, res: SaveResult): string {
  if (res.approvalRequestId) return t('ui.records.stepSent', { step: step.label });
  return res.receipts.length ? t('ui.records.stepReceipt', { step: step.label, receipt: res.receipts[0]!.number }) : t('ui.records.stepDone', { step: step.label });
}

/** Creates a record from the given fields; empty values are left out. */
export async function createRecord(gateway: RecordsGateway, spec: ListSpec, values: FormValues, keys: string[]): Promise<ActionResult> {
  const data = fromFormValues(spec.type, values, keys);
  for (const k of Object.keys(data)) if (data[k] === null || data[k] === false) delete data[k];
  const res = await gateway.create(spec.type.key, data);
  return { record: res.record, receipts: res.receipts, message: t('ui.records.createdMessage') };
}

export async function decide(gateway: RecordsGateway, approval: PendingApproval, decision: 'approve' | 'reject'): Promise<string> {
  const out = await gateway.decide(approval.id, decision);
  if (out.status === 'stale') throw { code: 'stale', message: out.message ?? t('ui.approval.stale'), issues: [] };
  return decisionMessage(out.status);
}

/** What a person sees after deciding on an approval, the same in the record panel and the inbox. */
export function decisionMessage(status: string): string {
  return status === 'approved' ? t('ui.approval.approved') : status === 'rejected' ? t('ui.approval.rejected') : t('ui.approval.recorded');
}

/** Receipts and any pending approval for a record. Failures leave them empty. */
export async function recordExtras(gateway: RecordsGateway, spec: ListSpec, id: string): Promise<{ receipts: Receipt[]; pending: PendingApproval | null }> {
  const [receipts, pending] = await Promise.all([
    gateway.receipts(spec.type.key, id).catch(() => [] as Receipt[]),
    spec.workflows.some((w) => w.transitions.some((t) => t.approval))
      ? gateway.pendingApproval(spec.type.key, id).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { receipts, pending };
}

export function transitionLabel(spec: ListSpec, key: string): string {
  return spec.workflow?.transitions.find((t) => t.key === key)?.label ?? key;
}
