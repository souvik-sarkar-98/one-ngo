import { describe, expect, it } from 'vitest';
import type { Me, RecordTypeBody } from '../models';
import { memoryMigrations } from '../testing/memory-migrations';
import { adminHome, mayOpen } from './areas';
import { MigrationSession, booksBalance, moved, refChoice, refOf, setField, setRef, suggestTarget, type MigrationSource } from './migration';

const caps = (c: Partial<Me['capabilities']>): Me['capabilities'] => ({ configure: false, publish: false, scripts: false, money: false, ...c });
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const supporter: RecordTypeBody = {
  key: 'supporter',
  label: 'Supporter',
  fields: [
    { key: 'name', label: 'Full name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'total', label: 'Total', type: 'money', calculated: 'x' },
    { key: 'photo', label: 'Photo', type: 'file' },
    { key: 'parent', label: 'Parent', type: 'reference', referenceType: 'supporter' },
  ],
} as RecordTypeBody;

describe('Data migration in Administration', () => {
  it('is its own area under Data, for people who may migrate data', () => {
    expect(adminHome(caps({ migration: true })).data.map((a) => [a.id, a.link])).toEqual([['migration', '/admin/migration']]);
    expect(adminHome(caps({ jobs: true })).data).toEqual([]);
    expect(mayOpen('migration', caps({ migration: true }))).toBe(true);
    expect(mayOpen('migration', caps({ settings: true }))).toBe(false);
  });
});

describe('mapping a file of any columns', () => {
  const columns = ['DonorId', 'FULL NAME', 'E-mail', 'Email', 'Legacy'];

  it('suggests fields by label or key, skips calculated, file and reference fields, and guesses the old id', () => {
    expect(suggestTarget(supporter, columns)).toEqual({
      key: 'supporter',
      type: 'supporter',
      oldId: 'DonorId',
      fields: { name: 'FULL NAME', email: 'E-mail' },
      refs: {},
      required: true,
    });
    const second = suggestTarget(supporter, columns, [suggestTarget(supporter, columns)]);
    expect(second.key).toBe('supporter_2');
    expect(second.required).toBe(false);
  });

  it('keeps a column on one field of a target, and a reference on a column or an earlier target', () => {
    let x = suggestTarget(supporter, columns);
    x = setField(x, 'email', 'FULL NAME');
    expect(x.fields).toEqual({ email: 'FULL NAME' });
    x = setRef(x, 'parent', { column: 'Legacy' });
    expect(x.refs).toEqual({ parent: { column: 'Legacy' } });
    x = setField(x, 'name', 'Legacy');
    expect(x.refs).toEqual({});
    expect(refOf(refChoice({ target: 'donor' }))).toEqual({ target: 'donor' });
    expect(refOf(refChoice({ column: 'Donor id' }))).toEqual({ column: 'Donor id' });
    expect(refOf('')).toBeNull();
  });

  it('moves a file up or down, and adds up the opening journal', () => {
    const sources = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as MigrationSource[];
    expect(moved(sources, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moved(sources, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(booksBalance([{ accountCode: 'BANK', debit: '4,80,000' }, { accountCode: 'INCOME', credit: '480000.00' }])).toEqual({ debit: 48000000, credit: 48000000, balanced: true });
    expect(booksBalance([{ accountCode: 'BANK', debit: '10' }]).balanced).toBe(false);
  });
});

describe('the migration session', () => {
  it('names a migration, adds any CSV files, keeps going past a refused one, maps, orders and checks', async () => {
    const gateway = memoryMigrations();
    const session = new MigrationSession(gateway, (fn) => setTimeout(fn, 0));
    const id = await session.create('Legacy extract');
    expect(id).toBe('m1');
    await session.open(id!);
    await session.addFiles([
      { body: new Blob(['DonorId,Full Name\nD-1,Asha\n']), name: 'donors.csv' },
      { body: new Blob(['x']), name: 'ledger.xlsx' },
      { body: new Blob(['Ward,Visit date,Households\nKothrud,03/11/2025,14\n']), name: 'visits.csv' },
    ]);
    const s = session.state.value;
    expect(s.profile!.sources.map((x) => [x.fileName, x.columns.map((c) => c.name)])).toEqual([
      ['donors.csv', ['DonorId', 'Full Name']],
      ['visits.csv', ['Ward', 'Visit date', 'Households']],
    ]);
    expect(s.error).toBe('ledger.xlsx: Choose a CSV file (.csv).');

    const donors = s.profile!.sources[0]!;
    await session.saveMapping(donors.id, { targets: [suggestTarget(supporter, donors.columns.map((c) => c.name))] });
    expect(session.state.value.profile!.sources[0]!.mapping!.targets[0]!.fields).toEqual({ name: 'Full Name' });
    await session.move(donors.id, 1);
    expect(session.state.value.profile!.sources.map((x) => x.fileName)).toEqual(['visits.csv', 'donors.csv']);
    await session.check();
    expect(session.state.value.profile!).toMatchObject({ status: 'checked', check: { rows: 2 } });
    expect(gateway.calls).toEqual(['create Legacy extract', 'add donors.csv', 'add ledger.xlsx', 'add visits.csv', `map ${donors.id} supporter`, `order s3,${donors.id}`]);
  });

  it('follows a run until its job ends, then reads the migration again', async () => {
    const gateway = memoryMigrations();
    const session = new MigrationSession(gateway, (fn) => setTimeout(fn, 0));
    const id = (await session.create('Run'))!;
    await session.open(id);
    await session.addFiles([{ body: new Blob(['Id,Name\n1,A\n2,B\n']), name: 'people.csv' }]);
    await session.check();
    await session.run();
    expect(session.state.value.profile!.status).toBe('running');
    await settle();
    expect(gateway.jobReads).toBe(2);
    expect(session.state.value.job).toMatchObject({ status: 'done', progress: 2, total: 2 });
    expect(session.state.value.profile!.status).toBe('done');
    session.dispose();
  });

  it('shows the server’s message and issues when a change is refused', async () => {
    const gateway = memoryMigrations();
    gateway.setMapping = async () => {
      throw Object.assign(new Error('This mapping cannot be saved.'), { code: 'validation_failed', issues: [{ path: '/targets/0/oldId', message: 'choose the column that holds the old id' }] });
    };
    const session = new MigrationSession(gateway);
    await session.open((await session.create('Bad'))!);
    await session.saveMapping('s1', { targets: [] });
    expect(session.state.value).toMatchObject({ busy: false, error: 'This mapping cannot be saved.', issues: [{ path: '/targets/0/oldId', message: 'choose the column that holds the old id' }] });
  });
});
