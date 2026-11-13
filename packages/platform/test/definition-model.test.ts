import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { resolveRecordGroups } from '../src/runtime/definitions/record-groups.js';
import type { DefinitionBodies, DefinitionKind, ListViewDef, RecordTypeDef } from '../src/runtime/definitions/types.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
const writer: Actor = {
  id: 'writer-1',
  roles: ['writer'],
  permissions: ['record:gift:create', 'record:gift:read', 'record:gift:update', 'record:sponsor:read', 'record:sponsor:create'],
};
const blind: Actor = { id: 'blind-1', roles: ['blind'], permissions: ['record:gift:create', 'record:gift:read'] };

const sponsor: RecordTypeDef = {
  key: 'sponsor',
  label: 'Sponsor',
  titleField: 'name',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'about', label: 'About', type: 'longText' },
    { key: 'level', label: 'Level', type: 'number' },
  ],
};
const gift: RecordTypeDef = {
  key: 'gift',
  label: 'Gift',
  fields: [
    { key: 'sponsor', label: 'Sponsor', type: 'reference', referenceType: 'sponsor' },
    { key: 'sponsorName', label: 'Sponsor name', type: 'text', copyFrom: { reference: 'sponsor', field: 'name' }, editableWhen: 'isEmpty(record.sponsor)' },
    { key: 'sponsorEmail', label: 'Sponsor email', type: 'email', copyFrom: { reference: 'sponsor', field: 'email' } },
    { key: 'note', label: 'Note', type: 'longText', copyFrom: { reference: 'sponsor', field: 'about' } },
    { key: 'amount', label: 'Amount', type: 'money' },
  ],
};

async function publish<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<void> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, kind, body);
  await w.platform.definitions.publish(ctx, kind, body.key);
}

async function publishIssues<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<string> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, kind, body);
  const err = await expectCode(w.platform.definitions.publish(ctx, kind, body.key), 'definition_invalid');
  return (err as unknown as { issues: { path: string; message: string }[] }).issues.map((i) => `${i.path} ${i.message}`).join(' | ');
}

beforeAll(async () => {
  w = await createWorld();
  await publish('recordType', sponsor);
  await publish('recordType', gift);
});
afterAll(() => w.close());

describe('copy from a chosen record', () => {
  const ctx = () => w.as(w.ngoA, writer);
  const newSponsor = (name: string, email?: string, about?: string) =>
    w.platform.records.create(w.as(w.ngoA), 'sponsor', { name, email, about }).then((r) => r.record);

  it('fills the copied fields on create, over anything typed', async () => {
    const s = await newSponsor('Meera', 'meera@example.org', 'Long-time supporter');
    const { record } = await w.platform.records.create(ctx(), 'gift', { sponsor: s.id, sponsorName: 'Typed', amount: 10 });
    expect(record.data).toMatchObject({ sponsorName: 'Meera', sponsorEmail: 'meera@example.org', note: 'Long-time supporter' });
  });

  it('copies again when the choice changes, and an empty source clears the target', async () => {
    const a = await newSponsor('Anil', 'anil@example.org');
    const b = await newSponsor('Bina');
    const { record } = await w.platform.records.create(ctx(), 'gift', { sponsor: a.id });
    const changed = await w.platform.records.update(ctx(), record.id, { expectedVersion: 1, data: { sponsor: b.id } });
    expect(changed.record.data.sponsorName).toBe('Bina');
    expect(changed.record.data).not.toHaveProperty('sponsorEmail');
  });

  it('keeps the details as they were while the choice stays the same', async () => {
    const s = await newSponsor('Chetan', 'old@example.org');
    const { record } = await w.platform.records.create(ctx(), 'gift', { sponsor: s.id });
    await w.platform.records.update(w.as(w.ngoA), s.id, { expectedVersion: 1, data: { email: 'new@example.org' } });
    const again = await w.platform.records.update(ctx(), record.id, { expectedVersion: 1, data: { sponsor: s.id, amount: 5 } });
    expect(again.record.data.sponsorEmail).toBe('old@example.org');
  });

  it('keeps typed details when no record is chosen', async () => {
    const { record } = await w.platform.records.create(ctx(), 'gift', { sponsorName: 'Walk-in', sponsorEmail: 'w@example.org' });
    expect(record.data).toMatchObject({ sponsorName: 'Walk-in', sponsorEmail: 'w@example.org' });
  });

  it('refuses a choice the person cannot see', async () => {
    const s = await newSponsor('Deepa');
    const err = await expectCode(w.platform.records.create(w.as(w.ngoA, blind), 'gift', { sponsor: s.id }), 'validation_failed');
    expect((err as unknown as { issues: { path: string; message: string }[] }).issues).toEqual([
      { path: '/sponsor', message: 'cannot be chosen: you cannot see these records' },
    ]);
  });

  it('refuses a record of another type, a deleted record, or one from another organisation', async () => {
    const otherType = await w.platform.records.create(w.as(w.ngoA), 'gift', { amount: 1 });
    const gone = await newSponsor('Gone');
    await w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`update record set deleted_at = now() where id = $1`, [gone.id]));
    await publishOther();
    const foreign = await w.platform.records.create(w.as(w.ngoB), 'sponsor', { name: 'Elsewhere' });
    for (const id of [otherType.record.id, gone.id, foreign.record.id]) {
      const err = await expectCode(w.platform.records.create(ctx(), 'gift', { sponsor: id }), 'validation_failed');
      expect((err as unknown as { issues: { path: string; message: string }[] }).issues).toEqual([{ path: '/sponsor', message: 'was not found' }]);
    }
  });
});

async function publishOther(): Promise<void> {
  const ctx = w.as(w.ngoB);
  await w.platform.definitions.saveDraft(ctx, 'recordType', sponsor);
  await w.platform.definitions.publish(ctx, 'recordType', 'sponsor');
}

describe('record groups', () => {
  it('orders groups, keeps readable types in their first group, hides empty groups, and lists the rest under Other', () => {
    const groups = resolveRecordGroups(
      [
        { key: 'late', label: 'Late', order: 20, recordTypes: ['c', 'a'] },
        { key: 'early', label: 'Early', order: 10, recordTypes: ['a', 'secret'] },
        { key: 'none', label: 'Nothing readable', recordTypes: ['secret'] },
        { key: 'beta', label: 'Beta', order: 20, recordTypes: ['b'] },
      ],
      ['a', 'b', 'c', 'd'],
    );
    expect(groups).toEqual([
      { key: 'early', label: 'Early', recordTypes: ['a'] },
      { key: 'beta', label: 'Beta', recordTypes: ['b'] },
      { key: 'late', label: 'Late', recordTypes: ['c'] },
      { key: 'other', label: 'Other', recordTypes: ['d'] },
    ]);
  });

  it('are served per person in the runtime definitions', async () => {
    await publish('recordGroup', { key: 'giving', label: 'Giving', order: 1, recordTypes: ['gift', 'sponsor'] });
    const app = buildServer(w.platform, { devAuth: true });
    const get = async (actor: Actor) =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/runtime/definitions',
          headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) },
        })
      ).json().recordGroups;
    expect(await get(blind)).toEqual([{ key: 'giving', label: 'Giving', recordTypes: ['gift'] }]);
    const all = await get({ id: 'admin-1', roles: ['admin'], permissions: ['*'] });
    expect(all[0]).toEqual({ key: 'giving', label: 'Giving', recordTypes: ['gift', 'sponsor'] });
    expect(all.at(-1).key).not.toBe('giving');
    await app.close();
  });

  it('refuses groups naming record types that are not published', async () => {
    expect(await publishIssues('recordGroup', { key: 'ghosts', label: 'Ghosts', recordTypes: ['gift', 'ghost'] })).toContain(
      "/recordTypes/1 record type 'ghost' is not published",
    );
  });

  it('checks the shape against the schema', () => {
    expect(w.platform.schemas.validate('recordGroup', { key: 'g', label: 'G', recordTypes: [] })).not.toEqual([]);
    expect(w.platform.schemas.validate('recordGroup', { key: 'g', label: 'G', recordTypes: ['a'], extra: 1 })).not.toEqual([]);
    expect(w.platform.schemas.validate('recordGroup', { key: 'g', label: 'G', order: 2, recordTypes: ['a'] })).toEqual([]);
  });
});

describe('definition checks for copy from, related sections, and compact columns', () => {
  it('checks copy from', async () => {
    const messages = await publishIssues('recordType', {
      key: 'badcopy',
      label: 'Bad copy',
      fields: [
        { key: 'sponsor', label: 'Sponsor', type: 'reference', referenceType: 'sponsor' },
        { key: 'ghostRef', label: 'Ghost', type: 'reference', referenceType: 'ghost' },
        { key: 'plain', label: 'Plain', type: 'text' },
        { key: 'a', label: 'A', type: 'text', copyFrom: { reference: 'plain', field: 'name' } },
        { key: 'b', label: 'B', type: 'text', copyFrom: { reference: 'ghostRef', field: 'name' } },
        { key: 'c', label: 'C', type: 'text', copyFrom: { reference: 'sponsor', field: 'nothing' } },
        { key: 'd', label: 'D', type: 'text', copyFrom: { reference: 'sponsor', field: 'level' } },
        { key: 'e', label: 'E', type: 'number', calculated: '1', copyFrom: { reference: 'sponsor', field: 'level' } },
        { key: 'f', label: 'F', type: 'longText', copyFrom: { reference: 'sponsor', field: 'name' } },
      ],
    });
    for (const m of [
      "/fields/3/copyFrom/reference 'plain' is not a reference field of this record type",
      "/fields/4/copyFrom/reference record type 'ghost' is not published",
      "/fields/5/copyFrom/field 'sponsor' has no field 'nothing'",
      "/fields/6/copyFrom/field 'level' is number but this field is text",
      '/fields/7/copyFrom calculated fields cannot also be copied',
    ]) {
      expect(messages).toContain(m);
    }
    expect(messages).not.toContain('/fields/8');
  });

  it('checks related sections and compact columns', async () => {
    const view: ListViewDef = {
      key: 'sponsors',
      recordType: 'sponsor',
      compactColumns: ['name', 'ghost'],
      detail: {
        sections: [
          { label: 'Sponsor', fields: ['name'] },
          { label: 'Gifts', related: { recordType: 'gift', field: 'sponsorName', total: 'note' } },
          { label: 'Ghosts', related: { recordType: 'ghost', field: 'x' } },
        ],
      },
    };
    const messages = await publishIssues('listView', view);
    for (const m of [
      "/compactColumns/1 unknown field 'ghost'",
      "/detail/sections/1/related/field 'sponsorName' is not a reference to 'sponsor' on 'gift'",
      "/detail/sections/1/related/total 'note' is not a number or money field of 'gift'",
      "/detail/sections/2/related/recordType record type 'ghost' is not published",
    ]) {
      expect(messages).toContain(m);
    }
    await publish('listView', {
      ...view,
      compactColumns: ['name', 'email'],
      detail: { sections: [{ label: 'Gifts', related: { recordType: 'gift', field: 'sponsor', total: 'amount' } }] },
    });
  });

  it('refuses sensitive compact columns and more than six', async () => {
    expect(
      await publishIssues('listView', { key: 'compactpan', recordType: 'donation', compactColumns: ['donorPan'] }),
    ).toContain("/compactColumns/0 sensitive field 'donorPan' cannot be a column");
    const seven = ['number', 'status', 'createdAt', 'updatedAt', 'donorName', 'amount', 'method'];
    expect(w.platform.schemas.validate('listView', { key: 'v', recordType: 'donation', compactColumns: seven })).not.toEqual([]);
  });

  it('refuses a section that mixes fields and related records', () => {
    expect(
      w.platform.schemas.validate('listView', {
        key: 'v',
        recordType: 'sponsor',
        detail: { sections: [{ label: 'Mixed', fields: ['name'], related: { recordType: 'gift', field: 'sponsor' } }] },
      }),
    ).not.toEqual([]);
  });
});
