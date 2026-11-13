import { describe, expect, it } from 'vitest';
import { contrast, draftPairs, luminance, themePairs } from './contrast';
import { cronText } from './cron-text';
import { previewRecordGroups } from './record-groups';

const text = (cron: string) => {
  const r = cronText(cron);
  return r.ok ? r.text : `error: ${r.error}`;
};

describe('cron in plain words', () => {
  it('reads the common schedules', () => {
    expect(text('0 9 * * *')).toBe('At 09:00, every day (UTC)');
    expect(text('30 6 1 * *')).toBe('At 06:30, on day 1 of the month (UTC)');
    expect(text('0 9 * * 1')).toBe('At 09:00, on Monday (UTC)');
    expect(text('0 9 * * 1-5')).toBe('At 09:00, Monday to Friday (UTC)');
    expect(text('0 9 * * 0,6')).toBe('At 09:00, on Sunday and Saturday (UTC)');
    expect(text('*/15 * * * *')).toBe('Every 15 minutes, every day (UTC)');
    expect(text('* * * * *')).toBe('Every minute, every day (UTC)');
    expect(text('5 * * * *')).toBe('At 5 minutes past every hour, every day (UTC)');
    expect(text('0 */2 * * *')).toBe('Every 2 hours, at 0 minutes past, every day (UTC)');
    expect(text('0 9-17 * * 1-5')).toBe('At 0 minutes past each hour from 09:00 to 17:00, Monday to Friday (UTC)');
    expect(text('0,30 9,18 * * *')).toBe('At 09:00, 09:30, 18:00 and 18:30, every day (UTC)');
    expect(text('0 8 1,15 1,7 *')).toBe('At 08:00, on day 1 and 15 of the month, in January and July (UTC)');
  });

  it('reads both day fields as either, as the server runs them', () => {
    expect(text('0 9 1 * 1')).toBe('At 09:00, on day 1 of the month or on Monday (UTC)');
  });

  it('falls back to minutes and hours when there are too many times to list', () => {
    expect(text('0,20,40 1,2,3 * * *')).toBe('At minutes 0, 20 and 40 past hours 1, 2 and 3, every day (UTC)');
    expect(text('10,20 * * * *')).toBe('At minutes 10 and 20 past every hour, every day (UTC)');
    expect(text('* 9 * * *')).toBe('Every minute of hour 9, every day (UTC)');
  });

  it('explains what is wrong, with the server ranges', () => {
    expect(text('0 9 * *')).toMatch(/^error: A schedule has five parts/);
    expect(text('0 24 * * *')).toBe('error: Part 2 (24) is not valid; use numbers from 0 to 23, *, lists, ranges or steps.');
    expect(text('0 9 * * 7')).toMatch(/^error: Part 5 \(7\)/);
    expect(text('*/0 * * * *')).toMatch(/^error: Part 1/);
    expect(text('0 9 * * MON')).toMatch(/^error: Part 5/);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios and levels', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('#000')).toBe(0);
    expect(contrast('#000000', '#ffffff')).toEqual({ ratio: 21, level: 'AAA' });
    expect(contrast('#ffffff', '#1f5f8b')).toEqual({ ratio: 6.8, level: 'AA' });
    expect(contrast('#767676', '#ffffff')).toEqual({ ratio: 4.5, level: 'AA' });
    expect(contrast('#949494', '#ffffff')).toEqual({ ratio: 3, level: 'large' });
    expect(contrast('#ffff00', '#ffffff')?.level).toBe('fail');
    expect(contrast('blue', '#ffffff')).toBeNull();
  });

  it('checks the pairs the app draws, with the stylesheet colours for missing tokens', () => {
    const pairs = themePairs({ brand: '#ffcc00' });
    expect(pairs.map((p) => p.id)).toEqual(['brandForegroundOnBrand', 'textOnBackground', 'textOnSurface', 'mutedOnSurface', 'brandOnSurface']);
    expect(pairs[0]).toMatchObject({ foreground: '#ffffff', background: '#ffcc00', contrast: { level: 'fail' } });
    expect(pairs[1]!.contrast!.level).toBe('AAA');
    expect(themePairs({ text: 'oops' })[1]!.contrast).toBeNull();
    expect(draftPairs({ brand: '' })[0]).toMatchObject({ foreground: '', background: '', contrast: null });
  });
});

describe('record groups preview', () => {
  const types = [
    { key: 'donor', label: 'Donors' },
    { key: 'donation', label: 'Donations' },
    { key: 'visit', label: 'Visits' },
    { key: 'volunteer', label: 'Volunteers' },
  ];
  const published = [
    { key: 'fundraising', label: 'Fundraising', order: 1, recordTypes: ['donor', 'donation'] },
    { key: 'programmes', label: 'Programmes', order: 2, recordTypes: ['visit'] },
  ];

  it('puts the draft in its place, each record type in the first group, and the rest under Other', () => {
    const g = previewRecordGroups(published, { key: 'programmes', label: 'Field work', order: 0, recordTypes: ['visit', 'donor'] }, types);
    expect(g.map((x) => [x.label, x.current, x.recordTypes.map((r) => r.label)])).toEqual([
      ['Field work', true, ['Visits', 'Donors']],
      ['Fundraising', false, ['Donations']],
      ['Other', false, ['Volunteers']],
    ]);
  });

  it('notes record types of the draft that show in an earlier group', () => {
    const g = previewRecordGroups(published, { key: 'ops', label: 'Operations', recordTypes: ['donor', 'volunteer'] }, types);
    const ops = g.find((x) => x.current)!;
    expect(ops.recordTypes.map((r) => r.key)).toEqual(['volunteer']);
    expect(ops.shownElsewhere).toEqual([{ key: 'donor', label: 'Donors', group: 'Fundraising' }]);
    expect(g.map((x) => x.key)).toEqual(['fundraising', 'programmes', 'ops']);
  });

  it('keeps an empty or half-written draft visible', () => {
    const g = previewRecordGroups([], { key: 'new' }, types);
    expect(g[0]).toMatchObject({ key: 'new', label: 'new', current: true, recordTypes: [] });
    expect(g[1]!.recordTypes).toHaveLength(4);
  });
});
