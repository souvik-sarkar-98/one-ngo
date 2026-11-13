import { describe, expect, it } from 'vitest';
import { PASSWORD_MIN_LENGTH, newPasswordProblem } from './password-rules';

describe('new password rules', () => {
  it('refuses a password shorter than the server will accept', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(newPasswordProblem('nine char', 'nine char')).toBe('ui.reset.tooShort');
    expect(newPasswordProblem('', '')).toBe('ui.reset.tooShort');
  });

  it('refuses two passwords that differ, and passes a long matching pair', () => {
    expect(newPasswordProblem('quiet lake path', 'quiet lake pat')).toBe('ui.reset.mismatch');
    expect(newPasswordProblem('quiet lake path', 'quiet lake path')).toBe('');
  });
});
