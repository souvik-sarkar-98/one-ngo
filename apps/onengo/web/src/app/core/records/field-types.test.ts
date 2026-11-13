import { describe, expect, it } from 'vitest';
import { cfField } from '../../ui/cf-types';
import { displayValue } from '../fields/fields';
import type { FileInfo, UploadTarget } from '../fields/files';
import type { RuntimeRecordType } from '../models';
import { changedOnly, fieldModels, formProblems, friendlyIssue, fromFormValues, splitIssues, toFormValues, type FormValues } from './record/forms';
import { fieldDisplay } from './record/present';
import { RecordSession } from './record/record-session';
import { resolveListSpec } from './spec';
import { fakeGateway, paramsOf, record } from './gateway/testing';
import { parseListUrl } from './list/url';

const beneficiary: RuntimeRecordType = {
  key: 'beneficiary',
  label: 'Beneficiary',
  version: 1,
  canCreate: true,
  canUpdate: true,
  titleField: 'name',
  fields: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'pan', label: 'PAN', type: 'text', unique: true, pattern: '[A-Z]{5}[0-9]{4}[A-Z]', patternMessage: 'Enter a PAN like ABCDE1234F.' },
    {
      key: 'needs',
      label: 'Needs',
      type: 'multiChoice',
      choices: [
        { value: 'fees', label: 'School fees' },
        { value: 'books', label: 'Books' },
        { value: 'bus', label: 'Bus pass' },
      ],
    },
    { key: 'photo', label: 'Photo', type: 'file', accept: ['image'], maxSizeMb: 5 },
    { key: 'documents', label: 'Documents', type: 'file', multiple: true, accept: ['image', 'pdf'], maxSizeMb: 10 },
    { key: 'home', label: 'Home location', type: 'location' },
    { key: 'consent', label: 'Consent signature', type: 'signature' },
    { key: 'notes', label: 'Case notes', type: 'richText' },
    { key: 'totalGiven', label: 'Total given', type: 'money', rollup: { recordType: 'donation', reference: 'donor', measure: 'sum', field: 'amount' } },
  ],
};
const viewer = () => ({ id: 'u1', roles: [] });
const keys = beneficiary.fields.map((f) => f.key);

const stored = {
  name: 'Lakshmi Devi',
  pan: 'ABCDE1234F',
  needs: ['fees', 'bus'],
  photo: 'f-photo',
  documents: ['f-letter', 'f-house'],
  home: { lat: 18.502114, lng: 73.925871, accuracy: 12, label: 'Home, Hadapsar' },
  consent: { file: 'f-sign', signedAt: '2026-10-24T05:35:00.000Z', signedBy: 'Lakshmi Devi' },
  notes: '<h4>Home visit</h4><p>Fees <strong>paid</strong>.</p>',
  totalGiven: 4500,
};

describe('field model for the new field types', () => {
  it('maps every type to its form control, with file options and the upload target', () => {
    const models = fieldModels(beneficiary, keys, stored, null, viewer(), { calculated: true });
    const cf = models.map(cfField);
    expect(cf.map((f) => [f.key, f.type])).toEqual([
      ['name', 'text'],
      ['pan', 'text'],
      ['needs', 'multiselect'],
      ['photo', 'file'],
      ['documents', 'file'],
      ['home', 'location'],
      ['consent', 'signature'],
      ['notes', 'richText'],
      ['totalGiven', 'number'],
    ]);
    expect(cf.find((f) => f.key === 'needs')!.options.map((o) => o.label)).toEqual(['School fees', 'Books', 'Bus pass']);
    expect(cf.find((f) => f.key === 'documents')).toMatchObject({ multiple: true, accept: ['image', 'pdf'], maxSizeMb: 10, upload: { type: 'beneficiary', field: 'documents' } });
    expect(cf.find((f) => f.key === 'photo')).toMatchObject({ multiple: false, upload: { type: 'beneficiary', field: 'photo' } });
    expect(cf.find((f) => f.key === 'consent')!.upload).toEqual({ type: 'beneficiary', field: 'consent' });
    expect(models.find((f) => f.key === 'pan')).toMatchObject({ pattern: '[A-Z]{5}[0-9]{4}[A-Z]', patternMessage: 'Enter a PAN like ABCDE1234F.' });
  });

  it('passes the typed coordinates and typed name options to the location and signature controls', () => {
    const plain = fieldModels(beneficiary, ['home', 'consent'], stored, null, viewer()).map(cfField);
    expect(plain.map((f) => [f.typedCoordinates, f.typedName])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
    const configured: RuntimeRecordType = {
      ...beneficiary,
      fields: beneficiary.fields.map((f) =>
        f.key === 'home' ? { ...f, typedCoordinates: false } : f.key === 'consent' ? { ...f, typedName: true } : f.key === 'name' ? { ...f, typedName: true, typedCoordinates: false } : f,
      ),
    };
    const cf = fieldModels(configured, ['home', 'consent', 'name'], stored, null, viewer()).map(cfField);
    expect(cf.map((f) => [f.key, f.typedCoordinates, f.typedName])).toEqual([
      ['home', false, undefined],
      ['consent', undefined, true],
      ['name', undefined, undefined],
    ]);
  });

  it('keeps rollups read-only like calculated fields, and never sends them', () => {
    expect(fieldModels(beneficiary, keys, stored, null, viewer()).map((f) => f.key)).not.toContain('totalGiven');
    expect(fieldModels(beneficiary, ['totalGiven'], stored, null, viewer(), { calculated: true })[0]).toMatchObject({ readOnly: true, calculated: true, required: false });
    expect(fromFormValues(beneficiary, { totalGiven: '9999' })).toEqual({});
    expect(resolveListSpec(beneficiary).editKeys).not.toContain('totalGiven');
    expect(displayValue(beneficiary.fields.at(-1)!, 4500)).toBe('₹4,500.00');
  });

  it('holds lists, locations and signatures in the form and sends back what was stored when nothing changed', () => {
    const values = toFormValues(beneficiary, stored);
    expect(values['needs']).toEqual(['fees', 'bus']);
    expect(values['photo']).toEqual(['f-photo']);
    expect(values['home']).toEqual({ lat: '18.502114', lng: '73.925871', accuracy: '12', label: 'Home, Hadapsar' });
    expect(values['consent']).toEqual(stored.consent);
    expect(values['notes']).toBe(stored.notes);
    const sent = fromFormValues(beneficiary, values);
    const { totalGiven: _, ...editable } = stored;
    expect(sent).toEqual(editable);
    expect(changedOnly(stored, sent)).toEqual({});
  });

  it('sends empty lists and locations as null, one file id for single fields, and leaves out files still uploading', () => {
    const values: FormValues = {
      needs: [],
      photo: ['f-new', 'f-other'],
      documents: ['f-letter', 'uploading:7'],
      home: { lat: '', lng: '', accuracy: '', label: '' },
      consent: null,
      notes: '  ',
    };
    expect(fromFormValues(beneficiary, values)).toEqual({ needs: null, photo: 'f-new', documents: ['f-letter'], home: null, consent: null, notes: null });
    expect(fromFormValues(beneficiary, { documents: [] })).toEqual({ documents: null });
  });

  it('sends a new signature as its uploaded file and the typed name, and leaves out a drawing not yet uploaded', () => {
    expect(fromFormValues(beneficiary, { consent: { drawing: 'data:image/png;base64,AA==', file: 'f-new', signedBy: ' Ravi ' } })).toEqual({ consent: { file: 'f-new', signedBy: 'Ravi' } });
    expect(fromFormValues(beneficiary, { consent: { drawing: 'data:image/png;base64,AA==' } })).toEqual({});
  });

  it('checks format rules, typed coordinates and unfinished uploads before saving', () => {
    const models = fieldModels(beneficiary, keys, {}, null, viewer());
    const values = toFormValues(beneficiary, {});
    expect(formProblems(models, { ...values, pan: 'abc' })).toEqual({ pan: 'Enter a PAN like ABCDE1234F.' });
    expect(formProblems(models, { ...values, pan: 'ABCDE1234F' })).toEqual({});
    expect(formProblems(models, { ...values, documents: ['uploading:1'] })).toEqual({ documents: 'Please wait for the upload to finish.' });
    expect(formProblems(models, { ...values, home: { lat: '98.5', lng: '73.9', accuracy: '', label: '' } })).toEqual({ home: 'Latitude: −90 to 90.' });
    const required = fieldModels({ fields: beneficiary.fields.map((f) => ({ ...f, required: true })) }, ['home', 'consent', 'needs'], {}, null, viewer());
    expect(Object.keys(formProblems(required, toFormValues(beneficiary, {})))).toEqual(['home', 'consent', 'needs']);
  });

  it('shows multiple choice as pills, files, location with a map link, the signature, and cleaned rich text', () => {
    const f = (k: string) => beneficiary.fields.find((x) => x.key === k)!;
    expect(fieldDisplay(f('needs'), stored.needs)).toEqual({ kind: 'pills', items: ['School fees', 'Bus pass'] });
    expect(displayValue(f('needs'), stored.needs)).toBe('School fees, Bus pass');
    expect(fieldDisplay(f('documents'), stored.documents)).toEqual({ kind: 'files', ids: ['f-letter', 'f-house'] });
    expect(displayValue(f('documents'), stored.documents)).toBe('📎 2');
    expect(fieldDisplay(f('home'), stored.home)).toEqual({
      kind: 'location',
      label: 'Home, Hadapsar',
      coordinates: '18.502114, 73.925871',
      accuracy: '± 12 m',
      low: false,
      maps: 'https://www.openstreetmap.org/?mlat=18.502114&mlon=73.925871#map=17/18.502114/73.925871',
    });
    expect(displayValue(f('home'), stored.home)).toBe('Home, Hadapsar');
    expect(fieldDisplay(f('consent'), stored.consent)).toMatchObject({ kind: 'signature', file: 'f-sign', line: expect.stringMatching(/^Signed by Lakshmi Devi on 24 Oct 2026/) });
    expect(fieldDisplay(f('notes'), '<p onclick="x()">Hi <script>alert(1)</script><a href="javascript:x">l</a></p>')).toEqual({ kind: 'richText', html: '<p>Hi <a>l</a></p>' });
    expect(displayValue(f('notes'), stored.notes)).toBe('Home visit Fees paid.');
    expect(fieldDisplay(f('needs'), [])).toBeUndefined();
    expect(fieldDisplay(f('consent'), { drawing: 'data:,' })).toBeUndefined();
  });
});

describe('email and phone are checked before saving', () => {
  const models = [
    { key: 'email', label: 'Email', kind: 'email' as const, required: false, readOnly: false, calculated: false, options: [] },
    { key: 'phone', label: 'Phone', kind: 'phone' as const, required: false, readOnly: false, calculated: false, options: [] },
  ];
  it('explains what to enter, and lets good values and blanks through', () => {
    expect(formProblems(models, { email: '5765', phone: 'jgghhjg' })).toEqual({
      email: 'Enter a valid email address, like name@example.org.',
      phone: 'Enter a valid phone number, like +91 98765 43210.',
    });
    expect(formProblems(models, { email: 'asha@example.org', phone: '+91 98765 43210' })).toEqual({});
    expect(formProblems(models, { email: '', phone: '' })).toEqual({});
  });
});

describe('server issues under their fields', () => {
  it('turns fragments into complete sentences with the field name', () => {
    expect(friendlyIssue('Phone', 'is required')).toBe('Phone is required.');
    expect(friendlyIssue('Phone', 'Required.')).toBe('Phone is required.');
    expect(friendlyIssue('Note', 'must be text')).toBe('Note must be text.');
    expect(friendlyIssue('Amount', 'Too small')).toBe('Amount: too small.');
    expect(friendlyIssue('Amount', 'Amount must be at least 1')).toBe('Amount must be at least 1.');
    expect(friendlyIssue('Email', 'Enter a valid email address.')).toBe('Enter a valid email address.');
  });

  it('completes only the fields it knows the name of', () => {
    const issues = [{ path: '/note', message: 'is required' }, { path: '/other', message: 'is wrong' }];
    expect(splitIssues('Check the form.', issues, { note: 'Note' }).fields).toEqual({ note: 'Note is required.', other: 'is wrong' });
    expect(splitIssues('Check the form.', issues).fields).toEqual({ note: 'is required', other: 'is wrong' });
  });
});

describe('signatures on save', () => {
  it('uploads a new drawing as a PNG for the field, then saves the file with the typed name', async () => {
    const spec = resolveListSpec(beneficiary);
    const fake = fakeGateway();
    const uploads: { name: string; type: string; target?: UploadTarget }[] = [];
    const s = new RecordSession(
      fake.gateway,
      spec,
      viewer,
      { saved: () => undefined, failed: () => undefined },
      undefined,
      {
        upload: async (file: Blob, name: string, target?: UploadTarget): Promise<FileInfo> => {
          uploads.push({ name, type: file.type, target });
          return { id: 'f-sig', name, mime: file.type, size: file.size };
        },
      },
    );
    await s.follow(parseListUrl(paramsOf({ id: 'r1', panel: 'edit' }), spec), record({ type: 'beneficiary', data: { name: 'Lakshmi Devi' } }));
    s.setValues({ ...s.snapshot.values, consent: { drawing: 'data:image/png;base64,iVBORw0KGgo=', signedBy: 'Ravi Kumar' } });
    await s.save(s.fields(['consent']));
    expect(uploads).toEqual([{ name: 'consent.png', type: 'image/png', target: { type: 'beneficiary', field: 'consent' } }]);
    const update = fake.calls.find((c) => c.op === 'update')!;
    expect(update.args[2]).toEqual({ consent: { file: 'f-sig', signedBy: 'Ravi Kumar' } });
  });
});
