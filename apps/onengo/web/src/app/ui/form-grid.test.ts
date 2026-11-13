import { describe, expect, it } from 'vitest';
import { drawnColumns } from './form-grid';

describe('form columns', () => {
  it('draws the columns a list view or action asks for on wide screens, and one when it asks for none', () => {
    expect(drawnColumns(2, false)).toBe(2);
    expect(drawnColumns(3, false)).toBe(3);
    expect(drawnColumns(undefined, false)).toBe(1);
  });

  it('always draws one column on a phone, whatever the form asks for', () => {
    expect(drawnColumns(3, true)).toBe(1);
    expect(drawnColumns(2, true)).toBe(1);
    expect(drawnColumns(undefined, true)).toBe(1);
  });
});
