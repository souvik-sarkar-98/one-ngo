import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPattern } from '../src/runtime/definitions/field-pattern.js';
import { normaliseData, validateRecordData } from '../src/runtime/records/validator.js';
import type { RecordTypeDef } from '../src/runtime/definitions/types.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

const FILE = '5b1c3e2a-8f0d-4c47-9a51-0f6f3c1d2e11';
const FILE2 = '7d3e5f4b-1a2c-4b3d-8e9f-0a1b2c3d4e5f';

const visit: RecordTypeDef = {
  key: 'visit',
  label: 'Visit',
  fields: [
    { key: 'needs', label: 'Needs', type: 'multiChoice', choices: [{ value: 'food', label: 'Food' }, { value: 'shelter', label: 'Shelter' }] },
    { key: 'photo', label: 'Photo', type: 'file', accept: ['image'] },
    { key: 'papers', label: 'Papers', type: 'file', multiple: true, accept: ['pdf', 'document'], maxSizeMb: 5 },
    { key: 'place', label: 'Place', type: 'location' },
    { key: 'consent', label: 'Consent', type: 'signature' },
    { key: 'story', label: 'Story', type: 'richText' },
    { key: 'visits', label: 'Visits', type: 'number', required: true, rollup: { recordType: 'visit', reference: 'parent', measure: 'count' } },
    { key: 'parent', label: 'Parent', type: 'reference', referenceType: 'visit' },
  ],
};

const check = (data: Record<string, unknown>) => validateRecordData(visit, 1, normaliseData(data)).map((i) => i.path);

describe('value checks for the new field types', () => {
  it('accepts good values and does not require rollups', () => {
    expect(
      check({
        needs: ['food', 'shelter'],
        photo: FILE,
        papers: [FILE, FILE2],
        place: { lat: 12.971599, lng: 77.594566, accuracy: 15, label: 'Bengaluru office' },
        consent: { file: FILE, signedAt: '2026-10-23T10:00:00Z', signedBy: 'Asha' },
        story: '<p>Hello <strong>there</strong></p>',
      }),
    ).toEqual([]);
  });

  it('checks multiple choice against the choices', () => {
    expect(check({ needs: ['food', 'gold'] })).toEqual(['/needs/1']);
    expect(check({ needs: 'food' })).toEqual(['/needs']);
    expect(check({ needs: ['food', 'food'] })).toEqual(['/needs']);
    expect(normaliseData({ needs: [] })).toEqual({});
  });

  it('checks file ids, one or several', () => {
    expect(check({ photo: 'not-a-file' })).toEqual(['/photo']);
    expect(check({ photo: [FILE] })).toEqual(['/photo']);
    expect(check({ papers: FILE })).toEqual(['/papers']);
    expect(check({ papers: Array.from({ length: 21 }, () => FILE) })).toContain('/papers');
  });

  it('checks location bounds and six decimal places', () => {
    expect(check({ place: { lat: 91, lng: 0 } })).toEqual(['/place/lat']);
    expect(check({ place: { lat: 0, lng: -181 } })).toEqual(['/place/lng']);
    expect(check({ place: { lat: 1.1234567, lng: 2 } })).toEqual(['/place']);
    expect(check({ place: { lat: 1e-7, lng: 2 } })).toEqual(['/place']);
    expect(check({ place: { lng: 2 } })).toEqual(['/place']);
    expect(check({ place: { lat: 1, lng: 2, accuracy: -1 } })).toEqual(['/place/accuracy']);
    expect(check({ place: { lat: 1, lng: 2, colour: 'red' } })).toEqual(['/place']);
  });

  it('checks the signature shape', () => {
    expect(check({ consent: { signedBy: 'Asha' } })).toEqual(['/consent']);
    expect(check({ consent: { file: FILE, signedAt: 'yesterday' } })).toEqual(['/consent/signedAt']);
    expect(check({ consent: { file: FILE, svg: '<svg/>' } })).toEqual(['/consent']);
  });

  it('limits rich text to 50,000 characters', () => {
    expect(check({ story: 'x'.repeat(50_000) })).toEqual([]);
    expect(check({ story: 'x'.repeat(50_001) })).toEqual(['/story']);
    expect(check({ story: 42 })).toEqual(['/story']);
  });
});

describe('messages a person can act on', () => {
  const contact: RecordTypeDef = {
    key: 'contact',
    label: 'Contact',
    fields: [
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'age', label: 'Age', type: 'number', min: 18 },
      { key: 'name', label: 'Name', type: 'text', maxLength: 5 },
      { key: 'since', label: 'Since', type: 'date' },
      { key: 'tier', label: 'Tier', type: 'choice', choices: [{ value: 'a', label: 'A' }] },
    ],
  };
  const messages = (data: Record<string, unknown>) => Object.fromEntries(validateRecordData(contact, 1, normaliseData(data)).map((i) => [i.path, i.message]));

  it('says what to enter instead of naming the validation rule', () => {
    expect(messages({ email: '5765', phone: 'jgghhjg', age: 3, name: 'Too long', since: 'soon', tier: 'z' })).toEqual({
      '/email': 'Enter a valid email address, like name@example.org.',
      '/phone': 'Enter a valid phone number, like +91 98765 43210.',
      '/age': 'Age must be at least 18.',
      '/name': 'Use at most 5 characters for Name.',
      '/since': 'Enter a valid date, like 2026-04-01.',
      '/tier': 'Choose one of the available options for Tier.',
    });
  });

  it('names the field when the value is the wrong kind', () => {
    expect(messages({ age: 'old', name: 7 })).toEqual({ '/age': 'Age must be a number.', '/name': 'Name must be text.' });
  });

  it('names an unknown field and says what a place is missing', () => {
    expect(messages({ nickname: 'x' })).toEqual({ '/': '“nickname” is not a field of this record.' });
    expect(check({ place: { lng: 2 } })).toEqual(['/place']);
    expect(validateRecordData(visit, 1, { place: { lng: 2 } })[0]!.message).toBe('Place needs its latitude.');
    expect(validateRecordData(visit, 1, { place: { lat: 91, lng: 0 } })[0]!.message).toBe('Place: the latitude must be at most 90.');
  });
});

describe('pattern safety', () => {
  it('accepts ordinary patterns', () => {
    for (const p of ['[A-Z]{5}[0-9]{4}[A-Z]', '\\d{6}', '(\\d{3})-(\\d{4})', '(?:ab)+c', '[(+*]+', 'a\\(b+\\)+']) expect(checkPattern(p)).toBeNull();
  });

  it('refuses nested repeats, back-references, invalid and long patterns', () => {
    for (const p of ['(a+)+', '(a*)*b', '((ab)+)+', '(\\d+){2,}', '(?:x+)*', '(?<n>a+)+']) {
      expect(checkPattern(p)).toMatch(/repeats inside repeats/);
    }
    expect(checkPattern('(a)\\1')).toMatch(/back-references/);
    expect(checkPattern('[a-')).toMatch(/not a valid/);
    expect(checkPattern('a'.repeat(201))).toMatch(/at most 200/);
  });
});

describe('definition checks for field options', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(() => w.close());

  async function issues(body: RecordTypeDef): Promise<string> {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'recordType', body);
    const err = await expectCode(w.platform.definitions.publish(ctx, 'recordType', body.key), 'definition_invalid');
    await w.platform.definitions.discardDraft(ctx, 'recordType', body.key);
    return (err as unknown as { issues: { path: string; message: string }[] }).issues.map((i) => `${i.path} ${i.message}`).join(' | ');
  }

  it('publishes a record type using every new type and option', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'recordType', {
      ...visit,
      visibility: 'restricted',
      fields: [
        ...visit.fields,
        { key: 'code', label: 'Code', type: 'text', unique: true, pattern: '[A-Z]{3}[0-9]{2}', patternMessage: 'Three letters and two digits' },
        { key: 'cost', label: 'Cost', type: 'money' },
        { key: 'spent', label: 'Spent', type: 'money', rollup: { recordType: 'visit', reference: 'parent', measure: 'sum', field: 'cost', where: "record.code != ''" } },
      ],
    });
    await w.platform.definitions.publish(ctx, 'recordType', 'visit');
  });

  it('refuses options on the wrong fields', async () => {
    const messages = await issues({
      key: 'badoptions',
      label: 'Bad options',
      fields: [
        { key: 'a', label: 'A', type: 'multiChoice' },
        { key: 'b', label: 'B', type: 'date', unique: true },
        { key: 'c', label: 'C', type: 'number', unique: true, calculated: '1' },
        { key: 'd', label: 'D', type: 'email', pattern: '.+@ngo\\.org' },
        { key: 'e', label: 'E', type: 'text', pattern: '(a+)+$' },
        { key: 'f', label: 'F', type: 'text', patternMessage: 'Nope' },
        { key: 'g', label: 'G', type: 'text', multiple: true, accept: ['image'], maxSizeMb: 2 },
        { key: 'h', label: 'H', type: 'text', typedCoordinates: false, typedName: true },
        { key: 'i', label: 'I', type: 'location', typedCoordinates: false },
        { key: 'j', label: 'J', type: 'signature', typedName: true },
      ],
    });
    expect(messages).not.toMatch(/\/fields\/[89]\//);
    for (const m of [
      '/fields/0/choices choice fields need at least one choice',
      '/fields/1/unique only text, email, phone and number fields can be unique',
      '/fields/2/unique calculated fields cannot be unique',
      '/fields/3/pattern only text fields can have a pattern',
      '/fields/4/pattern repeats inside repeats',
      '/fields/5/patternMessage a pattern message needs a pattern',
      '/fields/6/multiple only file fields have this option',
      '/fields/6/accept only file fields have this option',
      '/fields/6/maxSizeMb only file fields have this option',
      '/fields/7/typedCoordinates only location fields have this option',
      '/fields/7/typedName only signature fields have this option',
    ]) {
      expect(messages).toContain(m);
    }
  });

  it('checks rollups', async () => {
    const messages = await issues({
      key: 'badrollup',
      label: 'Bad rollup',
      fields: [
        { key: 'a', label: 'A', type: 'text', rollup: { recordType: 'donation', reference: 'donorName', measure: 'count' } },
        { key: 'b', label: 'B', type: 'number', rollup: { recordType: 'ghost', reference: 'x', measure: 'count' } },
        { key: 'c', label: 'C', type: 'number', rollup: { recordType: 'visit', reference: 'parent', measure: 'count' } },
        { key: 'd', label: 'D', type: 'number', calculated: '1', rollup: { recordType: 'badrollup', reference: 'self', measure: 'sum', field: 'a', where: '(' } },
        { key: 'self', label: 'Self', type: 'reference', referenceType: 'badrollup' },
      ],
    });
    for (const m of [
      '/fields/0/rollup rollups must be number or money fields',
      "/fields/0/rollup/reference 'donorName' is not a reference to 'badrollup' on 'donation'",
      "/fields/1/rollup/recordType record type 'ghost' is not published",
      "/fields/2/rollup/reference 'parent' is not a reference to 'badrollup' on 'visit'",
      '/fields/3/rollup rollups cannot also be calculated, copied or followed',
      '/fields/3/rollup/where expression error',
      "/fields/3/rollup/field 'a' is not a number or money field of 'badrollup'",
    ]) {
      expect(messages).toContain(m);
    }
  });

  it('keeps rollups out of forms and automations', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'listView', { key: 'visits', recordType: 'visit', create: { fields: ['visits'] } });
    const err = await expectCode(w.platform.definitions.publish(ctx, 'listView', 'visits'), 'definition_invalid');
    expect(JSON.stringify((err as unknown as { issues: unknown }).issues)).toContain("'visits' is kept up to date automatically");
  });

  it('checks visibility and file option values in the schema', () => {
    const base = { key: 'v', label: 'V', fields: [{ key: 'f', label: 'F', type: 'file' }] };
    expect(w.platform.schemas.validate('recordType', { ...base, visibility: 'private' })).not.toEqual([]);
    expect(w.platform.schemas.validate('recordType', { ...base, fields: [{ ...base.fields[0], accept: ['exe'] }] })).not.toEqual([]);
    expect(w.platform.schemas.validate('recordType', { ...base, fields: [{ ...base.fields[0], maxSizeMb: 100 }] })).not.toEqual([]);
    expect(w.platform.schemas.validate('recordType', { ...base, visibility: 'restricted' })).toEqual([]);
  });
});
