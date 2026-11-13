import { describe, expect, it } from 'vitest';
import { auditSnapshots } from '../src/runtime/records/audit-snapshot.js';
import type { RecordTypeDef } from '../src/runtime/definitions/types.js';

const type = {
  key: 'donor',
  fields: [
    { key: 'name', type: 'text', label: 'Name' },
    { key: 'city', type: 'text', label: 'City' },
    { key: 'pan', type: 'text', label: 'PAN', sensitive: true, readPermission: 'donor:pan:read' },
  ],
} as unknown as RecordTypeDef;

describe('audit snapshots', () => {
  it('keeps the whole record on create', () => {
    const { before, after } = auditSnapshots(type, null, { data: { name: 'Asha', city: 'Pune' }, status: 'new' });
    expect(before).toBeUndefined();
    expect(after).toEqual({ status: 'new', data: { name: 'Asha', city: 'Pune' } });
  });

  it('keeps only the changed fields on update, and marks the snapshot as a diff', () => {
    const { before, after } = auditSnapshots(
      type,
      { data: { name: 'Asha', city: 'Pune' }, status: 'new' },
      { data: { name: 'Asha', city: 'Mumbai' }, status: 'active' },
    );
    expect(before).toEqual({ status: 'new', data: { city: 'Pune' }, diff: true });
    expect(after).toEqual({ status: 'active', data: { city: 'Mumbai' }, diff: true });
  });

  it('lists a field that was added or removed', () => {
    const { before, after } = auditSnapshots(
      type,
      { data: { name: 'Asha' }, status: null },
      { data: { city: 'Pune' }, status: null },
    );
    expect(before!.data).toEqual({ name: 'Asha' });
    expect(after.data).toEqual({ city: 'Pune' });
  });

  it('records an empty change as an empty diff', () => {
    const { before, after } = auditSnapshots(type, { data: { name: 'Asha' }, status: 'new' }, { data: { name: 'Asha' }, status: 'new' });
    expect(before!.data).toEqual({});
    expect(after.data).toEqual({});
  });

  it('detects a change to a masked field, and stores only the mask', () => {
    const { before, after } = auditSnapshots(
      type,
      { data: { name: 'Asha', pan: 'AAAPA1111A' }, status: 'new' },
      { data: { name: 'Asha', pan: 'BBBPB2222B' }, status: 'new' },
    );
    expect(before!.data).toEqual({ pan: '***' });
    expect(after.data).toEqual({ pan: '***' });
    expect(JSON.stringify([before, after])).not.toContain('AAAPA');
    expect(JSON.stringify([before, after])).not.toContain('BBBPB');
  });
});
