import { t } from '../i18n/i18n';
import type { FieldDef, WorkflowBody } from '../models';
import type { RowView } from '../rows';
import { distances, type DiagramEdge, type DiagramNode } from './diagram';
import { conditionOf, isDefault, orderWorkflows, roleOf } from './ops/workflow';

const YES = '✓';
const START = '●';
const NONE = '—';

/** The default permission of a step when it names none. */
export const stepPermission = (recordType: string, step: string): string => `record:${recordType}:transition:${step}`;

/** States as boxes and steps as arrows, one per state a step starts from; steps that need approval are highlighted. */
export function workflowGraph(b: WorkflowBody): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const nodes = b.states.map((s): DiagramNode => {
    const notes = [s.key === b.initial && t('ui.builder.workflows.start'), s.final && t('ui.builder.workflow.final'), s.locked && t('ui.builder.workflow.locked')];
    const note = notes.filter(Boolean).join(' · ');
    return { id: s.key, label: s.label || s.key, ...(note && { note }), tone: s.key === b.initial ? 'start' : s.final ? 'final' : 'plain' };
  });
  const edges = b.transitions.flatMap((tr) =>
    tr.from.map(
      (from): DiagramEdge => ({
        id: `${tr.key}\u0000${from}`,
        from,
        to: tr.to,
        label: (tr.label || tr.key) + (tr.approval ? ` · ${t('ui.builder.schema.prop.approval')}` : ''),
        tone: tr.approval ? 'accent' : 'plain',
      }),
    ),
  );
  return { nodes, edges };
}

/** The step key of a diagram arrow. */
export const edgeStep = (edgeId: string): string => edgeId.split('\u0000')[0]!;

/** States no step leads to from the start state. */
export function unreachableStates(b: WorkflowBody): string[] {
  const { nodes, edges } = workflowGraph(b);
  const reached = distances(b.initial, nodes, edges);
  return b.states.filter((s) => !reached.has(s.key)).map((s) => s.label || s.key);
}

export function stateRows(b: WorkflowBody): RowView[] {
  return b.states.map((s) => ({
    id: s.key,
    title: s.label || s.key,
    cells: [
      { key: 'title', label: t('ui.builder.label'), value: s.label || s.key },
      { key: 'start', label: t('ui.builder.workflows.startColumn'), value: s.key === b.initial ? START : '' },
      { key: 'final', label: t('ui.builder.workflow.final'), value: s.final ? YES : '' },
      { key: 'locked', label: t('ui.builder.workflow.locked'), value: s.locked ? YES : '' },
    ],
    actions: [],
  }));
}

export function stepRows(b: WorkflowBody, fields: readonly FieldDef[]): RowView[] {
  const state = (k: string) => b.states.find((s) => s.key === k)?.label || k;
  const field = (k: string) => fields.find((f) => f.key === k)?.label || k;
  return b.transitions.map((tr) => {
    const approval = tr.approval
      ? t('ui.builder.workflows.approvalOf', { count: tr.approval.count ?? 1, who: [...(tr.approval.roles ?? []), ...(tr.approval.users ?? [])].join(', ') || NONE })
      : '';
    return {
      id: tr.key,
      title: tr.label || tr.key,
      ...(approval && { badge: { label: approval, tone: 'warning' as const } }),
      cells: [
        { key: 'title', label: t('ui.builder.workflow.buttonLabel'), value: tr.label || tr.key },
        { key: 'move', label: t('ui.builder.workflows.fromTo'), value: `${tr.from.map(state).join(', ') || NONE} → ${state(tr.to)}` },
        { key: 'asks', label: t('ui.builder.workflows.asksFor'), value: (tr.requiredFields ?? []).map(field).join(', ') || NONE },
        { key: 'who', label: t('ui.builder.workflows.who'), value: tr.permission ?? stepPermission(b.recordType, tr.key) },
        { key: 'approval', label: t('ui.builder.schema.prop.approval'), value: approval || NONE },
      ],
      actions: [],
    };
  });
}

/** The record type's workflows in the order the server considers them, with role and condition. */
export function workflowSetRows(set: readonly WorkflowBody[]): RowView[] {
  return orderWorkflows(set).map((w) => {
    const parallel = roleOf(w) === 'parallel';
    const role = parallel
      ? t('ui.builder.schema.enum.parallel')
      : isDefault(w)
        ? t('ui.builder.workflows.primaryDefault')
        : t('ui.builder.schema.enum.primary');
    const condition = conditionOf(w) || (parallel ? t('ui.builder.workflows.onCreate') : t('ui.builder.workflows.everyOther'));
    return {
      id: w.key,
      title: w.key,
      badge: { label: role, tone: parallel ? 'neutral' : 'primary' },
      cells: [
        { key: 'title', label: t('ui.builder.kind.workflow'), value: w.key },
        { key: 'role', label: t('ui.builder.schema.prop.role'), value: role },
        { key: 'condition', label: t('ui.builder.workflows.condition'), value: condition },
        { key: 'states', label: t('ui.builder.schema.prop.states'), value: String(w.states.length) },
        { key: 'steps', label: t('ui.builder.schema.prop.transitions'), value: String(w.transitions.length) },
      ],
      actions: [],
    };
  });
}
