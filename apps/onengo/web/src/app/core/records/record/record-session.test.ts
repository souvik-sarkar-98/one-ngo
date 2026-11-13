import { describe, expect, it } from 'vitest';
import type { RecordView } from '../../models';
import { RecordSession } from './record-session';
import { resolveListSpec } from '../spec';
import { donationType, donationsView, donationWorkflow, fakeGateway, paramsOf, record } from '../gateway/testing';
import { parseListUrl } from '../list/url';

const spec = resolveListSpec(donationType, donationWorkflow, donationsView);
const state = (p: Record<string, string>) => parseListUrl(paramsOf(p), spec);

function session() {
  const fake = fakeGateway();
  const saved: { record: RecordView; created: boolean }[] = [];
  const failed: string[] = [];
  const s = new RecordSession(fake.gateway, spec, () => ({ id: 'u1', roles: [] }), {
    saved: (record, created) => saved.push({ record, created }),
    failed: (m) => failed.push(m),
  });
  return { s, fake, saved, failed };
}

describe('record session (shared by the cards sheets and the record page)', () => {
  it('opens a record fresh from the server with receipts, showing the list copy meanwhile', async () => {
    const { s } = session();
    const opening = s.follow(state({ id: 'r1' }), record({ data: { donorName: 'Old' } }));
    expect(s.snapshot).toMatchObject({ loading: true, record: { data: { donorName: 'Old' } } });
    await opening;
    expect(s.snapshot.record!.data['donorName']).toBe('Asha');
    expect(s.snapshot.receipts).toHaveLength(1);
    expect(s.snapshot.values).toMatchObject({ donorName: 'Asha', amount: '1500' });
  });

  it('gives each mode its fields, judged against the state the record would be in', async () => {
    const { s } = session();
    await s.follow(state({ id: 'r1', panel: 'edit' }));
    expect(s.fields().map((f) => f.key)).toEqual(['donorName', 'amount']);
    await s.follow(state({ id: 'r1', panel: 'step:markPaid' }));
    expect(s.currentStep()!.key).toBe('markPaid');
    expect(s.fields().map((f) => f.key)).toEqual(['method', 'paidOn']);
    await s.follow(state({ create: 'new', createStep: '1' }));
    expect(s.fields().map((f) => f.key)).toEqual(['amount']);
  });

  it('offers a field the step reveals, so a payment reference can be entered as the donation is marked paid', async () => {
    const withReference = resolveListSpec(
      { ...donationType, fields: [...donationType.fields, { key: 'reference', label: 'Payment reference', type: 'text', visibleWhen: "status == 'paid'" }] },
      donationWorkflow,
      donationsView,
    );
    const fake = fakeGateway();
    const s = new RecordSession(fake.gateway, withReference, () => ({ id: 'u1', roles: [] }), { saved: () => {}, failed: () => {} });
    await s.follow(parseListUrl(paramsOf({ id: 'r1', panel: 'step:markPaid' }), withReference));
    expect(s.fields().map((f) => f.key)).toEqual(['method', 'paidOn', 'reference']);
    s.setValues({ ...s.snapshot.values, method: 'upi', paidOn: '2026-10-21', reference: 'UPI-9912' });
    await s.step(s.currentStep()!, s.fields());
    expect(fake.calls.at(-1)).toEqual({ op: 'transition', args: ['donation', 'r1', 'markPaid', { method: 'upi', paidOn: '2026-10-21', reference: 'UPI-9912' }, 3] });
  });

  it('checks required fields, saves only changes, and hands the saved record to the list', async () => {
    const { s, fake, saved } = session();
    await s.follow(state({ id: 'r1', panel: 'edit' }));
    s.setValues({ ...s.snapshot.values, donorName: '' });
    await s.save(s.fields());
    expect(s.snapshot.errors).toEqual({ donorName: 'Donor name is required.' });
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false);
    s.setValues({ ...s.snapshot.values, donorName: 'Asha S' });
    expect(s.isDirty(s.fields())).toBe(true);
    await s.save(s.fields());
    expect(fake.calls.at(-1)).toEqual({ op: 'update', args: ['donation', 'r1', { donorName: 'Asha S' }, 3] });
    expect(saved.at(-1)).toMatchObject({ created: false });
    expect(s.snapshot.message).toBe('Your changes have been saved.');
  });

  it('runs a step with its fields and creates through the create fields', async () => {
    const { s, fake, saved } = session();
    await s.follow(state({ id: 'r1', panel: 'step:markPaid' }));
    s.setValues({ ...s.snapshot.values, method: 'upi', paidOn: '2026-10-21' });
    await s.step(s.currentStep()!, s.fields());
    expect(fake.calls.at(-1)).toEqual({ op: 'transition', args: ['donation', 'r1', 'markPaid', { method: 'upi', paidOn: '2026-10-21' }, 3] });
    expect(s.snapshot.message).toBe('Mark as paid completed successfully.');

    await s.follow(state({ create: 'new' }));
    expect(s.check(s.fields())).toBe(false);
    s.setValues({ ...s.snapshot.values, donorName: 'New', amount: '75' });
    expect(s.check(s.fields())).toBe(true);
    await s.create([]);
    expect(fake.calls.at(-1)).toEqual({ op: 'create', args: ['donation', { donorName: 'New', amount: 75 }] });
    expect(saved.at(-1)).toMatchObject({ created: true, record: { id: 'new' } });
    expect(s.snapshot.mode).toEqual({ kind: 'view' });
  });

  it('drops a field message as soon as that field is given a value', async () => {
    const { s, fake } = session();
    fake.gateway.transition = async () =>
      Promise.reject({ code: 'invalid', message: 'Check the form.', issues: [{ path: '/method', message: 'is required for this step' }] });
    await s.follow(state({ id: 'r1', panel: 'step:markPaid' }));
    s.setValues({ ...s.snapshot.values, paidOn: '2026-10-21' });
    await s.step(s.currentStep()!, s.fields());
    expect(s.snapshot.errors).toEqual({ method: 'Method is required for this step.' });
    s.setValues({ ...s.snapshot.values, method: 'upi' });
    expect(s.snapshot.errors).toEqual({});
  });

  it('shows server problems on their fields and reports records that cannot be opened', async () => {
    const { s, fake, failed } = session();
    fake.gateway.update = async () => Promise.reject({ code: 'invalid', message: 'Check the form.', issues: [{ path: '/amount', message: 'Too small' }] });
    await s.follow(state({ id: 'r1', panel: 'edit' }));
    s.setValues({ ...s.snapshot.values, amount: '1' });
    await s.save(s.fields());
    expect(s.snapshot).toMatchObject({ error: 'Check the form.', errors: { amount: 'Amount: too small.' }, busy: false });

    fake.gateway.get = async () => Promise.reject({ code: 'not_found', message: 'Not found.' });
    await s.follow(state({ id: 'gone' }));
    expect(failed).toEqual(['Not found.']);
  });
});
