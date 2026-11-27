import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkOrder,
  dependencies,
  deriveOrder,
  isPeople,
  peopleOf,
  PEOPLE_TYPE,
  placeholders,
  renderTemplate,
  readSourceMapping,
  targetsOf,
  transformValue,
  type OrderedSource,
  type SourceMapping,
  type TypesByKey,
} from '../../../packages/platform/src/application/migration/mapping.js';
import type { RecordTypeDef } from '../../../packages/platform/src/runtime/definitions/types.js';
import { PRODUCT_ROOT } from '../../support/paths.js';

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

  it('accepts a mapping whose targets are all optional (e.g. a supplementary update file)', () => {
    const mapping = read({ targets: [{ key: 's', type: 'supporter', oldId: 'UserId', fields: { name: 'FullName' }, refs: {}, required: false }] });
    expect(mapping).toEqual({ targets: [{ key: 's', type: 'supporter', oldId: 'UserId', fields: { name: 'FullName' }, refs: {}, required: false }] });
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
    const schema = JSON.parse(readFileSync(join(PRODUCT_ROOT, 'schemas', 'recordType.schema.json'), 'utf8')) as { definitions: { key: { pattern: string } } };
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

describe('value transforms', () => {
  const guests = new Map<string, RecordTypeDef>([
    ['guest', type('guest', [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'gender', label: 'Gender', type: 'choice', choices: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }] },
      { key: 'member', label: 'Member', type: 'boolean' },
      { key: 'age', label: 'Age', type: 'number' },
    ])],
  ]);
  const cols = ['Id', 'Name', 'Sex', 'Member', 'Age'];
  const withTransforms = (transforms: unknown, fields: Record<string, string> = { name: 'Name', gender: 'Sex', member: 'Member', age: 'Age' }) => ({
    targets: [{ key: 'g', type: 'guest', oldId: 'Id', fields, transforms }],
  });
  const readGuests = (input: unknown) => readSourceMapping(input, cols, guests, ROLES);
  const problems = (input: unknown) => {
    try {
      readGuests(input);
    } catch (e) {
      return (e as { issues?: { path: string; message: string }[] }).issues ?? [];
    }
    throw new Error('The mapping was accepted.');
  };

    it('keeps rules for fields filled from a column, trimmed', () => {
      const m = readGuests(withTransforms({ gender: [{ from: ' M ', to: 'male' }, { from: 'F', to: 'female' }], member: [{ from: 'Y', to: 'yes' }], age: [{ from: 'old', to: '99' }], name: [] }));
      expect(targetsOf(m)[0]!.transforms).toEqual({ gender: [{ from: 'M', to: 'male' }, { from: 'F', to: 'female' }], member: [{ from: 'Y', to: 'yes' }], age: [{ from: 'old', to: '99' }] });
    });

    it('stores no transforms when none are sent, as older mappings are', () => {
      expect(targetsOf(readGuests(withTransforms(undefined)))[0]).not.toHaveProperty('transforms');
    });

      it('refuses a field no column fills, an unknown field, and duplicate or empty values', () => {
        expect(problems(withTransforms({ gender: [{ from: 'M', to: 'male' }] }, { name: 'Name' })).map((i) => i.path)).toEqual(['/targets/0/transforms/gender']);
        expect(problems(withTransforms({ nope: [] })).map((i) => i.path)).toEqual(['/targets/0/transforms/nope']);
        const bad = problems(withTransforms({ gender: [{ from: 'M', to: 'male' }, { from: ' m ', to: 'female' }, { from: '', to: 'x' }, { from: 'Q' }] }));
        expect(bad.map((i) => i.path)).toEqual(['/targets/0/transforms/gender/1/from', '/targets/0/transforms/gender/2/from', '/targets/0/transforms/gender/3/to']);
      });

      it('rewrites a cell by the first rule that names it, ignoring case and spaces, and leaves others as they are', () => {
        const rules = [{ from: 'M', to: 'Male' }, { from: 'F', to: 'Female' }];
        expect(transformValue(rules, 'm')).toBe('Male');
        expect(transformValue(rules, ' F ')).toBe('Female');
        expect(transformValue(rules, 'Other')).toBe('Other');
        expect(transformValue(rules, '')).toBe('');
        expect(transformValue(undefined, 'M')).toBe('M');
        expect(transformValue([{ from: 'N/A', to: '' }], 'n/a')).toBe('');
      });

      it('gives a value no rule names the default, an empty cell included, and a rule still wins', () => {
        expect(transformValue(undefined, '', 'Unknown')).toBe('Unknown');
        expect(transformValue([{ from: 'N/A', to: '' }], 'Other', 'Unknown')).toBe('Unknown');
        expect(transformValue([{ from: 'N/A', to: '' }], 'n/a', 'Unknown')).toBe('');
        expect(transformValue([], 'Asha', undefined)).toBe('Asha');
      });

        it('keeps a default for a field even if not filled from a column, trimmed, and refuses one that cannot take it', () => {
          const withDefaults = (defaults: unknown, fields: Record<string, string> = { name: 'Name', gender: 'Sex', member: 'Member', age: 'Age' }) => ({
            targets: [{ key: 'g', type: 'guest', oldId: 'Id', fields, defaults }],
          });
          expect(targetsOf(readGuests(withDefaults({ gender: ' male ', name: 'Anon', member: '  ', age: '25' })))[0]!.defaults).toEqual({ gender: 'male', name: 'Anon', age: '25' });
          expect(targetsOf(readGuests(withDefaults({ gender: 'male' }, { name: 'Name' })))[0]!.defaults).toEqual({ gender: 'male' });
          expect(targetsOf(readGuests(withDefaults({ gender: '  ' })))[0]).not.toHaveProperty('defaults');
          expect(targetsOf(readGuests(withDefaults(undefined)))[0]).not.toHaveProperty('defaults');
          expect(problems(withDefaults({ nope: 'x' })).map((i) => i.path)).toEqual(['/targets/0/defaults/nope']);
          expect(problems(withDefaults({ gender: 'Unknown' })).map((i) => i.path)).toEqual(['/targets/0/defaults/gender']);
          expect(problems(withDefaults({ name: 'x'.repeat(201) })).map((i) => i.path)).toEqual(['/targets/0/defaults/name']);
        });
      });

      describe('derived fields', () => {
        const people = new Map<string, RecordTypeDef>([
          ['person', type('person', [
            { key: 'fullName', label: 'Full name', type: 'text', required: true },
            { key: 'nickname', label: 'Nickname', type: 'text' },
            { key: 'age', label: 'Age', type: 'number' },
          ])],
        ]);
        const cols = ['Id', 'First name', 'Last name', 'Age'];
        const target = (extra: Record<string, unknown>) => ({ targets: [{ key: 'p', type: 'person', oldId: 'Id', fields: { age: 'Age' }, ...extra }] });
        const readPeople = (input: unknown) => readSourceMapping(input, cols, people, ROLES);
        const problems = (input: unknown) => {
          try {
            readPeople(input);
          } catch (e) {
            return (e as { issues?: { path: string; message: string }[] }).issues ?? [];
          }
          throw new Error('The mapping was accepted.');
        };

        it('keeps a template of the file columns for a text field, and counts as a mapped field', () => {
          const m = readPeople(target({ fields: {}, derived: { fullName: { template: '{First name} {Last name}', stray: 1 } } }));
          expect(targetsOf(m)[0]!.derived).toEqual({ fullName: { template: '{First name} {Last name}' } });
          expect(targetsOf(readPeople(target({}) as never))[0]).not.toHaveProperty('derived');
        });

        it('lets a column of the template also fill another field', () => {
          expect(() => readPeople(target({ fields: { age: 'First name' }, derived: { fullName: { template: '{First name} {Last name}' } } }))).not.toThrow();
        });

        it('refuses a number field, a field that also has a column, a template without columns, and a column the file lacks', () => {
          expect(problems(target({ derived: { age: { template: '{First name}' } } })).map((i) => i.path)).toContain('/targets/0/derived/age');
          expect(problems(target({ fields: { fullName: 'Last name' }, derived: { fullName: { template: '{First name}' } } })).map((i) => i.path)).toEqual(['/targets/0/derived/fullName']);
          expect(problems(target({ derived: { fullName: { template: 'no columns' } } })).map((i) => i.path)).toEqual(['/targets/0/derived/fullName/template']);
          expect(problems(target({ derived: { fullName: { template: '{First name} {Surname}' } } })).map((i) => i.path)).toEqual(['/targets/0/derived/fullName/template']);
        });

        it('names the columns of a template and builds the text from a row', () => {
          expect(placeholders('{First name} {Last name} ({First name})')).toEqual(['First name', 'Last name']);
          const row: Record<string, string> = { 'First name': ' Asha ', 'Last name': 'Rao' };
          const cell = (c: string) => row[c] ?? '';
          expect(renderTemplate('{First name} {Last name}', cell)).toBe('Asha Rao');
          expect(renderTemplate('{Last name}, {First name}', cell)).toBe('Rao, Asha');
          expect(renderTemplate('{First name} {Last name}', (c) => (c === 'Last name' ? '' : cell(c)))).toBe('Asha');
          expect(renderTemplate('{First name} {Last name}', () => '  ')).toBe('');
        });
      });

      describe('a file that holds people and records', () => {
        const cols = ['UserId', 'Email', 'FullName', 'Title'];
        const records = { targets: [{ key: 'd', type: 'donation', oldId: 'UserId', fields: { name: 'Title' }, persons: { owner: { column: 'UserId' } } }] };

        it('keeps the records and the people of one file side by side', () => {
          const m = read({ ...records, people: { ...PEOPLE, stray: 1 } }, cols);
          expect(isPeople(m)).toBe(false);
          expect(targetsOf(m)).toHaveLength(1);
          expect(peopleOf(m)).toEqual(PEOPLE);
          expect(peopleOf(read(records, cols))).toBeNull();
          expect(peopleOf(read({ kind: 'people', people: PEOPLE }, cols))).toEqual(PEOPLE);
        });

        it('names a problem of the people part with its own path', () => {
          expect(issues({ ...records, people: { ...PEOPLE, email: 'Nope' } }, cols).map((i) => i.path)).toEqual(['/people/email']);
          expect(issues({ ...records, people: { oldId: 'UserId', email: '', name: 'FullName' } }, cols).map((i) => i.path)).toEqual(['/people/email']);
        });

        it('writes people and records, and does not wait for the people it loads itself', () => {
          const both = { id: 'both', fileName: 'both.csv', mapping: read({ ...records, people: PEOPLE }, cols) };
          const other = { id: 'other', fileName: 'other.csv', mapping: read({ targets: [{ key: 'd', type: 'donation', oldId: 'UserId', fields: { name: 'Title' }, persons: { owner: { column: 'UserId' } } }] }, cols) };
          expect(dependencies([both, other], TYPES).get('both')).toEqual([]);
          expect(dependencies([both, other], TYPES).get('other')).toEqual(['both']);
          expect(deriveOrder([other, both], TYPES).map((f) => f.id)).toEqual(['both', 'other']);
        });
      });
