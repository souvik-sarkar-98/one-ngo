import { describe, expect, it } from 'vitest';
import type { RecordView } from '../models';
import { queryBody } from '../records/list/query';
import { resolveListSpec } from '../records/spec';
import { donationType, donationsView, donationWorkflow, fakeGateway, paramsOf } from '../records/gateway/testing';
import { parseListUrl, patch, queryKey, type ListState } from '../records/list/url';
import { PagedController, type PageSource } from './paged-controller';

interface Approval {
  id: string;
  step: string;
}

/** An in-memory page source over approvals, filtered by step. */
function approvalSource(all: Approval[]) {
  const loads: [string, number, number][] = [];
  const source: PageSource<Approval, { step: string; show: number }> = {
    key: (q) => q.step,
    show: (q) => q.show,
    load: async (q, offset, limit) => {
      loads.push([q.step, offset, limit]);
      const matching = all.filter((a) => !q.step || a.step === q.step);
      return { items: matching.slice(offset, offset + limit), total: matching.length };
    },
    id: (a) => a.id,
    failure: 'Could not load approvals.',
  };
  return { source, loads };
}

const approvals: Approval[] = Array.from({ length: 25 }, (_, i) => ({ id: `a${i + 1}`, step: i % 5 === 0 ? 'refund' : 'approve' }));

describe('paged controller over records', () => {
  const spec = resolveListSpec(donationType, donationWorkflow, donationsView);
  const state = (p: Record<string, string> = {}) => parseListUrl(paramsOf(p), spec);

  it('pages through the records gateway as the list state grows', async () => {
    const { gateway, calls } = fakeGateway(30);
    const c = new PagedController<RecordView, ListState>({
      key: queryKey,
      show: (s) => s.show,
      load: (s, offset, limit) => gateway.query('donation', queryBody(spec, s, offset, limit)),
      id: (r) => r.id,
      failure: 'Could not load records.',
    });
    let s = state();
    await c.sync(s);
    s = patch(s, { show: 24 }, spec);
    await c.sync(s);
    await c.sync(patch(s, { show: 36 }, spec));
    expect(calls.filter((x) => x.op === 'query')).toHaveLength(3);
    expect(c.snapshot).toMatchObject({ total: 30, hasMore: false });
    expect(c.snapshot.items.map((r) => r.id).slice(-1)).toEqual(['r30']);
  });
});

describe('paged controller over another source', () => {
  it('loads, appends, and starts again when the query changes', async () => {
    const { source, loads } = approvalSource(approvals);
    const c = new PagedController(source);
    await c.sync({ step: '', show: 10 });
    await c.sync({ step: '', show: 20 });
    expect(c.snapshot.items).toHaveLength(20);
    expect(c.snapshot.hasMore).toBe(true);
    await c.sync({ step: 'refund', show: 10 });
    expect(loads).toEqual([
      ['', 0, 10],
      ['', 10, 10],
      ['refund', 0, 10],
    ]);
    expect(c.snapshot).toMatchObject({ total: 5, hasMore: false });
    expect(c.snapshot.items.every((a) => a.step === 'refund')).toBe(true);
  });

  it('replaces and prepends by id, and reports failures with its own message', async () => {
    const { source } = approvalSource(approvals);
    const c = new PagedController(source);
    await c.sync({ step: 'refund', show: 10 });
    c.replaceRow({ id: 'a6', step: 'done' });
    expect(c.snapshot.items[1]).toEqual({ id: 'a6', step: 'done' });
    c.prependRow({ id: 'new', step: 'refund' });
    expect(c.snapshot.total).toBe(6);
    expect(c.snapshot.items.map((a) => a.id)).toEqual(['new', 'a1', 'a6', 'a11', 'a16', 'a21']);
    c.prependRow({ id: 'new', step: 'changed' });
    expect(c.snapshot.items.filter((a) => a.id === 'new')).toEqual([{ id: 'new', step: 'changed' }]);
    c.removeRow('new');
    c.removeRow('missing');
    expect(c.snapshot).toMatchObject({ total: 5, hasMore: false });
    expect(c.snapshot.items.map((a) => a.id)).toEqual(['a1', 'a6', 'a11', 'a16', 'a21']);

    const failing = new PagedController({ ...source, load: () => Promise.reject(new Error('boom')) });
    await failing.sync({ step: '', show: 10 });
    expect(failing.snapshot.error).toBe('Could not load approvals.');
    const offline = new PagedController({ ...source, load: () => Promise.reject({ code: 'offline', message: 'Cannot reach the server.' }) });
    await offline.sync({ step: '', show: 10 });
    expect(offline.snapshot.error).toBe('Cannot reach the server.');
  });
});
