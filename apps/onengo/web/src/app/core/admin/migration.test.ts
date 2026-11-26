import { describe, expect, it } from 'vitest';
import type { FieldDef, Me, RecordTypeBody } from '../models';
import { memoryMigrations } from '../testing/memory-migrations';
import { adminHome, mayOpen } from './areas';
import {
  ATTACHMENT_LIMIT,
  MigrationSession,
  attachmentPath,
  attachmentPathProblem,
  booksBalance,
  byteText,
  canDerive,
  canTransform,
  cleanRules,
  clearField,
  draftEmpty,
  draftReady,
  fieldCoverage,
  fillsField,
  fileDraftOf,
  fileFields,
  checkByKind,
  checkHasErrors,
  emptyPeople,
  groupWarnings,
  guessRole,
  kindOptions,
  legacyRoleValues,
  linkGroup,
  linkRefusal,
  mapGroups,
  mappingOf,
  moved,
  PEOPLE_GROUP,
  unlinkGroup,
  peopleDraftOf,
  peopleSpecOf,
  planAttachments,
  refChoice,
  refOf,
  roleRows,
  setDate,
  setDefault,
  setDerived,
  setField,
  setFile,
  setPerson,
  setRef,
  setRules,
  setState,
  stateRowsOf,
  templateColumns,
  templatePreview,
  suggestTarget,
  targetsOf,
  filesDraft,
  importKindOf,
  kindsKey,
  readKinds,
  recordGroups,
  rememberKinds,
  typesWithFiles,
  type ImportKind,
  type MigrationCheck,
  type MigrationSource,
  type MigrationWarning,
} from './migration';

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

  it('knows what fills a field and clears it whichever way it was filled', () => {
    let x = suggestTarget(supporter, columns);
    x = setRef(x, 'parent', { column: 'Legacy' });
    x = setPerson(x, 'email', 'DonorId');
    x = setFile(x, supporter.fields.find((f) => f.key === 'photo')!, 'Email');
    for (const key of ['name', 'parent', 'email', 'photo']) expect(fillsField(x, key)).toBe(true);
    expect(fillsField(x, 'total')).toBe(false);
    const cleared = ['name', 'parent', 'email', 'photo'].reduce(clearField, x);
    expect(cleared.fields).toEqual({});
    expect(cleared.refs).toEqual({});
    expect(cleared.persons).toEqual({});
    expect(cleared.files).toEqual({});
    expect(clearField(suggestTarget(supporter, columns), 'email').fields).toEqual({ name: 'FULL NAME' });
  });

  it('keeps value rules only while a column fills the field, and saves them without empty rules', () => {
    const gender = { key: 'gender', label: 'Gender', type: 'choice' } as FieldDef;
    let x = setField(suggestTarget(supporter, columns), 'email', 'E-mail');
    x = setRules(x, 'email', [{ from: ' M ', to: 'Male' }, { from: '', to: '' }]);
    expect(canTransform(gender)).toBe(true);
    expect(canTransform(supporter.fields.find((f) => f.key === 'total')!)).toBe(false);
    expect(x.transforms).toEqual({ email: [{ from: ' M ', to: 'Male' }, { from: '', to: '' }] });
    expect(cleanRules(x.transforms!.email!)).toEqual([{ from: 'M', to: 'Male' }]);
    expect(mappingOf({ targets: [x], peopleOn: false, people: emptyPeople([]) }, [])).toMatchObject({ targets: [{ transforms: { email: [{ from: 'M', to: 'Male' }] } }] });
    // Another column on the field keeps its rules; clearing the column drops them.
    expect(setField(x, 'email', 'Email').transforms).toBeDefined();
    expect(setField(x, 'email', '').transforms).toBeUndefined();
    expect(setRules(x, 'email', []).transforms).toBeUndefined();
  });

  it('gives a field a default while its column fills it, and saves it trimmed', () => {
    let x = setField(suggestTarget(supporter, columns), 'email', 'E-mail');
    x = setDefault(x, 'email', 'none@example.org');
    expect(x.defaults).toEqual({ email: 'none@example.org' });
    expect(mappingOf({ targets: [setDefault(x, 'email', '  unknown ')], peopleOn: false, people: emptyPeople([]) }, [])).toMatchObject({ targets: [{ defaults: { email: 'unknown' } }] });
    expect(targetsOf(mappingOf({ targets: [setDefault(x, 'email', '  ')], peopleOn: false, people: emptyPeople([]) }, []))[0]).not.toHaveProperty('defaults');
    expect(setDefault(x, 'email', '').defaults).toBeUndefined();
    // Another column on the field keeps the default; taking the column away drops it.
    expect(setField(x, 'email', 'Email').defaults).toEqual({ email: 'none@example.org' });
    expect(setField(x, 'email', '').defaults).toBeUndefined();
    expect(clearField(x, 'email').defaults).toBeUndefined();
  });
  it('builds a text field from a template and gives its column back when a column is chosen', () => {
    const name = supporter.fields.find((f) => f.key === 'name')!;
    let x = setDerived(suggestTarget(supporter, columns), name, '{FULL NAME} / {Legacy}');
    expect(x.fields).toEqual({ email: 'E-mail' });
    expect(x.derived).toEqual({ name: { template: '{FULL NAME} / {Legacy}' } });
    expect(fillsField(x, 'name')).toBe(true);
    expect(canDerive(name)).toBe(true);
    expect(canDerive(supporter.fields.find((f) => f.key === 'photo')!)).toBe(false);
    expect(templateColumns('{A} and {B} and {A}')).toEqual(['A', 'B']);
    const cols = [{ name: 'First', samples: ['Asha', 'Ravi'] }, { name: 'Last', samples: ['Rao', ''] }];
    expect(templatePreview('{First} {Last}', cols)).toBe('Asha Rao');
    expect(templatePreview('{First} {Last}', cols, 1)).toBe('Ravi');
    expect(templatePreview('{Nope}', cols)).toBe('');
    x = setField(x, 'name', 'FULL NAME');
    expect(x.derived).toBeUndefined();
    expect(x.fields.name).toBe('FULL NAME');
    expect(setDerived(setDerived(x, name, 'x {Legacy}'), name, null).derived).toBeUndefined();
  });

  it('moves a file up or down, and adds up the opening journal', () => {
    const sources = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as MigrationSource[];
    expect(moved(sources, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moved(sources, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(booksBalance([{ accountCode: 'BANK', debit: '4,80,000' }, { accountCode: 'INCOME', credit: '480000.00' }])).toEqual({ debit: 48000000, credit: 48000000, balanced: true });
    expect(booksBalance([{ accountCode: 'BANK', debit: '10' }]).balanced).toBe(false);
  });
});

describe('groups of files on the Map step', () => {
  const gift = {
    key: 'gift',
    label: 'Gift',
    fields: [
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'donor', label: 'Donor', type: 'reference', referenceType: 'supporter' },
    ],
  } as RecordTypeBody;
  const source = (id: string, columns: string[], mapping: MigrationSource['mapping'] = null): MigrationSource => ({
    id,
    fileName: `${id}.csv`,
    columns: columns.map((name) => ({ name, samples: [] })),
    rowCount: 1,
    position: 0,
    mapping,
    counts: null,
  });
  const identity = source('identity', ['DonorId', 'Full name', 'Email'], { targets: [suggestTarget(supporter, ['DonorId', 'Full name', 'Email'])] });
  const amounts = source('amounts', ['DonorId', 'Email', 'Amount']);
  const users = source('users', ['UserId', 'Email', 'Name'], { kind: 'people', people: { oldId: 'UserId', email: 'Email', name: 'Name' } });

  it('lists People first, then each record type in load order, then the groups added and still empty', () => {
    const drafts = { identity: fileDraftOf(identity), amounts: fileDraftOf(amounts), users: fileDraftOf(users) };
    expect(mapGroups([identity, amounts, users], drafts, ['gift'])).toEqual([
      { key: PEOPLE_GROUP, files: ['users'] },
      { key: 'supporter', files: ['identity'] },
      { key: 'gift', files: [] },
    ]);
    expect(fileDraftOf(amounts)).toMatchObject({ peopleOn: false, targets: [], people: { oldId: 'DonorId', email: 'Email' } });
  });

  it('links a second file to a record type with its own guessed old id and fields, and takes it out again', () => {
    const linked = linkGroup(fileDraftOf(amounts), 'supporter', supporter, ['DonorId', 'Email', 'Amount']);
    expect(linked).toMatchObject({ peopleOn: false, targets: [{ type: 'supporter', oldId: 'DonorId', fields: { email: 'Email' } }] });
    expect(mapGroups([identity, amounts], { identity: fileDraftOf(identity), amounts: linked }, [])).toEqual([{ key: 'supporter', files: ['identity', 'amounts'] }]);
    expect(unlinkGroup(linked, 'supporter')).toMatchObject({ peopleOn: false, targets: [] });
  });

  it('lets one file hold people and records, and at most five record types', () => {
    expect(linkRefusal(fileDraftOf(users), 'supporter')).toBe('');
    const both = linkGroup(fileDraftOf(users), 'supporter', supporter, ['UserId', 'Email', 'Name']);
    expect(both).toMatchObject({ peopleOn: true, targets: [{ type: 'supporter' }] });
    expect(mapGroups([users], { users: both }, [])).toEqual([{ key: PEOPLE_GROUP, files: ['users'] }, { key: 'supporter', files: ['users'] }]);
    expect(mappingOf(both, [])).toMatchObject({ targets: [{ type: 'supporter' }], people: { oldId: 'UserId' } });
    expect(draftEmpty(unlinkGroup(unlinkGroup(both, 'supporter'), PEOPLE_GROUP))).toBe(true);
    expect(linkRefusal(fileDraftOf(identity), PEOPLE_GROUP)).toBe('');
    expect(linkRefusal(fileDraftOf(amounts), PEOPLE_GROUP)).toBe('');
    expect(linkGroup(fileDraftOf(amounts), PEOPLE_GROUP, undefined, [])).toMatchObject({ peopleOn: true });
    const full = { ...fileDraftOf(identity), targets: Array.from({ length: 5 }, (_, i) => ({ ...suggestTarget(gift, []), key: `t${i}` })) };
    expect(linkRefusal(full, 'supporter')).toBe('ui.admin.migration.group.tooManyTypes');
  });

  it('drops the references other targets made to a record type taken out of the file', () => {
    const both = linkGroup(linkGroup(fileDraftOf(amounts), 'supporter', supporter, []), 'gift', gift, ['Amount']);
    both.targets[1] = setRef(both.targets[1]!, 'donor', { target: 'supporter' });
    const left = unlinkGroup(both, 'supporter');
    expect(left.targets.map((x) => [x.type, x.refs])).toEqual([['gift', {}]]);
  });

  it('shows where each field comes from across the linked files, and a required field no file fills', () => {
    const giftDraft = linkGroup(fileDraftOf(amounts), 'gift', gift, ['DonorId', 'Email', 'Amount']);
    giftDraft.targets[0] = setRef({ ...giftDraft.targets[0]!, oldId: 'DonorId' }, 'donor', { column: 'DonorId' });
    const other = { ...fileDraftOf(identity), targets: [...fileDraftOf(identity).targets, { ...suggestTarget(gift, []), key: 'g2', refs: { donor: { target: 'supporter' } } }] };
    const coverage = fieldCoverage({ ...gift, key: 'gift' }, [
      { source: amounts, draft: giftDraft },
      { source: identity, draft: other },
    ]);
    expect(coverage.map((c) => [c.field.key, c.from])).toEqual([
      ['amount', [{ sourceId: 'amounts', fileName: 'amounts.csv', column: 'Amount' }]],
      [
        'donor',
        [
          { sourceId: 'amounts', fileName: 'amounts.csv', column: 'DonorId' },
          { sourceId: 'identity', fileName: 'identity.csv', target: 'supporter' },
        ],
      ],
    ]);
    expect(fieldCoverage({ ...gift, key: 'gift' }, [])[0]).toEqual({ field: gift.fields[0], from: [] });
  });

  it('saves a people file with its three columns, and a records file with a target', () => {
    const people = fileDraftOf(users);
    expect(draftReady(people)).toBe(true);
    expect(draftReady({ ...people, people: { ...people.people, email: '' } })).toBe(false);
    expect(mappingOf(people, [])).toEqual({ kind: 'people', people: { oldId: 'UserId', email: 'Email', name: 'Name' } });
    // A file linked to People that fills no part of a person is not saved as people.
    const idle = linkGroup(fileDraftOf(amounts), PEOPLE_GROUP, undefined, []);
    expect(draftReady(idle)).toBe(false);
    const withRecords = { ...linkGroup(idle, 'supporter', supporter, ['DonorId']), people: emptyPeople([]) };
    expect(draftReady(withRecords)).toBe(true);
    expect(mappingOf(withRecords, [])).not.toHaveProperty('people');
    expect(draftReady(fileDraftOf(amounts))).toBe(false);
    expect(mappingOf(fileDraftOf(identity), [])).toEqual({ targets: targetsOf(identity.mapping) });
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
    expect(targetsOf(session.state.value.profile!.sources[0]!.mapping)[0]!.fields).toEqual({ name: 'Full Name' });
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

  it('reads the migration again on each tick of a run, so the failed rows so far show while it runs', async () => {
    const gateway = memoryMigrations();
    const session = new MigrationSession(gateway, (fn) => setTimeout(fn, 0));
    const seen: string[][] = [];
    session.state.subscribe((s) => {
      const failures = s.profile?.recentFailures;
      if (failures?.length) seen.push(failures.map((f) => `${f.fileName}: ${f.message}`));
    });
    const id = (await session.create('Live'))!;
    await session.open(id);
    await session.addFiles([{ body: new Blob(['Id,Name\n1,A\n2,\n']), name: 'people.csv' }]);
    await session.check();
    await session.run();
    await settle();
    expect(seen[0]).toEqual(['people.csv: Name is required']);
    expect(session.state.value.profile!.status).toBe('done');
    expect(session.state.value.profile!.recentFailures).toEqual([]);
    session.dispose();
  });

  it('follows a check that runs in the background until its job ends, then shows its result', async () => {
    const gateway = memoryMigrations();
    gateway.backgroundChecks = true;
    const session = new MigrationSession(gateway, (fn) => setTimeout(fn, 0));
    const id = (await session.create('Background check'))!;
    await session.open(id);
    await session.addFiles([{ body: new Blob(['Id,Name\n1,A\n2,B\n']), name: 'people.csv' }]);
    await session.check();
    expect(session.state.value.profile!).toMatchObject({ checkJobId: 'check1', check: null, status: 'draft' });
    expect(session.state.value.job).toBeNull();
    await settle();
    expect(session.state.value.profile!).toMatchObject({ checkJobId: null, status: 'checked', check: { rows: 2 } });
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

const person: RecordTypeBody = {
  key: 'donation',
  label: 'Donation',
  fields: [
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'collector', label: 'Collected by', type: 'person' },
  ],
} as RecordTypeBody;

describe('mapping a file of people', () => {
  const columns = ['UserId', 'Email', 'FullName', 'Roles', 'Active', 'Lang'];

  it('asks what is in the file, and disables People with the reason when the person lacks the permissions', () => {
    expect(kindOptions(true).map((o) => [o.kind, o.disabled, o.hint])).toEqual([
      ['records', false, 'ui.admin.migration.kindRecordsHint'],
      ['people', false, 'ui.admin.migration.kindPeopleHint'],
      ['files', false, 'ui.admin.migration.kindFilesHint'],
    ]);
    expect(kindOptions(false).find((o) => o.kind === 'people')).toMatchObject({ disabled: true, hint: 'ui.admin.migration.kindPeopleDenied' });
    expect(kindOptions(false).find((o) => o.kind === 'records')!.disabled).toBe(false);
  });

  it('guesses the columns, and saves a people mapping with the role table, status and language', async () => {
    const draft = emptyPeople(columns);
    expect(draft).toMatchObject({ oldId: 'UserId', email: 'Email', name: 'FullName', rolesColumn: 'Roles', statusColumn: 'Active', locale: 'Lang', separator: ';' });
    const roles = [
      { key: 'admin', label: 'Organisation administrator' },
      { key: 'finance', label: 'Finance', requireTwoStep: true },
      { key: 'front-desk', label: 'Front desk' },
    ];
    const values = legacyRoleValues(['Admin;Clerk', 'admin ; Guest', 'Finance'], ';');
    expect(values).toEqual(['Admin', 'Clerk', 'Guest', 'Finance']);
    expect(guessRole('Admin', roles)).toBe('admin');
    expect(guessRole('Clerk', roles)).toBe('');
    expect(guessRole('Front desk', roles)).toBe('front-desk');
    expect(guessRole('Finance', roles)).toBe('');
    const rows = roleRows(values, { Clerk: 'front-desk', Admin: 'admin', Extra: '' }, roles);
    expect(rows).toEqual([
      { value: 'Admin', role: 'admin' },
      { value: 'Clerk', role: 'front-desk' },
      { value: 'Guest', role: '' },
      { value: 'Finance', role: '' },
      { value: 'Extra', role: '' },
    ]);

    const gateway = memoryMigrations();
    const session = new MigrationSession(gateway);
    await session.open((await session.create('People'))!);
    await session.addFiles([{ body: new Blob(['UserId,Email,FullName,Roles,Active,Lang\n,,,Admin;Clerk,1,en\n']), name: 'people.csv' }]);
    const spec = peopleSpecOf({ ...draft, active: '1, yes', suspended: '0,no' }, rows);
    expect(spec).toEqual({
      oldId: 'UserId',
      email: 'Email',
      name: 'FullName',
      roles: { column: 'Roles', separator: ';', map: { Admin: 'admin', Clerk: 'front-desk', Guest: null, Finance: null, Extra: null } },
      status: { column: 'Active', active: ['1', 'yes'], suspended: ['0', 'no'] },
      locale: 'Lang',
    });
    await session.saveMapping('s2', { kind: 'people', people: spec });
    const saved = session.state.value.profile!.sources[0]!;
    expect(saved).toMatchObject({ kind: 'people', mapping: { kind: 'people', people: spec } });
    expect(gateway.calls.at(-1)).toBe('map s2 people');
    expect(peopleDraftOf(spec)).toMatchObject({ rolesColumn: 'Roles', active: '1, yes', suspended: '0, no', roleMap: { Guest: '' } });
  });

  it('leaves out what has no column, and keeps fixed roles', () => {
    const d = { ...emptyPeople(['Id', 'Mail', 'Name']), oldId: 'Id', email: 'Mail', name: 'Name', fixed: ['front-desk'] };
    expect(peopleSpecOf(d, [])).toEqual({ oldId: 'Id', email: 'Mail', name: 'Name', roles: { fixed: ['front-desk'] } });
    expect(peopleDraftOf({ oldId: 'Id', email: 'Mail', name: 'Name', roles: { fixed: ['a'] } }).fixed).toEqual(['a']);
  });

  it('shows a 422 issue path on the role it belongs to', async () => {
    const gateway = memoryMigrations();
    gateway.setMapping = async () => {
      throw Object.assign(new Error('This mapping cannot be saved.'), { code: 'validation_failed', issues: [{ path: '/people/roles/map/Admin', message: 'requires two-step sign-in' }] });
    };
    const session = new MigrationSession(gateway);
    await session.open((await session.create('Bad'))!);
    await session.saveMapping('s1', { kind: 'people', people: { oldId: 'a', email: 'b', name: 'c' } });
    expect(session.state.value.issues).toEqual([{ path: '/people/roles/map/Admin', message: 'requires two-step sign-in' }]);
  });
});

describe('a person field filled by legacy user id', () => {
  it('keeps the legacy column apart from the field’s email-or-id column, and fail-the-row only when chosen', () => {
    let x = suggestTarget(person, ['TxnNo', 'Amount', 'CreatedBy']);
    x = setField(x, 'collector', 'CreatedBy');
    x = setPerson(x, 'collector', 'CreatedBy');
    expect(x.fields).toEqual({ amount: 'Amount', collector: 'CreatedBy' });
    expect(x.persons).toEqual({ collector: { column: 'CreatedBy' } });
    x = setPerson(x, 'collector', 'CreatedBy', 'fail');
    expect(x.persons).toEqual({ collector: { column: 'CreatedBy', onMissing: 'fail' } });
    expect(setPerson(x, 'collector', '').persons).toEqual({});
  });

  it('saves the person mapping with the records mapping', async () => {
    const gateway = memoryMigrations();
    const session = new MigrationSession(gateway);
    await session.open((await session.create('Donations'))!);
    await session.addFiles([{ body: new Blob(['TxnNo,Amount,CreatedBy\nT-1,10,U-1\n']), name: 'donations.csv' }]);
    const target = setPerson(suggestTarget(person, ['TxnNo', 'Amount', 'CreatedBy']), 'collector', 'CreatedBy', 'fail');
    await session.saveMapping('s2', { targets: [target] });
    expect(targetsOf(session.state.value.profile!.sources[0]!.mapping)[0]!.persons).toEqual({ collector: { column: 'CreatedBy', onMissing: 'fail' } });
  });
});

describe('legacy dates and the status column', () => {
  it('takes each original date from its column, and drops the date when its column is cleared', () => {
    let x = suggestTarget(supporter, ['Name', 'Created', 'Updated']);
    x = setDate(x, 'createdAt', 'Created');
    x = setDate(x, 'updatedAt', 'Updated');
    expect(x.dates).toEqual({ createdAt: 'Created', updatedAt: 'Updated' });
    x = setDate(x, 'updatedAt', '');
    expect(x.dates).toEqual({ createdAt: 'Created' });
    expect(setDate(x, 'createdAt', '').dates).toBeUndefined();
  });

  it('gives each value of the status column the status it names, leaves out a value with no status, and drops the status when the column is cleared', () => {
    const x = setState(suggestTarget(supporter, ['Name', 'Status']), 'Status', { Open: 'open', Paid: '', Cancelled: 'cancelled' });
    expect(x.state).toEqual({ column: 'Status', map: { Open: 'open', Cancelled: 'cancelled' } });
    expect(setState(x, '', {}).state).toBeUndefined();
  });

  it('lists each sample value once, ignoring case, then the values already mapped, each with the status it takes', () => {
    expect(stateRowsOf(['Open', 'open ', 'Paid', ''], { Paid: 'paid', Lost: 'cancelled' })).toEqual([
      { value: 'Open', state: '' },
      { value: 'Paid', state: 'paid' },
      { value: 'Lost', state: 'cancelled' },
    ]);
  });
});

describe('the check by kind and its warnings', () => {
  const warnings: MigrationWarning[] = [
    { kind: 'unresolved-legacy-users', sourceId: 's2', fileName: 'donations.csv', column: 'CreatedBy', count: 12, samples: ['U-0017', 'U-0022', 'U-0031'] },
    { kind: 'duplicate-email', sourceId: 's1', fileName: 'people.csv', count: 2, samples: ['Legacy ids a, b share one email; they will be one person'] },
    { kind: 'unresolved-legacy-users', sourceId: 's3', fileName: 'gifts.csv', column: 'By', count: 1, samples: ['U-9'] },
    { kind: 'something-new', sourceId: null, fileName: null, count: 3, samples: [] },
  ];

  it('groups warnings by kind with their samples, and counts what is not shown for ids only', () => {
    const groups = groupWarnings(warnings);
    expect(groups.map((g) => [g.kind, g.title, g.items.length])).toEqual([
      ['unresolved-legacy-users', 'ui.admin.migration.warningGroup.unresolvedLegacyUsers', 2],
      ['duplicate-email', 'ui.admin.migration.warningGroup.duplicateEmail', 1],
      ['something-new', 'ui.admin.migration.warningGroup.other', 1],
    ]);
    expect(groups[0]!.items.map((i) => i.more)).toEqual([9, 0]);
    expect(groups[1]!.items[0]!.more).toBe(0);
  });

  it('counts the rows an optional target is left out of that are not shown', () => {
    const [group] = groupWarnings([
      { kind: 'optional-target-left-out', sourceId: 's1', fileName: 'combined.csv', target: 'gift', count: 7, samples: ['Row 3: Amount is not a number', 'Row 9: Amount must be at least 1'] },
    ]);
    expect(group).toMatchObject({ title: 'ui.admin.migration.warningGroup.optionalTargetLeftOut', items: [{ target: 'gift', more: 5 }] });
  });

  it('adds the per-file figures up per kind, people first', () => {
    const check = {
      sources: [
        { sourceId: 's1', fileName: 'donors.csv', rows: 10, ready: 10, invalid: 0, creates: 10, updates: 0 },
        { sourceId: 's2', fileName: 'people.csv', rows: 5, ready: 4, invalid: 1, creates: 3, updates: 1 },
        { sourceId: 's3', fileName: 'donations.csv', rows: 20, ready: 20, invalid: 0, creates: 20, updates: 0 },
      ],
    } as MigrationCheck;
    const sources = [{ id: 's1', kind: 'records' }, { id: 's2', kind: 'people' }, { id: 's3' }] as MigrationSource[];
    expect(checkByKind(check, sources)).toEqual([
      { kind: 'people', files: 1, rows: 5, ready: 4, invalid: 1, creates: 3, updates: 1 },
      { kind: 'records', files: 2, rows: 30, ready: 30, invalid: 0, creates: 30, updates: 0 },
    ]);
  });

  it('counts failing rows and file problems as errors, never warnings', () => {
    const clean = { invalid: 0, problems: [] as MigrationCheck['problems'] } as MigrationCheck;
    const problem = { sourceId: 's1', fileName: 'donors.csv', row: 0, message: 'Blocked.' };
    expect(checkHasErrors(clean)).toBe(false);
    expect(checkHasErrors({ ...clean, invalid: 1 })).toBe(true);
    expect(checkHasErrors({ ...clean, problems: [problem] })).toBe(true);
    expect(checkHasErrors({ ...clean, problems: [{ ...problem, severity: 'error' }] })).toBe(true);
    expect(checkHasErrors({ ...clean, problems: [{ ...problem, severity: 'warning' }] })).toBe(false);
  });

  it('does not start a run while the check has errors', async () => {
    const gateway = memoryMigrations();
    const check = gateway.check;
    gateway.check = async (id) => {
      const p = await check(id);
      return { ...p, check: { ...p.check!, ready: 1, invalid: 1 } };
    };
    const session = new MigrationSession(gateway, (fn) => setTimeout(fn, 0));
    await session.open((await session.create('Errors'))!);
    await session.addFiles([{ body: new Blob(['Id,Name\n1,A\n2,\n']), name: 'people.csv' }]);
    await session.check();
    await session.run();
    expect(session.state.value.profile!).toMatchObject({ status: 'checked', jobId: null });
    expect(gateway.jobReads).toBe(0);
    session.dispose();
  });
});
describe('file fields filled from attachments', () => {
  const scans: RecordTypeBody = {
    key: 'donation',
    label: 'Donation',
    fields: [
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'receipt', label: 'Receipt scan', type: 'file', multiple: true, required: true },
      { key: 'photo', label: 'Photo', type: 'file' },
    ],
  } as RecordTypeBody;
  const [receipt, photo] = fileFields(scans) as [FieldDef, FieldDef];

  it('lists the file fields, and keeps the separator for several-file fields and "skip" only when chosen', () => {
    expect(fileFields(scans).map((f) => f.key)).toEqual(['receipt', 'photo']);
    let x = suggestTarget(scans, ['TxnNo', 'Amount', 'Scans']);
    expect(x.files).toBeUndefined();
    x = setFile(x, receipt, 'Scans');
    expect(x.files).toEqual({ receipt: { column: 'Scans' } });
    x = setFile(x, receipt, 'Scans', { separator: ',', onMissing: 'skip' });
    expect(x.files).toEqual({ receipt: { column: 'Scans', separator: ',', onMissing: 'skip' } });
    x = setFile(x, photo, 'Pic', { separator: ',', onMissing: 'fail' });
    expect(x.files!.photo).toEqual({ column: 'Pic' });
    expect(setFile(x, receipt, '').files).toEqual({ photo: { column: 'Pic' } });
  });

  it('gives a column to one field only', () => {
    let x = suggestTarget(scans, ['TxnNo', 'Amount', 'Scans']);
    x = setFile(x, receipt, 'Scans');
    expect(x.fields).toEqual({ amount: 'Amount' });
    x = setFile(x, photo, 'Amount');
    expect(x.fields).toEqual({});
    x = setField(x, 'amount', 'Scans');
    expect(x.files).toEqual({ photo: { column: 'Amount' } });
    x = setFile(setField(x, 'amount', 'Pic'), receipt, 'Pic');
    expect(x.fields).toEqual({});
    expect(x.files).toEqual({ photo: { column: 'Amount' }, receipt: { column: 'Pic' } });
  });

  it('sends the files mapping with the records mapping', async () => {
    const gateway = memoryMigrations();
    const session = new MigrationSession(gateway);
    await session.open((await session.create('Donations'))!);
    await session.addFiles([{ body: new Blob(['TxnNo,Amount,Scans\nT-1,10,a.pdf;b.pdf\n']), name: 'donations.csv' }]);
    const target = setFile(suggestTarget(scans, ['TxnNo', 'Amount', 'Scans']), receipt, 'Scans', { onMissing: 'skip' });
    await session.saveMapping('s2', { targets: [target] });
    expect(targetsOf(session.state.value.profile!.sources[0]!.mapping)[0]!.files).toEqual({ receipt: { column: 'Scans', onMissing: 'skip' } });
  });
});

describe('attachments', () => {
  const file = (text: string) => new Blob([text]);
  const open = async () => {
    const gateway = memoryMigrations();
    const session = new MigrationSession(gateway);
    await session.open((await session.create('Donations'))!);
    return { gateway, session };
  };

  it('cleans paths and refuses the ones the server would, and anything past 5,000', () => {
    expect(attachmentPath('\\scans\\D-1.pdf')).toBe('scans/D-1.pdf');
    expect(attachmentPathProblem('scans/D-1.pdf')).toBeNull();
    expect(attachmentPathProblem('')).toBe('ui.admin.migration.attach.pathEmpty');
    expect(attachmentPathProblem('a/../b.pdf')).toBe('ui.admin.migration.attach.pathDots');
    expect(attachmentPathProblem('x'.repeat(256))).toBe('ui.admin.migration.attach.pathLong');
    expect(attachmentPathProblem('..b/..c.pdf')).toBeNull();
    const plan = planAttachments([{ body: file('a'), name: 'a.pdf' }, { body: file('b'), name: '../b.pdf' }, { body: file('c'), name: '/c.pdf' }], ATTACHMENT_LIMIT - 1);
    expect(plan.ok.map((f) => f.name)).toEqual(['a.pdf']);
    expect(plan.refused.map((r) => r.name)).toEqual(['../b.pdf', 'c.pdf']);
  });

  it('writes sizes as people read them', () => {
    expect([512, 2048, 5 * 1024 ** 2, 1.5 * 1024 ** 3].map(byteText)).toEqual(['512 B', '2 kB', '5 MB', '1.5 GB']);
  });

  it('uploads one after another under their paths, lists the refusals, and goes on past them', async () => {
    const { gateway, session } = await open();
    await session.addAttachments([
      { body: file('1'), name: 'scans/D-1.pdf' },
      { body: file('2'), name: 'scans/d-1.PDF' },
      { body: file('3'), name: '../x.pdf' },
      { body: file('44'), name: 'photos/ravi.jpg' },
    ]);
    const s = session.state.value;
    expect(gateway.calls.filter((c) => c.startsWith('attach'))).toEqual(['attach scans/D-1.pdf', 'attach scans/d-1.PDF', 'attach photos/ravi.jpg']);
    expect(s.refused.map((r) => [r.name, r.message])).toEqual([
      ['../x.pdf', 'The path may not contain "..".'],
      ['scans/d-1.PDF', 'The attachment scans/d-1.PDF is already there.'],
    ]);
    expect(s.profile!.attachments).toEqual({ count: 2, bytes: 3 });
    expect(s.attachmentList!.items.map((a) => [a.path, a.size, a.usedBy])).toEqual([['scans/D-1.pdf', 1, 0], ['photos/ravi.jpg', 2, 0]]);
    expect(s.upload).toBeNull();
    expect(s.busy).toBe(false);
  });

  it('searches and pages the list, removes one, and clears all, which sends the profile back to draft', async () => {
    const { gateway, session } = await open();
    await session.addFiles([{ body: file('A,B\n1,2\n'), name: 'a.csv' }]);
    await session.addAttachments(['a.pdf', 'b.pdf', 'c.jpg'].map((name) => ({ body: file('x'), name })));
    await session.check();
    expect(session.state.value.profile!.status).toBe('checked');

    await session.loadAttachments({ q: 'PDF', limit: 1, offset: 1 });
    expect(session.state.value.attachmentList).toEqual({ items: [expect.objectContaining({ path: 'b.pdf' })], total: 2 });

    const id = session.state.value.attachmentList!.items[0]!.id;
    await session.removeAttachment(id);
    expect(gateway.calls).toContain(`unattach ${id}`);
    expect(session.state.value.profile!).toMatchObject({ status: 'draft', attachments: { count: 2, bytes: 2 } });
    expect(session.state.value.attachmentList!.items.map((a) => a.path)).toEqual(['a.pdf', 'c.jpg']);

    await session.clearAttachments();
    expect(session.state.value.profile!.attachments).toEqual({ count: 0, bytes: 0 });
    expect(session.state.value.attachmentList).toEqual({ items: [], total: 0 });
  });

  it('shows a refusal of a remove', async () => {
    const { gateway, session } = await open();
    gateway.removeAttachment = async () => {
      throw Object.assign(new Error('The migration is running.'), { code: 'conflict' });
    };
    await session.removeAttachment('a1');
    expect(session.state.value).toMatchObject({ error: 'The migration is running.', busy: false });
  });
});

describe('deleting the source data', () => {
  it('purges, keeps the mapping, marks the files and profile, and empties the attachments', async () => {
    const gateway = memoryMigrations();
    const session = new MigrationSession(gateway);
    await session.open((await session.create('Donations'))!);
    await session.addFiles([{ body: new Blob(['TxnNo,Amount\nT-1,10\n']), name: 'donations.csv' }]);
    await session.saveMapping('s2', { targets: [suggestTarget(supporter, ['TxnNo', 'Amount'])] });
    await session.addAttachments([{ body: new Blob(['x']), name: 'a.pdf' }]);
    expect(session.state.value.profile!.purgedAt).toBeNull();

    await session.purge();
    const p = session.state.value.profile!;
    expect(gateway.calls).toContain('purge');
    expect(p.purgedAt).toBe('2026-11-25T00:00:00.000Z');
    expect(p.sources[0]).toMatchObject({ purgedAt: p.purgedAt, columns: [{ name: 'TxnNo', samples: [] }, { name: 'Amount', samples: [] }] });
    expect(p.sources[0]!.mapping).not.toBeNull();
    expect(p.attachments).toEqual({ count: 0, bytes: 0 });
    expect(session.state.value.attachmentList).toEqual({ items: [], total: 0 });
  });

  it('shows the refusal while a migration runs, and leaves the profile as it was', async () => {
    const gateway = memoryMigrations();
    const session = new MigrationSession(gateway, (fn) => setTimeout(fn, 60_000));
    await session.open((await session.create('Donations'))!);
    await session.addFiles([{ body: new Blob(['A\n1\n']), name: 'a.csv' }]);
    await session.check();
    await session.run();
    await session.purge();
    expect(session.state.value.error).toBe('The migration is running.');
    expect(session.state.value.profile!.purgedAt).toBeNull();
    session.dispose();
  });
});

describe('check warnings about attachments', () => {
  it('groups missing files and storage under their own titles, counting the names not shown', () => {
    const groups = groupWarnings([
      { kind: 'missing-attachments', sourceId: 's2', fileName: 'donations.csv', column: 'Scans', count: 8, samples: ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'] },
      { kind: 'storage-over-quota', sourceId: null, fileName: null, count: 1, samples: ['40 attachments are still to link'] },
    ]);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.more)])).toEqual([
      ['ui.admin.migration.warningGroup.missingAttachments', [3]],
      ['ui.admin.migration.warningGroup.storageOverQuota', [0]],
    ]);
  });
});

describe('what a file was added as', () => {
  const scans: RecordTypeBody = {
    key: 'donation',
    label: 'Donation',
    fields: [
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'receipt', label: 'Receipt scan', type: 'file', multiple: true },
    ],
  } as RecordTypeBody;
  const plain: RecordTypeBody = { key: 'volunteer', label: 'Volunteer', fields: [{ key: 'name', label: 'Name', type: 'text' }] } as RecordTypeBody;

  it('takes the choice made, else People for a people file and Records for any other', () => {
    expect(importKindOf({ id: 'a', kind: 'records' }, { a: 'files' })).toBe('files');
    expect(importKindOf({ id: 'a', kind: 'records' }, {})).toBe('records');
    expect(importKindOf({ id: 'a' }, {})).toBe('records');
    expect(importKindOf({ id: 'a', kind: 'people' }, {})).toBe('people');
    expect(importKindOf({ id: 'a', kind: 'people' }, { a: 'records' })).toBe('records');
  });

  it('shows record types as groups, never People, and not a type only a Files CSV fills', () => {
    const groups = [
      { key: PEOPLE_GROUP, files: ['p'] },
      { key: 'donation', files: ['r', 'f'] },
      { key: 'volunteer', files: ['f'] },
      { key: 'asset', files: [] },
    ];
    const kinds: Record<string, ImportKind> = { p: 'people', r: 'records', f: 'files' };
    expect(recordGroups(groups, kinds).map((g) => g.key)).toEqual(['donation', 'asset']);
  });

  it('offers only record types with a file field to a Files CSV', () => {
    expect(typesWithFiles([scans, plain]).map((x) => x.key)).toEqual(['donation']);
  });

  it('makes a Files CSV fill one type by old id and nothing else, which its file fields then fill', () => {
    const empty = fileDraftOf({ mapping: null, columns: [{ name: 'RecordId', samples: [] }, { name: 'Amount', samples: [] }, { name: 'FilePath', samples: [] }] });
    const d = filesDraft(empty, scans, ['RecordId', 'Amount', 'FilePath']);
    expect(d.targets).toHaveLength(1);
    expect(d.targets[0]).toMatchObject({ type: 'donation', oldId: 'RecordId', fields: {}, refs: {} });
    const [receipt] = fileFields(scans) as [FieldDef];
    const filled = setFile(d.targets[0]!, receipt, 'FilePath');
    expect(filled.files).toEqual({ receipt: { column: 'FilePath' } });
    expect(fillsField(filled, 'receipt')).toBe(true);
    expect(filesDraft(d, undefined, []).targets).toEqual([]);
  });

  it('keeps the choices per profile on the device and ignores what it cannot read', () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const key = kindsKey('acme', 'p1');
    expect(readKinds(store, key)).toEqual({});
    rememberKinds(store, key, { a: 'files', b: 'people' });
    expect(readKinds(store, key)).toEqual({ a: 'files', b: 'people' });
    expect(readKinds(store, kindsKey('acme', 'p2'))).toEqual({});
    data.set(key, JSON.stringify({ a: 'files', b: 'nonsense' }));
    expect(readKinds(store, key)).toEqual({ a: 'files' });
    data.set(key, 'not json');
    expect(readKinds(store, key)).toEqual({});
    expect(() => rememberKinds({ setItem: () => { throw new Error('full'); } }, key, {})).not.toThrow();
  });
});

describe('starting the profile over', () => {
  it('removes every CSV and every uploaded file, with the mappings, and says so', async () => {
    const session = new MigrationSession(memoryMigrations(), (fn) => setTimeout(fn, 60_000));
    await session.open((await session.create('Donations'))!);
    await session.addFiles([
      { body: new Blob(['A\n1\n']), name: 'a.csv' },
      { body: new Blob(['B\n2\n']), name: 'b.csv' },
    ]);
    await session.addAttachments([{ body: new Blob(['x']), name: 'scans/a.pdf' }]);
    expect(session.state.value.profile!.sources).toHaveLength(2);
    expect(session.state.value.profile!.attachments?.count).toBe(1);

    expect(await session.clearAll()).toBe(true);
    const { profile, attachmentList, message, busy } = session.state.value;
    expect(profile!.sources).toEqual([]);
    expect(profile!.attachments?.count ?? 0).toBe(0);
    expect(attachmentList?.items ?? []).toEqual([]);
    expect(message).toBe('Everything was removed. Add the files again.');
    expect(busy).toBe(false);
    session.dispose();
  });

  it('does nothing without a profile', async () => {
    expect(await new MigrationSession(memoryMigrations()).clearAll()).toBe(false);
  });
});