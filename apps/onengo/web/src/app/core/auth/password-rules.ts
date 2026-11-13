/** The shortest password the server accepts (PasswordPolicy); the page says so before asking. */
export const PASSWORD_MIN_LENGTH = 10;

/** The text key for what stops a new password being saved, or empty when it can be sent. */
export function newPasswordProblem(password: string, confirm: string): string {
  if (password.length < PASSWORD_MIN_LENGTH) return 'ui.reset.tooShort';
  if (password !== confirm) return 'ui.reset.mismatch';
  return '';
}
