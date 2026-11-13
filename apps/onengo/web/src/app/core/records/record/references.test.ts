import { describe, expect, it } from 'vitest';
import type { RecordView, RuntimeRecordType } from '../../models';
import { RecordSession } from './record-session';
import { copyTargets, pickReference } from './references';
import { resolveListSpec } from '../spec';
import { detailSections, rowModel, showValue } from './present';
import { fakeGateway, paramsOf, record } from '../gateway/testing';
import { parseListUrl } from '../list/url';

const gift: RuntimeRecordType = {
  key: 'gift',
  label: 'Gift',
  version: 1,
  canCreate: true,
  canUpdate: true,
  fields: [
    { key: 'donor', label: 'Donor', type: 'reference', referenceType: 'donor' },
    { key: 'donorName', label: 'Donor name', type: 'text', copyFrom: { reference: 'donor', field: 'name' }, editableWhen: 'record.donor == null' },
    { key: 'donorPhone', label: 'Phone', type: 'phone', copyFrom: { reference: 'donor', field: 'phone' } },
    { key: 'amount', label: 'Amount', type: 'money' },
  ],
};

const donor = (id: string, data: Record<string, unknown>): RecordView => record({ id, type: 'donor', number: null, status: null, data });
const spec = resolveListSpec(gift);

describe('client copy from a chosen reference', () => {
  it('copies every copyFrom field of the reference, blank when the chosen record has none', () => {
    expect(copyTargets(gift, 'donor').map((f) => f.key)).toEqual(['donorName', 'donorPhone']);
    const values = pickReference(gift, { donor: '', donorName: 'typed', donorPhone: '1', amount: '5' }, 'donor', donor('d1', { name: 'Asha' }));
    expect(values).toEqual({ donor: 'd1', donorName: 'Asha', donorPhone: '', amount: '5' });
  });

  it('keeps copied values when the choice is cleared or the same record is chosen again', () => {
    const picked = { donor: 'd1', donorName: 'Asha', donorPhone: 'edited', amount: '' };
    expect(pickReference(gift, picked, 'donor', null)).toEqual({ ...picked, donor: '' });
    expect(pickReference(gift, picked, 'donor', donor('d1', { name: 'Asha', phone: '98' }))).toEqual(picked);
    expect(pickReference(gift, picked, 'donor', donor('d2', { name: 'Ravi', phone: '98' }))).toMatchObject({ donor: 'd2', donorName: 'Ravi', donorPhone: '98' });
  });

  it('locks and unlocks copied fields through editableWhen as the session picks and clears', async () => {
    const s = new RecordSession(fakeGateway().gateway, spec, () => ({ id: 'u1', roles: [] }), { saved: () => undefined, failed: () => undefined });
    await s.follow(parseListUrl(paramsOf({ create: 'new' }), spec));
    const readOnly = () => Object.fromEntries(s.fields(['donor', 'donorName', 'donorPhone']).map((f) => [f.key, f.readOnly]));
    expect(readOnly()).toEqual({ donor: false, donorName: false, donorPhone: false });

    s.pickReference('donor', donor('d1', { name: 'Asha', phone: '98' }));
    expect(s.snapshot.values).toMatchObject({ donor: 'd1', donorName: 'Asha', donorPhone: '98' });
    expect(readOnly()).toEqual({ donor: false, donorName: true, donorPhone: false });

    s.pickReference('donor', null);
    expect(s.snapshot.values).toMatchObject({ donor: '', donorName: 'Asha', donorPhone: '98' });
    expect(readOnly()).toEqual({ donor: false, donorName: false, donorPhone: false });
  });
});

describe('a chosen reference on a record', () => {
  const gifted = record({ type: 'gift', data: { donor: 'd1', donorName: 'Asha', amount: 1500 }, references: { donor: { id: 'd1', label: 'Asha Sharma' } } });

  it('shows the referenced record, on the record and in list rows, while the id stays stored', () => {
    expect(showValue(gift, undefined, gifted, 'donor')).toBe('Asha Sharma');
    expect(gifted.data['donor']).toBe('d1');
    const sections = detailSections(spec, gifted, [], { id: 'u1', roles: [] });
    expect(sections.flatMap((s) => (s.kind === 'fields' ? s.fields : []))).toEqual(expect.arrayContaining([{ label: 'Donor', value: 'Asha Sharma' }]));
    expect(rowModel({ ...spec, columns: ['donor'], compactColumns: ['donor'] }, gifted).cells).toEqual([{ key: 'donor', label: 'Donor', value: 'Asha Sharma' }]);
  });

  it('says so when the chosen record cannot be read, and shows nothing when none is chosen', () => {
    expect(showValue(gift, undefined, record({ type: 'gift', data: { donor: 'd1' } }), 'donor')).toBe('Not available');
    expect(showValue(gift, undefined, record({ type: 'gift', data: {} }), 'donor')).toBe('—');
  });
});
