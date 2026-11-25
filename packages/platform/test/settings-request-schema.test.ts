import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { settingsRequest } from '../src/http/contracts/settings.js';

// The same options the server compiles request bodies with (apps/onengo/server/src/http/validation.ts).
const validate = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false, allowUnionTypes: true, discriminator: true }).compile(
  settingsRequest,
);

describe('settings request: sign-in email templates', () => {
  it('accepts null for a purpose, which keeps the default wording', () => {
    expect(validate({ emailTemplates: { sign_in_code: null, password_reset: null, invite: null } })).toBe(true);
    expect(validate({ emailTemplates: { sign_in_code: 'emailCode', password_reset: null, invite: 'welcome' } })).toBe(true);
  });

  it('still refuses other types', () => {
    expect(validate({ emailTemplates: { invite: 5 } })).toBe(false);
    expect(validate({ emailTemplates: { unknown: 'x' } })).toBe(false);
  });
});
