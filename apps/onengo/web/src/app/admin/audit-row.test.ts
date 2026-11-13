import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../core/admin/admin';
import { auditSentence } from './rows';

const entry = (patch: Partial<AuditEntry>): AuditEntry => ({
  id: 1,
  at: '2026-11-01T10:00:00.000Z',
  actorId: null,
  actorName: null,
  action: 'signed_in',
  entity: 'session',
  entityId: null,
  area: 'people',
  recordType: null,
  ...patch,
});

describe('audit sentences', () => {
  it('tells a sign-in, a published theme and a settings change apart without showing a UUID', () => {
    expect(auditSentence(entry({ actorName: 'Asha Sharma' }), () => 'Donations')).toBe('Signed in');
    expect(
      auditSentence(
        entry({ actorId: 'system', action: 'definition.published', entity: 'definition:theme', entityId: 'organisation' }),
        () => 'Donations',
      ),
    ).toBe('Published the organisation theme');
    expect(
      auditSentence(
        entry({
          actorName: 'Asha Sharma',
          action: 'settings.changed',
          entity: 'tenant',
          entityId: '11111111-1111-1111-1111-111111111111',
        }),
        () => 'Donations',
      ),
    ).toBe('Changed organisation settings');
  });

  it('leaves the name to the Who column and keeps a readable record id', () => {
    const id = '22222222-2222-2222-2222-222222222222';
    expect(auditSentence(entry({ actorId: id, action: 'record.created', entity: 'record', entityId: id, recordType: 'donation' }), () => 'Donations')).toBe(
      'Record created Donations',
    );
    expect(auditSentence(entry({ actorName: 'Asha', action: 'record.updated', recordType: 'donation', entityId: 'DON/40' }), () => 'Donations')).toBe(
      'Record updated Donations DON/40',
    );
  });

  it('calls the tenant the organisation', () => {
    expect(auditSentence(entry({ actorName: 'Asha', action: 'data.exported', entity: 'tenant', entityId: null, area: 'organisation' }), () => 'Donations')).toBe(
      'Data exported the organisation',
    );
  });
});
