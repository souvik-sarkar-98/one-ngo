import { describe, expect, it } from 'vitest';
import {
  addField,
  addRule,
  allows,
  copyCandidates,
  defaultNumbering,
  duplicateField,
  moveField,
  moveRule,
  numberFormatProblem,
  numberPreview,
  panelSections,
  readPermissionOf,
  removeField,
  removeRule,
  ruleBadges,
  setCalculated,
  setCopyFrom,
  setFieldType,
  setGeneral,
  setLabel,
  setNumbering,
  setRollup,
  setRule,
  setSensitive,
  shownFields,
  toggleAccept,
  typeSummary,
  usesSummary,
  type FieldDef,
  type RecordTypeDef,
} from './record-type';

const donation = (): RecordTypeDef => ({
  key: 'donation',
  label: 'Donation',
  titleField: 'donorName',
  numbering: { sequence: 'donation', format: 'DON/{fy}/{seq:5}', reset: 'fiscal_year' },
  fields: [
    { key: 'donor', label: 'Donor', type: 'reference', referenceType: 'donor' },
    { key: 'donorName', label: 'Donor name', type: 'text', required: true, copyFrom: { reference: 'donor', field: 'name' } },
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'fee', label: 'Fee', type: 'money' },
  ],
});

const person = (): RecordTypeDef => ({
  key: 'person',
  label: 'Person',
  fields: [
    { key: 'userId', label: 'User', type: 'person' },
    { key: 'phone', label: 'Phone', type: 'phone', sensitive: true },
    { key: 'department', label: 'Department', type: 'text' },
  ],
});

const field = (b: RecordTypeDef, key: string) => b.fields.find((f) => f.key === key)!;

describe('record type: general and numbering', () => {
  it('sets names and drops cleared ones', () => {
    const b = setGeneral(donation(), { pluralLabel: 'Donations', description: '' });
    expect(b.pluralLabel).toBe('Donations');
    expect('description' in b).toBe(false);
    expect(setGeneral(b, { titleField: '' }).titleField).toBeUndefined();
    expect(setGeneral(b, { visibility: 'restricted' }).visibility).toBe('restricted');
  });

  it('adds, changes and removes numbering, previewing the next number like the server', () => {
    const plain = setNumbering(donation(), undefined);
    expect(plain.numbering).toBeUndefined();
    expect(defaultNumbering(plain)).toEqual({ sequence: 'donation', format: 'DON/{fy}/{seq:5}', reset: 'fiscal_year' });
    expect(numberPreview(donation().numbering!, 45, '2026-27')).toBe('DON/2026-27/00045');
    expect(numberPreview(donation().numbering!, 3, '2026')).toBe('DON/2026/00003');
    expect(numberPreview({ sequence: 'donor', format: 'DNR/{seq:5}-{period}', reset: 'never' }, 7, '2025-26')).toBe('DNR/00007-all');
    expect(numberFormatProblem('DON/{fy}')).toMatch(/\{seq\}/);
    expect(numberFormatProblem('DON/{year}/{seq}')).toContain('{year}');
    expect(numberFormatProblem('DON/{fy}/{seq:4}')).toBeNull();
  });

  it('numbers every record type, including a person record', () => {
    expect(allows(person())).toEqual({ numbering: true, workflows: true, remove: true });
    expect(allows(donation())).toEqual({ numbering: true, workflows: true, remove: true });
    expect(setNumbering(person(), defaultNumbering(person())).numbering).toEqual(defaultNumbering(person()));
  });
});

describe('record type: fields', () => {
  it('adds fields with unique keys from their labels', () => {
    const one = addField(donation(), 'New field');
    expect(one.key).toBe('newField');
    const two = addField(one.body, 'New field');
    expect(two.key).toBe('newField2');
    expect(field(two.body, 'newField2')).toEqual({ key: 'newField2', label: 'New field', type: 'text' });
  });

  it('keeps the key following the label until it is published, renaming the title and copies', () => {
    const { body, key } = addField(donation(), 'New field');
    const renamed = setLabel(body, key, 'Paid on', false);
    expect(renamed.key).toBe('paidOn');
    const ref = setLabel(donation(), 'donor', 'Giver', false);
    expect(ref.key).toBe('giver');
    expect(field(ref.body, 'donorName').copyFrom).toEqual({ reference: 'giver', field: 'name' });
    const title = setLabel(donation(), 'donorName', 'Name', false);
    expect(title.body.titleField).toBe('name');
    const fixed = setLabel(donation(), 'amount', 'Gift', true);
    expect(fixed.key).toBe('amount');
    expect(field(fixed.body, 'amount').label).toBe('Gift');
  });

  it('names a field whose saved label is missing without renaming its key', () => {
    const blank = { ...donation(), fields: donation().fields.map((f) => (f.key === 'amount' ? { key: f.key, type: f.type } : f)) } as ReturnType<typeof donation>;
    const named = setLabel(blank, 'amount', 'Gift', false);
    expect(named.key).toBe('amount');
    expect(field(named.body, 'amount').label).toBe('Gift');
  });

  it('duplicates, moves and removes fields', () => {
    const dup = duplicateField(donation(), 'amount', 'Amount copy');
    expect(dup.body.fields.map((f) => f.key)).toEqual(['donor', 'donorName', 'amount', 'amountCopy', 'fee']);
    expect(moveField(donation(), 3, 0).fields.map((f) => f.key)).toEqual(['fee', 'donor', 'donorName', 'amount']);
    expect(moveField(donation(), 0, 2).fields.map((f) => f.key)).toEqual(['donorName', 'amount', 'donor', 'fee']);
    const gone = removeField(donation(), 'donorName');
    expect(gone.fields.map((f) => f.key)).toEqual(['donor', 'amount', 'fee']);
    expect(gone.titleField).toBeUndefined();
  });

  it('shows and can remove every field of a person record', () => {
    expect(shownFields(person()).map((f) => f.key)).toEqual(['userId', 'phone', 'department']);
    expect(removeField(person(), 'userId').fields.map((f) => f.key)).toEqual(['phone', 'department']);
    expect(moveField(person(), 1, 0).fields.map((f) => f.key)).toEqual(['phone', 'userId', 'department']);
  });

  it('drops the options a new type does not have', () => {
    let b = setFieldType(donation(), 'fee', 'choice');
    expect(field(b, 'fee').choices).toHaveLength(1);
    b = setFieldType(b, 'fee', 'text');
    expect(field(b, 'fee').choices).toBeUndefined();
    b = setFieldType(donation(), 'donorName', 'person');
    expect(field(b, 'donorName').copyFrom).toBeUndefined();
    const file = setFieldType({ ...donation(), fields: [{ key: 'doc', label: 'Doc', type: 'file', multiple: true, maxSizeMb: 2 }] }, 'doc', 'location');
    expect(field(file, 'doc')).toEqual({ key: 'doc', label: 'Doc', type: 'location' });
  });

  it('makes calculated and roll-up fields read-only', () => {
    let b = setCalculated(donation(), 'amount', 'record.fee * 2');
    expect(field(b, 'amount')).toEqual({ key: 'amount', label: 'Amount', type: 'money', calculated: 'record.fee * 2' });
    expect(panelSections(b, field(b, 'amount'))).not.toContain('conditions');
    b = setCalculated(b, 'amount', '');
    expect(field(b, 'amount').calculated).toBeUndefined();
    b = setRollup(donation(), 'fee', { recordType: 'gift', reference: 'donation', measure: 'count', field: 'x' });
    expect(field(b, 'fee').rollup).toEqual({ recordType: 'gift', reference: 'donation', measure: 'count' });
    expect(panelSections(b, field(b, 'fee'))).not.toContain('calculated');
  });

  it('copies only through reference fields, into compatible fields, never into person fields', () => {
    const b = setCopyFrom(donation(), 'fee', { reference: 'donor', field: 'fee' });
    expect(field(b, 'fee').copyFrom).toEqual({ reference: 'donor', field: 'fee' });
    expect(setCopyFrom(b, 'fee', undefined).fields[3]!.copyFrom).toBeUndefined();
    const withPerson = { ...donation(), fields: [...donation().fields, { key: 'worker', label: 'Worker', type: 'person' } as FieldDef] };
    expect(setCopyFrom(withPerson, 'worker', { reference: 'donor', field: 'owner' })).toBe(withPerson);
    expect(panelSections(withPerson, field(withPerson, 'worker'))).not.toContain('copyFrom');
    const source: FieldDef[] = [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'longText' },
      { key: 'total', label: 'Total', type: 'money' },
    ];
    expect(copyCandidates(field(donation(), 'donorName'), source).map((f) => f.key)).toEqual(['name', 'notes']);
  });

  it('shows the sections that apply to each type', () => {
    const b: RecordTypeDef = {
      key: 'visit',
      label: 'Visit',
      fields: [
        { key: 'where', label: 'Where', type: 'location' },
        { key: 'sign', label: 'Sign', type: 'signature' },
        { key: 'photo', label: 'Photo', type: 'file' },
        { key: 'kind', label: 'Kind', type: 'choice', choices: [{ value: 'a', label: 'A' }] },
      ],
    };
    expect(panelSections(b, field(b, 'where'))).toEqual(['basics', 'rules', 'conditions', 'location', 'access']);
    expect(panelSections(b, field(b, 'sign'))).toContain('signature');
    expect(panelSections(b, field(b, 'photo'))).toContain('file');
    expect(panelSections(b, field(b, 'kind'))).toEqual(['basics', 'rules', 'choices', 'conditions', 'calculated', 'access']);
    expect(panelSections(person(), field(person(), 'phone'))).toEqual(['basics', 'rules', 'conditions', 'calculated', 'access']);
  });

  it('keeps file kinds in a fixed order and drops an empty list', () => {
    const b = { ...donation(), fields: [{ key: 'doc', label: 'Doc', type: 'file' } as FieldDef] };
    const two = toggleAccept(toggleAccept(b, 'doc', 'pdf'), 'doc', 'image');
    expect(field(two, 'doc').accept).toEqual(['image', 'pdf']);
    expect(field(toggleAccept(toggleAccept(two, 'doc', 'pdf'), 'doc', 'image'), 'doc').accept).toBeUndefined();
  });

  it('turns Sensitive into the record type sensitive permission', () => {
    let b = setGeneral(donation(), {});
    b = { ...b, fields: b.fields.map((f) => (f.key === 'fee' ? { ...f, readPermission: 'money:fees:read' } : f)) };
    expect(readPermissionOf(b, field(b, 'fee'))).toBe('money:fees:read');
    b = setSensitive(b, 'fee', true);
    expect(field(b, 'fee')).toMatchObject({ sensitive: true });
    expect(field(b, 'fee').readPermission).toBeUndefined();
    expect(readPermissionOf(b, field(b, 'fee'))).toBe('record:donation:sensitive');
    expect(field(setSensitive(b, 'fee', false), 'fee').sensitive).toBeUndefined();
  });
});

describe('record type: table summaries and rules', () => {
  it('summarises types and rules as badges', () => {
    const b = donation();
    expect(typeSummary(field(b, 'donor'))).toBe('Link to record → donor');
    expect(ruleBadges(b, field(b, 'donorName')).map((x) => x.label)).toEqual(['Copied from Donor']);
    const calc = setSensitive(setCalculated(b, 'fee', '1'), 'fee', true);
    expect(ruleBadges(calc, field(calc, 'fee')).map((x) => x.label)).toEqual(['Calculated', 'Sensitive']);
  });

  it('adds, edits, moves and removes rules', () => {
    const one = addRule(donation());
    const two = addRule(one.body);
    expect([one.key, two.key]).toEqual(['rule1', 'rule2']);
    let b = setRule(two.body, 'rule1', { when: 'record.amount > 0', expression: 'record.fee <= record.amount', message: 'Fee too high' });
    expect(b.rules![0]).toEqual({ key: 'rule1', when: 'record.amount > 0', expression: 'record.fee <= record.amount', message: 'Fee too high' });
    b = setRule(b, 'rule1', { when: '' });
    expect(b.rules![0]!.when).toBeUndefined();
    expect(moveRule(b, 0, 1).rules!.map((r) => r.key)).toEqual(['rule2', 'rule1']);
    expect(removeRule(removeRule(b, 'rule1'), 'rule2').rules).toBeUndefined();
  });
});

describe('record type: still-used notice', () => {
  it('names each definition once, with every use of it', () => {
    const usages = [
      { kind: 'recordType' as const, key: 'donor', label: 'Donors', path: '/fields/1/calculated', what: "calculation of 'Total'" },
      { kind: 'recordType' as const, key: 'donor', label: 'Donors', path: '/rules/0', what: "rule 'Too high'" },
      { kind: 'recordType' as const, key: 'donor', label: 'Donors', path: '/rules/1', what: "rule 'Too high'" },
      { kind: 'page' as const, key: 'home', label: null, path: '/widgets/0/field', what: "widget 'Notes'" },
    ];
    expect(usesSummary(usages)).toBe("Donors (calculation of 'Total'; rule 'Too high'), home (widget 'Notes')");
  });

  it('is empty when nothing uses the field', () => {
    expect(usesSummary([])).toBe('');
  });
});
