import { describe, expect, it } from 'vitest';
import { PlatformError } from '@onengo/kernel/errors';
import { checkOrder, deriveOrder, readMapping, type OrderedSource, type SourceMapping } from '../src/application/migration/mapping.js';
import type { RecordTypeDef } from '../src/runtime/definitions/types.js';

const donor = {
  key: 'donor',
  label: 'Donor',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'total', label: 'Total', type: 'money', rollup: { recordType: 'donation', reference: 'donor', measure: 'sum', field: 'amount' } },
    { key: 'photo', label: 'Photo', type: 'file' },
  ],
} as RecordTypeDef;
const donation = {
  key: 'donation',
  label: 'Donation',
  fields: [
    { key: 'donor', label: 'Donor', type: 'reference', referenceType: 'donor', required: true },
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'note', label: 'Note', type: 'text', visibleWhen: 'amount > 0', required: true },
  ],
} as RecordTypeDef;
const types = new Map([
  ['donor', donor],
  ['donation', donation],
]);

function issuesOf(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PlatformError);
    return (e as PlatformError).issues;
  }
  throw new Error('expected a validation failure');
}

describe('a file mapping', () => {
  const columns = ['DonorId', 'Full Name', 'Email', 'TxnNo', 'Amount', 'InternalCode'];

  it('fills two record types from one row, the second pointing at the first', () => {
    const mapping = readMapping(
      {
        targets: [
          { key: 'donor', type: 'donor', oldId: 'DonorId', fields: { name: 'Full Name', email: 'Email' } },
          { key: 'gift', type: 'donation', oldId: 'TxnNo', fields: { amount: 'Amount' }, refs: { donor: { target: 'donor' } }, required: false },
        ],
      },
      columns,
      types,
    );
    expect(mapping).toEqual({
      targets: [
        { key: 'donor', type: 'donor', oldId: 'DonorId', fields: { name: 'Full Name', email: 'Email' }, refs: {}, required: true },
        { key: 'gift', type: 'donation', oldId: 'TxnNo', fields: { amount: 'Amount' }, refs: { donor: { target: 'donor' } }, required: false },
      ],
    });
  });

  it('accepts any columns and leaves unmatched ones out', () => {
    const mapping = readMapping({ targets: [{ key: 'd', type: 'donor', oldId: 'DonorId', fields: { name: 'Full Name' } }] }, columns, types);
    expect(Object.values(mapping.targets[0]!.fields)).toEqual(['Full Name']);
  });

  it('refuses rollup and file fields, unknown fields and columns, and a column used twice', () => {
    const issues = issuesOf(() =>
      readMapping(
        {
          targets: [
            {
              key: 'd',
              type: 'donor',
              oldId: 'Nope',
              fields: { name: 'Full Name', email: 'Full Name', total: 'Amount', photo: 'Email', age: 'Email' },
            },
          ],
        },
        columns,
        types,
      ),
    );
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['/targets/0/oldId', '/targets/0/fields/email', '/targets/0/fields/total', '/targets/0/fields/photo', '/targets/0/fields/age']),
    );
  });

  it('needs every required field the save does not fill itself', () => {
    const issues = issuesOf(() => readMapping({ targets: [{ key: 'g', type: 'donation', oldId: 'TxnNo', fields: { amount: 'Amount' } }] }, columns, types));
    expect(issues).toEqual([{ path: '/targets/0/fields/donor', message: "Donation needs 'Donor'; match a column to it" }]);
  });

  it('takes references from a column of old ids or an earlier target of the same type', () => {
    expect(readMapping({ targets: [{ key: 'g', type: 'donation', oldId: 'TxnNo', fields: { amount: 'Amount' }, refs: { donor: { column: 'DonorId' } } }] }, columns, types).targets[0]!.refs).toEqual({
      donor: { column: 'DonorId' },
    });
    const issues = issuesOf(() =>
      readMapping(
        {
          targets: [
            { key: 'g', type: 'donation', oldId: 'TxnNo', fields: { amount: 'Amount' }, refs: { donor: { target: 'later' } } },
            { key: 'later', type: 'donor', oldId: 'DonorId', fields: { name: 'Full Name' }, refs: { name: { column: 'Email' } } },
          ],
        },
        columns,
        types,
      ),
    );
    expect(issues.map((i) => i.path)).toEqual(['/targets/0/refs/donor', '/targets/1/refs/name']);
  });

  it('needs at least one target, at least one required, and unique keys', () => {
    expect(issuesOf(() => readMapping({ targets: [] }, columns, types))[0]!.path).toBe('/targets');
    expect(issuesOf(() => readMapping({ targets: [{ key: 'd', type: 'donor', oldId: 'DonorId', fields: { name: 'Full Name' }, required: false }] }, columns, types))[0]!.path).toBe(
      '/targets',
    );
    const twice = { key: 'd', type: 'donor', oldId: 'DonorId', fields: { name: 'Full Name' } };
    expect(issuesOf(() => readMapping({ targets: [twice, twice] }, columns, types))[0]!.path).toBe('/targets/1/key');
  });
});

describe('the order files load in', () => {
  const donors: OrderedSource = {
    id: 'a',
    fileName: 'donors.csv',
    mapping: { targets: [{ key: 'd', type: 'donor', oldId: 'Id', fields: { name: 'Name' }, refs: {}, required: true }] },
  };
  const gifts: OrderedSource = {
    id: 'b',
    fileName: 'donations.csv',
    mapping: { targets: [{ key: 'g', type: 'donation', oldId: 'Txn', fields: { amount: 'Amount' }, refs: { donor: { column: 'DonorId' } }, required: true }] },
  };
  const unmapped: OrderedSource = { id: 'c', fileName: 'visits.csv', mapping: null };

  it('moves a file after the file whose records it looks up, and keeps the rest in place', () => {
    expect(deriveOrder([unmapped, gifts, donors], types).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(deriveOrder([donors, unmapped, gifts], types).map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('refuses an order that loads a file before the file it looks up', () => {
    expect(() => checkOrder([donors, gifts], types)).not.toThrow();
    expect(issuesOf(() => checkOrder([gifts, donors], types))).toEqual([{ path: '/order/0', message: 'donations.csv looks up records from donors.csv, so it must come after it' }]);
  });

  it('refuses two files that each look up the other', () => {
    const backwards: SourceMapping = {
      targets: [{ key: 'd', type: 'donor', oldId: 'Id', fields: { name: 'Name' }, refs: { name: { column: 'X' } }, required: true }],
    };
    const loopType = { ...donor, fields: [...donor.fields, { key: 'firstGift', label: 'First gift', type: 'reference', referenceType: 'donation' }] } as RecordTypeDef;
    const loopTypes = new Map([
      ['donor', loopType],
      ['donation', donation],
    ]);
    const a: OrderedSource = { ...donors, mapping: { targets: [{ ...backwards.targets[0]!, refs: { firstGift: { column: 'Gift' } } }] } };
    expect(issuesOf(() => deriveOrder([a, gifts], loopTypes))[0]!.message).toBe('donors.csv, donations.csv');
  });

  it('lets a file refer to its own record type by old id, row after row', () => {
    const parentType = { ...donor, fields: [...donor.fields, { key: 'parent', label: 'Parent', type: 'reference', referenceType: 'donor' }] } as RecordTypeDef;
    const self: OrderedSource = {
      id: 'x',
      fileName: 'donors.csv',
      mapping: { targets: [{ key: 'd', type: 'donor', oldId: 'Id', fields: { name: 'Name' }, refs: { parent: { column: 'ParentId' } }, required: true }] },
    };
    expect(deriveOrder([self], new Map([['donor', parentType]])).map((s) => s.id)).toEqual(['x']);
  });
});
