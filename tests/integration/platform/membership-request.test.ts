import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareDeployment } from '../../../packages/platform/src/prepare-deployment.js';
import { checkCrossReferences, type DefinitionLookup } from '../../../packages/platform/src/runtime/definitions/cross-refs.js';
import type { FieldDef, RecordTypeDef } from '../../../packages/platform/src/runtime/definitions/types.js';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';
import { PRODUCT_ROOT } from '../../support/paths.js';

type Actor = NonNullable<Parameters<TestWorld['as']>[1]>;

const MODULES_DIR = join(PRODUCT_ROOT, 'modules');
const folders = readdirSync(MODULES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

let w: TestWorld;

/** Someone who may approve membership requests, but is not the one who made them. */
const manager: Actor = {
  id: 'manager-2',
  roles: ['membership-manager'],
  permissions: ['record:membershipRequest:*', 'record:member:read', 'record:donor:read', 'people:read'],
};

beforeAll(async () => {
  w = await createWorld({ donations: false });
  const deployed = await prepareDeployment(w.platform.db, { shippedModules: folders });
  const ctx = w.as(w.ngoA);
  for (const key of ['donations', 'members']) await w.platform.definitions.enableModule(ctx, deployed.modules.find((m) => m.manifest.key === key)!.manifest);
}, 120_000);
afterAll(() => w.close());

describe('a person field that looks people up by email', () => {
  const lookup: DefinitionLookup = {
    recordType: () => undefined,
    workflowFor: () => undefined,
    workflowsFor: () => [],
    template: () => undefined,
    definition: () => undefined,
    all: (() => []) as DefinitionLookup['all'],
    accountCodes: null,
    receiptSeries: null,
    roles: null,
    connectors: null,
  };
  const emailIssues = (fields: FieldDef[]) =>
    checkCrossReferences('recordType', { key: 'thing', label: 'Thing', fields } as RecordTypeDef, lookup)
      .filter((i) => i.path.endsWith('/emailFrom'))
      .map((i) => i.message);
  const email: FieldDef = { key: 'email', label: 'Email', type: 'email' };

  it('accepts an email field of the same record', () => {
    expect(emailIssues([email, { key: 'login', label: 'Login', type: 'person', emailFrom: 'email' }])).toEqual([]);
  });

  it('refuses an email source that is missing or is not an email field', () => {
    expect(emailIssues([{ key: 'login', label: 'Login', type: 'person', emailFrom: 'email' }])).toHaveLength(1);
    expect(emailIssues([{ key: 'phone', label: 'Phone', type: 'phone' }, { key: 'login', label: 'Login', type: 'person', emailFrom: 'phone' }])).toHaveLength(1);
  });

  it('refuses the setting on a field that is not a person field', () => {
    expect(emailIssues([email, { key: 'note', label: 'Note', type: 'text', emailFrom: 'email' }])).toHaveLength(1);
  });
});

async function personFor(email: string, displayName: string): Promise<string> {
  return (await w.platform.people.add(w.as(w.ngoA), { email, displayName, roles: [] })).userId;
}

/** A complete application: every field is required except address lines 2 and 3. */
const applicant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  firstName: 'Test',
  lastName: 'Applicant',
  title: 'mr',
  gender: 'male',
  dateOfBirth: '1990-05-17',
  email: 'test.applicant@example.org',
  phone: '+91 98000 00000',
  addressLine1: '1 Main Road',
  city: 'Bengaluru',
  pincode: '560001',
  district: 'Bengaluru Urban',
  state: 'Karnataka',
  country: 'India',
  preferredDonation: '500',
  ...over,
});

/**
 * Verifying a request asks for a second manager's approval. Nothing else
 * happens until that manager approves. No person is needed for this step.
 */
async function approveRequest(requestId: string): Promise<void> {
  const ctx = w.as(w.ngoA);
  const current = await w.platform.records.get(ctx, requestId);
  const asked = await w.platform.records.transition(ctx, requestId, 'verify', { expectedVersion: current.version });
  expect(asked.approvalRequestId).toBeTruthy();
  const decided = await w.platform.approvals.decide(w.as(w.ngoA, manager), asked.approvalRequestId!, 'approve');
  expect(decided.status).toBe('approved');
}

/** After approval, Onboard asks for the person created under People, then creates the member and donor. */
async function linkAndComplete(requestId: string, login: string): Promise<void> {
  const ctx = w.as(w.ngoA);
  const current = await w.platform.records.get(ctx, requestId);
  await w.platform.records.transition(ctx, requestId, 'complete', { expectedVersion: current.version, data: { login } });
}

describe('membership requests', () => {
  it('needs one other manager to approve before any person exists, then creates the member and donor for the linked person', async () => {
    const ctx = w.as(w.ngoA);
    const req = await w.platform.records.create(
      ctx,
      'membershipRequest',
      applicant({
        firstName: 'Kavya',
        lastName: 'Rao',
        email: 'kavya.request@example.org',
        phone: '+91 98000 11122',
        addressLine1: '12 Lake View',
        preferredDonation: '1000',
        pan: 'ABCDE1234F',
      }),
    );
    expect(req.record.status).toBe('submitted');
    expect(req.record.number).toMatch(/^MREQ\//);
    expect(req.record.data).toMatchObject({ firstName: 'Kavya', lastName: 'Rao', name: 'Kavya Rao' });
    // The fee box starts ticked on a new request, so the standard fee is raised unless someone unticks it.
    expect(req.record.data.feeApplies).toBe(true);

    // Verifying asks for another manager. The requester cannot approve it, and the request stays submitted.
    const asked = await w.platform.records.transition(ctx, req.record.id, 'verify', { expectedVersion: req.record.version });
    expect(asked.approvalRequestId).toBeTruthy();
    expect((await w.platform.records.get(ctx, req.record.id)).status).toBe('submitted');
    await expect(w.platform.approvals.decide(ctx, asked.approvalRequestId!, 'approve')).rejects.toThrow();

    // Another manager approves. The request is now Approved, and no person exists yet.
    const decided = await w.platform.approvals.decide(w.as(w.ngoA, manager), asked.approvalRequestId!, 'approve');
    expect(decided.status).toBe('approved');
    expect((await w.platform.records.get(ctx, req.record.id)).status).toBe('approved');
    expect((await w.platform.records.list(ctx, 'member')).some((m) => m.data.email === 'kavya.request@example.org')).toBe(false);

    // Only now is the person created under People and linked on the request.
    const userId = await personFor('kavya.request@example.org', 'Kavya Rao');

    // Onboarding without choosing the person is refused, and the request stays approved.
    await expect(
      w.platform.records.transition(ctx, req.record.id, 'complete', { expectedVersion: (await w.platform.records.get(ctx, req.record.id)).version }),
    ).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: '/login' })]) });
    expect((await w.platform.records.get(ctx, req.record.id)).status).toBe('approved');

    // The manager corrects the phone number, then onboards, choosing the person in the step.
    const current = await w.platform.records.get(ctx, req.record.id);
    const edited = await w.platform.records.update(ctx, req.record.id, {
      expectedVersion: current.version,
      data: { phone: '+91 98000 11123' },
    });
    await w.platform.records.transition(ctx, req.record.id, 'complete', { expectedVersion: edited.record.version, data: { login: userId } });
    expect((await w.platform.records.get(ctx, req.record.id)).status).toBe('completed');
    await w.platform.dispatcher.runOnce();

    const members = (await w.platform.records.list(ctx, 'member')).filter((m) => m.data.login === userId);
    expect(members).toHaveLength(1);
    expect(members[0]!.data).toMatchObject({
      phone: '+91 98000 11123',
      designation: 'Member',
      firstName: 'Kavya',
      lastName: 'Rao',
      city: 'Bengaluru',
      pincode: '560001',
    });
    expect(members[0]!.data).not.toHaveProperty('donor');

    const fees = (await w.platform.records.list(ctx, 'membershipFee')).filter((f) => f.data.member === members[0]!.id);
    expect(fees).toHaveLength(1);
    expect(fees[0]!.data).toMatchObject({ amount: 100 });
    expect(fees[0]!.status).toBe('raised');

    const donors = (await w.platform.records.list(ctx, 'donor')).filter((d) => d.data.login === userId);
    expect(donors).toHaveLength(1);
    expect(donors[0]!.data).toMatchObject({
      donorType: 'member',
      monthlyDonation: 1000,
      name: 'Kavya Rao',
      email: 'kavya.request@example.org',
      pan: 'ABCDE1234F',
      city: 'Bengaluru',
    });
    expect(String(donors[0]!.data.address)).toContain('12 Lake View');
    expect(donors[0]!.data).not.toHaveProperty('member');
  });

  it('needs every field except address lines 2 and 3', async () => {
    const ctx = w.as(w.ngoA);
    const required = [
      'firstName', 'lastName', 'title', 'gender', 'dateOfBirth', 'email', 'phone',
      'addressLine1', 'city', 'pincode', 'district', 'state', 'country', 'preferredDonation',
    ];
    for (const key of required) {
      const missing = applicant({ email: `missing.${key.toLowerCase()}@example.org` });
      delete missing[key];
      await expect(w.platform.records.create(ctx, 'membershipRequest', missing), `${key} should be required`).rejects.toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ path: `/${key}` })]),
      });
    }
    const minimal = applicant({ email: 'no.lines@example.org' });
    expect(minimal).not.toHaveProperty('addressLine2');
    expect(minimal).not.toHaveProperty('addressLine3');
    await expect(w.platform.records.create(ctx, 'membershipRequest', minimal)).resolves.toBeTruthy();
  });

  it('a request that is not approved creates no member and no donor', async () => {
    const ctx = w.as(w.ngoA);
    const req = await w.platform.records.create(ctx, 'membershipRequest', applicant({ firstName: 'Declined', email: 'declined.request@example.org', phone: '+91 98000 33344' }));
    const rejected = await w.platform.records.transition(ctx, req.record.id, 'reject', {
      expectedVersion: req.record.version,
      data: { rejectionReason: 'Incomplete address.' },
    });
    expect(rejected.record.status).toBe('rejected');
    expect(rejected.record.data.rejectionReason).toBe('Incomplete address.');
    await w.platform.dispatcher.runOnce();
    const members = await w.platform.records.list(ctx, 'member');
    expect(members.some((m) => m.data.email === 'declined.request@example.org')).toBe(false);
    const donors = await w.platform.records.list(ctx, 'donor');
    expect(donors.some((d) => d.data.email === 'declined.request@example.org')).toBe(false);
  });

  it('a blank designation becomes Member, a waived fee raises nothing, and an existing donor stops a new one being made', async () => {
    const ctx = w.as(w.ngoA);
    const userId = await personFor('waived.request@example.org', 'Waived Fee');
    const req = await w.platform.records.create(
      ctx,
      'membershipRequest',
      applicant({
        firstName: 'Waived',
        lastName: 'Fee',
        email: 'waived.request@example.org',
        phone: '+91 98000 55566',
        designation: 'Treasurer',
        feeApplies: false,
        preferredDonation: 'none',
      }),
    );
    await approveRequest(req.record.id);
    await linkAndComplete(req.record.id, userId);
    await w.platform.dispatcher.runOnce();
    const member = (await w.platform.records.list(ctx, 'member')).find((m) => m.data.login === userId)!;
    expect(member.data.designation).toBe('Treasurer');
    expect((await w.platform.records.list(ctx, 'membershipFee')).some((f) => f.data.member === member.id)).toBe(false);
    // "No monthly donation" leaves the donor without a monthly amount.
    const donor = (await w.platform.records.list(ctx, 'donor')).find((d) => d.data.login === userId)!;
    expect(donor.data.donorType).toBe('member');
    expect(donor.data.monthlyDonation ?? null).toBeNull();

    const oldDonor = await w.platform.records.create(ctx, 'donor', { name: 'Old Friend', email: 'old.friend@example.org' });
    const otherUser = await personFor('old.friend@example.org', 'Old Friend');
    const req2 = await w.platform.records.create(
      ctx,
      'membershipRequest',
      applicant({ firstName: 'Old', lastName: 'Friend', email: 'old.friend@example.org', phone: '+91 98000 77788', existingDonor: oldDonor.record.id }),
    );
    await approveRequest(req2.record.id);
    await linkAndComplete(req2.record.id, otherUser);
    await w.platform.dispatcher.runOnce();
    const donors = (await w.platform.records.list(ctx, 'donor')).filter((d) => d.data.email === 'old.friend@example.org');
    expect(donors).toHaveLength(1);
    expect(donors[0]!.id).toBe(oldDonor.record.id);
  });

  it('raises the monthly donation on the 1st, once, for donors with an amount, and emails them', async () => {
    const ctx = w.as(w.ngoA);
    const giver = await w.platform.records.create(ctx, 'donor', { name: 'Monthly Giver', email: 'monthly.giver@example.org', monthlyDonation: 250 });
    const nonGiver = await w.platform.records.create(ctx, 'donor', { name: 'One Off Giver', email: 'one.off@example.org' });

    // First sighting starts the clock; the next 1st at 03:00 UTC is when donations are raised.
    await w.platform.automations.tick(new Date('2026-10-20T00:00:00Z'));
    const due = await w.platform.automations.tick(new Date('2026-11-01T04:00:00Z'));
    expect(due.automationsRun).toBeGreaterThan(0);

    const donations = (await w.platform.records.list(ctx, 'donation')).filter((d) => d.data.donor === giver.record.id);
    expect(donations).toHaveLength(1);
    expect(donations[0]!.status).toBe('raised');
    expect(donations[0]!.data).toMatchObject({ amount: 250, donorName: 'Monthly Giver', donorEmail: 'monthly.giver@example.org' });
    expect((await w.platform.records.list(ctx, 'donation')).some((d) => d.data.donor === nonGiver.record.id)).toBe(false);

    // A second run in the same month does nothing.
    await w.platform.automations.tick(new Date('2026-11-01T05:00:00Z'));
    expect((await w.platform.records.list(ctx, 'donation')).filter((d) => d.data.donor === giver.record.id)).toHaveLength(1);
  });
});
