import { describe, expect, it } from 'vitest';
import { formatMoney } from './i18n/i18n';
import type { PageDef, RuntimeDefinitions } from './models';
import {
  aggregateRequests,
  emptyContent,
  homeWithList,
  listSpecFor,
  loadWidget,
  movedPins,
  pinEntries,
  pinList,
  pinMenu,
  planPage,
  type PlannedWidget,
} from './pages';
import { parseListUrl } from './records/list/url';
import { memoryGateway } from './testing/memory-gateway';

const HOME: PageDef = {
  key: 'home',
  label: 'Home',
  widgets: [
    { index: 0, type: 'stat', label: 'Outstanding', recordType: 'donation', view: { chip: 'outstanding' }, measure: 'count' },
    { index: 1, type: 'stat', label: 'Raised', recordType: 'donation', view: { chip: 'paid' }, measure: 'sum', field: 'amount' },
    { index: 3, type: 'chart', label: 'By purpose', recordType: 'donation', measure: 'count', groupBy: { field: 'purpose' }, chart: 'bar' },
    { index: 4, type: 'list', label: 'Large gifts waiting', listView: 'donations', view: { chip: 'outstanding', filters: { amount: { from: 5000 } } }, limit: 2 },
    { index: 5, type: 'links', label: 'Links', items: [{ label: 'New donation', to: '/records/donation?create=new' }, { label: 'Elsewhere', to: 'https://example.org' }] },
    { index: 6, type: 'stat', label: 'Ghosts', recordType: 'ghost', measure: 'count' },
    { index: 7, type: 'groups' },
  ],
};

async function world(pages: PageDef[] = [HOME]) {
  const gw = memoryGateway();
  const defs: RuntimeDefinitions = { ...(await gw.auth.definitions()), pages };
  return { gw, defs, load: (w: PlannedWidget) => loadWidget(w, { pages: gw.pages, records: gw.records }, defs) };
}

const listState = (defs: RuntimeDefinitions, query: string) => {
  const spec = listSpecFor(defs, 'donation')!;
  const params = new URLSearchParams(query);
  return { spec, state: parseListUrl((n) => params.get(n), spec) };
};

describe('page plans', () => {
  it('show the record groups on Home when there is no Home page', async () => {
    const { defs } = await world([]);
    expect(planPage(defs, 'home', ['admin'])!.widgets.map((w) => w.kind)).toEqual(['groups']);
    expect(planPage(defs, 'fundraising', ['admin'])).toBeNull();
  });

  it('keep the page order, leave out what the person cannot read, and allow only in-app links', async () => {
    const { defs } = await world();
    const plan = planPage(defs, 'home', ['admin'])!;
    expect(plan.widgets.map((w) => `${w.kind}:${'label' in w ? w.label : ''}`)).toEqual([
      'stat:Outstanding',
      'stat:Raised',
      'chart:By purpose',
      'list:Large gifts waiting',
      'links:Links',
      'groups:',
    ]);
    expect(plan.widgets.find((w) => w.kind === 'links')).toMatchObject({ items: [{ label: 'New donation' }] });
    expect(plan.widgets.find((w) => w.kind === 'list')).toMatchObject({
      link: '/records/donation?amountFrom=5000',
      query: { statusIn: ['raised'], filters: { amount: { from: 5000 } }, limit: 2, offset: 0 },
    });
  });

  it('ask for each figure once, naming the page widget by its place in the published page', async () => {
    const { defs } = await world();
    expect(aggregateRequests(planPage(defs, 'home', ['admin'])!)).toEqual([
      { id: 'w0', recordType: 'donation', request: { statusIn: ['raised'], measure: 'count', widget: { page: 'home', index: 0 } } },
      { id: 'w1', recordType: 'donation', request: { statusIn: ['paid'], measure: 'sum', field: 'amount', widget: { page: 'home', index: 1 } } },
      { id: 'w3', recordType: 'donation', request: { measure: 'count', groupBy: { field: 'purpose' }, widget: { page: 'home', index: 3 } } },
    ]);
  });

  it('respect the page audience: other pages are closed, Home falls back to the groups', async () => {
    const desk: PageDef = { key: 'desk', label: 'Finance desk', audience: ['finance'], widgets: [{ type: 'groups' }] };
    const { defs } = await world([{ ...HOME, audience: ['finance'] }, desk]);
    expect(planPage(defs, 'desk', ['admin'])).toBeNull();
    expect(planPage(defs, 'desk', ['finance'])!.label).toBe('Finance desk');
    expect(planPage(defs, 'home', ['admin'])!.widgets.map((w) => w.kind)).toEqual(['groups']);
  });
});

describe('widgets with the memory gateway', () => {
  it('load counts, totals, chart buckets and the first rows of a list', async () => {
    const { defs, load } = await world();
    const [outstanding, raised, chart, list] = planPage(defs, 'home', ['admin'])!.widgets;
    expect(await load(outstanding!)).toEqual({ kind: 'stat', label: 'Outstanding', value: '6' });
    expect(await load(raised!)).toEqual({ kind: 'stat', label: 'Raised', value: formatMoney(143000) });
    expect(await load(chart!)).toMatchObject({ kind: 'chart', buckets: [{ key: 'education', label: 'Education', value: 4 }, { key: 'general', value: 5 }, { key: 'health', value: 3 }] });
    const rows = await load(list!);
    expect(rows.kind === 'list' && rows.rows.map((r) => r.id)).toEqual(['donation-12', 'donation-10']);
    expect(rows.kind === 'list' && rows.rows.every((r) => r.actions.length === 0)).toBe(true);
  });

  it('draw groups and links without asking the server', async () => {
    const { gw, defs, load } = await world();
    const plan = planPage(defs, 'home', ['admin'])!;
    const before = gw.calls.length;
    expect(await load(plan.widgets.find((w) => w.kind === 'groups')!)).toMatchObject({ kind: 'groups', groups: [{ key: 'fundraising' }] });
    expect(emptyContent(plan.widgets.find((w) => w.kind === 'links')!, defs)).toMatchObject({ kind: 'links', items: [{ to: '/records/donation?create=new' }] });
    expect(gw.calls.length).toBe(before);
  });
});

describe('pins', () => {
  it('pin a list as shown to the person’s Home, first and with three rows', async () => {
    const { gw, defs, load } = await world();
    const { spec, state } = listState(defs, 'chip=mine&sort=-amount&id=donation-1&panel=edit');
    expect(await pinList(gw.pages, spec, state, 'donations', false)).toBe('Pinned to your Home as "Donations · Mine".');
    const pins = await gw.pages.pins();
    expect(pins).toEqual([{ id: 'pin-1', label: 'Donations · Mine', listView: 'donations', address: '/records/donation?chip=mine&sort=-amount', position: 0 }]);

    const plan = planPage(defs, 'home', ['admin'], pins)!;
    expect(plan.widgets[0]).toMatchObject({ id: 'pin:pin-1', kind: 'list', link: pins[0]!.address, query: { owner: 'me', sort: { field: 'amount', dir: 'desc' }, limit: 3 } });
    const rows = await load(plan.widgets[0]!);
    expect(rows.kind === 'list' && rows.rows.map((r) => r.id)).toEqual(['donation-5', 'donation-12', 'donation-1']);
    expect(planPage(defs, 'home', ['admin'], [{ ...pins[0]!, address: '/records/ghost' }])!.widgets[0]!.kind).toBe('stat');
  });

  it('are renamed, moved and unpinned from their menu', async () => {
    const { gw, defs } = await world();
    for (const q of ['chip=mine', 'chip=paid']) {
      const { spec, state } = listState(defs, q);
      await pinList(gw.pages, spec, state, 'donations', false);
    }
    let pins = await gw.pages.pins();
    expect(pinMenu(pins, 'pin-1').map((e) => e.id)).toEqual(['open', 'rename', 'down', 'unpin']);
    expect(pinMenu(pins, 'pin-2').map((e) => e.id)).toEqual(['open', 'rename', 'up', 'unpin']);
    await gw.pages.renamePin('pin-2', 'Paid this year');
    pins = await gw.pages.orderPins(movedPins(pins, 'pin-2', -1));
    expect(pins.map((p) => p.label)).toEqual(['Paid this year', 'Donations · Mine']);
    expect(planPage(defs, 'home', ['admin'], pins)!.widgets.slice(0, 2).map((w) => w.id)).toEqual(['pin:pin-2', 'pin:pin-1']);
    await gw.pages.removePin('pin-1');
    expect((await gw.pages.pins()).map((p) => p.id)).toEqual(['pin-2']);
    expect(planPage(defs, 'fundraising', ['admin'], pins)).toBeNull();
  });

  it('for everyone go into the Home page draft, before the record groups', async () => {
    const { gw, defs } = await world();
    const first = listState(defs, 'chip=mine&amountFrom=1000&q=ravi');
    expect(await pinList(gw.pages, first.spec, first.state, 'donations', true)).toMatch(/Home page draft/);
    const label = `Donations · Mine · “ravi” · Amount: ${formatMoney(1000)} – …`;
    expect((await gw.pages.homePage())!.widgets).toEqual([
      { type: 'list', label, listView: 'donations', view: { chip: 'mine', filters: { amount: { from: 1000, to: null } } }, limit: 5 },
      { type: 'groups' },
    ]);
    const second = listState(defs, '');
    await pinList(gw.pages, second.spec, second.state, 'donations', true);
    expect((await gw.pages.homePage())!.widgets.map((w) => ('label' in w ? w.label : w.type))).toEqual([label, 'Donations · Outstanding', 'groups']);
    expect(await gw.pages.pins()).toEqual([]);
  });

  it('keep the published widget places out of a draft', async () => {
    const { defs } = await world();
    const { spec, state } = listState(defs, '');
    const page = homeWithList(HOME, spec, state, 'donations');
    expect(page.widgets.some((w) => 'index' in w)).toBe(false);
    expect(page.widgets.at(-2)).toMatchObject({ type: 'list', listView: 'donations', limit: 5 });
  });

  it('offer "Pin to everyone’s Home" only to those who publish, on lists with a list view', () => {
    expect(pinEntries(false, 'donations').map((e) => e.id)).toEqual(['pin']);
    expect(pinEntries(true, undefined).map((e) => e.id)).toEqual(['pin']);
    expect(pinEntries(true, 'donations').map((e) => e.label)).toEqual(['Pin to my Home', "Pin to everyone's Home"]);
  });
});