import { describe, expect, it } from 'vitest';
import type { PageDef } from '../../models';
import { planWidget } from '../../pages';
import { memoryGateway } from '../../testing/memory-gateway';
import {
  addLink,
  addWidget,
  changeWidgetType,
  moveLink,
  moveWidget,
  newWidget,
  removeLink,
  removeWidget,
  setAudience,
  setGroupBy,
  setLink,
  setWidget,
  setWidgetPermission,
  setWidgetView,
  toggleAudience,
  widgetRows,
  widgetSummary,
  type WidgetNames,
} from './page';

const page = (): PageDef => ({
  key: 'home',
  label: 'Home',
  widgets: [
    { type: 'stat', label: 'Raised', recordType: 'donation', measure: 'sum', field: 'amount', view: { chip: 'paid' } },
    { type: 'links', label: 'Quick links', items: [{ label: 'Donors', to: '/records/donor' }] },
    { type: 'groups' },
  ],
});

const names: WidgetNames = {
  recordType: (k) => ({ donation: 'Donation' })[k],
  field: (_, k) => ({ amount: 'Amount', method: 'Method' })[k],
  listView: (k) => ({ donations: 'Donations' })[k],
  chip: (_, c) => ({ paid: 'Paid', outstanding: 'Outstanding' })[c],
};

describe('page widget operations', () => {
  it('adds widgets the page rules accept as they are', () => {
    for (const type of ['stat', 'chart', 'list', 'links'] as const) {
      const w = newWidget(type) as { label: string };
      expect(w.label.length, type).toBeGreaterThan(0);
    }
    expect(newWidget('links')).toMatchObject({ items: [{ to: '/' }] });
    const p = addWidget(page(), 'chart');
    expect(p.widgets).toHaveLength(4);
    expect(p.widgets[3]).toMatchObject({ type: 'chart', measure: 'count', chart: 'bar', groupBy: { period: 'month', dateField: 'createdAt' } });
    expect(page().widgets).toHaveLength(3);
  });

  it('removes and reorders widgets', () => {
    expect(removeWidget(page(), 1).widgets.map((w) => w.type)).toEqual(['stat', 'groups']);
    expect(moveWidget(page(), 2, 0).widgets.map((w) => w.type)).toEqual(['groups', 'stat', 'links']);
    expect(moveWidget(page(), 0, 9).widgets.map((w) => w.type)).toEqual(['stat', 'links', 'groups']);
  });

  it('drops the published place of a widget when editing', () => {
    const p = { ...page(), widgets: page().widgets.map((w, index) => ({ ...w, index })) };
    expect(setWidget(p, 0, { label: 'Raised this month' }).widgets.every((w) => w.index === undefined)).toBe(true);
  });

  it('changes settings, dropping empty ones and the field when counting', () => {
    expect(setWidget(page(), 0, { measure: 'count' }).widgets[0]).toEqual({ type: 'stat', label: 'Raised', recordType: 'donation', measure: 'count', view: { chip: 'paid' } });
    expect(setWidget(page(), 0, { field: '' }).widgets[0]).not.toHaveProperty('field');
    expect(setWidgetView(page(), 0, { chip: undefined }).widgets[0]).not.toHaveProperty('view');
    expect(setWidgetView(page(), 0, { owner: 'me' }).widgets[0]).toMatchObject({ view: { chip: 'paid', owner: 'me' } });
    const chart = addWidget(page(), 'chart');
    expect(setGroupBy(chart, 3, { field: 'method' }).widgets[3]).toMatchObject({ groupBy: { field: 'method' } });
  });

  it('changes a widget type keeping what still applies', () => {
    const p = setWidgetPermission(page(), 0, 'finance:dashboard');
    const chart = changeWidgetType(p, 0, 'chart').widgets[0]!;
    expect(chart).toMatchObject({ type: 'chart', label: 'Raised', recordType: 'donation', measure: 'sum', field: 'amount', view: { chip: 'paid' }, permission: 'finance:dashboard', chart: 'bar' });
    const list = changeWidgetType(p, 0, 'list').widgets[0]!;
    expect(list).toEqual({ type: 'list', label: 'Raised', listView: '', limit: 5, permission: 'finance:dashboard' });
    expect(changeWidgetType(p, 0, 'groups').widgets[0]).toEqual({ type: 'groups', permission: 'finance:dashboard' });
    expect(changeWidgetType(page(), 2, 'stat').widgets[2]).toMatchObject({ type: 'stat', label: 'Number' });
  });

  it('sets and clears a permission per widget and per link', () => {
    expect(setWidgetPermission(page(), 2, ' record:donation:read ').widgets[2]).toEqual({ type: 'groups', permission: 'record:donation:read' });
    expect(setWidgetPermission(setWidgetPermission(page(), 2, 'x'), 2, '').widgets[2]).toEqual({ type: 'groups' });
    const withPerm = setLink(page(), 1, 0, { permission: 'record:donor:read' });
    expect(withPerm.widgets[1]).toMatchObject({ items: [{ label: 'Donors', to: '/records/donor', permission: 'record:donor:read' }] });
    expect(setLink(withPerm, 1, 0, { permission: ' ' }).widgets[1]).toMatchObject({ items: [{ label: 'Donors', to: '/records/donor' }] });
    expect((setLink(withPerm, 1, 0, { permission: '' }).widgets[1] as { items: object[] }).items[0]).not.toHaveProperty('permission');
  });

  it('adds, removes and moves links, keeping at least one', () => {
    const two = addLink(page(), 1);
    expect((two.widgets[1] as { items: { to: string }[] }).items.map((i) => i.to)).toEqual(['/records/donor', '/']);
    expect((moveLink(two, 1, 1, 0).widgets[1] as { items: { to: string }[] }).items.map((i) => i.to)).toEqual(['/', '/records/donor']);
    expect((removeLink(two, 1, 0).widgets[1] as { items: { to: string }[] }).items.map((i) => i.to)).toEqual(['/']);
    expect((removeLink(page(), 1, 0).widgets[1] as { items: unknown[] }).items).toHaveLength(1);
  });

  it('sets the audience, empty meaning everyone', () => {
    expect(setAudience(page(), ['finance', 'finance', 'admin']).audience).toEqual(['finance', 'admin']);
    expect(setAudience({ ...page(), audience: ['x'] }, [])).not.toHaveProperty('audience');
    expect(toggleAudience(toggleAudience(page(), 'finance', true), 'viewer', true).audience).toEqual(['finance', 'viewer']);
    expect(toggleAudience({ ...page(), audience: ['finance'] }, 'finance', false)).not.toHaveProperty('audience');
  });

  it('describes each widget for the table', () => {
    expect(widgetSummary(page().widgets[0]!, names)).toBe('Total of Amount · Donation · chip Paid');
    expect(widgetSummary(page().widgets[1]!, names)).toBe('1 link');
    expect(widgetSummary({ type: 'chart', label: 'By month', recordType: 'donation', measure: 'count', groupBy: { period: 'month', dateField: 'paidOn' }, chart: 'line' }, names)).toBe(
      'Count · Donation · by Month · Line chart',
    );
    expect(widgetSummary({ type: 'list', label: 'Waiting', listView: 'donations', limit: 2, view: { owner: 'me' } }, names)).toBe('Donations · 2 rows · My own records');
    const rows = widgetRows(setWidgetPermission(page(), 2, 'record:donation:read'), names);
    expect(rows.map((r) => [r.id, r.title, r.badge?.label])).toEqual([
      ['0', 'Raised', 'Number'],
      ['1', 'Quick links', 'Links'],
      ['2', 'Record groups', 'Record groups'],
    ]);
    expect(rows[2]!.cells.find((c) => c.key === 'permission')!.value).toBe('record:donation:read');
  });

  it('a new widget previews from sample data once its record type is chosen', async () => {
    const mg = memoryGateway();
    const defs = await mg.auth.definitions();
    const p = setWidget(addWidget({ ...page(), widgets: [] }, 'stat'), 0, { recordType: 'donation' });
    const planned = planWidget(defs, p.key, p.widgets[0]!, 0);
    expect(planned).toMatchObject({ kind: 'stat', recordType: 'donation', request: { measure: 'count' } });
    if (!planned || planned.kind !== 'stat') throw new Error('expected a stat widget');
    expect(planned.request.widget).toBeUndefined();
    const result = await mg.pages.aggregate('donation', planned.request);
    expect('value' in result && result.value).toBeGreaterThan(0);
    expect(planWidget(defs, p.key, newWidget('stat'), 0)).toBeNull();
  });
});
