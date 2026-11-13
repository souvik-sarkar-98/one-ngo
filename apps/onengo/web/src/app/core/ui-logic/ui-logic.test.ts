import { describe, expect, it } from 'vitest';
import { badgeText, initials, opensInPlace } from '@onengo/web-kit';
import { AutocompleteSession, listSource, type Suggestion, type SuggestionSource, type Timers } from './autocomplete';
import { axisTicks, chartGeometry, niceCeil } from './chart';
import { dropIndex, keyMove, moveItem } from './reorder';

describe('editable table reordering', () => {
  it('moves one item and leaves the input alone', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(list, 1, 9)).toEqual(list);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops before or after the row under the pointer', () => {
    expect(dropIndex(0, 2, false)).toBe(1);
    expect(dropIndex(0, 2, true)).toBe(2);
    expect(dropIndex(3, 1, false)).toBe(1);
    expect(dropIndex(3, 1, true)).toBe(2);
    expect(moveItem(['a', 'b', 'c', 'd'], 0, dropIndex(0, 3, true))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves with Alt and the arrow, Home and End keys only', () => {
    expect(keyMove('ArrowUp', true, 2, 4)).toBe(1);
    expect(keyMove('ArrowDown', true, 2, 4)).toBe(3);
    expect(keyMove('Home', true, 2, 4)).toBe(0);
    expect(keyMove('End', true, 2, 4)).toBe(3);
    expect(keyMove('ArrowDown', true, 3, 4)).toBeNull();
    expect(keyMove('ArrowUp', true, 0, 4)).toBeNull();
    expect(keyMove('ArrowUp', false, 2, 4)).toBeNull();
    expect(keyMove('x', true, 2, 4)).toBeNull();
  });
});

describe('chart scales', () => {
  it('rounds the axis up to 1, 2, 2.5 or 5 times a power of ten', () => {
    expect([0, 0.7, 1, 3, 7, 21, 240, 999].map(niceCeil)).toEqual([1, 1, 1, 5, 10, 25, 250, 1000]);
    expect(axisTicks(0)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(axisTicks(37)).toEqual([0, 10, 20, 30, 40]);
    expect(axisTicks(120000)).toEqual([0, 50000, 100000, 150000]);
  });

  it('places bars and the line inside the box', () => {
    const g = chartGeometry(
      [
        { key: 'apr', label: 'Apr', value: 10 },
        { key: 'may', label: 'May', value: 20 },
        { key: 'jun', label: 'Jun', value: -5 },
      ],
      { width: 330, height: 120, left: 30, bottom: 20 },
    );
    expect(g.baseline).toBe(100);
    expect(g.ticks.map((t) => t.value)).toEqual([0, 5, 10, 15, 20]);
    expect(g.ticks[0]!.y).toBe(100);
    expect(g.ticks.at(-1)!.y).toBe(0);
    expect(g.bars.map((b) => [b.x, b.width, b.y, b.height])).toEqual([
      [50, 60, 50, 50],
      [150, 60, 0, 100],
      [250, 60, 100, 0],
    ]);
    expect(g.line).toBe('M80 50 L180 0 L280 100');
  });

  it('draws nothing for no buckets', () => {
    const g = chartGeometry([], { width: 100, height: 50, left: 10, bottom: 10 });
    expect(g.bars).toEqual([]);
    expect(g.line).toBe('');
  });
});

describe('links and badges', () => {
  const click = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  it('leaves modified and middle clicks to the browser', () => {
    expect(opensInPlace(click)).toBe(true);
    expect(opensInPlace({ ...click, ctrlKey: true })).toBe(false);
    expect(opensInPlace({ ...click, metaKey: true })).toBe(false);
    expect(opensInPlace({ ...click, button: 1 })).toBe(false);
  });

  it('caps badge counts and hides zero', () => {
    expect([0, -1, undefined, 4, 99, 100].map(badgeText)).toEqual(['', '', '', '4', '99', '99+']);
  });

  it('takes initials from a name or an address', () => {
    expect(initials('Asha Sharma')).toBe('AS');
    expect(initials('ravi.kumar@example.org')).toBe('RK');
    expect(initials('')).toBe('');
  });
});

function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers: Timers = {
    set: (fn) => {
      pending.set(next, fn);
      return next++;
    },
    clear: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    get count() {
      return pending.size;
    },
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const donors: Suggestion[] = [
  { id: 'd1', label: 'Asha Sharma', hint: 'DNR-001' },
  { id: 'd2', label: 'Ravi Kumar', hint: 'DNR-002' },
  { id: 'd3', label: 'Kumari Devi', hint: 'DNR-003' },
];

describe('autocomplete', () => {
  it('matches a fixed list, prefix matches first', async () => {
    const s = listSource(donors);
    expect((await s.search('kum')).map((d) => d.id)).toEqual(['d3', 'd2']);
    expect((await s.search('dnr-002')).map((d) => d.id)).toEqual(['d2']);
    expect(await s.search('')).toEqual(donors);
  });

  it('searches once typing stops and drops older answers', async () => {
    const t = manualTimers();
    const asked: string[] = [];
    let release: (v: Suggestion[]) => void = () => {};
    const source: SuggestionSource = {
      search: (text) => {
        asked.push(text);
        return text === 'as' ? new Promise((r) => (release = r)) : Promise.resolve(donors.slice(1));
      },
    };
    const s = new AutocompleteSession(source, 300, t.timers);
    s.input('a');
    s.input('as');
    expect(t.count).toBe(1);
    t.flush();
    expect(asked).toEqual(['as']);
    s.input('ra');
    t.flush();
    await tick();
    expect(s.snapshot.options.map((o) => o.id)).toEqual(['d2', 'd3']);
    release([donors[0]!]);
    await tick();
    expect(s.snapshot.options.map((o) => o.id)).toEqual(['d2', 'd3']);
    expect(s.snapshot).toMatchObject({ open: true, loading: false, active: 0 });
  });

  it('moves with the arrow keys, chooses with Enter and closes with Escape', async () => {
    const t = manualTimers();
    const s = new AutocompleteSession(listSource(donors), 300, t.timers);
    s.focus();
    expect(t.count).toBe(0);
    await tick();
    expect(s.snapshot.options).toHaveLength(3);
    s.key('ArrowDown');
    s.key('ArrowDown');
    expect(s.snapshot.active).toBe(2);
    s.key('ArrowDown');
    expect(s.snapshot.active).toBe(0);
    s.key('ArrowUp');
    expect(s.snapshot.active).toBe(2);
    s.key('Home');
    expect(s.snapshot.active).toBe(0);
    const out = s.key('Enter');
    expect(out).toEqual({ handled: true, chosen: donors[0] });
    expect(s.snapshot).toMatchObject({ text: 'Asha Sharma', open: false });
    expect(s.key('Escape')).toEqual({ handled: false });
    s.key('ArrowDown');
    await tick();
    expect(s.snapshot.open).toBe(true);
    expect(s.key('Escape')).toEqual({ handled: true });
    expect(s.snapshot.open).toBe(false);
  });

  it('waits for enough characters and reports failures', async () => {
    const t = manualTimers();
    const s = new AutocompleteSession({ minLength: 2, search: () => Promise.reject(new Error('offline')) }, 300, t.timers);
    s.input('a');
    expect(t.count).toBe(0);
    expect(s.snapshot.loading).toBe(false);
    s.input('as');
    t.flush();
    await tick();
    expect(s.snapshot).toMatchObject({ error: true, loading: false, options: [] });
  });
});
