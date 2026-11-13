import { describe, expect, it } from 'vitest';
import { passwordLinkEmail } from '../src/application/identity/password-link-email.js';

const link = { url: 'https://ngo.test/reset-password?token=t', organisation: 'Asha Trust' };

describe('invitation and reset emails', () => {
  it('write the English wording when the language has no entry', () => {
    const invite = passwordLinkEmail({}, { kind: 'invite', ...link });
    expect(invite.subject).toBe('You have been invited to Asha Trust');
    expect(invite.body).toContain('You have been added to Asha Trust.');
    expect(invite.body).toContain(link.url);

    const reset = passwordLinkEmail({}, { kind: 'reset', ...link });
    expect(reset.subject).toBe('Reset your password');
    expect(reset.body).toContain(link.url);
    expect(reset.body).not.toContain('Asha Trust');
  });

  it('write the organisation name and the link into the language in use', () => {
    const text = {
      'ui.email.inviteSubject': 'आपको {organisation} में आमंत्रित किया गया है',
      'ui.email.inviteBody': 'इस लिंक से अपना पासवर्ड सेट करें:\n\n{url}\n',
    };
    const invite = passwordLinkEmail(text, { kind: 'invite', ...link });
    expect(invite.subject).toBe('आपको Asha Trust में आमंत्रित किया गया है');
    expect(invite.body).toBe('इस लिंक से अपना पासवर्ड सेट करें:\n\nhttps://ngo.test/reset-password?token=t\n');
  });

  it('leave a placeholder they do not know alone', () => {
    const invite = passwordLinkEmail({ 'ui.email.inviteSubject': 'Join {organisation} as {role}' }, { kind: 'invite', ...link });
    expect(invite.subject).toBe('Join Asha Trust as {role}');
  });
});
