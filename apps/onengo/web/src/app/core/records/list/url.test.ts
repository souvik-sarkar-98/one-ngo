import { describe, expect, it } from 'vitest';
import { resolveListSpec } from '../spec';
import { donationType, donationsView, donationWorkflow, paramsOf } from '../gateway/testing';
import { criteriaFromParams, ownedParams, paramsFromCriteria, parseListUrl, patch, pushesHistory, toQueryParams, withoutFilter, type ListState } from './url';

const spec = resolveListSpec(donationType, donationWorkflow, donationsView);
const parse = (p: Record<string, string>) => parseListUrl(paramsOf(p), spec);
const roundTrip = (s: ListState) => {
  const q = toQueryParams(s, spec);
  return parseListUrl((n) => q[n] ?? null, spec);
};

describe('the import link needs record:<type>:import', () => {
  const without = resolveListSpec(donationType, donationWorkflow, donationsView, { canImport: false });
  const withImport = resolveListSpec(donationType, donationWorkflow, donationsView, { canImport: true });

  it('ignores ?import=new, and an import in progress, without the permission', () => {
    expect(parseListUrl(paramsOf({ import: 'new' }), without).import).toBeUndefined();
    const inProgress = parseListUrl(paramsOf({ import: 'imp7', importStep: '2' }), without);
    expect(inProgress.import).toBeUndefined();
    expect(inProgress.importStep).toBeUndefined();
    expect(parseListUrl(paramsOf({ import: 'new', chip: 'mine' }), without).chip).toBe('mine');
  });

  it('opens the import with the permission, and when the list does not say', () => {
    expect(parseListUrl(paramsOf({ import: 'new' }), withImport)).toMatchObject({ import: 'new', importStep: 0 });
    expect(parseListUrl(paramsOf({ import: 'imp7', importStep: '2' }), withImport)).toMatchObject({ import: 'imp7', importStep: 2 });
    expect(parseListUrl(paramsOf({ import: 'new' }), spec).import).toBe('new');
  });

  it('leaves a record or the create form open as before', () => {
    expect(parseListUrl(paramsOf({ id: 'r1', import: 'new' }), without).id).toBe('r1');
    expect(withImport.canImport).toBe(true);
    expect(spec.canImport).toBeUndefined();
  });
});

describe('the address bar holds the whole list state', () => {
  it('reads every parameter', () => {
    const s = parse({
      view: 'table',
      chip: 'mine',
      q: ' asha ',
      method: 'upi,cash',
      paidOnFrom: '2026-04-01',
      amountTo: '500',
      anonymous: 'true',
      sort: '-amount',
      show: '30',
      filters: 'open',
      id: 'r7',
      panel: 'step:markPaid',
    });
    expect(s).toEqual<ListState>({
      view: 'table',
      chip: 'mine',
      q: 'asha',
      criteria: { method: ['upi', 'cash'], paidOnFrom: '2026-04-01', amountTo: '500', anonymous: true },
      sort: { field: 'amount', dir: 'desc' },
      show: 36,
      filtersOpen: true,
      id: 'r7',
      panel: { kind: 'step', step: 'markPaid' },
      create: undefined,
      createStep: 0,
      presets: {},
    });
  });

  it('round-trips any state through the parameters', () => {
    const states: ListState[] = [
      parse({}),
      parse({ view: 'cards', chip: 'mine', q: 'x', method: 'cash', sort: 'donorName', show: '24', filters: 'open' }),
      parse({ id: 'r1', panel: 'edit', amountFrom: '1', amountTo: '9' }),
      parse({ create: 'new', createStep: '1', paidOnTo: '2026-12-31', anonymous: 'false' }),
    ];
    for (const s of states) expect(roundTrip(s)).toEqual(s);
  });

  it('drops invalid values so a bad link still opens', () => {
    expect(parse({ view: 'grid', chip: 'nope', sort: 'donorPan', show: '-3', panel: 'step:hidden-nope', method: 'cheque', amountFrom: 'abc', paidOnFrom: '1st April', anonymous: 'maybe' })).toEqual(parse({}));
    expect(parse({ panel: 'edit' }).panel).toEqual({ kind: 'view' });
    expect(parse({ show: '9999' }).show).toBe(492);
    expect(parse({ createStep: '5', create: 'new' }).createStep).toBe(0);
  });

  it('leaves out defaults and clears everything it owns', () => {
    const q = toQueryParams(parse({}), spec);
    expect(Object.keys(q).sort()).toEqual(ownedParams(spec).sort());
    expect(Object.values(q).every((v) => v === null)).toBe(true);
  });

  it('keeps filter parameters the same as before, so old links still work', () => {
    const c = criteriaFromParams(spec.filters, paramsOf({ method: 'upi,cash', paidOnFrom: '2026-04-01', amountTo: '500', anonymous: 'true', unrelated: 'x' }));
    expect(c).toEqual({ method: ['upi', 'cash'], paidOnFrom: '2026-04-01', amountTo: '500', anonymous: true });
    expect(paramsFromCriteria(spec.filters, withoutFilter(c, 'amount'))).toEqual({
      method: 'upi,cash',
      paidOnFrom: '2026-04-01',
      paidOnTo: null,
      amountFrom: null,
      amountTo: null,
      anonymous: 'true',
    });
  });
});

describe('changes', () => {
  const deep = parse({ chip: 'mine', show: '48', view: 'table', filters: 'open' });

  it('starts from the first page when what is listed changes', () => {
    expect(patch(deep, { chip: 'outstanding' }, spec).show).toBe(12);
    expect(patch(deep, { q: 'a' }, spec).show).toBe(12);
    expect(patch(deep, { criteria: { anonymous: true } }, spec).show).toBe(12);
    expect(patch(deep, { sort: { field: 'amount', dir: 'asc' } }, spec).show).toBe(12);
    expect(patch(deep, { chip: 'mine' }, spec).show).toBe(48);
  });

  it('switching layout keeps everything else', () => {
    const next = patch(deep, { view: 'cards' }, spec);
    expect({ ...next, view: undefined }).toEqual({ ...deep, view: undefined });
  });

  it('opening a record closes create and the other way round', () => {
    const creating = patch(deep, { create: 'new', createStep: 1 }, spec);
    expect(patch(creating, { id: 'r1' }, spec)).toMatchObject({ id: 'r1', create: undefined, createStep: 0, panel: { kind: 'view' } });
    const open = patch(deep, { id: 'r1', panel: { kind: 'edit' } }, spec);
    expect(open.panel).toEqual({ kind: 'edit' });
    expect(patch(open, { create: 'new' }, spec)).toMatchObject({ id: undefined, create: 'new' });
    expect(patch(open, { id: undefined }, spec).panel).toEqual({ kind: 'view' });
  });

  it('adds history only when a record or the create form opens', () => {
    expect(pushesHistory(deep, patch(deep, { id: 'r1' }, spec))).toBe(true);
    expect(pushesHistory(deep, patch(deep, { create: 'new' }, spec))).toBe(true);
    const open = patch(deep, { id: 'r1' }, spec);
    expect(pushesHistory(open, patch(open, { panel: { kind: 'edit' } }, spec))).toBe(false);
    expect(pushesHistory(open, patch(open, { id: undefined }, spec))).toBe(false);
    for (const change of [{ chip: 'outstanding' }, { q: 'x' }, { show: 60 }, { view: 'cards' as const }, { filtersOpen: false }]) {
      expect(pushesHistory(deep, patch(deep, change, spec))).toBe(false);
    }
  });
});
