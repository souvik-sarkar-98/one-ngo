import { describe, expect, it } from 'vitest';
import type { CatalogueItem } from '../models';
import { catalogueParams, frameTab, nextSort, parseCatalogueAddress, parseEditorAddress, selectionParams, tabParams, type EditorTab } from './address';
import { builderHome, catalogueHint, homeRowReadOnly, catalogueRow, duplicateBody, filterCatalogue, kindChips, kindPageCopy, newDefinitionBody, rowActions } from './catalogue';
import { localChangeLines } from './changes';
import { builderTrail, selectionLabel } from './crumbs';
import { humanise, summarySections } from './summary';

const reader = (q: string) => {
  const p = new URLSearchParams(q);
  return (n: string) => p.get(n);
};

const item = (kind: CatalogueItem['kind'], key: string, extra: Partial<CatalogueItem> = {}): CatalogueItem => ({
  kind,
  key,
  label: null,
  publishedVersion: 1,
  draftVersion: null,
  owner: 'tenant',
  moduleKey: null,
  ...extra,
});

const ITEMS: CatalogueItem[] = [
  item('workflow', 'donation', { owner: 'base', moduleKey: 'donations', publishedVersion: 2 }),
  item('recordType', 'donation', { label: 'Donation', owner: 'base', moduleKey: 'donations', publishedVersion: 4, draftVersion: null }),
  item('recordType', 'beneficiary', { label: 'Beneficiary', publishedVersion: null, draftVersion: 1 }),
  item('theme', 'organisation', { label: 'Organisation theme', publishedVersion: 2 }),
];

describe('Builder addresses', () => {
  it('reads the editor tab and selection, dropping what is invalid', () => {
    expect(parseEditorAddress(reader('tab=changes'))).toEqual({ tab: 'changes', create: false });
    expect(parseEditorAddress(reader('tab=nope&field=amount'))).toEqual({ tab: 'visual', field: 'amount', create: false });
    expect(parseEditorAddress(reader('step=markPaid&create='))).toEqual({ tab: 'visual', step: 'markPaid', create: true });
  });

  it('reads pages of the Visual tab as tabs that belong to it', () => {
    expect(parseEditorAddress(reader('tab=rules'))).toEqual({ tab: 'rules', create: false });
    expect(parseEditorAddress(reader('tab=usedBy')).tab).toBe('usedBy');
    expect(['rules', 'usedBy', 'visual', 'json'].map((tab) => frameTab(tab as EditorTab))).toEqual(['visual', 'visual', 'visual', 'json']);
    expect(parseEditorAddress(reader('tab=workflows')).tab).toBe('workflows');
    expect(frameTab('workflows')).toBe('visual');
    expect(selectionLabel({ key: 'donation' }, { tab: 'rules', create: false })).toBe('Rules');
  });

  it('writes tabs and selections so only one is set', () => {
    expect(tabParams('visual')).toEqual({ tab: null, field: null, step: null, section: null, widget: null, create: null });
    expect(tabParams('history')).toMatchObject({ tab: 'history', field: null, widget: null });
    expect(selectionParams({ field: 'amount' })).toEqual({ tab: null, field: 'amount', step: null, section: null, widget: null, create: null });
    expect(selectionParams({ widget: '2' })).toMatchObject({ widget: '2', field: null });
    expect(parseEditorAddress(reader('widget=2'))).toEqual({ tab: 'visual', widget: '2', create: false });
    expect(selectionParams({ create: true })).toMatchObject({ create: '' });
  });

  it('reads and writes the catalogue chip, search, sort and filters', () => {
    expect(parseCatalogueAddress(reader('kind=recordType&q=don&sort=-key&from=module,bogus&state=draft'))).toEqual({
      kind: 'recordType',
      q: 'don',
      sort: { field: 'key', dir: 'desc' },
      from: ['module'],
      state: ['draft'],
    });
    expect(parseCatalogueAddress(reader('kind=nothing&sort=colour'))).toEqual({ q: '', from: [], state: [] });
    expect(catalogueParams({ kind: undefined, q: '', sort: { field: 'label', dir: 'asc' }, from: [] })).toEqual({ kind: null, q: null, sort: 'label', from: null });
  });

  it('cycles a sort ascending, descending, then off', () => {
    expect(nextSort(undefined, 'key')).toEqual({ field: 'key', dir: 'asc' });
    expect(nextSort({ field: 'key', dir: 'asc' }, 'key')).toEqual({ field: 'key', dir: 'desc' });
    expect(nextSort({ field: 'key', dir: 'desc' }, 'key')).toBeUndefined();
    expect(nextSort({ field: 'key', dir: 'desc' }, 'label')).toEqual({ field: 'label', dir: 'asc' });
  });
});

describe('Builder catalogue', () => {
  it('counts every kind, including those with none', () => {
    const chips = kindChips(ITEMS);
    expect(chips[0]).toEqual({ id: 'all', label: 'All 4' });
    expect(chips.find((c) => c.id === 'recordType')?.label).toBe('Record types 2');
    expect(chips.find((c) => c.id === 'script')?.label).toBe('Scripts 0');
    expect(chips.map((c) => c.id).slice(1, 5)).toEqual(['recordType', 'workflow', 'listView', 'recordGroup']);
  });

  it('opens the home as grouped rows, and a kind as its own page', () => {
    const home = builderHome();
    expect(home.map((group) => group.id)).toEqual(['data', 'process', 'templates', 'money', 'look', 'access', 'advanced']);
    expect(home[0]?.rows.map((row) => row.href)).toEqual(['/builder?kind=recordType', '/builder?kind=listView', '/builder?kind=recordGroup', '/builder?kind=dataFeed']);
    expect(home[0]?.rows[1]).toMatchObject({ labelKey: 'ui.builder.home.lists', hintKey: 'ui.builder.home.hint.listView' });
    const look = home.find((group) => group.id === 'look');
    expect(look?.rows.map((row) => row.href)).toEqual(['/builder/theme', '/builder/layout', '/builder?kind=page', '/builder/translations']);
    expect(home.find((group) => group.id === 'access')?.rows[0]?.href).toBe('/builder/access');
    expect(home.find((group) => group.id === 'advanced')?.rows.map((row) => row.href)).toEqual(['/builder?kind=script', '/builder/modules']);
    expect(kindPageCopy('receiptRule')).toEqual({
      titleKey: 'ui.builder.kinds.receiptRule',
      hintKey: 'ui.builder.home.hint.receiptRule',
      createKey: 'ui.builder.home.new.receiptRule',
    });
    expect(kindPageCopy('listView').createKey).toBe('ui.builder.home.new.listView');
    const rows = home.flatMap((group) => group.rows);
    expect(rows.filter((row) => row.changeNeeds).map((row) => [row.id, row.changeNeeds])).toEqual([
      ['script', 'scripts'],
      ['modules', 'modules'],
    ]);
    expect(catalogueHint(ITEMS[1]!)).toBe('v4 · Module · donations');
    expect(catalogueHint(ITEMS[2]!)).toBe('Draft v1');
  });

  it('opens Scripts and Modules read-only without the permission that changes them', () => {
    const person = (scripts: boolean, permissions: string[]) => ({ permissions, capabilities: { configure: true, publish: false, scripts, money: false } });
    const [script, modules, theme] = [
      builderHome().flatMap((g) => g.rows).find((r) => r.id === 'script')!,
      builderHome().flatMap((g) => g.rows).find((r) => r.id === 'modules')!,
      builderHome().flatMap((g) => g.rows).find((r) => r.id === 'theme')!,
    ];
    const looker = person(false, ['config:read']);
    expect(homeRowReadOnly(script, looker)).toBe(true);
    expect(homeRowReadOnly(modules, looker)).toBe(true);
    expect(homeRowReadOnly(theme, looker)).toBe(false);
    expect(homeRowReadOnly(script, person(true, ['config:read', 'config:script:publish']))).toBe(false);
    expect(homeRowReadOnly(modules, person(false, ['config:read', 'config:modules']))).toBe(false);
    expect(homeRowReadOnly(modules, person(false, ['config:*']))).toBe(false);
    expect(homeRowReadOnly(modules, person(false, ['*']))).toBe(false);
    expect(homeRowReadOnly(script, null)).toBe(true);
  });

  it('filters by kind, search, origin and state, sorted by kind then name by default', () => {
    const keys = (a: Parameters<typeof filterCatalogue>[1]) => filterCatalogue(ITEMS, a).map((i) => `${i.kind}/${i.key}`);
    expect(keys({ q: '', from: [], state: [] })).toEqual(['recordType/beneficiary', 'recordType/donation', 'workflow/donation', 'theme/organisation']);
    expect(keys({ kind: 'recordType', q: '', from: [], state: [] })).toEqual(['recordType/beneficiary', 'recordType/donation']);
    expect(keys({ q: 'DON', from: [], state: [] })).toEqual(['recordType/donation', 'workflow/donation']);
    expect(keys({ q: '', from: ['organisation'], state: ['draft'] })).toEqual(['recordType/beneficiary']);
    const desc = keys({ q: '', from: [], state: [], sort: { field: 'label', dir: 'desc' } });
    expect([desc[0], desc[3]]).toEqual(['theme/organisation', 'recordType/beneficiary']);
    expect(keys({ q: '', from: [], state: [], sort: { field: 'state', dir: 'asc' } })[0]).toBe('recordType/beneficiary');
  });

  it('draws a definition as a row with where it comes from, its state and its menu', () => {
    const row = catalogueRow(ITEMS[1]!, true);
    expect(row).toMatchObject({ id: 'recordType/donation', title: 'Donation', meta: 'Module · donations', badge: { label: 'v4', tone: 'success' } });
    expect(row.cells.map((c) => c.value)).toEqual(['Donation', 'Record type', 'donation', 'Module · donations', 'v4']);
    expect(row.actions.map((a) => a.id)).toEqual(['open', 'history', 'duplicate', 'revert']);
    const draft = catalogueRow(ITEMS[2]!, true);
    expect(draft.badge).toEqual({ label: 'Draft v1', tone: 'warning' });
    expect(draft.actions.map((a) => a.id)).toEqual(['open', 'history', 'duplicate', 'deleteDraft']);
    expect(rowActions(ITEMS[2]!, false).map((a) => a.id)).toEqual(['open', 'history']);
    expect(catalogueRow(ITEMS[0]!, true).title).toBe('donation');
  });

  it('starts new definitions from the kind\'s starter or a ready-made record type', () => {
    expect(newDefinitionBody('page', 'reports', 'Reports')).toEqual({ key: 'reports', label: 'Reports', widgets: [{ type: 'groups' }] });
    expect(newDefinitionBody('listView', 'shifts', 'Shifts', { recordType: 'shift' })).toEqual({ key: 'shifts', recordType: 'shift', label: 'Shifts' });
    expect(newDefinitionBody('template', 'thanks', 'Thanks')).not.toHaveProperty('label');
    const beneficiary = newDefinitionBody('recordType', 'beneficiary', 'Beneficiary', { starter: 'beneficiary' });
    expect(beneficiary).toMatchObject({ key: 'beneficiary', label: 'Beneficiary', titleField: 'name' });
    expect((beneficiary['fields'] as { key: string }[]).map((f) => f.key)).toEqual(['name', 'phone', 'dateOfBirth', 'address']);
  });

  it('copies a definition under a new key and name', () => {
    const body = { key: 'donation', label: 'Donation', fields: [{ key: 'amount' }] };
    expect(duplicateBody('recordType', body, 'pledge', 'Pledge')).toEqual({ key: 'pledge', label: 'Pledge', fields: [{ key: 'amount' }] });
    expect(body.key).toBe('donation');
  });
});

describe('Builder breadcrumbs', () => {
  const body = {
    key: 'donation',
    label: 'Donation',
    fields: [{ key: 'donorName', label: 'Donor name' }],
    transitions: [{ key: 'markPaid', label: 'Mark as paid' }],
    detail: { sections: [{ id: 'donations', label: 'Donations' }] },
  };

  it('names the selection or the tab', () => {
    expect(selectionLabel(body, { tab: 'visual', field: 'donorName', create: false })).toBe('Field: Donor name');
    expect(selectionLabel(body, { tab: 'visual', field: 'gone', create: false })).toBe('Field: gone');
    expect(selectionLabel(body, { tab: 'visual', step: 'markPaid', create: false })).toBe('Step: Mark as paid');
    expect(selectionLabel(body, { tab: 'visual', section: 'donations', create: false })).toBe('Section: Donations');
    expect(selectionLabel(body, { tab: 'visual', create: true })).toBe('Create form');
    expect(selectionLabel(body, { tab: 'changes', create: false })).toBe('Changes');
    expect(selectionLabel(body, { tab: 'visual', create: false })).toBeNull();
  });

  it('builds Builder, its group, the kind, the definition and the selection, with links on all but the last', () => {
    expect(builderTrail()).toEqual([{ label: 'Builder' }]);
    expect(builderTrail('recordType')).toEqual([
      { label: 'Builder', href: '/builder' },
      { label: 'Data', href: '/builder#builder-data' },
      { label: 'Record types' },
    ]);
    expect(builderTrail('recordType', 'donation', 'Donation', 'Field: Donor name')).toEqual([
      { label: 'Builder', href: '/builder' },
      { label: 'Data', href: '/builder#builder-data' },
      { label: 'Record types', href: '/builder?kind=recordType' },
      { label: 'Donation', href: '/builder/recordType/donation' },
      { label: 'Field: Donor name' },
    ]);
    expect(builderTrail('workflow', 'donation').at(-1)).toEqual({ label: 'donation' });
  });
});

describe('Builder change lines and summaries', () => {
  it('lists unsaved differences item by item', () => {
    const before = { label: 'Donation', fields: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] };
    const after = { label: 'Gift', fields: [{ key: 'b', label: 'B' }, { key: 'c', label: 'C' }], description: 'x' };
    expect(localChangeLines(before, after)).toEqual(['Changes label', 'Removes fields › a', 'Adds fields › c', 'Adds description']);
    expect(localChangeLines(before, { ...before, fields: [...before.fields].reverse() })).toEqual(['Changes fields']);
    expect(localChangeLines(before, before)).toEqual([]);
  });

  it('summarises a definition read-only: about, settings, and its tables', () => {
    expect(humanise('pluralLabel')).toBe('Plural label');
    const sections = summarySections(
      'recordType',
      'donor',
      { kind: 'recordType', key: 'donor', published: { version: 3, owner: 'tenant', baseVersion: null, body: {} }, draft: null, history: [], shipped: null },
      { key: 'donor', label: 'Donor', searchable: true, fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    );
    expect(sections.map((s) => s.title)).toEqual(['About', 'Settings', 'Fields']);
    expect(sections[0]).toMatchObject({ fields: expect.arrayContaining([{ label: 'Published', value: 'v3' }, { label: 'From', value: 'Organisation' }]) });
    expect(sections[1]).toMatchObject({ fields: [{ label: 'Label', value: 'Donor' }, { label: 'Searchable', value: 'Yes' }] });
    expect(sections[2]).toMatchObject({ kind: 'items', items: [{ title: 'Name', subtitle: 'text' }] });
  });
});
