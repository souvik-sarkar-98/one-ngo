import { describe, expect, it } from 'vitest';
import { readSourceMapping, stateOf, targetsOf, type TypesByKey } from '../src/application/migration/mapping.js';
import type { RecordTypeDef } from '../src/runtime/definitions/types.js';

/** Legacy dates and the status a record is created in: the mapping side, without a database. */

const type = (key: string, fields: Record<string, unknown>[]) => ({ key, label: key, fields }) as unknown as RecordTypeDef;
const TYPES: TypesByKey = new Map([
  ['gift', type('gift', [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'note', label: 'Note', type: 'text' },
  ])],
]);
const STATES = new Map([['gift', ['open', 'paid', 'cancelled']]]);
const COLUMNS = ['Code', 'Title', 'Status', 'Created', 'Updated'];
const read = (input: unknown, stateKeys = STATES) => readSourceMapping(input, COLUMNS, TYPES, [], stateKeys);
const base = { key: 'g', type: 'gift', oldId: 'Code', fields: { name: 'Title' } };

function issuesOf(input: unknown, stateKeys = STATES): { path: string; message: string }[] {
  try {
    read(input, stateKeys);
  } catch (e) {
    return (e as { issues?: { path: string; message: string }[] }).issues ?? [];
  }
  throw new Error('The mapping was accepted.');
}

describe('legacy dates', () => {
  it('keeps the columns of the created and updated dates', () => {
    const m = read({ targets: [{ ...base, dates: { createdAt: 'Created', updatedAt: 'Updated' } }] });
    expect(targetsOf(m)[0]!.dates).toEqual({ createdAt: 'Created', updatedAt: 'Updated' });
  });

  it('a date column may also fill a field, so it is not counted as used', () => {
    const m = read({ targets: [{ ...base, fields: { name: 'Title', note: 'Created' }, dates: { createdAt: 'Created' } }] });
    expect(targetsOf(m)[0]!.dates).toEqual({ createdAt: 'Created' });
    expect(targetsOf(m)[0]!.fields).toEqual({ name: 'Title', note: 'Created' });
  });

  it('refuses a date column the file does not have', () => {
    expect(issuesOf({ targets: [{ ...base, dates: { createdAt: 'Nope' } }] })).toEqual([
      expect.objectContaining({ path: '/targets/0/dates/createdAt', message: "the file has no column 'Nope'" }),
    ]);
  });

  it('a mapping without dates is read as before', () => {
    const m = read({ targets: [base] });
    expect(targetsOf(m)[0]).not.toHaveProperty('dates');
  });
});

describe('legacy status', () => {
  const state = { column: 'Status', map: { Open: 'open', Cancelled: 'cancelled' } };

  it('keeps the column and the value map', () => {
    const m = read({ targets: [{ ...base, state }] });
    expect(targetsOf(m)[0]!.state).toEqual(state);
  });

  it('refuses a value that is not a status of the primary workflow', () => {
    expect(issuesOf({ targets: [{ ...base, state: { column: 'Status', map: { Lost: 'lost' } } }] })).toEqual([
      expect.objectContaining({ path: '/targets/0/state/map/Lost', message: "'lost' is not a status of gift" }),
    ]);
  });

  it('refuses a status for a record type that has no workflow', () => {
    expect(issuesOf({ targets: [{ ...base, state }] }, new Map())).toEqual([
      expect.objectContaining({ path: '/targets/0/state', message: 'gift has no workflow to take a status from' }),
    ]);
  });

  it('refuses a status column the file does not have', () => {
    expect(issuesOf({ targets: [{ ...base, state: { column: 'Nope', map: { Open: 'open' } } }] })).toEqual([
      expect.objectContaining({ path: '/targets/0/state/column', message: "the file has no column 'Nope'" }),
    ]);
  });

  it('refuses a value mapped twice, ignoring case', () => {
    expect(issuesOf({ targets: [{ ...base, state: { column: 'Status', map: { Open: 'open', OPEN: 'paid' } } }] })).toEqual([
      expect.objectContaining({ path: '/targets/0/state/map/OPEN', message: "'OPEN' is mapped twice" }),
    ]);
  });

  it('refuses a mapping with no values', () => {
    expect(issuesOf({ targets: [{ ...base, state: { column: 'Status', map: {} } }] })).toEqual([
      expect.objectContaining({ path: '/targets/0/state/map', message: 'map at least one value' }),
    ]);
  });

  it('a status column may also fill a field', () => {
    const m = read({ targets: [{ ...base, fields: { name: 'Title', note: 'Status' }, state }] });
    expect(targetsOf(m)[0]!.fields).toEqual({ name: 'Title', note: 'Status' });
  });

  it('matches a cell to its state ignoring case and spaces', () => {
    expect(stateOf({ Open: 'open', Cancelled: 'cancelled' }, '  cancelled ')).toBe('cancelled');
    expect(stateOf({ Open: 'open' }, 'Lost')).toBeUndefined();
  });
});
