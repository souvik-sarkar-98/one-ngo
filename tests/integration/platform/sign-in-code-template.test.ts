import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const codeFrom = (text: string) => /(\d{6})/.exec(text)![1]!;

describe('sign-in code email template', () => {
  it('sends the default wording when the organisation has chosen no template', async () => {
    const id = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'default@example.org', displayName: 'Default', roles: [] });
    expect(id).toBeTruthy();
    w.mail.sent.length = 0;
    await w.platform.identity.requestEmailCode({ tenantKey: 'asha', email: 'default@example.org' });
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]!.subject).toBe('Your sign-in code');
    expect(w.mail.sent[0]!.text).toMatch(/Your sign-in code is \d{6}\./);
  });

  it('sends the chosen published message template, filled from the code and the member', async () => {
    await w.platform.identity.addMember(w.as(w.ngoA), { email: 'chosen@example.org', displayName: 'Chosen Person', roles: [] });
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'template', {
      key: 'emailCode',
      subject: 'Code for {{ user.displayName }}',
      body: 'Hello {{ user.displayName }}, your code is {{ code }}. It expires in {{ expiresInMinutes }} minutes.',
    });
    await w.platform.definitions.publish(ctx, 'template', 'emailCode');
    await w.platform.administration.saveSettings(ctx, { emailTemplates: { sign_in_code: 'emailCode' } });

    w.mail.sent.length = 0;
    await w.platform.identity.requestEmailCode({ tenantKey: 'asha', email: 'chosen@example.org' });
    expect(w.mail.sent).toHaveLength(1);
    const sent = w.mail.sent[0]!;
    expect(sent.subject).toBe('Code for Chosen Person');
    expect(sent.text).toBe(`Hello Chosen Person, your code is ${codeFrom(sent.text)}. It expires in 10 minutes.`);
  });

  it('falls back to the default wording when the chosen template no longer exists', async () => {
    await w.platform.identity.addMember(w.as(w.ngoA), { email: 'gone@example.org', displayName: 'Gone', roles: [] });
    // Saving rejects an unpublished key, so the row is written directly: a template chosen and later removed.
    await w.platform.db.asSystem((tx) =>
      tx.query(
        `insert into tenant_auth_email_template (tenant_id, purpose, template_key, updated_by) values ($1, 'sign_in_code', 'removedTemplate', 'test')
         on conflict (tenant_id, purpose) do update set template_key = excluded.template_key`,
        [w.ngoA],
      ),
    );

    w.mail.sent.length = 0;
    await w.platform.identity.requestEmailCode({ tenantKey: 'asha', email: 'gone@example.org' });
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]!.subject).toBe('Your sign-in code');
    expect(w.mail.sent[0]!.text).toMatch(/Your sign-in code is \d{6}\./);
  });
});
