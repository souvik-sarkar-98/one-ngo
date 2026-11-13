import { describe, expect, it } from 'vitest';
import type { RecordView, RuntimeAction, RuntimeWorkflow } from '../../models';
import { actionMenu, actionNeedsPanel, actionOffered, footerGroups, hasRowActions, openTarget, panelActions, recordActions, showsConfirmation } from './actions';
import { recordCrumb, rowModel, stepSummary, workflowLines, workflowName } from './present';
import { RecordSession } from './record-session';
import { recordRow } from '../list/rows';
import { resolveListSpec } from '../spec';
import { donationType, donationsView, donationWorkflow, fakeGateway, paramsOf, record } from '../gateway/testing';
import { parseListUrl, pushesHistory, toQueryParams } from '../list/url';

const thanks: RuntimeWorkflow = {
  key: 'thanks',
  recordType: 'donation',
  role: 'parallel',
  initial: 'pending',
  states: [
    { key: 'pending', label: 'Pending' },
    { key: 'sent', label: 'Sent', final: true },
  ],
  transitions: [
    { key: 'sendThanks', label: 'Send thanks', from: ['pending'], to: 'sent', requiredFields: ['anonymous'], allowed: true },
    { key: 'skipThanks', label: 'Skip', from: ['pending'], to: 'sent', allowed: false },
  ],
};

const pledge: RuntimeWorkflow = {
  key: 'pledge',
  recordType: 'donation',
  appliesWhen: 'record.amount > 100000',
  initial: 'promised',
  states: [{ key: 'promised', label: 'Promised' }],
  transitions: [{ key: 'collect', label: 'Collect', from: ['promised'], to: 'promised', allowed: true }],
};

const action = (over: Partial<RuntimeAction> & Pick<RuntimeAction, 'key'>): RuntimeAction => ({
  recordType: 'donation',
  label: over.key,
  placement: ['panel', 'row'],
  steps: [{ type: 'notify' }],
  allowed: true,
  ...over,
});

const actions = [
  action({ key: 'remind', label: 'Send reminder', when: 'record.amount >= 1000' }),
  action({ key: 'refund', placement: ['panel'], allowed: false }),
  action({ key: 'print', placement: ['row'], when: "status == 'paid'" }),
  action({ key: 'odd', placement: ['panel'], when: 'record.(' }),
];

const spec = resolveListSpec(donationType, donationWorkflow, donationsView, { workflows: [thanks, donationWorkflow, pledge], actions });
const viewer = { id: 'u1', roles: [] };

describe('record actions: workflow steps merged with configured actions', () => {
  it('orders workflows primary first and keeps the existing steps unchanged', () => {
    expect(spec.workflows.map((w) => w.key)).toEqual(['donation', 'thanks', 'pledge']);
    expect(resolveListSpec(donationType, donationWorkflow).workflows.map((w) => w.key)).toEqual(['donation']);
    expect(resolveListSpec(donationType, donationWorkflow).actions).toEqual([]);
  });

  it('groups allowed steps by the workflows the record is in, primary first', () => {
    const a = recordActions(spec, record({ states: { thanks: 'pending' } }), viewer, 'outstanding');
    expect(a.edit).toBe(true);
    expect(a.workflows).toEqual([
      { workflow: 'donation', primary: true, steps: [{ key: 'markPaid', label: 'Mark as paid', fields: ['method', 'paidOn'], approval: false, primary: true }] },
      { workflow: 'thanks', primary: false, steps: [{ key: 'sendThanks', label: 'Send thanks', fields: ['anonymous'], approval: false, primary: true }] },
    ]);
    expect(recordActions(spec, record(), viewer).workflows.map((w) => w.workflow)).toEqual(['donation']);
    expect(recordActions(spec, record({ workflow: 'pledge', status: 'promised' }), viewer).workflows).toMatchObject([
      { workflow: 'pledge', primary: true, steps: [{ key: 'collect' }] },
    ]);
  });

  it('offers configured actions by permission and `when`, leaving unreadable conditions to the server', () => {
    expect(recordActions(spec, record(), viewer).actions.map((x) => x.key)).toEqual(['remind', 'odd']);
    expect(recordActions(spec, record({ status: 'paid', data: { donorName: 'Asha', amount: 500 } }), viewer).actions.map((x) => x.key)).toEqual([
      'print',
      'odd',
    ]);
    expect(actionOffered(actions[1]!, record(), viewer)).toBe(false);
    expect(actionOffered(action({ key: 'mine', when: 'user.id == record.ownerId' }), record({ data: { ownerId: 'u1' } }), viewer)).toBe(true);
  });

  it('builds the panel and row menus in their own order', () => {
    const a = recordActions(spec, record({ states: { thanks: 'pending' } }), viewer, 'outstanding');
    expect(actionMenu(a, 'panel').map((m) => m.id)).toEqual(['step:markPaid', 'step:sendThanks', 'action:remind', 'action:odd', 'edit']);
    expect(actionMenu(a, 'row')).toEqual([
      { id: 'edit', label: 'Edit' },
      { id: 'step:markPaid', label: 'Mark as paid' },
      { id: 'step:sendThanks', label: 'Send thanks' },
      { id: 'action:remind', label: 'Send reminder', divider: true },
    ]);
    expect(actionMenu({ edit: false, workflows: [], actions: [actions[0]!] }, 'row')).toEqual([{ id: 'action:remind', label: 'Send reminder' }]);
  });

  it('gives a record row the same content as the record row model, with its menu', () => {
    const { record: _r, ...content } = rowModel(spec, record());
    expect(content).toMatchObject({ id: 'r1', title: 'Asha', badge: { label: 'Raised', tone: 'warning' } });
    expect(recordRow(spec, record(), viewer, 'outstanding')).toEqual({
      ...content,
      actions: [
        { id: 'edit', label: 'Edit' },
        { id: 'step:markPaid', label: 'Mark as paid' },
        { id: 'action:remind', label: 'Send reminder', divider: true },
      ],
    });
  });

  it('lets the record session run a step of a parallel workflow', async () => {
    const fake = fakeGateway();
    fake.gateway.get = async (_t, id) => record({ id, states: { thanks: 'pending' } });
    const s = new RecordSession(fake.gateway, spec, () => viewer, { saved: () => undefined, failed: () => undefined });
    await s.follow(parseListUrl(paramsOf({ id: 'r1', panel: 'step:sendThanks' }), spec));
    expect(s.snapshot.mode).toEqual({ kind: 'step', step: 'sendThanks' });
    expect(s.currentStep()!.key).toBe('sendThanks');
    expect(s.defaultKeys()).toEqual(['anonymous']);
    expect(s.recordActions()!.actions.map((x) => x.key)).toEqual(['remind', 'odd']);
  });
});

const sendReminder = action({
  key: 'sendReminder',
  label: 'Send reminder',
  confirm: 'Send a payment reminder?',
  form: {
    fields: [
      { key: 'channel', label: 'Send by', type: 'choice', required: true, choices: [{ value: 'whatsapp', label: 'WhatsApp' }] },
      { key: 'note', label: 'Note to add', type: 'text' },
    ],
  },
});
const payNow = action({ key: 'payNow', label: 'Pay now', when: "status == 'raised'" });
const printReceipt = action({ key: 'print', label: 'Print receipt', when: "status == 'paid'" });
const cancelIt = action({ key: 'cancelIt', label: 'Cancel donation', confirm: 'Cancel this donation?' });
const withActions = resolveListSpec(donationType, donationWorkflow, donationsView, {
  workflows: [donationWorkflow, thanks],
  actions: [sendReminder, payNow, printReceipt, cancelIt],
});

function actionSession() {
  const fake = fakeGateway();
  const saved: { record: RecordView; created: boolean; open?: string }[] = [];
  const s = new RecordSession(fake.gateway, withActions, () => viewer, {
    saved: (record, created, open) => saved.push({ record, created, ...(open ? { open } : {}) }),
    failed: () => undefined,
  });
  return { s, fake, saved };
}

describe('record panel: actions, several workflows', () => {
  it('keeps the action panel in the address and drops unknown actions', () => {
    const state = parseListUrl(paramsOf({ id: 'r1', panel: 'action:sendReminder' }), withActions);
    expect(state.panel).toEqual({ kind: 'action', action: 'sendReminder' });
    expect(toQueryParams(state, withActions)['panel']).toBe('action:sendReminder');
    expect(parseListUrl(paramsOf({ id: 'r1', panel: 'action:nope' }), withActions).panel).toEqual({ kind: 'view' });
    expect(pushesHistory(parseListUrl(paramsOf({ id: 'r1' }), withActions), state)).toBe(false);
  });

  it('opens actions with a form or a confirmation in the panel and runs the others at once', () => {
    expect([sendReminder, payNow, cancelIt].map(actionNeedsPanel)).toEqual([true, false, true]);
    expect(showsConfirmation(sendReminder, false)).toBe(false);
    expect(showsConfirmation(sendReminder, true)).toBe(true);
    expect(showsConfirmation(cancelIt, false)).toBe(true);
    expect(showsConfirmation(payNow, true)).toBe(false);
  });

  it('groups the footer steps by workflow, naming each only when there is more than one, then the panel actions', () => {
    const two = recordActions(withActions, record({ states: { thanks: 'pending' } }), viewer, 'outstanding');
    expect(footerGroups(withActions, two)).toEqual([
      { workflow: 'donation', label: 'Donation', steps: [expect.objectContaining({ key: 'markPaid' })] },
      { workflow: 'thanks', label: 'Thanks', steps: [expect.objectContaining({ key: 'sendThanks' })] },
    ]);
    expect(footerGroups(withActions, recordActions(withActions, record(), viewer)).map((g) => g.label)).toEqual([null]);
    expect(panelActions(two).map((a) => a.key)).toEqual(['sendReminder', 'payNow', 'cancelIt']);
    expect(panelActions(recordActions(withActions, record({ status: 'paid' }), viewer)).map((a) => a.key)).toEqual(['sendReminder', 'print', 'cancelIt']);
    expect(workflowName({ key: 'scholarshipIntake' })).toBe('Scholarship intake');
  });

  it('shows one status line per workflow and names the workflow a step moves', () => {
    const r = record({ states: { thanks: 'pending' } });
    expect(workflowLines(withActions, r)).toEqual([
      { workflow: 'donation', name: 'Donation', state: 'Raised', tone: 'warning' },
      { workflow: 'thanks', name: 'Thanks', state: 'Pending', tone: 'warning' },
    ]);
    expect(workflowLines(withActions, record())).toEqual([]);
    expect(stepSummary(withActions, r, 'sendThanks')).toEqual([
      { label: 'Number', value: 'DON/2026-27/00001' },
      { label: 'Thanks', value: 'Pending → Sent' },
    ]);
    expect(stepSummary(resolveListSpec(donationType, donationWorkflow), r, 'markPaid')[1]).toEqual({ label: 'Status', value: 'Raised → Paid' });
    expect(recordCrumb(withActions, r)).toBe('DON/2026-27/00001 · Asha');
  });

  it('runs an action in action mode: its own fields, required checks, the confirmation in the panel, then the server', async () => {
    const { s, fake, saved } = actionSession();
    await s.follow(parseListUrl(paramsOf({ id: 'r1', panel: 'action:sendReminder' }), withActions));
    expect(s.snapshot.mode).toEqual({ kind: 'action', action: 'sendReminder' });
    expect(s.currentAction()!.key).toBe('sendReminder');
    expect(s.fields().map((f) => [f.key, f.kind, f.required])).toEqual([
      ['channel', 'choice', true],
      ['note', 'text', false],
    ]);
    expect(s.snapshot.values).toEqual({ channel: '', note: '' });

    const a = s.currentAction()!;
    await s.act(a, s.fields());
    expect(s.snapshot.errors).toEqual({ channel: 'Send by is required.' });
    s.setValues({ ...s.snapshot.values, channel: 'whatsapp' });
    await s.act(a, s.fields());
    expect(s.snapshot.confirming).toBe(true);
    s.backToForm();
    expect(s.snapshot).toMatchObject({ confirming: false, values: { channel: 'whatsapp' } });
    await s.act(a, s.fields());
    expect(fake.calls.some((c) => c.op === 'runAction')).toBe(false);

    await s.act(a, s.fields());
    expect(fake.calls.at(-1)).toEqual({ op: 'runAction', args: ['donation', 'r1', 'sendReminder', { channel: 'whatsapp' }, 3] });
    expect(s.snapshot).toMatchObject({ message: 'sendReminder: done.', confirming: false, busy: false });
    expect(saved.at(-1)).toMatchObject({ created: false, record: { version: 4 } });
  });

  it('keeps what the action said once its sheet closes and the record is shown again', async () => {
    const { s } = actionSession();
    await s.follow(parseListUrl(paramsOf({ id: 'r1', panel: 'action:cancelIt' }), withActions));
    const a = s.currentAction()!;
    await s.act(a, s.fields());
    await s.act(a, s.fields());
    expect(s.snapshot.message).toBe('cancelIt: done.');
    await s.follow(parseListUrl(paramsOf({ id: 'r1' }), withActions));
    expect(s.snapshot).toMatchObject({ message: 'cancelIt: done.', mode: { kind: 'view' } });
  });

  it('offers only actions whose condition and permission allow them, and passes on where an action leads', async () => {
    const { s, fake, saved } = actionSession();
    await s.follow(parseListUrl(paramsOf({ id: 'r1', panel: 'action:print' }), withActions));
    expect(s.currentAction()).toBeNull();

    await s.follow(parseListUrl(paramsOf({}), withActions));
    await s.runOn(record({ id: 'r7', status: 'paid' }), printReceipt);
    expect(fake.calls.at(-1)).toEqual({ op: 'runAction', args: ['donation', 'r7', 'print', {}, 3] });
    expect(saved.at(-1)).toMatchObject({ created: false, open: '/print/receipt/rc' });
    expect(s.snapshot.message).toBe('print: done.');

    fake.gateway.runAction = async () => Promise.reject({ code: 'rule_violation', message: 'This record has no receipt to print yet.' });
    await s.runOn(record({ id: 'r8', status: 'paid' }), printReceipt);
    expect(s.snapshot).toMatchObject({ error: 'This record has no receipt to print yet.', busy: false });
  });

  it('follows in-app routes and device links, and ignores anything else', () => {
    expect(openTarget('/print/receipt/rc-12')).toEqual({ kind: 'app', url: '/print/receipt/rc-12' });
    expect(openTarget('upi://pay?pa=demo@upi')).toEqual({ kind: 'external', url: 'upi://pay?pa=demo@upi' });
    expect(openTarget('https://pay.example/p/1')).toEqual({ kind: 'external', url: 'https://pay.example/p/1' });
    expect(openTarget('/payments/p1')).toBeNull();
    expect(openTarget('javascript:alert(1)')).toBeNull();
    expect(openTarget(undefined)).toBeNull();
  });

  it('gives rows a menu when only configured row actions are on offer', () => {
    const readOnly = { ...donationType, canUpdate: false };
    expect(hasRowActions(resolveListSpec(readOnly, undefined, donationsView, { actions: [payNow] }))).toBe(true);
    expect(hasRowActions(resolveListSpec(readOnly, undefined, donationsView, { actions: [{ ...payNow, placement: ['panel'] }] }))).toBe(false);
  });
});
