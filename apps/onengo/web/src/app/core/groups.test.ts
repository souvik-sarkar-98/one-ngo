import { describe, expect, it } from 'vitest';
import { CollapsedGroups, homeGroups, recordsModel, type KeyValueStore } from './groups';
import type { RuntimeDefinitions, RuntimeRecordType } from './models';
import { memoryGateway } from './testing/memory-gateway';

const definitions = (): Promise<RuntimeDefinitions> => memoryGateway().auth.definitions();

function many(defs: RuntimeDefinitions, n: number): RuntimeDefinitions {
  const extra: RuntimeRecordType[] = Array.from({ length: n }, (_, i) => ({
    key: `type${i}`,
    label: `Type ${i}`,
    description: i === 3 ? 'Volunteer hours' : undefined,
    fields: [{ key: 'name', label: 'Name', type: 'text' }],
    version: 1,
    canCreate: false,
    canUpdate: false,
  }));
  return { ...defs, recordTypes: [...defs.recordTypes, ...extra] };
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('record groups on Home', () => {
  it('show one card per group with "New" where the person can create, and no counts', async () => {
    const defs = await definitions();
    expect(homeGroups(defs)).toEqual([
      {
        key: 'fundraising',
        label: 'Fundraising',
        items: [
          { label: 'Donors', to: '/records/donor', create: { label: 'New donor', to: '/records/donor?create=new' } },
          { label: 'Donations', to: '/records/donation', create: { label: 'New donation', to: '/records/donation?create=new' } },
        ],
      },
    ]);
    const readOnly = { ...defs, recordTypes: defs.recordTypes.map((t) => ({ ...t, canCreate: false })) };
    expect(homeGroups(readOnly)[0]!.items.every((i) => !i.create)).toBe(true);
  });

  it('put record types in no group under Other and hide empty groups', async () => {
    const defs = many(await definitions(), 1);
    const withEmpty = { ...defs, recordGroups: [...defs.recordGroups!, { key: 'empty', label: 'Empty', recordTypes: ['ghost'] }] };
    expect(homeGroups(withEmpty).map((g) => g.label)).toEqual(['Fundraising', 'Other']);
  });
});

describe('the Records screen', () => {
  it('offers search only above eight record types', async () => {
    const defs = await definitions();
    expect(recordsModel(defs, 'don', new Set()).search).toBe(false);
    expect(recordsModel(defs, 'don', new Set()).sections[0]!.types.map((t) => t.label)).toEqual(['Donors', 'Donations']);
    expect(recordsModel(many(defs, 6), '', new Set()).search).toBe(false);
    expect(recordsModel(many(defs, 7), '', new Set()).search).toBe(true);
  });

  it('searches labels and descriptions, opening the groups that match', async () => {
    const defs = many(await definitions(), 8);
    const collapsed = new Set(['fundraising', 'other']);
    expect(recordsModel(defs, '', collapsed).sections.map((s) => [s.key, s.collapsed])).toEqual([
      ['fundraising', true],
      ['other', true],
    ]);
    const found = recordsModel(defs, 'VOLUNTEER', collapsed);
    expect(found.sections).toEqual([{ key: 'other', label: 'Other', collapsed: false, types: [{ key: 'type3', label: 'Type 3', hint: 'Volunteer hours', link: '/records/type3' }] }]);
    expect(recordsModel(defs, 'nothing like this', collapsed)).toMatchObject({ empty: true, sections: [] });
  });

  it('remembers collapsed groups per organisation on the device', () => {
    const store = memoryStore();
    const seva = new CollapsedGroups(store, 'seva');
    expect([...seva.toggle('fundraising')]).toEqual(['fundraising']);
    expect([...new CollapsedGroups(store, 'seva').value]).toEqual(['fundraising']);
    expect([...new CollapsedGroups(store, 'other-org').value]).toEqual([]);
    expect([...seva.toggle('fundraising')]).toEqual([]);
    store.data.set('ngo.groups.collapsed.broken', '{not json');
    expect([...new CollapsedGroups(store, 'broken').value]).toEqual([]);
  });
});
