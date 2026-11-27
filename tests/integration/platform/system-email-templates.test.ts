import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

async function publishMessage(key: string, subject: string, body: string): Promise<void> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, 'template', { key, label: key, subject, body });
  await w.platform.definitions.publish(ctx, 'template', key);
}

describe('password reset and invitation templates', () => {
  it('sends the chosen reset template, with the link and the reset expiry', async () => {
    await w.platform.identity.addMember(w.as(w.ngoA), { email: 'reset-tpl@example.org', displayName: 'Reset Person', roles: [] });
    await publishMessage('resetMail', 'Reset for {{ user.displayName }}', 'Open {{ url }} within {{ expiresInMinutes }} minutes.');
    await w.platform.administration.saveSettings(w.as(w.ngoA), { emailTemplates: { password_reset: 'resetMail' } });

    w.mail.sent.length = 0;
    await w.platform.identity.requestPasswordReset({ tenantKey: 'asha', email: 'reset-tpl@example.org' });
    expect(w.mail.sent).toHaveLength(1);
    const sent = w.mail.sent[0]!;
    expect(sent.subject).toBe('Reset for Reset Person');
    expect(sent.text).toMatch(/^Open https:\/\/ngo\.test\/reset-password\?token=[^ ]+ within 30 minutes\.$/);
  });

  it('sends the chosen invitation template, with the seven-day expiry', async () => {
    const userId = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'invite-tpl@example.org', displayName: 'Invited Person', roles: [] });
    await publishMessage('inviteMail', 'Welcome {{ user.displayName }}', 'Join {{ organisation }}: {{ url }} ({{ expiresInMinutes }} minutes)');
    await w.platform.administration.saveSettings(w.as(w.ngoA), { emailTemplates: { invite: 'inviteMail' } });

    w.mail.sent.length = 0;
    await w.platform.identity.inviteMember(w.as(w.ngoA), userId);
    expect(w.mail.sent).toHaveLength(1);
    const sent = w.mail.sent[0]!;
    expect(sent.subject).toBe('Welcome Invited Person');
    expect(sent.text).toContain('Join Asha Trust: https://ngo.test/reset-password?');
    expect(sent.text).toContain('(10080 minutes)');
  });

  it('sends the default reset wording when no reset template is chosen', async () => {
    await w.platform.identity.addMember(w.as(w.ngoA), { email: 'reset-default@example.org', displayName: 'Default Reset', roles: [] });
    await w.platform.administration.saveSettings(w.as(w.ngoA), { emailTemplates: { sign_in_code: null, password_reset: null, invite: null } });

    w.mail.sent.length = 0;
    await w.platform.identity.requestPasswordReset({ tenantKey: 'asha', email: 'reset-default@example.org' });
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]!.subject).toBe('Reset your password');
    expect(w.mail.sent[0]!.text).toContain('expires in 30 minutes');
  });
});
