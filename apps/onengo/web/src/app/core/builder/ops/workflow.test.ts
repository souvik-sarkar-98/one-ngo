import { describe, expect, it } from 'vitest';
import type { WorkflowBody } from '../../models';
import { workflowSetRows } from '../workflow-view';
import {
  addState,
  addStep,
  appliesTo,
  conditionOf,
  moveState,
  moveStep,
  newWorkflow,
  orderWorkflows,
  otherStepKeys,
  removeState,
  removeStep,
  renameState,
  setApproval,
  setCondition,
  setInitial,
  setRole,
  setStateFlags,
  setStateLabel,
  setStep,
  setStepLabel,
  toggleApproval,
  toggleFrom,
  toggleRequired,
  uniqueKey,
  workflowSetChecks,
} from './workflow';

const wf = (key: string, extra: Partial<WorkflowBody> = {}): WorkflowBody => ({
  key,
  recordType: 'beneficiary',
  initial: 'open',
  states: [
    { key: 'open', label: 'Open' },
    { key: 'closed', label: 'Closed', final: true },
  ],
  transitions: [{ key: `${key}Close`, label: 'Close', from: ['open'], to: 'closed' }],
  ...extra,
});

describe('workflow ops: states', () => {
  it('adds a state with a unique key', () => {
    const b = addState(addState(wf('a')));
    expect(b.states.map((s) => s.key)).toEqual(['open', 'closed', 'state', 'state2']);
  });

  it('lets the key follow the label until published or set by hand', () => {
    let b = addState(wf('a'));
    b = setStateLabel(b, 2, 'On hold');
    expect(b.states[2]).toEqual({ key: 'on_hold', label: 'On hold' });
    b = setStateLabel(b, 2, 'On hold now');
    expect(b.states[2]!.key).toBe('on_hold_now');
    expect(setStateLabel(b, 2, 'Paused', ['on_hold_now']).states[2]).toEqual({ key: 'on_hold_now', label: 'Paused' });
    expect(setStateLabel(b, 1, 'Open', []).states[1]!.key).toBe('open2');
  });

  it('renames a state everywhere the workflow names it', () => {
    const b = renameState(wf('a', { transitions: [{ key: 'x', label: 'X', from: ['open', 'closed'], to: 'open' }] }), 0, 'new');
    expect(b.initial).toBe('new');
    expect(b.transitions[0]).toMatchObject({ from: ['new', 'closed'], to: 'new' });
  });

  it('writes final and locked only when on', () => {
    let b = setStateFlags(wf('a'), 0, { locked: true });
    expect(b.states[0]).toEqual({ key: 'open', label: 'Open', locked: true });
    b = setStateFlags(b, 1, { final: false });
    expect(b.states[1]).toEqual({ key: 'closed', label: 'Closed' });
  });

  it('sets the start state only to a known state', () => {
    expect(setInitial(wf('a'), 'closed').initial).toBe('closed');
    expect(setInitial(wf('a'), 'ghost').initial).toBe('open');
  });

  it('removes a state with the steps that lead to it or start only from it, keeping the last state', () => {
    const b = wf('a', {
      states: [
        { key: 'open', label: 'Open' },
        { key: 'review', label: 'Review' },
        { key: 'closed', label: 'Closed' },
      ],
      transitions: [
        { key: 'send', label: 'Send', from: ['open'], to: 'review' },
        { key: 'close', label: 'Close', from: ['open', 'review'], to: 'closed' },
        { key: 'back', label: 'Back', from: ['review'], to: 'open' },
      ],
    });
    const out = removeState(b, 1);
    expect(out.states.map((s) => s.key)).toEqual(['open', 'closed']);
    expect(out.transitions).toEqual([{ key: 'close', label: 'Close', from: ['open'], to: 'closed' }]);
    expect(removeState(b, 0).initial).toBe('review');
    const one = wf('a', { states: [{ key: 'open', label: 'Open' }], transitions: [] });
    expect(removeState(one, 0)).toBe(one);
  });

  it('reorders states', () => {
    expect(moveState(wf('a'), 1, 0).states.map((s) => s.key)).toEqual(['closed', 'open']);
  });
});

describe('workflow ops: steps', () => {
  it('adds a step from the start state with a key unique across the record type', () => {
    const b = addStep(wf('a'), ['step']);
    expect(b.transitions.at(-1)).toEqual({ key: 'step2', label: '', from: ['open'], to: 'closed' });
  });

  it('lets the step key follow its label, avoiding other workflows and published keys', () => {
    let b = addStep(wf('a'));
    b = setStepLabel(b, 1, 'Reopen', ['reopen']);
    expect(b.transitions[1]).toMatchObject({ key: 'reopen2', label: 'Reopen' });
    b = setStepLabel(b, 1, 'Reopen case', [], ['reopen2']);
    expect(b.transitions[1]).toMatchObject({ key: 'reopen2', label: 'Reopen case' });
    b = setStep(b, 1, { key: 'custom' });
    expect(setStepLabel(b, 1, 'Other').transitions[1]!.key).toBe('custom');
  });

  it('toggles start states in the states order and required fields', () => {
    let b = toggleFrom(wf('a'), 0, 'closed', true);
    expect(b.transitions[0]!.from).toEqual(['open', 'closed']);
    b = toggleFrom(toggleFrom(b, 0, 'open', false), 0, 'open', true);
    expect(b.transitions[0]!.from).toEqual(['open', 'closed']);
    b = toggleRequired(b, 0, 'reason', true);
    expect(b.transitions[0]!.requiredFields).toEqual(['reason']);
    expect('requiredFields' in toggleRequired(b, 0, 'reason', false).transitions[0]!).toBe(false);
  });

  it('turns approval on and off and edits it', () => {
    let b = toggleApproval(wf('a'), 0, true);
    expect(b.transitions[0]!.approval).toEqual({ roles: [], count: 1 });
    b = setApproval(b, 0, { roles: ['treasurer'], count: 2, when: 'record.amount > 10' });
    expect(b.transitions[0]!.approval).toEqual({ roles: ['treasurer'], count: 2, when: 'record.amount > 10' });
    b = setApproval(b, 0, { when: '', users: [] });
    expect(b.transitions[0]!.approval).toEqual({ roles: ['treasurer'], count: 2 });
    expect('approval' in toggleApproval(b, 0, false).transitions[0]!).toBe(false);
    expect(setApproval(wf('a'), 0, { count: 3 })).toEqual(wf('a'));
  });

  it('clears optional step settings set to undefined, removes and reorders steps', () => {
    const b = setStep(setStep(wf('a'), 0, { guard: 'x' }), 0, { guard: undefined });
    expect('guard' in b.transitions[0]!).toBe(false);
    const two = addStep(wf('a'));
    expect(moveStep(two, 1, 0).transitions.map((t) => t.key)).toEqual(['step', 'aClose']);
    expect(removeStep(two, 0).transitions.map((t) => t.key)).toEqual(['step']);
  });

  it('makes unique keys with a number', () => {
    expect(uniqueKey('close', [])).toBe('close');
    expect(uniqueKey('close', ['close', 'close2'])).toBe('close3');
  });
});

describe('workflow ops: primary and parallel', () => {
  it('switches role and drops the condition of the other role', () => {
    const p = setRole(setCondition(wf('a'), "record.programme == 'x'"), 'parallel');
    expect(p.role).toBe('parallel');
    expect('appliesWhen' in p).toBe(false);
    const withStart = setCondition(p, 'status == "enrolled"');
    expect(withStart.startsWhen).toBe('status == "enrolled"');
    const back = setRole(withStart, 'primary');
    expect('role' in back || 'startsWhen' in back).toBe(false);
    expect(setRole(back, 'primary')).toBe(back);
  });

  it('sets the condition of the role, and empty removes it', () => {
    const a = setCondition(wf('a'), 'record.x > 1');
    expect(conditionOf(a)).toBe('record.x > 1');
    expect('appliesWhen' in setCondition(a, '  ')).toBe(false);
  });

  it('accepts exactly one default primary workflow', () => {
    const intake = wf('intake');
    const scholarship = wf('scholarship', { appliesWhen: "record.programme == 'scholarship'" });
    const closure = wf('closure', { role: 'parallel', startsWhen: "status == 'enrolled'" });
    const checks = workflowSetChecks([intake, scholarship, closure]);
    expect(checks.map((c) => c.level)).toEqual(['ok', 'ok', 'warning']);
    expect(checks[0]!.message).toMatch(/Exactly one primary/);
  });

  it('refuses a second default primary workflow and warns when there is none', () => {
    const two = workflowSetChecks([wf('a'), wf('b')]);
    expect(two[0]).toEqual({ level: 'error', message: 'Only one primary workflow may have no condition: a, b.' });
    const none = workflowSetChecks([wf('a', { appliesWhen: 'true' })]);
    expect(none[0]!.level).toBe('warning');
    expect(workflowSetChecks([wf('p', { role: 'parallel' })])[0]!.level).toBe('error');
    expect(workflowSetChecks([])).toEqual([]);
  });

  it('refuses step keys repeated across workflows', () => {
    const a = wf('a');
    const b = wf('b', { role: 'parallel', transitions: [{ key: 'aClose', label: 'Close', from: ['open'], to: 'closed' }] });
    expect(workflowSetChecks([a, b])).toContainEqual({ level: 'error', message: 'Step keys used in more than one workflow: aClose.' });
    expect(otherStepKeys([a, b], 'b')).toEqual(['aClose']);
  });

  it('orders workflows as the server considers them', () => {
    const set = [wf('z', { role: 'parallel' }), wf('c', { appliesWhen: 'x' }), wf('b', { appliesWhen: 'y' }), wf('m')];
    expect(orderWorkflows(set).map((w) => w.key)).toEqual(['m', 'b', 'c', 'z']);
    expect(workflowSetRows(set).map((r) => [r.id, r.cells[1]!.value, r.cells[2]!.value])).toEqual([
      ['m', 'Primary · default', 'Every new record no other primary workflow takes'],
      ['b', 'Primary', 'y'],
      ['c', 'Primary', 'x'],
      ['z', 'Parallel', 'When a record is created'],
    ]);
  });

  it('says which records follow which workflow', () => {
    const set = [
      wf('closure', { role: 'parallel', startsWhen: "status == 'enrolled'" }),
      wf('intake'),
      wf('scholarship', { appliesWhen: "record.programme == 'scholarship'" }),
    ];
    expect(appliesTo(set)).toEqual([
      "A new record follows scholarship when record.programme == 'scholarship'.",
      'Otherwise it follows intake.',
      'The choice is made once, when the record is created.',
      "closure starts beside it when status == 'enrolled'.",
    ]);
    expect(appliesTo([wf('only'), wf('side', { role: 'parallel' })])).toEqual([
      'Every new record follows only.',
      'side starts beside it when a record is created.',
    ]);
  });

  it('starts a new workflow with step keys unique across the record type', () => {
    const starter = wf('second', { transitions: [{ key: 'close', label: 'Close', from: ['open'], to: 'closed' }] });
    const existing = [wf('first', { transitions: [{ key: 'close', label: 'Close', from: ['open'], to: 'closed' }] })];
    const parallel = newWorkflow(starter, existing, 'parallel');
    expect(parallel.role).toBe('parallel');
    expect(parallel.transitions[0]!.key).toBe('close2');
    const primary = newWorkflow(starter, [], 'primary');
    expect('role' in primary).toBe(false);
    expect(primary.transitions[0]!.key).toBe('close');
  });
});
