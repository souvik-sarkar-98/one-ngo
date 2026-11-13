import { describe, expect, it, vi } from 'vitest';
import { displayValue } from '../../fields/fields';
import { formatMoney } from '../../i18n/i18n';
import type { ListViewDef, RuntimeRecordType } from '../../models';
import { peopleSource } from '../../people/people';
import { memoryGateway, sampleSeed } from '../../testing/memory-gateway';
import { donationsView, donationType, donationWorkflow, donorsView, donorType } from '../../testing/sample-data';
import { changedOnly, toFormValue } from './forms';
import { filterPills } from './present';
import { criteriaToFilters } from '../list/query';
import { RecordSession, type RecordLinks } from './record-session';
import { personTitles, type PickOption } from './references';
import { resolveListSpec, type ListSpec } from '../spec';
import { fakeGateway, paramsOf } from '../gateway/testing';
import { parseListUrl } from '../list/url';

const gift: RuntimeRecordType = {
  ...donationType,
  fields: [
    ...donationType.fields.map((f) => (f.key === 'donorName' ? { ...f, editableWhen: 'record.donor == null' } : f)),
    { key: 'donorCity', label: 'City', type: 'text', copyFrom: { reference: 'donor', field: 'city' } },
  ],
};
const giftsView: ListViewDef = { ...donationsView, create: { ...donationsView.create, presets: [{ param: 'donor', field: 'donor' }] } };
const giftSpec = resolveListSpec(gift, donationWorkflow, giftsView, { workflows: [donationWorkflow] });
const donorSpec = resolveListSpec(donorType, undefined, donorsView);

const viewer = () => ({ id: 'u1', roles: ['admin'] });
const hooks = { saved: () => undefined, failed: () => undefined };
const linksTo = (specs: ListSpec[], people?: RecordLinks['people']): RecordLinks => ({ spec: (type) => specs.find((s) => s.type.key === type) ?? null, people });

function giftSession(over: { donor?: Partial<RuntimeRecordType> } = {}) {
  const g = memoryGateway();
  const donors = { ...donorSpec, type: { ...donorType, ...over.donor } };
  const s = new RecordSession(g.records, giftSpec, viewer, hooks, linksTo([giftSpec, donors], g.people));
  return { g, s, donor: () => s.fields(['donor'])[0]! };
}
const readOnly = (s: RecordSession, keys: string[]) => Object.fromEntries(s.fields(keys).map((f) => [f.key, f.readOnly]));

describe('record picker over the memory gateway', () => {
  it('searches eight at a time with a second line, then offers "New donor" with the typed text', async () => {
    const { g, s, donor } = giftSession();
    await s.follow(parseListUrl(paramsOf({ create: 'new' }), giftSpec));
    const options = (await s.picker(donor())!.source.search(' meera ')) as PickOption[];
    expect(g.calls.filter((c) => c.op === 'query').at(-1)!.args).toEqual(['donor', { search: 'meera', limit: 8 }]);
    expect(options.map((o) => [o.label, o.hint ?? null, o.create ?? null])).toEqual([
      ['Meera Krishnan', 'Chennai', null],
      ['New donor “meera”', null, 'meera'],
    ]);
  });

  it('copies on choosing, locks by editableWhen, and unlocks on clearing with the copied values kept', async () => {
    const { s, donor } = giftSession();
    await s.follow(parseListUrl(paramsOf({ create: 'new' }), giftSpec));
    expect(readOnly(s, ['donorName', 'donorCity'])).toEqual({ donorName: false, donorCity: false });

    const [meera] = await s.picker(donor())!.source.search('meera');
    await s.choose('donor', meera!);
    expect(s.snapshot.values).toMatchObject({ donor: 'donor-1', donorName: 'Meera Krishnan', donorCity: 'Chennai' });
    expect(s.picker(donor())!.text).toBe('Meera Krishnan');
    expect(readOnly(s, ['donorName', 'donorCity'])).toEqual({ donorName: true, donorCity: false });

    await s.choose('donor', null);
    expect(s.snapshot.values).toMatchObject({ donor: '', donorName: 'Meera Krishnan', donorCity: 'Chennai' });
    expect(s.picker(donor())!.text).toBe('');
    expect(readOnly(s, ['donorName', 'donorCity'])).toEqual({ donorName: false, donorCity: false });
  });

  it('creates the record from the typed text and chooses it', async () => {
    const { g, s, donor } = giftSession();
    await s.follow(parseListUrl(paramsOf({ create: 'new' }), giftSpec));
    const options = await s.picker(donor())!.source.search('Priya Nair');
    expect(options.map((o) => o.label)).toEqual(['New donor “Priya Nair”']);
    await s.choose('donor', options[0]!);
    const created = g.calls.find((c) => c.op === 'create')!;
    expect(created.args).toEqual(['donor', { name: 'Priya Nair' }]);
    const id = s.snapshot.values['donor'] as string;
    expect(g.record(id)).toMatchObject({ type: 'donor', data: { name: 'Priya Nair' } });
    expect(s.snapshot.values).toMatchObject({ donorName: 'Priya Nair' });
    expect(s.picker(donor())!.text).toBe('Priya Nair');
    expect(s.snapshot.busy).toBe(false);
  });

  it('offers no "New …" when the person cannot create the type or it has no title field', async () => {
    for (const over of [{ canCreate: false }, { titleField: undefined }]) {
      const { s, donor } = giftSession({ donor: over });
      await s.follow(parseListUrl(paramsOf({ create: 'new' }), giftSpec));
      expect((await s.picker(donor())!.source.search('zzz')).map((o) => o.label)).toEqual([]);
    }
  });

  it('shows a chosen reference by its title, read once through the gateway', async () => {
    const { g, s, donor } = giftSession();
    await s.follow(parseListUrl(paramsOf({ id: 'donation-2', panel: 'edit' }), giftSpec));
    await vi.waitFor(() => expect(s.picker(donor())!.text).toBe('Rahul Banerjee'));
    expect(g.calls.filter((c) => c.op === 'get' && c.args[0] === 'donor').map((c) => c.args[1])).toEqual(['donor-2']);
    expect(readOnly(s, ['donorName'])).toEqual({ donorName: true });
  });

  it('fills and locks the copied fields when create opens with the reference as a preset', async () => {
    const { s, donor } = giftSession();
    await s.follow(parseListUrl(paramsOf({ create: 'new', donor: 'donor-3' }), giftSpec));
    await vi.waitFor(() => expect(s.picker(donor())!.text).toBe('Sunita Patil'));
    expect(s.snapshot.values).toMatchObject({ donor: 'donor-3', donorName: 'Sunita Patil', donorCity: 'Pune' });
    expect(readOnly(s, ['donorName'])).toEqual({ donorName: true });
  });

  it('has no picker when the referenced type cannot be read', async () => {
    const g = memoryGateway();
    const s = new RecordSession(g.records, giftSpec, viewer, hooks, linksTo([giftSpec]));
    await s.follow(parseListUrl(paramsOf({ create: 'new' }), giftSpec));
    expect(s.picker(s.fields(['donor'])[0]!)).toBeNull();
    expect(s.picker(s.fields(['amount'])[0]!)).toBeNull();
  });
});

describe('related sections over the memory gateway', () => {
  it('shows the count, the server total and the latest records, each opening in its own list', async () => {
    const g = memoryGateway();
    const s = new RecordSession(g.records, donorSpec, viewer, hooks, linksTo([donorSpec, giftSpec]));
    await s.follow(parseListUrl(paramsOf({ id: 'donor-1' }), donorSpec));
    expect(g.calls.filter((c) => c.op === 'query').map((c) => c.args)).toEqual([
      ['donation', { filters: { donor: { in: ['donor-1'] } }, sort: { field: 'createdAt', dir: 'desc' }, limit: 10, sum: ['amount'] }],
    ]);
    expect(s.snapshot.related[0]).toMatchObject({ count: 2, sum: 8000, error: '' });
    const [section] = s.relatedSections();
    expect(section).toMatchObject({ kind: 'items', id: 'related:donations', selectable: true, title: `Donations · 2 · ${formatMoney(8000)}` });
    expect(section!.kind === 'items' && section!.items).toEqual([
      { id: 'donation-7', title: 'DON/2026-27/00007', subtitle: formatMoney(3000), badge: { label: 'Raised', tone: 'warning' } },
      { id: 'donation-1', title: 'DON/2026-27/00001', subtitle: formatMoney(5000), badge: { label: 'Paid', tone: 'success' } },
    ]);
  });

  it('offers "New … for this record" through the related list view preset, when the person may create there', async () => {
    const g = memoryGateway();
    const open = async (specs: ListSpec[]) => {
      const s = new RecordSession(g.records, donorSpec, viewer, hooks, linksTo(specs));
      await s.follow(parseListUrl(paramsOf({ id: 'donor-1' }), donorSpec));
      return s.relatedCreates();
    };
    expect(await open([donorSpec, giftSpec])).toEqual([{ id: 'donations', label: 'New donation for Meera Krishnan', recordType: 'donation', presets: { donor: 'donor-1' } }]);
    expect(await open([donorSpec, { ...giftSpec, type: { ...gift, canCreate: false } }])).toEqual([]);
    expect(await open([donorSpec, { ...giftSpec, presets: [] }])).toEqual([]);
    expect(await open([donorSpec])).toEqual([]);
  });

  it('keeps an empty section with its error when the related type cannot be read', async () => {
    const g = memoryGateway();
    const s = new RecordSession(g.records, donorSpec, viewer, hooks, linksTo([donorSpec]));
    g.records.query = async () => {
      throw { code: 'forbidden', message: 'You cannot see donations.' };
    };
    await s.follow(parseListUrl(paramsOf({ id: 'donor-1' }), donorSpec));
    expect(s.relatedSections()).toEqual([{ kind: 'items', id: 'related:donations', title: 'Donations · 0', selectable: true, note: 'You cannot see donations.', items: [] }]);
  });
});

describe('person picker', () => {
  const visit: RuntimeRecordType = {
    key: 'visit',
    label: 'Visit',
    version: 1,
    canCreate: true,
    canUpdate: true,
    fields: [
      { key: 'place', label: 'Place', type: 'text' },
      { key: 'visitedBy', label: 'Visited by', type: 'person' },
    ],
  };
  const visitSpec = resolveListSpec(visit, undefined, { key: 'visits', recordType: 'visit', filters: ['visitedBy'] });

  it('suggests active people only, by name with the email, and never "New …"', async () => {
    const seed = sampleSeed();
    seed.users.push(
      { id: 'u3', displayName: 'Ravi Suspended', email: 'ravi@example.org', password: 'x', roles: [], status: 'suspended' },
      { id: 'u4', displayName: 'Isha Invited', email: 'isha@example.org', password: 'x', roles: [], status: 'invited' },
    );
    const g = memoryGateway(seed);
    const source = peopleSource(g.people);
    expect(source.minLength).toBe(0);
    expect(await source.search('')).toEqual([
      { id: 'u1', label: 'Asha Rao', hint: 'asha@example.org' },
      { id: 'u2', label: 'Vikram Iyer', hint: 'vikram@example.org' },
    ]);
    expect(await source.search('ravi')).toEqual([]);
    expect(await source.search('nobody at all')).toEqual([]);
  });

  it('keeps the user id, shows the name, and treats a stored { id, name } as unchanged', async () => {
    const g = memoryGateway();
    const s = new RecordSession(fakeGateway().gateway, visitSpec, viewer, hooks, linksTo([visitSpec], g.people));
    await s.follow(parseListUrl(paramsOf({ create: 'new' }), visitSpec));
    const field = s.fields(['visitedBy'])[0]!;
    const [, vikram] = await s.picker(field)!.source.search('');
    await s.choose('visitedBy', vikram!);
    expect(s.snapshot.values['visitedBy']).toBe('u2');
    expect(s.picker(field)!.text).toBe('Vikram Iyer');
    expect(g.calls.filter((c) => c.port === 'people').map((c) => c.args)).toEqual([['']]);

    const stored = { visitedBy: { id: 'u2', name: 'Vikram Iyer' } };
    expect(toFormValue(visit.fields[1]!, stored.visitedBy)).toBe('u2');
    expect(personTitles(visit.fields, stored)).toEqual({ u2: 'Vikram Iyer' });
    expect(changedOnly(stored, { visitedBy: 'u2' })).toEqual({});
    expect(changedOnly(stored, { visitedBy: 'u1' })).toEqual({ visitedBy: 'u1' });
    expect(displayValue(visit.fields[1]!, stored.visitedBy)).toBe('Vikram Iyer');
  });

  it('filters by person with "Assigned to me", sent as the token me', () => {
    const [filter] = visitSpec.filters;
    expect(filter).toMatchObject({ kind: 'list', field: { key: 'visitedBy', choices: [{ value: 'me', label: 'Assigned to me' }] } });
    expect(criteriaToFilters(visitSpec.filters, { visitedBy: ['me'] })).toEqual({ visitedBy: { in: ['me'] } });
    expect(filterPills(visitSpec.filters, { visitedBy: ['me'] })).toEqual([{ id: 'visitedBy', label: 'Visited by: Assigned to me' }]);
  });
});
