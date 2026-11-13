import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEvent } from '../src/infrastructure/postgres/stores/audit-store.js';
import type { RecordTypeDef } from '../src/runtime/definitions/types.js';
import { admin, createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;

const donor: RecordTypeDef = {
  key: 'followDonor',
  label: 'Follow donor',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
  ],
};
const gift: RecordTypeDef = {
  key: 'followGift',
  label: 'Follow gift',
  fields: [
    { key: 'donor', label: 'Donor', type: 'reference', referenceType: 'followDonor' },
    { key: 'ownerName', label: 'Owner name', type: 'text', follow: { via: 'donor', field: 'name' } },
    { key: 'snapshot', label: 'Snapshot', type: 'text', copyFrom: { reference: 'donor', field: 'name' } },
    { key: 'holder', label: 'Holder', type: 'person' },
    { key: 'holderName', label: 'Holder name', type: 'text', follow: { via: 'holder', field: 'name' } },
  ],
};

async function publish(body: RecordTypeDef): Promise<void> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, 'recordType', body);
  await w.platform.definitions.publish(ctx, 'recordType', body.key);
}

beforeAll(async () => {
  w = await createWorld();
  await publish(donor);
  await publish(gift);
});
afterAll(() => w.close());

describe('a field that follows a record', () => {
  it('updates when the source is saved, including records that already pointed at it, and leaves a snapshot alone', async () => {
    const ctx = w.as(w.ngoA);
    const source = await w.platform.records.create(ctx, 'followDonor', { name: 'Meera', email: 'meera@example.org' });
    const linked = await w.platform.records.create(ctx, 'followGift', { donor: source.record.id });
    expect(linked.record.data).toMatchObject({ ownerName: 'Meera', snapshot: 'Meera' });
    await w.platform.records.update(ctx, source.record.id, { expectedVersion: source.record.version, data: { name: 'Meera Nair' } });
    await w.platform.dispatcher.runOnce();
    const after = await w.platform.records.get(ctx, linked.record.id);
    expect(after.data.ownerName).toBe('Meera Nair');
    expect(after.data.snapshot).toBe('Meera');
  });
});

describe('a field that follows an account', () => {
  it('is filled when the person field is set, and updates when that member name changes', async () => {
    const ctx = w.as(w.ngoA);
    const { userId } = await w.platform.people.add(ctx, { email: 'kabir.follow@example.org', displayName: 'Kabir Shah', roles: [] });
    await w.platform.dispatcher.runOnce();
    const created = await w.platform.records.create(ctx, 'followGift', { holder: userId });
    expect(created.record.data.holderName).toBe('Kabir Shah');
    await w.platform.dispatcher.runOnce();
    await w.platform.db.withTenant(w.ngoA, async (tx) => {
      await tx.query(`update tenant_member set display_name = $1 where user_id = $2`, ['Kabir S.', userId]);
      await enqueueEvent(tx, 'user.updated', { userId, name: 'Kabir S.', email: 'kabir.follow@example.org' });
    });
    await w.platform.dispatcher.runOnce();
    const after = await w.platform.records.get(ctx, created.record.id);
    expect(after.data.holderName).toBe('Kabir S.');
  });
});
