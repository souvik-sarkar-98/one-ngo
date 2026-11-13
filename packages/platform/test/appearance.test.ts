import { describe, expect, it } from 'vitest';
import { layoutOf, readLayout, themeOf } from '../src/runtime/definitions/appearance.js';

describe('organisation appearance', () => {
  it('checks the layout and reads a broken one as unset', () => {
    expect(layoutOf({ items: ['home', 'records', 'settings'], listLayout: 'cards' })).toEqual({
      items: ['home', 'records', 'settings'],
      listLayout: 'cards',
    });
    expect(layoutOf({ items: ['home', 'settings', 'inbox'], listLayout: 'table', icons: { inbox: 'bell', settings: 'settings' } })).toEqual({
      items: ['home', 'settings', 'inbox'],
      listLayout: 'table',
      icons: { inbox: 'bell', settings: 'settings' },
    });
    expect(layoutOf({ items: ['home', 'inbox', 'records', 'reports', 'people', 'admin', 'builder', 'guide', 'page:fundraising', 'settings', 'record:donation'], listLayout: 'cards' }).items).toHaveLength(11);
    expect(layoutOf({
      items: ['home', 'records', 'inbox', 'reports', 'builder', 'page:demo', 'admin', 'guide', 'settings', 'signout'],
      listLayout: 'table',
    }).items).toContain('reports');
    expect(() => layoutOf({ items: ['records'], listLayout: 'cards' })).toThrow();
    expect(() => layoutOf({ items: ['home', 'home'], listLayout: 'table' })).toThrow();
    expect(() => layoutOf({ items: ['home', 'settings'], more: ['inbox'], listLayout: 'table' })).toThrow();
    expect(() => layoutOf({ primary: ['home', 'settings'], listLayout: 'table' })).toThrow();
    expect(layoutOf({ items: ['home'], listLayout: 'table', icons: { home: 'favorite' } }).icons).toEqual({ home: 'favorite' });
    expect(() => layoutOf({ items: ['home'], listLayout: 'table', icons: { home: 'nope' } })).toThrow();
    expect(() => layoutOf({ items: ['home'], listLayout: 'table', icons: { missing: 'bell' } })).toThrow();
    expect(readLayout({ items: 'home' })).toBeNull();
    expect(readLayout(null)).toBeNull();
  });

  it('keeps only filled theme tokens and names the theme organisation', () => {
    expect(themeOf({ brand: ' #0e7c66 ', radius: '', background: undefined })).toEqual({ key: 'organisation', brand: '#0e7c66' });
    expect(() => themeOf({ key: 'other', brand: '#0e7c66' })).toThrow();
    expect(() => themeOf(null)).toThrow();
  });
});
