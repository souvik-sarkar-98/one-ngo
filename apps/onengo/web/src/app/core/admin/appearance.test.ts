import { describe, expect, it } from 'vitest';
import { addRecordItem, removeRecordItem, reorderItems, setItemIcon, startingLayout, toPublished } from './layout-draft';
import { DEFAULT_COLOURS } from '../builder/contrast';
import { colourPicker, themeBody, themeDraft, themeIssues, themeNeedsConfirm, themeProblems } from './theme-form';
import type { Me, RuntimeDefinitions } from '../models';

const me = { capabilities: { peopleDirectory: true, configure: true } } as Me;
const defs = {
  theme: null,
  recordTypes: [{ key: 'donation', label: 'Donation', pluralLabel: 'Donations', fields: [] }],
  workflows: {},
  pages: [{ key: 'fundraising', label: 'Fundraising', widgets: [] }],
} as unknown as RuntimeDefinitions;

describe('theme form', () => {
  it('omits blank tokens and asks before a low-contrast publish', () => {
    expect(themeBody({ brand: ' #0e7c66 ', background: '' })).toEqual({ key: 'organisation', brand: '#0e7c66' });
    expect(themeIssues(themeBody({ brand: 'green', radius: '8' }))).toEqual(['brand', 'radius']);
    expect(themeNeedsConfirm({ brand: '#f6e7a1', brandForeground: '#ffffff' })).toBe(true);
    expect(themeNeedsConfirm({ brand: '#0e7c66', brandForeground: '#ffffff' })).toBe(false);
  });

  it('fills a missing theme from the stylesheet and keeps a published colour', () => {
    const blank = themeDraft(null);
    expect(blank.brand).toBe(DEFAULT_COLOURS.brand);
    expect(blank.radius).toBe('6px');
    expect(themeProblems(blank)).toEqual([]);
    expect(colourPicker('brand', '')).toBe(DEFAULT_COLOURS.brand);

    const draft = themeDraft({ brand: '#112233', radius: '8px' });
    expect(draft.brand).toBe('#112233');
    expect(draft.text).toBe(DEFAULT_COLOURS.text);
    expect(draft.radius).toBe('8px');
    expect(themeProblems({ ...draft, brand: 'green' })).toContain('brand');
    expect(themeProblems({ ...draft, brand: '' })).toContain('brand');
  });
});

describe('layout draft', () => {
  it('lists the fixed destinations once and leaves record lists out until someone adds one', () => {
    const start = startingLayout(me, defs);
    expect(start.items[0]).toBe('home');
    expect(start.items).toContain('reports');
    expect(start.items).toContain('settings');
    expect(start.items).toContain('page:fundraising');
    expect(start.items).not.toContain('record:donation');
    expect(start.items.filter((key) => key === 'home')).toHaveLength(1);
    expect(start.listLayout).toBe('table');

    const added = addRecordItem(start, 'record:donation');
    expect(added.items.at(-1)).toBe('record:donation');
    expect(addRecordItem(added, 'record:donation').items).toEqual(added.items);
    expect(addRecordItem(start, 'home').items).toEqual(start.items);
    expect(removeRecordItem(added, 'home').items).toContain('home');
    expect(removeRecordItem(added, 'record:donation').items).not.toContain('record:donation');

    const marked = setItemIcon(added, 'record:donation', 'bell');
    expect(marked.icons).toEqual({ 'record:donation': 'bell' });
    expect(setItemIcon(marked, 'record:donation', 'records').icons).toEqual({});
    expect(setItemIcon(added, 'record:donation', 'nope').icons).toEqual({});

    const moved = reorderItems(start, 0, 2);
    expect(moved.items[2]).toBe('home');
    expect(moved.items).toHaveLength(start.items.length);
    expect(toPublished(marked)).toEqual({ items: marked.items, listLayout: 'table', icons: { 'record:donation': 'bell' } });
    expect(toPublished(start).icons).toBeUndefined();
  });

  it('keeps a published record list and its icon, and still fills in a missing fixed destination', () => {
    const published = startingLayout(null, {
      ...defs,
      navigation: { items: ['home', 'records', 'record:donation', 'settings'], icons: { 'record:donation': 'bell', records: 'records' } },
      listLayout: 'cards',
    });
    expect(published.items.indexOf('records')).toBeLessThan(published.items.indexOf('record:donation'));
    expect(published.items.indexOf('record:donation')).toBeLessThan(published.items.indexOf('settings'));
    expect(published.items).toContain('inbox');
    expect(published.icons).toEqual({ 'record:donation': 'bell' });
    expect(published.listLayout).toBe('cards');

    const gone = startingLayout(null, {
      ...defs,
      recordTypes: [],
      navigation: { items: ['home', 'record:donation', 'settings'] },
    });
    expect(gone.items).not.toContain('record:donation');
  });
});
