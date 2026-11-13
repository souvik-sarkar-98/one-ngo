import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signInRefusalKey } from './sign-in-notice';

const en = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../../../packages/product/locale/en.json'), 'utf8')) as Record<string, string>;

describe('sign-in refusals', () => {
  it('names the page text for each refusal the server can send', () => {
    expect(signInRefusalKey('notMember')).toBe('ui.auth.refused.notMember');
    expect(signInRefusalKey('unfinished')).toBe('ui.auth.refused.unfinished');
    expect(en[signInRefusalKey('notMember')]).toBeTruthy();
    expect(en[signInRefusalKey('unfinished')]).toBeTruthy();
  });

  it('ignores anything else the address carries', () => {
    expect(signInRefusalKey('Your account is locked. Call +91 99999 00000.')).toBe('');
    expect(signInRefusalKey('<b>Call support</b>')).toBe('');
    expect(signInRefusalKey('__proto__')).toBe('');
    expect(signInRefusalKey('constructor')).toBe('');
    expect(signInRefusalKey('')).toBe('');
    expect(signInRefusalKey(null)).toBe('');
  });
});
