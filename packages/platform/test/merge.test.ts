import { describe, expect, it } from 'vitest';
import { applyExtensionPatch } from '../src/runtime/definitions/merge.js';

const base = {
  key: 'donation',
  label: 'Donation',
  fields: [
    { key: 'donorName', label: 'Donor name', type: 'text', required: true },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'notes', label: 'Notes', type: 'longText' },
  ],
};

describe('extension patches', () => {
  it('merges keyed lists by key, appends new items, and deletes with $delete', () => {
    const merged = applyExtensionPatch(base, {
      label: 'Contribution',
      fields: [
        { key: 'donorName', label: 'Contributor' },
        { key: 'notes', $delete: true },
        { key: 'campaign', label: 'Campaign', type: 'text' },
      ],
    });
    expect(merged.label).toBe('Contribution');
    expect(merged.fields.map((f) => f.key)).toEqual(['donorName', 'amount', 'campaign']);
    expect(merged.fields[0]).toEqual({ key: 'donorName', label: 'Contributor', type: 'text', required: true });
    expect(merged.fields[2]).not.toHaveProperty('$delete');
  });

  it('removes properties set to null and replaces non-keyed arrays', () => {
    const merged = applyExtensionPatch({ a: 1, b: [1, 2], c: { d: 1, e: 2 } }, { a: null, b: [3], c: { e: null } });
    expect(merged).toEqual({ b: [3], c: { d: 1 } });
  });

  it('does not mutate the base', () => {
    const copy = structuredClone(base);
    applyExtensionPatch(base, { fields: [{ key: 'amount', label: 'Changed' }] });
    expect(base).toEqual(copy);
  });
});
