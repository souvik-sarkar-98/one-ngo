import { describe, expect, it } from 'vitest';
import type { ListLayout, RecordQueryBody } from '../core/models';
import { listLayout } from '../core/records/list/layout';
import { ListSession } from '../core/records/list/list-session';
import { panelRow, tableColumns } from '../core/records/list/rows';
import { resolveListSpec } from '../core/records/spec';
import { donationType, donationsView, donationWorkflow, fakeGateway, paramsOf, record } from '../core/records/gateway/testing';
import { parseListUrl } from '../core/records/list/url';

const spec = resolveListSpec(donationType, donationWorkflow, donationsView);

/** A list session wired to a fake address bar, as either layout uses it. */
function session(view: ListLayout, total = 41) {
  const fake = fakeGateway(total);
  const urls: { params: Record<string, string | null>; replace: boolean }[] = [];
  let params: Record<string, string> = { view };
  const s = new ListSession(
    spec,
    fake.gateway,
    {
      navigate: (next, replace) => {
        urls.push({ params: { ...next, view: null }, replace });
        params = Object.fromEntries(Object.entries({ ...params, ...next }).filter(([, v]) => v !== null)) as Record<string, string>;
        void s.fromUrl((n) => params[n] ?? null);
      },
    },
    { preferred: () => view, remember: () => undefined },
  );
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const queries = () => fake.calls.filter((c) => c.op === 'query').map((c) => c.args[1] as RecordQueryBody);
  return { s, urls, queries, settle, start: () => s.fromUrl((n) => params[n] ?? null) };
}

/** The same person's actions, in the same order, in either layout. */
async function script(view: ListLayout) {
  const t = session(view);
  await t.start();
  t.s.selectChip('mine');
  await t.settle();
  t.s.search('asha');
  t.s.applyFilters({ method: ['upi'], amountFrom: '100' });
  t.s.toggleSort('amount');
  await t.settle();
  t.s.loadMore();
  await t.settle();
  t.s.loadMore();
  await t.settle();
  t.s.removeFilter('amount');
  await t.settle();
  t.s.open('r3', { kind: 'step', step: 'markPaid' });
  t.s.setPanel({ kind: 'view' });
  t.s.close();
  t.s.openCreate();
  t.s.setCreateStep(1);
  t.s.closeCreate();
  await t.settle();
  return t;
}

describe('cards and table behave the same', () => {
  it('the same actions give the same addresses, history, and queries', async () => {
    const cards = await script('cards');
    const table = await script('table');
    expect(cards.urls).toEqual(table.urls);
    expect(cards.queries()).toEqual(table.queries());
    expect(cards.s.state).toEqual({ ...table.s.state, view: 'cards' });
  });

  it('infinite scroll loads each page once and stops at the total', async () => {
    for (const view of ['cards', 'table'] as const) {
      const t = session(view, 30);
      await t.start();
      t.s.loadMore();
      t.s.loadMore();
      await t.settle();
      t.s.loadMore();
      await t.settle();
      t.s.loadMore();
      await t.settle();
      expect(t.queries().map((q) => [q.offset, q.limit])).toEqual([
        [0, 12],
        [12, 12],
        [24, 12],
      ]);
      expect(t.s.rows.items).toHaveLength(30);
      expect(t.s.rows.hasMore).toBe(false);
    }
  });

  it('switching layout keeps every other parameter and does not reload', async () => {
    const t = session('cards');
    await t.start();
    t.s.selectChip('mine');
    await t.settle();
    t.s.loadMore();
    await t.settle();
    const before = t.queries().length;
    t.s.setView('table');
    await t.settle();
    expect(t.urls.at(-1)).toMatchObject({ replace: true, params: { chip: 'mine', show: '24' } });
    expect(t.queries()).toHaveLength(before);
  });

  it('opening a record adds history; list changes replace it', async () => {
    const t = await script('table');
    // Opening a record or the create form pushes one entry. Moving inside it, or closing it, replaces that entry.
    const pushed = t.urls.filter((u) => !u.replace).map((u) => Object.fromEntries(Object.entries(u.params).filter(([k, v]) => v !== null && ['id', 'panel', 'create', 'createStep'].includes(k))));
    expect(pushed).toEqual([{ id: 'r3', panel: 'step:markPaid' }, { create: 'new' }]);
  });
});

describe('one record list screen, two row layouts', () => {
  const compact = resolveListSpec(donationType, donationWorkflow, { ...donationsView, compactColumns: ['donorName', 'paidOn', 'donorPan'] });
  const viewer = { id: 'u1', roles: [] };

  it('phones always get cards; wider screens take the address, then the person, then the list view', () => {
    expect(listLayout(true, 'table', () => 'table')).toBe('cards');
    expect(listLayout(true, undefined, () => 'table')).toBe('cards');
    expect(listLayout(false, 'cards', () => 'table')).toBe('cards');
    expect(listLayout(false, undefined, () => 'table')).toBe('table');
  });

  it('shows every column on desktops and the compact ones on tablets, never sensitive ones', () => {
    expect(tableColumns(compact, true).map((c) => c.key)).toEqual(['number', 'donorName', 'amount', 'status']);
    expect(tableColumns(compact, false)).toEqual([
      { key: 'donorName', label: 'Donor name', sortable: true },
      { key: 'paidOn', label: 'Paid on', sortable: true },
    ]);
  });

  it('without compact columns tablets show the title, the first subtitle field and the status', () => {
    expect(tableColumns(spec, false).map((c) => c.key)).toEqual(['donorName', 'amount', 'status']);
  });

  it('draws the same rows and row menus in both layouts, with a cell for every table column', () => {
    const row = panelRow(compact, record({ data: { donorName: 'Asha', amount: 1500, paidOn: '2026-10-01' } }), viewer, 'outstanding');
    expect(row.actions.map((a) => a.id)).toEqual(['edit', 'step:markPaid']);
    for (const wide of [true, false]) {
      for (const c of tableColumns(compact, wide)) expect(row.cells.some((x) => x.key === c.key), c.key).toBe(true);
    }
  });

  it('table headers sort the same fields as the Sort menu, and their sort survives the address bar', () => {
    for (const wide of [true, false]) {
      for (const c of tableColumns(compact, wide).filter((x) => x.sortable)) expect(compact.sortable).toContain(c.key);
    }
    expect(parseListUrl(paramsOf({ sort: '-paidOn' }), compact).sort).toEqual({ field: 'paidOn', dir: 'desc' });
    expect(parseListUrl(paramsOf({ sort: 'donorPan' }), compact).sort).toBeUndefined();
  });
});
