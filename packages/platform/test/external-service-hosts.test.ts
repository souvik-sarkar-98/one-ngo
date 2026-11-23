import { describe, expect, it } from 'vitest';
import { pwnedPasswords } from '@onengo/kernel/crypto';
import { pwnedPasswordsApiBaseFromEnvironment } from '../src/composition/entry.js';

const SANDBOX = 'https://127.0.0.1:8095';

describe('breached-password host', () => {
  it('calls Have I Been Pwned unless a base is set', async () => {
    expect(pwnedPasswordsApiBaseFromEnvironment({})).toBeUndefined();
    expect(pwnedPasswordsApiBaseFromEnvironment({ PWNED_PASSWORDS_API_BASE: `${SANDBOX}/` })).toBe(SANDBOX);
    expect(() => pwnedPasswordsApiBaseFromEnvironment({ PWNED_PASSWORDS_API_BASE: 'not a url' })).toThrow(/PWNED_PASSWORDS_API_BASE/);
    expect(() => pwnedPasswordsApiBaseFromEnvironment({ PWNED_PASSWORDS_API_BASE: 'http://127.0.0.1:8095' })).toThrow(/https/);

    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      return { status: 200, text: async () => '' };
    };
    await pwnedPasswords({ fetch }).breachCount('monsoon in the hills');
    await pwnedPasswords({ apiBase: pwnedPasswordsApiBaseFromEnvironment({ PWNED_PASSWORDS_API_BASE: SANDBOX }), fetch }).breachCount('monsoon in the hills');
    expect(urls[0]).toMatch(/^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
    expect(urls[1]).toMatch(new RegExp(`^${SANDBOX}/range/[0-9A-F]{5}$`));
  });
});
