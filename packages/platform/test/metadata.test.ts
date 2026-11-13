import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordTypeDef, WorkflowDef } from '../src/runtime/definitions/types.js';
import { admin, clerk, createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const volunteer: RecordTypeDef = {
  key: 'volunteer',
  label: 'Volunteer',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'hours', label: 'Hours', type: 'number', min: 0 },
  ],
};

describe('NGO-owned definitions', () => {
  it('creates a new record type through draft and publish, with no code', async () => {
    const ctx = w.as(w.ngoA);
    expect(await w.platform.definitions.saveDraft(ctx, 'recordType', volunteer)).toBe(1);
    const published = await w.platform.definitions.publish(ctx, 'recordType', 'volunteer');
    expect(published).toMatchObject({ version: 1, owner: 'tenant' });

    const { record } = await w.platform.records.create(ctx, 'volunteer', { name: 'Meera', hours: 4 });
    expect(record).toMatchObject({ schemaVersion: 1, data: { name: 'Meera', hours: 4 } });

    expect(await w.platform.definitions.get(w.ngoB, 'recordType', 'volunteer')).toBeUndefined();
    expect(await w.platform.records.list(ctx, 'volunteer', { search: 'Meer' })).toHaveLength(1);
    expect(await w.platform.records.list(ctx, 'volunteer', { search: 'nobody' })).toHaveLength(0);
  });

  it('keeps old versions so historical records keep their schema, and rolls back', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'recordType', {
      ...volunteer,
      fields: [...volunteer.fields, { key: 'skill', label: 'Skill', type: 'text', required: true }],
    });
    await w.platform.definitions.publish(ctx, 'recordType', 'volunteer');

    const old = (await w.platform.records.list(ctx, 'volunteer'))[0]!;
    expect(old.schemaVersion).toBe(1);
    expect((await w.platform.definitions.getVersion(w.ngoA, 'recordType', 'volunteer', 1))?.body.fields).toHaveLength(2);
    await expectCode(w.platform.records.create(ctx, 'volunteer', { name: 'Kabir' }), 'validation_failed');

    const rolled = await w.platform.definitions.rollback(ctx, 'recordType', 'volunteer', 1);
    expect(rolled.version).toBe(3);
    await w.platform.records.create(ctx, 'volunteer', { name: 'Kabir' });
    const history = await w.platform.definitions.history(w.ngoA, 'recordType', 'volunteer');
    expect(history.map((h) => [h.version, h.status])).toEqual([
      [1, 'superseded'],
      [2, 'superseded'],
      [3, 'published'],
    ]);
  });

  it('rejects invalid definitions and broken references before publishing', async () => {
    const ctx = w.as(w.ngoA);
    await expectCode(
      w.platform.definitions.saveDraft(ctx, 'recordType', { key: 'Bad Key', label: 'x', fields: [] } as never),
      'definition_invalid',
    );
    const wf: WorkflowDef = {
      key: 'shift',
      recordType: 'shift',
      initial: 'open',
      states: [{ key: 'open', label: 'Open' }],
      transitions: [],
    };
    await w.platform.definitions.saveDraft(ctx, 'workflow', wf);
    const err = await expectCode(w.platform.definitions.publish(ctx, 'workflow', 'shift'), 'definition_invalid');
    expect((err as unknown as { issues: { message: string }[] }).issues[0]!.message).toMatch(/not published/);

    await w.platform.definitions.saveDraft(ctx, 'recordType', {
      key: 'shift',
      label: 'Shift',
      fields: [{ key: 'total', label: 'Total', type: 'number', calculated: 'record.a +' }],
    });
    await expectCode(w.platform.definitions.publish(ctx, 'recordType', 'shift'), 'definition_invalid');
  });

  it('publishes an organisation theme and refuses anything that is not a token', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'theme', { key: 'organisation', brand: '#0f5c4c', radius: '8px' });
    await w.platform.definitions.publish(ctx, 'theme', 'organisation');
    expect((await w.platform.definitions.get(w.ngoA, 'theme', 'organisation'))?.body.brand).toBe('#0f5c4c');
    await expectCode(w.platform.definitions.saveDraft(ctx, 'theme', { key: 'organisation', brand: 'red' }), 'definition_invalid');
  });

  it('requires configuration permissions', async () => {
    await expectCode(w.platform.definitions.saveDraft(w.as(w.ngoA, clerk), 'recordType', volunteer), 'forbidden');
  });
});

describe('shipped modules and extension patches', () => {
  it('lets an NGO adjust a shipped definition without forking it', async () => {
    const ctx = w.as(w.ngoA);
    await expectCode(
      w.platform.definitions.saveDraft(ctx, 'recordType', { key: 'donation', label: 'x', fields: volunteer.fields }),
      'forbidden',
    );
    const patched = await w.platform.definitions.setExtensionPatch(ctx, 'recordType', 'donation', {
      fields: [
        { key: 'donorName', label: 'Contributor name' },
        { key: 'campaign', label: 'Campaign', type: 'text' },
      ],
    });
    expect(patched.owner).toBe('base');
    expect(patched.baseVersion).toBe(1);
    expect(patched.body.fields.find((f) => f.key === 'donorName')?.label).toBe('Contributor name');

    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'X', amount: 10, campaign: 'Diwali' });
    expect(record.data.campaign).toBe('Diwali');
    await expectCode(
      w.platform.records.create(w.as(w.ngoB), 'donation', { donorName: 'X', amount: 10, campaign: 'Diwali' }),
      'validation_failed',
    );
  });

  it('re-applies the patch when the product ships a new base version', async () => {
    const pkg = await w.platform.publishShippedModule('donations');
    const base = pkg.definitions.find((d) => d.kind === 'recordType' && d.body.key === 'donation')!.body as RecordTypeDef;
    await w.platform.definitions.publishBase(
      'recordType',
      { ...base, fields: [...base.fields, { key: 'giftAid', label: 'Matched by employer', type: 'boolean' }] },
      'donations',
    );
    const result = await w.platform.definitions.enableModule(w.as(w.ngoA, admin), pkg.manifest);
    expect(result.materialised).toContain('recordType|donation');

    const effective = (await w.platform.definitions.get(w.ngoA, 'recordType', 'donation'))!;
    expect(effective.baseVersion).toBe(2);
    const keys = effective.body.fields.map((f) => f.key);
    expect(keys).toContain('giftAid');
    expect(keys).toContain('campaign');
    expect(effective.body.fields.find((f) => f.key === 'donorName')?.label).toBe('Contributor name');
  });

  it('restores an earlier patched version as the newest one, keeping the current module version', async () => {
    const ctx = w.as(w.ngoA);
    const gifts = await w.platform.definitions.setExtensionPatch(ctx, 'listView', 'donations', { label: 'Gifts' });
    await w.platform.definitions.setExtensionPatch(ctx, 'listView', 'donations', { label: 'Contributions' });

    const restored = await w.platform.definitions.rollback(ctx, 'listView', 'donations', gifts.version);
    expect(restored).toMatchObject({ owner: 'base', baseVersion: gifts.baseVersion });
    expect(restored.version).toBeGreaterThan(gifts.version + 1);
    expect(restored.body.label).toBe('Gifts');

    const live = (await w.platform.definitions.get(w.ngoA, 'listView', 'donations'))!;
    expect(live).toMatchObject({ version: restored.version, body: { label: 'Gifts' } });
    expect((await w.platform.definitions.baseAndPatch(ctx, 'listView', 'donations'))?.patch).toEqual({ label: 'Gifts' });
    const history = await w.platform.definitions.history(w.ngoA, 'listView', 'donations');
    expect(history.filter((h) => h.status === 'published').map((h) => h.version)).toEqual([restored.version]);
  });

  it('rejects a patch that breaks the definition', async () => {
    await expectCode(
      w.platform.definitions.setExtensionPatch(w.as(w.ngoA), 'recordType', 'donation', {
        fields: [{ key: 'amount', type: 'colour' }],
      }),
      'definition_invalid',
    );
    await expectCode(
      w.platform.definitions.setExtensionPatch(w.as(w.ngoA), 'recordType', 'donation', { key: 'other' }),
      'definition_invalid',
    );
  });
});
