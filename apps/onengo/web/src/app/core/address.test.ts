import { describe, expect, it } from 'vitest';
import { depth, encode, flag, list, oneOf, range, roundDepth, sort, text } from './address';

const from = (p: Record<string, string>) => (name: string) => p[name] ?? null;

describe('address codecs', () => {
  it('text trims by default and treats empty as absent', () => {
    expect(text().read(from({ q: '  asha ' }), 'q')).toBe('asha');
    expect(text().read(from({ q: '   ' }), 'q')).toBeUndefined();
    expect(text({ trim: false }).read(from({ q: ' a ' }), 'q')).toBe(' a ');
    expect(text().read(from({}), 'q')).toBeUndefined();
    expect(text().write('q', '')).toEqual({ q: null });
    expect(text().write('q', 'x')).toEqual({ q: 'x' });
  });

  it('oneOf keeps only known values', () => {
    const view = oneOf(['cards', 'table'] as const);
    expect(view.read(from({ view: 'table' }), 'view')).toBe('table');
    expect(view.read(from({ view: 'grid' }), 'view')).toBeUndefined();
    expect(view.write('view', undefined)).toEqual({ view: null });
  });

  it('list splits, trims and limits to the allowed values', () => {
    expect(list(['upi', 'cash']).read(from({ m: 'upi, bogus ,cash,' }), 'm')).toEqual(['upi', 'cash']);
    expect(list(['upi']).read(from({ m: 'bogus' }), 'm')).toBeUndefined();
    expect(list().read(from({ m: 'a,b' }), 'm')).toEqual(['a', 'b']);
    expect(list().write('m', ['a', 'b'])).toEqual({ m: 'a,b' });
    expect(list().write('m', [])).toEqual({ m: null });
  });

  it('flag reads its on and off words; with no off word only on counts', () => {
    expect(flag().read(from({ f: 'true' }), 'f')).toBe(true);
    expect(flag().read(from({ f: 'false' }), 'f')).toBe(false);
    expect(flag().read(from({ f: 'yes' }), 'f')).toBeUndefined();
    expect(flag().write('f', false)).toEqual({ f: 'false' });
    const open = flag('open', null);
    expect(open.read(from({ filters: 'open' }), 'filters')).toBe(true);
    expect(open.read(from({ filters: 'false' }), 'filters')).toBeUndefined();
    expect(open.write('filters', false)).toEqual({ filters: null });
    expect(open.write('filters', true)).toEqual({ filters: 'open' });
  });

  it('range keeps each valid end on its own', () => {
    const n = range('number');
    expect(n.names('amount')).toEqual(['amountFrom', 'amountTo']);
    expect(n.read(from({ amountFrom: ' 100 ', amountTo: 'lots' }), 'amount')).toEqual({ from: '100' });
    expect(n.read(from({ amountTo: 'x' }), 'amount')).toBeUndefined();
    const d = range('date');
    expect(d.read(from({ onFrom: '2026-04-01', onTo: '2026-4-1' }), 'on')).toEqual({ from: '2026-04-01' });
    expect(d.write('on', { to: '2026-05-01' })).toEqual({ onFrom: null, onTo: '2026-05-01' });
  });

  it('sort reads a direction and allows only sortable fields', () => {
    const s = sort(['amount', 'createdAt']);
    expect(s.read(from({ sort: '-amount' }), 'sort')).toEqual({ field: 'amount', dir: 'desc' });
    expect(s.read(from({ sort: 'createdAt' }), 'sort')).toEqual({ field: 'createdAt', dir: 'asc' });
    expect(s.read(from({ sort: 'donorPan' }), 'sort')).toBeUndefined();
    expect(s.write('sort', { field: 'amount', dir: 'desc' })).toEqual({ sort: '-amount' });
  });

  it('depth rounds to whole pages within the cap and leaves the first page unwritten', () => {
    const show = depth(12, 500);
    expect(show.read(from({ show: '13' }), 'show')).toBe(24);
    expect(show.read(from({ show: '9999' }), 'show')).toBe(492);
    expect(show.read(from({ show: '-3' }), 'show')).toBeUndefined();
    expect(show.read(from({ show: '1.5' }), 'show')).toBeUndefined();
    expect(show.write('show', 12)).toEqual({ show: null });
    expect(show.write('show', 36)).toEqual({ show: '36' });
    expect(roundDepth(0, 20, 500)).toBe(20);
  });

  it('encodes values the same way everywhere', () => {
    expect([encode(undefined), encode(''), encode([]), encode(['a', 'b']), encode(false), encode(3)]).toEqual([null, null, null, 'a,b', 'false', '3']);
  });
});
