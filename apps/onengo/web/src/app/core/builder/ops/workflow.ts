import { toKey } from '../../fields/fields';
import { t } from '../../i18n/i18n';
import type { ApprovalDef, TransitionDef, WorkflowBody } from '../../models';

type State = WorkflowBody['states'][number];
export type WorkflowRole = 'primary' | 'parallel';

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const move = <T>(list: readonly T[], from: number, to: number): T[] => {
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item !== undefined) out.splice(to, 0, item);
  return out;
};

export const roleOf = (w: Pick<WorkflowBody, 'role'>): WorkflowRole => (w.role === 'parallel' ? 'parallel' : 'primary');
/** The condition that matters for the workflow's role: `appliesWhen` for primary, `startsWhen` for parallel. */
export const conditionOf = (w: WorkflowBody): string => (roleOf(w) === 'parallel' ? w.startsWhen : w.appliesWhen) ?? '';
export const isDefault = (w: WorkflowBody): boolean => roleOf(w) === 'primary' && w.appliesWhen === undefined;

/** A state key from a label: lower case with underscores, as the schema requires. */
export function stateKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's$1').slice(0, 40);
}

/** `base`, or `base2`, `base3`… when it is taken. */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

// ---------------------------------------------------------------- states

export function addState(b: WorkflowBody, label = ''): WorkflowBody {
  const key = uniqueKey(stateKey(label) || 'state', b.states.map((s) => s.key));
  return { ...b, states: [...b.states, { key, label }] };
}

/** Renames a state everywhere the workflow names it: the start state and each step's from and to. */
export function renameState(b: WorkflowBody, index: number, key: string): WorkflowBody {
  const old = b.states[index]?.key;
  if (old === undefined || old === key) return b;
  const swap = (s: string) => (s === old ? key : s);
  return {
    ...b,
    initial: swap(b.initial),
    states: b.states.map((s, i) => (i === index ? { ...s, key } : s)),
    transitions: b.transitions.map((tr) => ({ ...tr, from: tr.from.map(swap), to: swap(tr.to) })),
  };
}

/** Sets the label; the key follows it while it was made from the old label and is not in `fixed` (published keys, stored on records). */
export function setStateLabel(b: WorkflowBody, index: number, label: string, fixed: readonly string[] = []): WorkflowBody {
  const s = b.states[index];
  if (!s) return b;
  const auto = !fixed.includes(s.key) && (!s.key || s.key === stateKey(s.label) || /^state\d*$/.test(s.key));
  const next = { ...b, states: b.states.map((x, i) => (i === index ? { ...x, label } : x)) };
  if (!auto) return next;
  const key = uniqueKey(stateKey(label) || 'state', b.states.filter((_, i) => i !== index).map((x) => x.key));
  return renameState(next, index, key);
}

/** Final and locked are written only when on. */
export function setStateFlags(b: WorkflowBody, index: number, flags: Pick<State, 'final' | 'locked'>): WorkflowBody {
  const flag = (s: State, name: 'final' | 'locked') => (name in flags ? flags[name] : s[name]) || undefined;
  return { ...b, states: b.states.map((s, i) => (i === index ? clean({ ...s, final: flag(s, 'final'), locked: flag(s, 'locked') }) : s)) };
}

export function setInitial(b: WorkflowBody, key: string): WorkflowBody {
  return b.states.some((s) => s.key === key) ? { ...b, initial: key } : b;
}

/** Removes a state with the steps that lead to it or start only from it. The last state stays. */
export function removeState(b: WorkflowBody, index: number): WorkflowBody {
  const key = b.states[index]?.key;
  if (key === undefined || b.states.length < 2) return b;
  const states = b.states.filter((_, i) => i !== index);
  return {
    ...b,
    states,
    initial: b.initial === key ? states[0]!.key : b.initial,
    transitions: b.transitions
      .filter((tr) => tr.to !== key)
      .map((tr) => ({ ...tr, from: tr.from.filter((f) => f !== key) }))
      .filter((tr) => tr.from.length > 0),
  };
}

export function moveState(b: WorkflowBody, from: number, to: number): WorkflowBody {
  return { ...b, states: move(b.states, from, to) };
}

// ---------------------------------------------------------------- steps

/**
 * Adds a step from the start state to the next state. `taken` holds the step
 * keys of the record type's other workflows, since step keys are unique across them.
 */
export function addStep(b: WorkflowBody, taken: readonly string[] = []): WorkflowBody {
  const key = uniqueKey('step', [...taken, ...b.transitions.map((tr) => tr.key)]);
  const to = b.states.find((s) => s.key !== b.initial)?.key ?? b.initial;
  return { ...b, transitions: [...b.transitions, { key, label: '', from: b.initial ? [b.initial] : [], to }] };
}

export function setStep(b: WorkflowBody, index: number, patch: Partial<TransitionDef>): WorkflowBody {
  return { ...b, transitions: b.transitions.map((tr, i) => (i === index ? clean({ ...tr, ...patch }) : tr)) };
}

/** Sets the button text; the key follows it while it was made from the old text and is not in `fixed` (published keys, part of permissions). */
export function setStepLabel(b: WorkflowBody, index: number, label: string, taken: readonly string[] = [], fixed: readonly string[] = []): WorkflowBody {
  const tr = b.transitions[index];
  if (!tr) return b;
  const auto = !fixed.includes(tr.key) && (!tr.key || tr.key === toKey(tr.label) || /^step\d*$/.test(tr.key));
  if (!auto) return setStep(b, index, { label });
  const others = [...taken, ...b.transitions.filter((_, i) => i !== index).map((x) => x.key)];
  return setStep(b, index, { label, key: uniqueKey(toKey(label) || 'step', others) });
}

/** Turns a start state on or off for a step, keeping the states' order. */
export function toggleFrom(b: WorkflowBody, index: number, state: string, on: boolean): WorkflowBody {
  const tr = b.transitions[index];
  if (!tr) return b;
  const chosen = new Set(tr.from);
  if (on) chosen.add(state);
  else chosen.delete(state);
  return setStep(b, index, { from: b.states.map((s) => s.key).filter((k) => chosen.has(k)) });
}

export function toggleRequired(b: WorkflowBody, index: number, field: string, on: boolean): WorkflowBody {
  const tr = b.transitions[index];
  if (!tr) return b;
  const req = (tr.requiredFields ?? []).filter((f) => f !== field);
  if (on) req.push(field);
  return setStep(b, index, { requiredFields: req.length ? req : undefined });
}

/** Turns approval on (one approval, no approvers yet) or off. */
export function toggleApproval(b: WorkflowBody, index: number, on: boolean): WorkflowBody {
  return setStep(b, index, { approval: on ? (b.transitions[index]?.approval ?? { roles: [], count: 1 }) : undefined });
}

export function setApproval(b: WorkflowBody, index: number, patch: Partial<ApprovalDef>): WorkflowBody {
  const a = b.transitions[index]?.approval;
  if (!a) return b;
  const next = clean({ ...a, ...patch });
  if (!next.when) delete next.when;
  if (next.users && !next.users.length) delete next.users;
  return setStep(b, index, { approval: next });
}

export function removeStep(b: WorkflowBody, index: number): WorkflowBody {
  return { ...b, transitions: b.transitions.filter((_, i) => i !== index) };
}

export function moveStep(b: WorkflowBody, from: number, to: number): WorkflowBody {
  return { ...b, transitions: move(b.transitions, from, to) };
}

// ---------------------------------------------------------------- role and condition

/** Primary or parallel; the condition of the other role is dropped, since it means something else. */
export function setRole(b: WorkflowBody, role: WorkflowRole): WorkflowBody {
  if (roleOf(b) === role) return b;
  const { role: _role, appliesWhen: _applies, startsWhen: _starts, ...rest } = b;
  return role === 'parallel' ? { ...rest, role } : rest;
}

/** Sets `appliesWhen` (primary) or `startsWhen` (parallel); empty removes it, making a primary workflow the default. */
export function setCondition(b: WorkflowBody, source: string): WorkflowBody {
  const prop = roleOf(b) === 'parallel' ? 'startsWhen' : 'appliesWhen';
  const { [prop]: _old, ...rest } = b;
  return source.trim() ? { ...rest, [prop]: source } : rest;
}

// ---------------------------------------------------------------- several workflows

/** The step keys of the other workflows, which a new step key must not repeat. */
export function otherStepKeys(set: readonly WorkflowBody[], key: string): string[] {
  return set.filter((w) => w.key !== key).flatMap((w) => w.transitions.map((tr) => tr.key));
}

/** The order the server considers them: the default primary, other primary ones, then parallel ones, each by key. */
export function orderWorkflows(set: readonly WorkflowBody[]): WorkflowBody[] {
  const rank = (w: WorkflowBody) => (roleOf(w) === 'parallel' ? 2 : isDefault(w) ? 0 : 1);
  return [...set].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

/**
 * A new workflow for a record type from the starter body: parallel, or
 * primary with an empty condition to fill in when a default already exists;
 * its step keys are made unique across the record type's workflows.
 */
export function newWorkflow(starter: WorkflowBody, set: readonly WorkflowBody[], role: WorkflowRole): WorkflowBody {
  const taken = set.flatMap((w) => w.transitions.map((tr) => tr.key));
  const transitions: TransitionDef[] = [];
  for (const tr of starter.transitions) transitions.push({ ...tr, key: uniqueKey(tr.key, [...taken, ...transitions.map((x) => x.key)]) });
  const body = { ...starter, transitions };
  return role === 'parallel' ? { ...body, role } : body;
}

export type CheckLevel = 'ok' | 'warning' | 'error';
export interface SetCheck {
  level: CheckLevel;
  message: string;
}

/** The rules across a record type's workflows, as the server applies them. */
export function workflowSetChecks(set: readonly WorkflowBody[]): SetCheck[] {
  const out: SetCheck[] = [];
  const primaries = set.filter((w) => roleOf(w) === 'primary');
  const defaults = primaries.filter(isDefault);
  if (set.length && !primaries.length) out.push({ level: 'error', message: t('ui.builder.workflows.noPrimary') });
  else if (defaults.length > 1) out.push({ level: 'error', message: t('ui.builder.workflows.manyDefaults', { names: defaults.map((w) => w.key).join(', ') }) });
  else if (primaries.length && !defaults.length) out.push({ level: 'warning', message: t('ui.builder.workflows.noDefault') });
  else if (primaries.length) out.push({ level: 'ok', message: t('ui.builder.workflows.oneDefault') });

  if (set.length > 1) {
    const seen = new Map<string, number>();
    for (const w of set) for (const k of new Set(w.transitions.map((tr) => tr.key))) seen.set(k, (seen.get(k) ?? 0) + 1);
    const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    out.push(
      dup.length
        ? { level: 'error', message: t('ui.builder.workflows.duplicateSteps', { keys: dup.join(', ') }) }
        : { level: 'ok', message: t('ui.builder.workflows.uniqueSteps') },
    );
  }
  if (primaries.length > 1) out.push({ level: 'warning', message: t('ui.builder.workflows.newOnly') });
  return out;
}

/** "Applies to": which new records follow which primary workflow, and when each parallel one starts. */
export function appliesTo(set: readonly WorkflowBody[]): string[] {
  const ordered = orderWorkflows(set);
  const primaries = ordered.filter((w) => roleOf(w) === 'primary');
  const conditional = primaries.filter((w) => !isDefault(w));
  const fallback = primaries.find(isDefault);
  const out: string[] = [];
  if (fallback && !conditional.length) out.push(t('ui.builder.workflows.always', { name: fallback.key }));
  for (const w of conditional) out.push(t('ui.builder.workflows.followsWhen', { name: w.key, condition: w.appliesWhen ?? '' }));
  if (fallback && conditional.length) out.push(t('ui.builder.workflows.otherwise', { name: fallback.key }));
  if (primaries.length > 1) out.push(t('ui.builder.workflows.onceOnly'));
  for (const w of ordered.filter((x) => roleOf(x) === 'parallel')) {
    out.push(
      w.startsWhen
        ? t('ui.builder.workflows.startsBeside', { name: w.key, condition: w.startsWhen })
        : t('ui.builder.workflows.startsOnCreate', { name: w.key }),
    );
  }
  return out;
}
