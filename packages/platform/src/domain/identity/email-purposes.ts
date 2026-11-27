/** The system emails an organisation may send from one of its message templates. */
export const EMAIL_PURPOSES = ['sign_in_code', 'password_reset', 'invite'] as const;
export type EmailPurpose = (typeof EMAIL_PURPOSES)[number];
