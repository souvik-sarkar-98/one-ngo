/** The English wording, used where the catalogue has no entry for the language. */
const ENGLISH: Record<string, string> = {
  'ui.email.inviteSubject': 'You have been invited to {organisation}',
  'ui.email.inviteBody': 'You have been added to {organisation}. Set your password with this link, which works for 7 days:\n\n{url}\n',
  'ui.email.resetSubject': 'Reset your password',
  'ui.email.resetBody':
    'Use this link to choose a new password. It works once and expires in 30 minutes:\n\n{url}\n\nIf you did not ask for this, ignore this email; your password has not changed.',
};

/**
 * The subject and body of an invitation or password-reset email, in the
 * language of the person it goes to: the organisation's screen text, else the
 * shipped catalogue, else English.
 */
export function passwordLinkEmail(
  text: Record<string, string>,
  input: { kind: 'reset' | 'invite'; url: string; organisation: string },
): { subject: string; body: string } {
  const fill = (key: string) =>
    (text[key] ?? ENGLISH[key] ?? '').replace(/\{(\w+)\}/g, (whole, name: string) =>
      name === 'organisation' ? input.organisation : name === 'url' ? input.url : whole,
    );
  const prefix = input.kind === 'invite' ? 'ui.email.invite' : 'ui.email.reset';
  return { subject: fill(`${prefix}Subject`), body: fill(`${prefix}Body`) };
}
