import { describe, expect, it } from 'vitest';
import type { ListLayout } from '../models';
import { ListSession } from './list/list-session';
import { resolveListSpec } from './spec';
import { donationType, donationsView, donationWorkflow, fakeGateway, paramsOf } from './gateway/testing';
import { ownedParams, parseListUrl, toQueryParams } from './list/url';

/** Architecture §4 and Design §9: the record list's parameters and which changes add a history entry. */
const spec = resolveListSpec(donationType, donationWorkflow, {
  ...donationsView,
  create: { ...donationsView.create, presets: [{ param: 'donor', field: 'donorName' }] },
});

type Call = { params: Record<string, string | null>; replace: boolean };

function run(start: Record<string, string>, act: (s: ListSession) => void, preferred: ListLayout = 'table'): Call[] {
  const calls: Call[] = [];
  const s = new ListSession(spec, fakeGateway().gateway, { navigate: (params, replace) => calls.push({ params, replace }) }, { preferred: () => preferred, remember: () => undefined });
  void s.fromUrl(paramsOf(start));
  act(s);
  return calls;
}

const CASES: { name: string; start: Record<string, string>; act: (s: ListSession) => void; push: boolean; writes: Record<string, string | null> }[] = [
  { name: 'layout', start: {}, act: (s) => s.setView('cards'), push: false, writes: { view: 'cards' } },
  { name: 'chip', start: { show: '36' }, act: (s) => s.selectChip('mine'), push: false, writes: { chip: 'mine', show: null } },
  { name: 'search', start: {}, act: (s) => s.search(' asha '), push: false, writes: { q: 'asha' } },
  { name: 'filters', start: { filters: 'open' }, act: (s) => s.applyFilters({ method: ['upi'], amountFrom: '100' }), push: false, writes: { method: 'upi', amountFrom: '100', filters: null } },
  { name: 'remove a filter', start: { method: 'upi', anonymous: 'true' }, act: (s) => s.removeFilter('method'), push: false, writes: { method: null, anonymous: 'true' } },
  { name: 'sort', start: {}, act: (s) => s.toggleSort('amount'), push: false, writes: { sort: 'amount' } },
  { name: 'depth', start: {}, act: (s) => s.go({ show: 24 }), push: false, writes: { show: '24' } },
  { name: 'filters panel', start: {}, act: (s) => s.openFilters(), push: false, writes: { filters: 'open' } },
  { name: 'open a record', start: { chip: 'mine' }, act: (s) => s.open('r1'), push: true, writes: { id: 'r1', panel: null, chip: 'mine' } },
  { name: 'panel mode', start: { id: 'r1' }, act: (s) => s.setPanel({ kind: 'step', step: 'markPaid' }), push: false, writes: { id: 'r1', panel: 'step:markPaid' } },
  { name: 'back to detail', start: { id: 'r1', panel: 'edit' }, act: (s) => s.setPanel({ kind: 'view' }), push: false, writes: { id: 'r1', panel: null } },
  { name: 'close a record', start: { id: 'r1', q: 'asha' }, act: (s) => s.close(), push: false, writes: { id: null, q: 'asha' } },
  { name: 'open create with a preset', start: {}, act: (s) => s.openCreate({ donor: 'd7' }), push: true, writes: { create: 'new', donor: 'd7' } },
  { name: 'create step', start: { create: 'new' }, act: (s) => s.setCreateStep(1), push: false, writes: { create: 'new', createStep: '1' } },
  { name: 'close create', start: { create: 'new', createStep: '1', donor: 'd7' }, act: (s) => s.closeCreate(), push: false, writes: { create: null, createStep: null, donor: null } },
  { name: 'open import', start: { id: 'r1', chip: 'mine' }, act: (s) => s.openImport(), push: false, writes: { import: 'new', importStep: null, id: null, chip: 'mine' } },
  { name: 'import step', start: { import: 'new' }, act: (s) => s.setImport('imp7', 1), push: false, writes: { import: 'imp7', importStep: '1' } },
  { name: 'import moved on', start: { import: 'imp7', importStep: '3' }, act: (s) => s.setImport('imp7', 4, true), push: false, writes: { import: 'imp7', importStep: '4' } },
  { name: 'close import', start: { import: 'imp7', importStep: '2', q: 'asha' }, act: (s) => s.closeImport(), push: false, writes: { import: null, importStep: null, q: 'asha' } },
];

describe('record list address contract', () => {
  it('owns exactly the contract parameters: layout, chip, search, filters, sort, depth, panels and presets', () => {
    expect(ownedParams(spec).sort()).toEqual(
      ['view', 'chip', 'q', 'sort', 'show', 'filters', 'id', 'panel', 'create', 'createStep', 'import', 'importStep', 'importId', 'method', 'paidOnFrom', 'paidOnTo', 'amountFrom', 'amountTo', 'anonymous', 'donor'].sort(),
    );
  });

  for (const c of CASES) {
    it(`${c.name}: ${c.push ? 'adds a history entry' : 'replaces the current entry'}`, () => {
      const calls = run(c.start, c.act);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.replace).toBe(!c.push);
      expect(calls[0]!.params).toMatchObject(c.writes);
    });
  }

  it('writes the same addresses whichever layout is showing', () => {
    for (const c of CASES) {
      const strip = (calls: Call[]) => calls.map((x) => ({ ...x, params: { ...x.params, view: null } }));
      const cards = strip(run({ ...c.start, view: 'cards' }, c.act));
      const table = strip(run({ ...c.start, view: 'table' }, c.act));
      if (c.name !== 'layout') expect(cards, c.name).toEqual(table);
    }
  });

  it('reads presets only with create, and writes them back', () => {
    expect(parseListUrl(paramsOf({ create: 'new', donor: 'd7' }), spec).presets).toEqual({ donor: 'd7' });
    expect(parseListUrl(paramsOf({ donor: 'd7' }), spec).presets).toEqual({});
    expect(toQueryParams(parseListUrl(paramsOf({ create: 'new', donor: 'd7' }), spec), spec)).toMatchObject({ create: 'new', donor: 'd7' });
  });

  it('drops invalid parameters and leaves unknown ones alone', () => {
    const state = parseListUrl(paramsOf({ view: 'grid', chip: 'nope', panel: 'edit', createStep: '9', foo: 'bar' }), spec);
    expect(state).toEqual(parseListUrl(paramsOf({}), spec));
    for (const c of CASES) {
      const calls = run({ ...c.start, foo: 'bar' }, c.act);
      expect(Object.keys(calls[0]!.params).every((k) => ownedParams(spec).includes(k)), c.name).toBe(true);
    }
  });

  it('a record opened by link keeps the list parameters it was opened from', () => {
    const state = parseListUrl(paramsOf({ chip: 'mine', q: 'asha', method: 'upi', sort: '-amount', id: 'r1', panel: 'edit' }), spec);
    const params = toQueryParams({ ...state, id: undefined, panel: { kind: 'view' } }, spec);
    expect(params).toMatchObject({ chip: 'mine', q: 'asha', method: 'upi', sort: '-amount', id: null, panel: null });
  });
});
