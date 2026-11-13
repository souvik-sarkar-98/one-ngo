import { describe, expect, it } from 'vitest';
import { AUDIT_RETENTION_DAYS_DEFAULT, auditArchiveFromEnvironment } from '../src/composition/entry.js';

describe('audit retention from the environment', () => {
  it('archives nothing, and so deletes nothing, without an archive folder', () => {
    expect(auditArchiveFromEnvironment({})).toEqual({});
    expect(auditArchiveFromEnvironment({ AUDIT_RETENTION_DAYS: '90' })).toEqual({});
  });

  it('defaults to 548 days (one and a half years) when a folder is set', () => {
    expect(AUDIT_RETENTION_DAYS_DEFAULT).toBe(548);
    expect(auditArchiveFromEnvironment({ AUDIT_ARCHIVE_DIR: 'archive' }).auditDays).toBe(548);
    expect(auditArchiveFromEnvironment({ AUDIT_ARCHIVE_DIR: 'archive', AUDIT_RETENTION_DAYS: '  ' }).auditDays).toBe(548);
  });

  it('takes the number of days from AUDIT_RETENTION_DAYS', () => {
    const policy = auditArchiveFromEnvironment({ AUDIT_ARCHIVE_DIR: 'archive', AUDIT_RETENTION_DAYS: '90' });
    expect(policy.auditDays).toBe(90);
    expect(policy.archiveAudit).toBeTypeOf('function');
  });

  it('refuses a value that is not a whole number of days', () => {
    for (const bad of ['abc', '0', '-5', '1.5']) {
      expect(() => auditArchiveFromEnvironment({ AUDIT_ARCHIVE_DIR: 'archive', AUDIT_RETENTION_DAYS: bad })).toThrow(/AUDIT_RETENTION_DAYS/);
    }
  });
});
