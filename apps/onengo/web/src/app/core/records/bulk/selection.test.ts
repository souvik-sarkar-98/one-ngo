import { describe, expect, it } from 'vitest';
import type { RuntimeAction, RuntimeRecordType } from '../../models';
import { BulkSession } from './bulk-session';
import {
  allMatchingOffer,
  bulkOperations,
  bulkTarget,
  canSelect,
  jobSummary,
  MAX_SELECTED,
  NO_SELECTION,
  operationBody,
  operationFields,
  pageTicked,
  selectAllMatching,
  selectedCount,
  selectedRecords,
  summarise,
  summaryLine,
  toggled,
  toggledPage,
  type BulkGateway,
  type BulkJob,
  type BulkOperation,
} from './selection';
import { resolveListSpec } from '../spec';
import { donationType, donationsView, donationWorkflow, record } from '../gateway/testing';

const remind: RuntimeAction = {
  key: 'remind',
  recordType: 'donation',
  label: 'Send reminder',
  placement: ['row', 'bulk'],
  when: 'record.amount >= 1000',
  form: { fields: [{ key: 'note', label: 'Note', type: 'text', required: true }] },
  steps: [{ type: 'notify' }],
  allowed: true,
};
const rowOnly: RuntimeAction = { ...remind, key: 'call', label: 'Call', placement: ['row'], when: undefined, form: undefined };
const refused: RuntimeAction = { ...remind, key: 'refund', label: 'Refund', when: undefined, allowed: false };
const shared: RuntimeRecordType = { ...donationType, visibility: 'restricted' };
const spec = resolveListSpec(donationType, donationWorkflow, donationsView, { workflows: [donationWorkflow], actions: [remind, rowOnly, refused] });
const sharedSpec = resolveListSpec(shared, donationWorkflow, donationsView, { workflows: [donationWorkflow], actions: [] });
const viewer = { id: 'u1', roles: [] };
const ALL = ['record:donation:*'];
const ids = (ops: BulkOperation[]) => ops.map((o) => o.id);

const raised = record({ id: 'a', data: { donorName: 'Asha', amount: 1500 } });
const small = record({ id: 'b', number: 'DON/2026-27/00002', data: { donorName: 'Ravi', amount: 500 } });
const paid = record({ id: 'c', status: 'paid', data: { donorName: 'Meena', amount: 2000 } });

describe('bulk operations allowed for every selected record', () => {
  it('needs the bulk permission and something selected', () => {
    expect(canSelect(['record:donation:read', 'record:donation:bulk'], 'donation')).toBe(true);
    expect(canSelect(['record:donation:read', 'record:donation:export'], 'donation')).toBe(false);
    expect(bulkOperations(spec, [raised], ['record:donation:read', 'record:donation:export'], viewer, 'outstanding')).toEqual([]);
    expect(bulkOperations(spec, [], ALL, viewer, 'outstanding')).toEqual([]);
  });

  it('offers steps, bulk actions, Edit fields and Export when every record allows them', () => {
    expect(ids(bulkOperations(spec, [raised], ALL, viewer, 'outstanding'))).toEqual(['step:markPaid', 'action:remind', 'edit', 'export']);
  });

  it('drops what any one selected record does not allow', () => {
    // b's amount fails the action's condition; c is past the step and locked in its final state.
    expect(ids(bulkOperations(spec, [raised, small], ALL, viewer, 'outstanding'))).toEqual(['step:markPaid', 'edit', 'export']);
    expect(ids(bulkOperations(spec, [raised, paid], ALL, viewer, 'outstanding'))).toEqual(['action:remind', 'export']);
    expect(ids(bulkOperations(spec, [raised, small, paid], ALL, viewer, 'outstanding'))).toEqual(['export']);
  });

  it('follows the record type and list permissions for Edit fields, Share and Export', () => {
    const noEdit = { ...spec, type: { ...spec.type, canUpdate: false } };
    expect(ids(bulkOperations(noEdit, [raised], ALL, viewer, 'outstanding'))).toEqual(['step:markPaid', 'action:remind', 'export']);
    expect(ids(bulkOperations(spec, [raised], ALL, viewer, 'mine'))).not.toContain('edit');
    expect(ids(bulkOperations(spec, [raised], ['record:donation:bulk'], viewer, 'outstanding'))).toEqual(['step:markPaid', 'action:remind', 'edit']);
    expect(ids(bulkOperations(sharedSpec, [raised], ALL, viewer, 'outstanding'))).toEqual(['step:markPaid', 'edit', 'share', 'export']);
    expect(ids(bulkOperations(sharedSpec, [raised], ['record:donation:bulk'], viewer, 'outstanding'))).not.toContain('share');
  });
});

describe('selection', () => {
  const loaded = ['a', 'b', 'c'];

  it('ticks rows one at a time and the whole page from the header box', () => {
    let s = toggled(NO_SELECTION, 'a', loaded);
    expect(s).toEqual({ selecting: true, ids: ['a'], all: false });
    expect(pageTicked(s, loaded)).toBe('some');
    s = toggledPage(s, loaded);
    expect(pageTicked(s, loaded)).toBe('all');
    expect(toggled(s, 'b', loaded).ids).toEqual(['a', 'c']);
    expect(toggledPage(s, loaded)).toEqual({ selecting: true, ids: [], all: false });
  });

  it('offers every match, up to 5,000, once the loaded rows are all ticked', () => {
    const page = toggledPage(NO_SELECTION, loaded);
    expect(allMatchingOffer(toggled(NO_SELECTION, 'a', loaded), loaded, 214)).toBeNull();
    expect(allMatchingOffer(page, loaded, 3)).toBeNull();
    expect(allMatchingOffer(page, loaded, 214)).toBe('offer');
    expect(allMatchingOffer(page, loaded, MAX_SELECTED)).toBe('offer');
    expect(allMatchingOffer(page, loaded, MAX_SELECTED + 1)).toBe('tooMany');
    expect(selectAllMatching(page, loaded, MAX_SELECTED + 1)).toBe(page);

    const all = selectAllMatching(page, loaded, 214);
    expect(all.all).toBe(true);
    expect(selectedCount(all, 214)).toBe(214);
    expect(selectedCount(page, 214)).toBe(3);
    expect(allMatchingOffer(all, loaded, 214)).toBeNull();
    expect(bulkTarget(all, { statusIn: ['raised'] })).toEqual({ query: { statusIn: ['raised'] } });
    expect(bulkTarget(page, { statusIn: ['raised'] })).toEqual({ ids: ['a', 'b', 'c'] });
    expect(selectedRecords(all, [raised, small]).map((r) => r.id)).toEqual(['a', 'b']);
    expect(toggled(all, 'a', loaded)).toEqual({ selecting: true, ids: ['b', 'c'], all: false });
  });
});

describe('bulk forms', () => {
  const markPaid = bulkOperations(spec, [raised], ALL, viewer, 'outstanding')[0]!;
  const edit: BulkOperation = { id: 'edit', kind: 'edit', label: 'Edit fields' };
  const share: BulkOperation = { id: 'share', kind: 'share', label: 'Share' };

  it("asks for a step's required fields once and sends them as the step's data", () => {
    expect(operationFields(spec, markPaid, {}).map((f) => [f.key, f.required])).toEqual([
      ['method', true],
      ['paidOn', true],
    ]);
    expect(operationBody(spec, markPaid, { method: 'upi' })).toEqual({ errors: { paidOn: 'Paid on is required.' }, general: [] });
    expect(operationBody(spec, markPaid, { method: 'upi', paidOn: '2026-10-24' })).toEqual({
      body: { type: 'step', step: 'markPaid', data: { method: 'upi', paidOn: '2026-10-24' } },
    });
  });

  it('sets only the fields filled in, and at least one', () => {
    expect(operationFields(spec, edit, {}).every((f) => !f.required)).toBe(true);
    expect(operationBody(spec, edit, { donorName: '', amount: '' })).toEqual({ errors: {}, general: ['Fill in at least one field to continue.'] });
    expect(operationBody(spec, edit, { donorName: '', amount: '250' })).toEqual({ body: { type: 'edit', values: { amount: 250 } } });
  });

  it('shares with a person or a role', () => {
    expect(operationFields(sharedSpec, share, { shareWith: 'role' }).map((f) => f.key)).toEqual(['shareWith', 'role', 'access', 'expiresAt']);
    expect(operationBody(sharedSpec, share, { shareWith: 'user', access: 'read' })).toMatchObject({ errors: { person: 'Person is required.' } });
    expect(operationBody(sharedSpec, share, { shareWith: 'role', role: 'volunteer', access: 'edit', expiresAt: '2026-12-31' })).toEqual({
      body: { type: 'share', principalKind: 'role', principal: 'volunteer', access: 'edit', expiresAt: '2026-12-31' },
    });
  });
});

describe('bulk results', () => {
  const name = (id: string) => ({ b: 'DON/2026-27/00002' })[id] ?? id;

  it('counts done, waiting for approval and failed, naming the failed records', () => {
    const s = summarise(
      [
        { id: 'a', ok: true },
        { id: 'c', ok: true, message: 'Waiting for approval.', approvalRequestId: 'ap1' },
        { id: 'b', ok: false, message: 'Paid on cannot be before the donation date.' },
      ],
      name,
    );
    expect(s).toEqual({ done: 1, waiting: 1, failed: 1, problems: [{ id: 'b', record: 'DON/2026-27/00002', message: 'Paid on cannot be before the donation date.' }] });
    expect(summaryLine(s)).toBe('1 done, 1 waiting for approval, 1 failed');
    expect(summaryLine(summarise([{ id: 'a', ok: true }], name))).toBe('1 done');
  });

  it("reads a finished job's counts and its failed items", () => {
    const job: BulkJob = { id: 'j1', kind: 'bulk', status: 'done', progress: 214, total: 214, error: null, cancelRequested: false, startedAt: null, result: { done: 212, failed: 2 } };
    const s = jobSummary(job, [{ seq: 4, status: 'failed', recordId: 'b', message: 'Already waiting for approval.' }], name);
    expect(s).toMatchObject({ done: 212, failed: 2, problems: [{ record: 'DON/2026-27/00002', message: 'Already waiting for approval.' }] });
    expect(jobSummary({ ...job, status: 'cancelled', result: null, progress: 120 }, [], name)).toMatchObject({ done: 120, failed: 0, stopped: true });
  });
});

describe('bulk session', () => {
  function gateway(answer: Awaited<ReturnType<BulkGateway['run']>>, jobs: BulkJob[] = []) {
    const calls: unknown[][] = [];
    const g: BulkGateway = {
      run: async (...args) => (calls.push(['run', ...args]), answer),
      job: async (id) => (calls.push(['job', id]), jobs.shift()!),
      failedItems: async (id) => (calls.push(['failed', id]), [{ seq: 1, status: 'failed', recordId: 'b', message: 'No.' }]),
      cancelJob: async (id) => (calls.push(['cancel', id]), { ...jobs[0]!, cancelRequested: true }),
    };
    return { g, calls };
  }
  const markPaid = bulkOperations(spec, [raised], ALL, viewer, 'outstanding')[0]!;
  const job = (over: Partial<BulkJob>): BulkJob => ({ id: 'j1', kind: 'bulk', status: 'running', progress: 0, total: 214, error: null, cancelRequested: false, startedAt: null, ...over });

  it('checks the form, runs small selections at once and shows the result', async () => {
    const { g, calls } = gateway({ results: [{ id: 'a', ok: true }, { id: 'b', ok: false, message: 'No.' }], done: 1, failed: 1 });
    let finished = 0;
    const s = new BulkSession(g, spec, (id) => id.toUpperCase(), { finished: () => finished++ });
    s.open(markPaid, 2);
    await s.submit({ ids: ['a', 'b'] });
    expect(calls).toEqual([]);
    expect(s.snapshot.errors).toHaveProperty('method');
    s.setValues({ method: 'upi', paidOn: '2026-10-24' });
    await s.submit({ ids: ['a', 'b'] });
    expect(calls).toEqual([['run', 'donation', { ids: ['a', 'b'] }, { type: 'step', step: 'markPaid', data: { method: 'upi', paidOn: '2026-10-24' } }]]);
    expect(s.snapshot.summary).toMatchObject({ done: 1, failed: 1, problems: [{ record: 'B', message: 'No.' }] });
    expect(finished).toBe(1);
  });

  it('follows a large run as a job until it finishes, then lists its failures', async () => {
    const { g, calls } = gateway({ jobId: 'j1', total: 214 }, [job({ progress: 120 }), job({ status: 'done', progress: 214, result: { done: 213, failed: 1 } })]);
    const progress: (number | undefined)[] = [];
    let finished = 0;
    const s = new BulkSession(g, spec, (id) => id, { finished: () => finished++, wait: async () => void progress.push(s.snapshot.job?.progress) });
    s.open(markPaid, 214);
    s.setValues({ method: 'upi', paidOn: '2026-10-24' });
    await s.submit({ query: { statusIn: ['raised'] } });
    expect(progress).toEqual([120]);
    expect(calls.map((c) => c[0])).toEqual(['run', 'job', 'job', 'failed']);
    expect(s.snapshot.summary).toMatchObject({ done: 213, failed: 1 });
    expect(finished).toBe(1);
  });
});
