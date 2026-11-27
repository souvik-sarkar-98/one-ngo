import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, expectCode, type TestWorld } from '../../support/platform/helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

describe('sign-in email templates on the organisation settings screen', () => {
  it('offers published message templates, saves the three choices, and clears them', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'template', { key: 'settingsCode', label: 'Sign-in code', subject: 'Code', body: 'Your code is {{ code }}.' });
    await w.platform.definitions.publish(ctx, 'template', 'settingsCode');
    await w.platform.definitions.saveDraft(ctx, 'template', { key: 'settingsPage', label: 'Printed page', kind: 'document', subject: 'Page', body: 'Page', html: '<p>Page</p>' });
    await w.platform.definitions.publish(ctx, 'template', 'settingsPage');

    const first = await w.platform.administration.settings(ctx);
    expect(first.emailTemplates).toEqual({ sign_in_code: null, password_reset: null, invite: null });
    expect(first.emailTemplateOptions).toEqual(expect.arrayContaining([{ key: 'settingsCode', label: 'Sign-in code' }]));
    expect(first.emailTemplateOptions.map((t) => t.key)).not.toContain('settingsPage');

    const chosen = await w.platform.administration.saveSettings(ctx, {
      emailTemplates: { sign_in_code: 'settingsCode', password_reset: 'settingsCode', invite: 'settingsCode' },
    });
    expect(chosen.emailTemplates).toEqual({ sign_in_code: 'settingsCode', password_reset: 'settingsCode', invite: 'settingsCode' });

    // A template that is not published, or is a document, is refused and nothing is saved.
    await expectCode(w.platform.administration.saveSettings(ctx, { emailTemplates: { invite: 'settingsPage' } }), 'validation_failed');
    await expectCode(w.platform.administration.saveSettings(ctx, { emailTemplates: { password_reset: 'notPublished' } }), 'validation_failed');
    expect((await w.platform.administration.settings(ctx)).emailTemplates).toEqual({
      sign_in_code: 'settingsCode',
      password_reset: 'settingsCode',
      invite: 'settingsCode',
    });

    // Saving replaces every choice: a purpose left out goes back to the default wording.
    const partial = await w.platform.administration.saveSettings(ctx, { emailTemplates: { sign_in_code: 'settingsCode' } });
    expect(partial.emailTemplates).toEqual({ sign_in_code: 'settingsCode', password_reset: null, invite: null });

    const cleared = await w.platform.administration.saveSettings(ctx, { emailTemplates: { sign_in_code: null } });
    expect(cleared.emailTemplates).toEqual({ sign_in_code: null, password_reset: null, invite: null });
  });

  it('writes nothing when a template is refused, not even the other settings in the same save', async () => {
    const ctx = w.as(w.ngoA);
    const before = await w.platform.administration.settings(ctx);
    await expectCode(
      w.platform.administration.saveSettings(ctx, { name: 'Renamed in one save', emailTemplates: { invite: 'notPublished' } }),
      'validation_failed',
    );
    const after = await w.platform.administration.settings(ctx);
    expect(after.name).toBe(before.name);
    expect(after.emailTemplates).toEqual(before.emailTemplates);
  });
});
