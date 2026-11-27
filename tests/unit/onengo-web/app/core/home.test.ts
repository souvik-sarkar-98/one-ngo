import { describe, expect, it } from 'vitest';
import type { GroupCard } from '../../../../../apps/onengo/web/src/app/core/groups';
import { filterGroups, filterTasks, taskAreas, taskCards } from '../../../../../apps/onengo/web/src/app/core/home';
import { planWidget, type PlannedWidget } from '../../../../../apps/onengo/web/src/app/core/pages';

const widgets: PlannedWidget[] = [
  { id: 'w0', kind: 'groups' },
  { id: 'w1', kind: 'wizards', label: 'Fundraising', items: [{ label: 'Record a donation', to: '/records/donation?create=new' }] },
  { id: 'w3', kind: 'links', label: 'Quick links', items: [{ label: 'Donors in Pune', to: '/records/donor?city=pune' }] },
  {
    id: 'w2',
    kind: 'wizards',
    label: 'Spending',
    items: [
      { label: 'Claim an expense', to: '/records/expenseClaim?create=new' },
      { label: 'Add an earning', to: '/records/earning?create=new' },
    ],
  },
];

const groups: GroupCard[] = [
  { key: 'fund', label: 'Fundraising', items: [{ label: 'Donors', to: '/records/donor' }, { label: 'Donations', to: '/records/donation' }] },
  { key: 'spend', label: 'Spending', items: [{ label: 'Expense claims', to: '/records/expenseClaim' }] },
];

describe('Home tasks', () => {
  it('are the links of the task-card widgets, under the widget label; plain links widgets stay links', () => {
    const cards = taskCards(widgets);
    expect(cards.map((c) => `${c.area}:${c.label}`)).toEqual(['Fundraising:Record a donation', 'Spending:Claim an expense', 'Spending:Add an earning']);
    expect(taskAreas(cards)).toEqual(['Fundraising', 'Spending']);
    expect(taskCards([{ id: 'g', kind: 'groups' }])).toEqual([]);
  });

  it('narrow by area and by search together, ignoring case', () => {
    const cards = taskCards(widgets);
    expect(filterTasks(cards, null, '')).toHaveLength(3);
    expect(filterTasks(cards, 'Spending', '')).toHaveLength(2);
    expect(filterTasks(cards, null, 'DONATION').map((c) => c.label)).toEqual(['Record a donation']);
    expect(filterTasks(cards, 'Spending', 'donation')).toEqual([]);
    expect(filterTasks(cards, null, 'spending')).toHaveLength(2);
  });
});

describe('task-card widgets in a page plan', () => {
  it('keep in-app links only and are left out when none remain', () => {
    const w = { type: 'wizards' as const, label: 'Spending', items: [{ label: 'Claim', to: '/records/expenseClaim?create=new' }, { label: 'Away', to: 'https://example.org' }] };
    expect(planWidget(null, 'fundraising', w, 2)).toEqual({ id: 'w2', kind: 'wizards', label: 'Spending', items: [{ label: 'Claim', to: '/records/expenseClaim?create=new' }] });
    expect(planWidget(null, 'fundraising', { ...w, items: [w.items[1]!] }, 0)).toBeNull();
  });
});

describe('Home record groups under a search', () => {
  it('stay whole without a search', () => {
    expect(filterGroups(groups, '  ')).toEqual(groups);
  });

  it('keep only matching records, or every record of a group whose name matches', () => {
    expect(filterGroups(groups, 'donat')).toEqual([{ ...groups[0]!, items: [groups[0]!.items[1]!] }]);
    expect(filterGroups(groups, 'spend')).toEqual([groups[1]]);
    expect(filterGroups(groups, 'nothing')).toEqual([]);
  });
});
