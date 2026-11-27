import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { parseCell } from '../../../packages/platform/src/application/shared/import-cells.js';
import type { FieldDef } from '../../../packages/platform/src/shared/definitions/types.js';
import { admin, createWorld, expectCode, type TestWorld } from '../../support/platform/helpers.js';

/** A choice field whose options are the organisation's active money accounts. */

let w: TestWorld;
const viewer = { id: 'viewer-1', roles: ['viewer'], permissions: ['record:voucher:read'] };

const voucher = {
  key: 'voucher',
  label: 'Voucher',
  numbering: { sequence: 'voucher', format: 'V/{seq:3}', reset: 'never' },
  titleField: 'title',
  fields: [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'account', label: 'Paid from', type: 'choice', choicesFrom: 'moneyAccounts' },
  ],
};

const publishType = async (body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), 'recordType', body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), 'recordType', String(body.key));
};

beforeAll(async () => {
  w = await createWorld();
  await publishType(voucher);
  await w.platform.moneyAccounts.open(w.as(w.ngoA), { key: 'project', name: 'Project bank (HDFC)', kind: 'bank' });
});
afterAll(() => w.close());

const served = async () => {
  const app = buildServer(w.platform, { devAuth: true });
  const res = await app.inject({ method: 'GET', url: '/api/runtime/definitions', headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(viewer) } });
  await app.close();
  expect(res.statusCode).toBe(200);
  return (res.json().recordTypes as { key: string; fields: FieldDef[] }[]).find((t) => t.key === 'voucher')!.fields.find((f) => f.key === 'account')!;
};

describe('a field that takes its choices from money accounts', () => {
  it('is served with the active accounts: the ledger code as the value, the name as the label', async () => {
    const field = await served();
    expect(field.choicesFrom).toBe('moneyAccounts');
    expect(field.choices).toEqual([
      { value: 'BANK', label: 'Main bank account' },
      { value: 'BANK_PROJECT', label: 'Project bank (HDFC)' },
      { value: 'CASH', label: 'Cash in hand' },
    ]);
  });

  it('follows accounts as they open and close, with no new version of the form', async () => {
    const version = (await w.platform.definitions.get(w.ngoA, 'recordType', 'voucher'))!.version;
    await w.platform.moneyAccounts.open(w.as(w.ngoA), { key: 'wallet', name: 'Ravi wallet', kind: 'wallet' });
    expect((await served()).choices!.map((c) => c.label)).toContain('Ravi wallet');
    await w.platform.moneyAccounts.close(w.as(w.ngoA), 'wallet');
    expect((await served()).choices!.map((c) => c.label)).not.toContain('Ravi wallet');
    expect((await w.platform.definitions.get(w.ngoA, 'recordType', 'voucher'))!.version).toBe(version);
  });

  it('keeps the stored definition free of the accounts', async () => {
    const stored = (await w.platform.definitions.get(w.ngoA, 'recordType', 'voucher'))!.body.fields.find((f) => f.key === 'account')!;
    expect(stored.choices).toBeUndefined();
  });

  it('accepts an active account, leaves the field optional, and refuses any other value', async () => {
    const ctx = w.as(w.ngoA, admin);
    expect((await w.platform.records.create(ctx, 'voucher', { title: 'A', account: 'BANK_PROJECT' })).record.data).toMatchObject({ account: 'BANK_PROJECT' });
    expect((await w.platform.records.create(ctx, 'voucher', { title: 'B' })).record.data).not.toHaveProperty('account');
    const refused = await expectCode(w.platform.records.create(ctx, 'voucher', { title: 'C', account: 'NOWHERE' }), 'validation_failed');
    expect(refused.message).toMatch(/not valid/i);
    await expectCode(w.platform.records.create(ctx, 'voucher', { title: 'D', account: 'DONATION_INCOME' }), 'validation_failed');
  });

  it('refuses a closed account for a new value, but lets a record that holds it be edited', async () => {
    const ctx = w.as(w.ngoA, admin);
    await w.platform.moneyAccounts.open(ctx, { key: 'old', name: 'Old wallet', kind: 'wallet' });
    const { record } = await w.platform.records.create(ctx, 'voucher', { title: 'Old', account: 'WALLET_OLD' });
    await w.platform.moneyAccounts.close(ctx, 'old');
    await expectCode(w.platform.records.create(ctx, 'voucher', { title: 'New', account: 'WALLET_OLD' }), 'validation_failed');
    const edited = await w.platform.records.update(ctx, record.id, { data: { title: 'Old, renamed' }, expectedVersion: record.version });
    expect(edited.record.data).toMatchObject({ title: 'Old, renamed', account: 'WALLET_OLD' });
    await expectCode(
      w.platform.records.update(ctx, record.id, { data: { account: 'NOWHERE' }, expectedVersion: edited.record.version }),
      'validation_failed',
    );
  });

  it('reads a cell of an import as the account text, to be checked when the record is saved', () => {
    const field = { key: 'account', label: 'Paid from', type: 'choice', choicesFrom: 'moneyAccounts' } as FieldDef;
    expect(parseCell(field, ' BANK ')).toEqual({ value: 'BANK' });
  });
});

describe('publishing such a field', () => {
  const field = (extra: Record<string, unknown>, type = 'choice') => ({
    ...voucher,
    key: 'checked',
    numbering: { sequence: 'checked', format: 'C/{seq:3}', reset: 'never' },
    fields: [{ key: 'title', label: 'Title', type: 'text', required: true }, { key: 'account', label: 'Paid from', type, ...extra }],
  });

  it('is refused on a field that is not a choice, or that also lists its own choices', async () => {
    await expectCode(publishType(field({ choicesFrom: 'moneyAccounts' }, 'text')), 'definition_invalid');
    await expectCode(publishType(field({ choicesFrom: 'moneyAccounts', choices: [{ value: 'a', label: 'A' }] })), 'definition_invalid');
    await expectCode(publishType(field({ choicesFrom: 'somewhereElse' })), 'definition_invalid');
  });

  it('still needs a choice when there is no source', async () => {
    await expectCode(publishType(field({})), 'definition_invalid');
  });
});
