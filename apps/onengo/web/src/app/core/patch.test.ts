import { describe, expect, it } from 'vitest';
import { applyExtensionPatch } from './server';
import { makePatch } from './patch';

const base = {
  key: 'donation',
  label: 'Donation',
  titleField: 'donorName',
  fields: [
    { key: 'donorName', label: 'Donor name', type: 'text', required: true },
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'notes', label: 'Notes', type: 'longText' },
  ],
  rules: [{ key: 'r1', expression: 'record.amount > 0', message: 'Positive' }],
};

describe('makePatch round-trips through applyExtensionPatch', () => {
  it('returns undefined when nothing changed', () => {
    expect(makePatch(base, structuredClone(base))).toBeUndefined();
  });

  it('produces a minimal keyed patch for label, field edits, additions, and removals', () => {
    const edited = structuredClone(base);
    edited.label = 'Contribution';
    edited.fields[0]!.label = 'Supporter';
    edited.fields = edited.fields.filter((f) => f.key !== 'notes');
    edited.fields.push({ key: 'campaign', label: 'Campaign', type: 'text' } as (typeof edited.fields)[number]);
    const patch = makePatch(base, edited);
    expect(patch).toEqual({
      label: 'Contribution',
      fields: [
        { key: 'donorName', label: 'Supporter' },
        { key: 'notes', $delete: true },
        { key: 'campaign', label: 'Campaign', type: 'text' },
      ],
    });
    expect(applyExtensionPatch(base, patch)).toEqual(edited);
  });

  it('removes properties with null and handles removed optional flags', () => {
    const edited = structuredClone(base) as Record<string, unknown> & typeof base;
    delete (edited as Partial<typeof base>).titleField;
    delete (edited.fields[1] as { required?: boolean }).required;
    const patch = makePatch(base, edited);
    expect(applyExtensionPatch(base, patch)).toEqual(edited);
  });

  it('round-trips random edits', () => {
    for (let n = 0; n < 50; n++) {
      const edited = structuredClone(base);
      if (n % 2) edited.fields.reverse();
      if (n % 3 === 0) edited.fields.splice(n % edited.fields.length, 1);
      if (n % 5 === 0) edited.fields.push({ key: `extra${n}`, label: `Extra ${n}`, type: 'number' } as (typeof edited.fields)[number]);
      if (n % 7 === 0) edited.rules = [];
      const merged = applyExtensionPatch(base, makePatch(base, edited) ?? {});
      const sortFields = (b: typeof base) => ({ ...b, fields: [...b.fields].sort((x, y) => x.key.localeCompare(y.key)) });
      expect(sortFields(merged)).toEqual(sortFields(edited));
    }
  });
});
