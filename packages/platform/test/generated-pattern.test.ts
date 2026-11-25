import { describe, expect, it } from 'vitest';
import { counterDigits, initialOf, parseGenerated, yymmOf } from '../src/shared/definitions/generated-pattern.js';

describe('generated field patterns', () => {
  it('parses the member ID pattern into its parts', () => {
    expect(parseGenerated('NM{yymm:joinedOn}{initial:firstName}{initial:lastName}{seq:3}')).toEqual([
      { kind: 'text', text: 'NM' },
      { kind: 'yymm', field: 'joinedOn' },
      { kind: 'initial', field: 'firstName' },
      { kind: 'initial', field: 'lastName' },
      { kind: 'seq', width: 3 },
    ]);
  });

  it('refuses a pattern without exactly one counter at the end', () => {
    expect(parseGenerated('NM{yymm:joinedOn}')).toBe('Use exactly one {seq:N} counter.');
    expect(parseGenerated('{seq:2}{seq:3}')).toBe('Use exactly one {seq:N} counter.');
    expect(parseGenerated('{seq:3}NM')).toBe('Put the {seq:N} counter at the end.');
  });

  it('refuses unknown tokens, odd characters and widths out of range', () => {
    expect(typeof parseGenerated('NM{rand:3}')).toBe('string');
    expect(typeof parseGenerated('NM/{seq:3}')).toBe('string');
    expect(typeof parseGenerated('{seq:0}')).toBe('string');
    expect(typeof parseGenerated('{seq:7}')).toBe('string');
  });

  it('reads YYMM from an ISO date and initials from names', () => {
    expect(yymmOf('2026-11-23')).toBe('2611');
    expect(yymmOf('23/11/2026')).toBeNull();
    expect(yymmOf(undefined)).toBeNull();
    expect(initialOf('  asha')).toBe('A');
    expect(initialOf('')).toBe('X');
    expect(initialOf('अमित')).toBe('X');
  });

  it('counts 001, 002, 003 under a prefix, and widens past the width', () => {
    expect([1, 2, 3, 10, 999].map((n) => counterDigits(n, 3))).toEqual(['001', '002', '003', '010', '999']);
    expect(counterDigits(1000, 3)).toBe('1000');
    expect(counterDigits(1001, 3)).toBe('1001');
    const seen = new Set<string>();
    for (let n = 1; n <= 1200; n++) seen.add(counterDigits(n, 3));
    expect(seen.size).toBe(1200);
  });
});
