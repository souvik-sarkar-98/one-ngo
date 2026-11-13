import { describe, expect, it } from 'vitest';
import type { RecordQueryBody } from '../../models';
import { ListController } from './list-controller';
import { resolveListSpec } from '../spec';
import { donationType, donationsView, donationWorkflow, fakeGateway, paramsOf, record } from '../gateway/testing';
import { parseListUrl, patch } from './url';

const spec = resolveListSpec(donationType, donationWorkflow, donationsView);
const state = (p: Record<string, string> = {}) => parseListUrl(paramsOf(p), spec);
const bodies = (calls: { op: string; args: unknown[] }[]) => calls.filter((c) => c.op === 'query').map((c) => c.args[1] as RecordQueryBody);

describe('list controller', () => {
  it('loads the first page with chip, search, filters, and sort', async () => {
    const { gateway, calls } = fakeGateway();
    const c = new ListController(gateway, spec);
    await c.sync(state({ chip: 'mine', q: 'asha', method: 'upi', sort: '-amount' }));
    expect(bodies(calls)).toEqual<RecordQueryBody[]>([
      { statusIn: undefined, owner: 'me', search: 'asha', filters: { method: { in: ['upi'] } }, sort: { field: 'amount', dir: 'desc' }, limit: 12, offset: 0 },
    ]);
    expect(c.snapshot).toMatchObject({ total: 41, hasMore: true, loading: false });
    expect(c.snapshot.items).toHaveLength(12);
  });

  it('appends one page each time show grows, and stops at the total', async () => {
    const { gateway, calls } = fakeGateway(30);
    const c = new ListController(gateway, spec);
    let s = state();
    await c.sync(s);
    s = patch(s, { show: 24 }, spec);
    await c.sync(s);
    s = patch(s, { show: 36 }, spec);
    await c.sync(s);
    await c.sync(patch(s, { show: 48 }, spec));
    expect(bodies(calls).map((b) => [b.offset, b.limit])).toEqual([
      [0, 12],
      [12, 12],
      [24, 12],
    ]);
    expect(c.snapshot.items).toHaveLength(30);
    expect(c.snapshot.hasMore).toBe(false);
  });

  it('loads a deep link in one request', async () => {
    const { gateway, calls } = fakeGateway();
    const c = new ListController(gateway, spec);
    await c.sync(state({ show: '36' }));
    expect(bodies(calls).map((b) => [b.offset, b.limit])).toEqual([[0, 36]]);
  });

  it('does not reload for changes that do not affect the rows', async () => {
    const { gateway, calls } = fakeGateway();
    const c = new ListController(gateway, spec);
    const s = state();
    await c.sync(s);
    for (const change of [{ view: 'table' as const }, { id: 'r1' }, { filtersOpen: true }, { create: 'new' }]) await c.sync(patch(s, change, spec));
    expect(bodies(calls)).toHaveLength(1);
  });

  it('never runs two page loads at once and drops answers to old queries', async () => {
    const fake = fakeGateway();
    const c = new ListController(fake.gateway, spec);
    await c.sync(state());
    fake.holdQueries();
    const s = patch(state(), { show: 24 }, spec);
    const first = c.sync(s);
    await c.sync(s);
    expect(bodies(fake.calls)).toHaveLength(2);
    fake.resume();
    await first;

    fake.holdQueries();
    const old = c.sync(state({ q: 'old' }));
    fake.resume();
    await c.sync(state({ q: 'new' }));
    await old;
    expect(bodies(fake.calls).at(-1)!.search).toBe('new');
  });

  it('replaces a saved row in place and reports errors', async () => {
    const { gateway } = fakeGateway();
    const c = new ListController(gateway, spec);
    await c.sync(state());
    c.replaceRow(record({ id: 'r2', status: 'paid' }));
    expect(c.snapshot.items[1]!.status).toBe('paid');

    const failing = new ListController({ ...gateway, query: async () => Promise.reject({ code: 'offline', message: 'Cannot reach the server.' }) }, spec);
    await failing.sync(state());
    expect(failing.snapshot.error).toBe('Cannot reach the server.');
  });
});
