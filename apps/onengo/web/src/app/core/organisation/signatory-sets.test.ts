import { describe, expect, it } from 'vitest';
import { SIGNATORIES_PER_DOCUMENT, movedSignatory, notInSet, withSignatory, withoutSignatory } from './signatory-sets';

describe('signatory sets', () => {
  it('adds a signatory once, at the end, up to the limit', () => {
    expect(withSignatory(['a'], 'b')).toEqual(['a', 'b']);
    expect(withSignatory(['a'], 'a')).toEqual(['a']);
    expect(withSignatory(['a'], '')).toEqual(['a']);
    const full = Array.from({ length: SIGNATORIES_PER_DOCUMENT }, (_, i) => `s${i}`);
    expect(withSignatory(full, 'extra')).toEqual(full);
  });

  it('removes and moves by position, and does not move past either end', () => {
    expect(withoutSignatory(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(movedSignatory(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(movedSignatory(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(movedSignatory(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(movedSignatory(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('lists only the people not already in the set', () => {
    const people = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    expect(notInSet(people, ['a'])).toEqual([{ id: 'b', name: 'B' }]);
  });
});
