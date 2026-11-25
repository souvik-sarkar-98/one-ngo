import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkOrder,
  dependencies,
  deriveOrder,
  isPeople,
  PEOPLE_TYPE,
  readSourceMapping,
  targetsOf,
  type OrderedSource,
  type SourceMapping,
  type TypesByKey,
} from '../src/application/migration/mapping.js';
import type { RecordTypeDef } from '../src/runtime/definitions/types.js';

const type = (key: string, fields: Record<string, unknown>[]) => ({ key, label: key, fields }) as unknown as RecordTypeDef;
const TYPES: TypesByKey = new Map([
  ['supporter', type('supporter', [{ key: 'name', label: 'Name', type: 'text', required: true }])],
  ['pledge', type('pledge', [
    { key: 'supporter', label: 'Supporter', type: 'reference', referenceType: 'supporter', required: true },
    { key: 'amount', label: 'Amount', type: 'money' },
  ])],
  ['donation', type('donation', [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'owner', label: 'Owner', type: 'person', required: true },
    { key: 'note', label: 'Note', type: 'text' },
  ])],
]);
const COLUMNS = ['UserId', 'Email', 'FullName', 'Roles', 'Active', 'Lang'];
const ROLES = ['admin', 'front-desk', 'volunteer'];
const read = (input: unknown, columns = COLUMNS) => readSourceMapping(input, columns, TYPES, ROLES);
const PEOPLE = { oldId: 'UserId', email: 'Email', name: 'FullName' };

function issues(input: unknown, columns = COLUMNS) {
  try {
    read(input, columns);
  } catch (e) {
    return (e as { issues?: { path: string; message: string }[] }).issues ?? [];
  }
  throw new Error('The mapping was accepted.');
}

describe('people mapping', () => {
  it('reads the shape of plan 3.4 and stores only what it knows', () => {
    const mapping = read({
      kind: 'people',
      ignored: true,
      people: {
        ...PEOPLE,
        roles: { column: 'Roles', separator: ';', map: { Admin: 'admin', Clerk: 'front-desk', Guest: null }, stray: 1 },
        status: { column: 'Active', active: ['1', ' yes '], suspended: ['0', 'no'] },
        locale: 'Lang',
      },
    });
    expect(mapping).toEqual({
      kind: 'people',
      people: {
        ...PEOPLE,
        roles: { column: 'Roles', separator: ';', map: { Admin: 'admin', Clerk: 'front-desk', Guest: null } },
        status: { column: 'Active', active: ['1', 'yes'], suspended: ['0', 'no'] },
        locale: 'Lang',
      },
    });
    expect(isPeople(mapping)).toBe(true);
    expect(targetsOf(mapping)).toEqual([]);
  });

  it('needs only the legacy id, email and name, and everyone is then active with no roles', () => {
    expect(read({ kind: 'people', people: PEOPLE })).toEqual({ kind: 'people', people: PEOPLE });
  });

  it('accepts a fixed role list for everyone', () => {
    expect(read({ kind: 'people', people: { ...PEOPLE, roles: { fixed: ['volunteer', 'volunteer', 'admin'] } } })).toMatchObject({
      people: { roles: { fixed: ['volunteer', 'admin'] } },
    });
  });

  it('names every problem with a path, including one entry of a role map', () => {
    expect(
      issues({
        kind: 'people',
        people: {
          oldId: 'Nope',
          email: 'UserId',
          name: 'UserId',
          roles: { column: 'Roles', separator: '/', map: { Admin: 'owner', Clerk: 'front-desk', Guest: 7 } },
          status: { column: 'Active', active: ['1', 'Yes'], suspended: ['yes'] },
          locale: 'Missing',
        },
      }),
    ).toEqual([
      { path: '/people/oldId', message: "the file has no column 'Nope'" },
      { path: '/people/name', message: "column 'UserId' already holds the email" },
      { path: '/people/roles/separator', message: 'must be one of ; , |' },
      { path: '/people/roles/map/Admin', message: "'owner' is not a role" },
      { path: '/people/roles/map/Guest', message: 'choose a role, or null to ignore it' },
      { path: '/people/status/suspended', message: 'a value cannot mean both active and suspended' },
      { path: '/people/locale', message: "the file has no column 'Missing'" },
    ]);
  });

  it('asks for columns that are missing or blank', () => {
    expect(issues({ kind: 'people', people: { oldId: '', email: 'Email' } })).toEqual([
      { path: '/people/oldId', message: 'choose a column' },
      { path: '/people/name', message: 'choose a column' },
    ]);
    expect(issues({ kind: 'people' })).toEqual([{ path: '/people', message: 'must be an object' }]);
  });

  it('refuses unknown fixed roles, two ways to give roles, and empty or one-sided status lists', () => {
    expect(issues({ kind: 'people', people: { ...PEOPLE, roles: { fixed: ['admin', 'owner'] } } })).toEqual([{ path: '/people/roles/fixed/1', message: "'owner' is not a role" }]);
    expect(issues({ kind: 'people', people: { ...PEOPLE, roles: { fixed: ['admin'], column: 'Roles' } } })).toEqual([{ path: '/people/roles', message: "use either 'column' or 'fixed', not both" }]);
    expect(issues({ kind: 'people', people: { ...PEOPLE, status: { column: 'Active', active: [], suspended: ['0'] } } })).toEqual([
      { path: '/people/status/active', message: 'list at least one value' },
    ]);
  });

  it('refuses a kind it does not know', () => {
    expect(issues({ kind: 'groups', people: PEOPLE })).toEqual([{ path: '/kind', message: "must be 'records' or 'people'" }]);
  });
});

describe('kind dispatch', () => {
  const RECORDS = { targets: [{ key: 's', type: 'supporter', oldId: 'UserId', fields: { name: 'FullName' } }] };

  it('reads a mapping without a kind, as old rows are, as records', () => {
    const mapping = read(RECORDS);
    expect(isPeople(mapping)).toBe(false);
    expect(mapping).toEqual({ targets: [{ key: 's', type: 'supporter', oldId: 'UserId', fields: { name: 'FullName' }, refs: {}, required: true }] });
    expect(targetsOf(mapping)).toHaveLength(1);
    expect(read({ kind: 'records', ...RECORDS })).toEqual(mapping);
  });

  it('keeps the records rules and paths', () => {
    expect(issues({ ...RECORDS, targets: [{ ...RECORDS.targets[0]!, type: 'nothing' }] })).toEqual([{ path: '/targets/0/type', message: "'nothing' is not a record type" }]);
    expect(issues({})).toEqual([{ path: '/targets', message: 'must be a list' }]);
  });
});

describe('@people ordering', () => {
  const people: SourceMapping = { kind: 'people', people: PEOPLE };
  const records = (key: string, type: string, refs: Record<string, { column: string }> = {}): SourceMapping => ({
    targets: [{ key, type, oldId: 'Id', fields: {}, refs, required: true }],
  });
  const file = (id: string, mapping: SourceMapping | null): OrderedSource => ({ id, fileName: `${id}.csv`, mapping });

  it('writes a pseudo type that cannot be a record type key', () => {
    expect(PEOPLE_TYPE).toBe('@people');
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../product/schemas/recordType.schema.json'), 'utf8')) as { definitions: { key: { pattern: string } } };
    expect(new RegExp(schema.definitions.key.pattern).test(PEOPLE_TYPE)).toBe(false);
    expect(TYPES.has(PEOPLE_TYPE)).toBe(false);
  });

  it('puts a people file in the order without making any file wait for it yet', () => {
    const files = [file('gifts', records('pledge', 'pledge', { supporter: { column: 'S' } })), file('people', people), file('supporters', records('supporter', 'supporter'))];
    expect(dependencies(files, TYPES).get('people')).toEqual([]);
    expect(dependencies(files, TYPES).get('gifts')).toEqual(['supporters']);
    expect(deriveOrder(files, TYPES).map((f) => f.id)).toEqual(['people', 'supporters', 'gifts']);
    expect(() => checkOrder(files, TYPES)).toThrow(/order that cannot run/);
    expect(() => checkOrder([files[1]!, files[2]!, files[0]!], TYPES)).not.toThrow();
  });

  it('keeps a hand order that has the people file first, and one with it later when nothing needs it', () => {
    const order = [file('people', people), file('supporters', records('supporter', 'supporter'))];
    expect(deriveOrder(order, TYPES).map((f) => f.id)).toEqual(['people', 'supporters']);
    expect(() => checkOrder([...order].reverse(), TYPES)).not.toThrow();
  });

  it('leaves a file without a mapping where it is', () => {
    const files = [file('raw', null), file('people', people)];
    expect(deriveOrder(files, TYPES).map((f) => f.id)).toEqual(['raw', 'people']);
  });
});

describe('persons mapping', () => {
  const COLS = ['Id', 'Title', 'OwnerId', 'Other'];
  const target = (extra: Record<string, unknown>) => ({ targets: [{ key: 'd', type: 'donation', oldId: 'Id', fields: { name: 'Title' }, ...extra }] });
  const targetOf = (m: SourceMapping) => targetsOf(m)[0]!;

  it('reads a person field filled by legacy user id, with onMissing; a required person field may stay unmapped', () => {
    expect(targetOf(read(target({ persons: { owner: { column: 'OwnerId' } } }), COLS)).persons).toEqual({ owner: { column: 'OwnerId' } });
    expect(targetOf(read(target({ persons: { owner: { column: 'OwnerId', onMissing: 'fail' } } }), COLS)).persons).toEqual({ owner: { column: 'OwnerId', onMissing: 'fail' } });
    // Without persons the required person field may stay unmapped: a later file can fill it, and a new row without it fails in the check. Old mappings have no persons.
    expect(() => read(target({}), COLS)).not.toThrow();
    expect(targetOf(read({ targets: [{ key: 's', type: 'supporter', oldId: 'Id', fields: { name: 'Title' } }] }, COLS)).persons).toBeUndefined();
  });

  it('names every problem with a path', () => {
    expect(issues(target({ persons: { nothing: { column: 'OwnerId' } } }), COLS).map((i) => i.path)).toContain('/targets/0/persons/nothing');
    expect(issues(target({ persons: { note: { column: 'OwnerId' }, owner: { column: 'OwnerId' } } }), COLS)).toEqual([{ path: '/targets/0/persons/note', message: "'note' is not a person field of donation" }]);
    expect(issues(target({ persons: { owner: { column: 'Missing' } } }), COLS)).toEqual([{ path: '/targets/0/persons/owner/column', message: "the file has no column 'Missing'" }]);
    expect(issues(target({ persons: { owner: {} } }), COLS)).toEqual([{ path: '/targets/0/persons/owner/column', message: 'choose a column' }]);
    expect(issues(target({ persons: { owner: { column: 'OwnerId', onMissing: 'skip' } } }), COLS)).toEqual([{ path: '/targets/0/persons/owner/onMissing', message: "must be 'blank' or 'fail'" }]);
  });

  it('refuses a person field that is also in fields or refs', () => {
    expect(issues(target({ fields: { name: 'Title', owner: 'Other' }, persons: { owner: { column: 'OwnerId' } } }), COLS)).toEqual([
      { path: '/targets/0/persons/owner', message: "'Owner' is already filled from a column" },
    ]);
  });

  it('lets one column fill a person field and a text field, since persons do not use the column', () => {
    const m = read(target({ fields: { name: 'Title', note: 'OwnerId' }, persons: { owner: { column: 'OwnerId' } } }), COLS);
    expect(targetOf(m)).toMatchObject({ fields: { name: 'Title', note: 'OwnerId' }, persons: { owner: { column: 'OwnerId' } } });
  });

  it('orders a file with persons after the people file, and refuses a hand order that puts it first', () => {
    const people: SourceMapping = { kind: 'people', people: PEOPLE };
    const donations = read(target({ persons: { owner: { column: 'OwnerId' } } }), COLS);
    const files: OrderedSource[] = [
      { id: 'donations', fileName: 'donations.csv', mapping: donations },
      { id: 'people', fileName: 'people.csv', mapping: people },
    ];
    expect(dependencies(files, TYPES).get('donations')).toEqual(['people']);
    expect(dependencies(files, TYPES).get('people')).toEqual([]);
    expect(deriveOrder(files, TYPES).map((f) => f.id)).toEqual(['people', 'donations']);
    expect(() => checkOrder(files, TYPES)).toThrow(/order that cannot run/);
    expect(() => checkOrder([files[1]!, files[0]!], TYPES)).not.toThrow();
    // Without a person column nothing waits for the people file.
    expect(dependencies([{ ...files[0]!, mapping: read(target({ fields: { name: 'Title', owner: 'OwnerId' } }), COLS) }, files[1]!], TYPES).get('donations')).toEqual([]);
  });
});
