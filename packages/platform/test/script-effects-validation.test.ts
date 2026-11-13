import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCHEMA_DIR } from '../src/platform.js';
import { describe, expect, it } from 'vitest';
import { SchemaRegistry } from '../src/runtime/definitions/schema-registry.js';
import { type EffectPolicy, ScriptEffectsValidator } from '../src/runtime/scripts/effects.js';

const validator = new ScriptEffectsValidator(SCHEMA_DIR);
const policy: EffectPolicy = {
  hook: 'afterSave',
  allow: ['ledger.propose', 'records.create', 'notify', 'connector.call'],
  connectors: ['tally'],
  accounts: ['1100', '4100'],
  maxTotalAmount: '100000.00',
};
const journal = (lines: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'ledger.propose', date: '2026-10-26', lines, ...extra });
const balanced = journal([
  { account: '1100', debit: '1500' },
  { account: '4100', credit: 1500, fund: 'general' },
]);
const messages = (output: unknown, p: EffectPolicy = policy) => validator.check(output, p).issues.map((i) => `${i.path} ${i.message}`);

describe('script effects schema', () => {
  it('accepts every effect type and normalises journal amounts', () => {
    const out = validator.check(
      {
        effects: [
          balanced,
          { type: 'records.create', recordType: 'thankYouCall', data: { donor: 'abc', due: '2026-11-01' } },
          { type: 'notify', template: 'donationThanks', to: { field: 'donor' }, channels: ['email'], values: { campaign: 'Diwali' } },
          { type: 'connector.call', connector: 'tally', body: { voucher: 'R-12' } },
        ],
      },
      policy,
    );
    expect(out.issues).toEqual([]);
    expect(out.totalPaise).toBe(150000);
    expect(out.effects.map((e) => e.type)).toEqual(['ledger.propose', 'records.create', 'notify', 'connector.call']);
    expect(out.effects[0]).toMatchObject({ lines: [{ debit: '1500.00' }, { credit: '1500.00', fund: 'general' }] });
  });

  it('treats an empty list as no effects, so existing before-save scripts are unchanged', () => {
    expect(validator.check({ record: { amount: 1 }, effects: [] }, { hook: 'beforeSave', allow: [] })).toEqual({
      record: { amount: 1 },
      effects: [],
      totalPaise: 0,
      issues: [],
    });
  });

  it('refuses malformed effects', () => {
    for (const bad of [
      { effects: [{ type: 'ledger.post', date: '2026-10-26', lines: [] }] },
      { effects: [journal([{ account: '1100', debit: '1' }])] },
      { effects: [journal([{ account: '1100', debit: '1', credit: '1' }, { account: '4100', credit: '1' }])] },
      { effects: [journal([{ account: '1100', debit: '1.005' }, { account: '4100', credit: '1.005' }])] },
      { effects: [journal([{ account: '1100', debit: '-1' }, { account: '4100', credit: '-1' }])] },
      { effects: [{ ...balanced, sourceRecordId: 'other' }] },
      { effects: [{ type: 'records.create', recordType: 'Bad Type', data: {} }] },
      { effects: [{ type: 'notify', template: 'x', to: { email: 'someone@example.org' } }] },
      { effects: [{ type: 'notify', template: 'x', to: {} }] },
      { effects: [{ type: 'connector.call', connector: 'tally', body: { x: 1 }, url: 'https://example.org' }] },
      { effects: Array.from({ length: 21 }, () => balanced) },
      { record: {} },
    ]) {
      expect(messages(bad), JSON.stringify(bad).slice(0, 80)).not.toEqual([]);
    }
  });

  it('is published with the other schemas without changing how definitions validate', async () => {
    const schema = JSON.parse(await readFile(join(SCHEMA_DIR, 'scriptEffects.schema.json'), 'utf8'));
    expect(schema.$id).toBe('scriptEffects');
    const registry = new SchemaRegistry(SCHEMA_DIR);
    const script = { key: 'thanks', recordType: 'donation', hook: 'beforeSave', code: 'ctx.record.x = 1;' };
    expect(registry.validate('script', script)).toEqual([]);
    expect(registry.validate('script', { ...script, hook: 'afterSave' })).toEqual([]);
    expect(registry.validate('script', { ...script, hook: 'onDelete' })).not.toEqual([]);
  });
});

describe('core-rule pre-checks', () => {
  it('rejects an unbalanced journal before it reaches the ledger', () => {
    expect(messages({ effects: [journal([{ account: '1100', debit: '1500.00' }, { account: '4100', credit: '1499.99' }])] })).toEqual([
      '/effects/0/lines journal does not balance: debits 1500.00, credits 1499.99',
    ]);
  });

  it('rejects zero amounts and impossible dates', () => {
    expect(messages({ effects: [journal([{ account: '1100', debit: 0 }, { account: '4100', credit: '0' }], { date: '2026-02-30' })] })).toEqual([
      '/effects/0/date is not a real date',
      '/effects/0/lines/0/debit must be a positive amount with at most two decimals',
      '/effects/0/lines/1/credit must be a positive amount with at most two decimals',
    ]);
  });

  it('caps the total of proposed journals at the declared amount, and requires one', () => {
    expect(messages({ effects: [balanced, balanced] }, { ...policy, maxTotalAmount: '2999.99' })).toEqual([
      "/effects proposed journals total 3000.00, above the script's limit of 2999.99",
    ]);
    expect(messages({ effects: [balanced] }, { ...policy, maxTotalAmount: undefined })).toEqual([
      '/effects the script must declare a maximum total amount to propose journal entries',
    ]);
  });

  it('allows only declared effect types, accounts and connectors', () => {
    expect(messages({ effects: [balanced] }, { ...policy, allow: ['notify'] })).toEqual(["/effects/0/type the script does not declare 'ledger.propose' effects"]);
    expect(messages({ effects: [balanced] }, { ...policy, accounts: ['1100'] })).toEqual(["/effects/0/lines/1/account the script does not declare account '4100'"]);
    expect(messages({ effects: [{ type: 'connector.call', connector: 'bank', body: {} }] })).toEqual(["/effects/0/connector the script does not declare connector 'bank'"]);
  });

  it('allows effects and record changes only on hooks that take them', () => {
    expect(messages({ effects: [balanced] }, { ...policy, hook: 'validate' })).toEqual(['/effects the validate hook cannot propose effects']);
    expect(messages({ effects: [balanced] }, { ...policy, hook: 'workflowGuard' })).toEqual(['/effects the workflowGuard hook cannot propose effects']);
    expect(messages({ record: {}, effects: [] }, { ...policy, hook: 'afterSave' })).toEqual(['/record the afterSave hook cannot change the record']);
    expect(messages({ record: {}, effects: [balanced] }, { ...policy, hook: 'customButton' })).toEqual([]);
  });

  it('honours a lower per-run limit and never a higher one', () => {
    expect(messages({ effects: [balanced, balanced] }, { ...policy, maxEffects: 1 })).toEqual(['/effects at most 1 effects per run']);
    expect(validator.check({ effects: Array.from({ length: 20 }, () => balanced) }, { ...policy, maxEffects: 99, maxTotalAmount: '100000' }).issues).toEqual([]);
  });

  it('returns no effects at all when any one is refused', () => {
    const out = validator.check({ effects: [balanced, { type: 'connector.call', connector: 'bank', body: {} }] }, policy);
    expect(out.effects).toEqual([]);
    expect(out.issues).toHaveLength(1);
  });
});
