/**
 * The sign-in page shows only messages the app itself issued. A provider
 * sign-in that fails comes back as `/sign-in?reason=<key>`, and the page has
 * its own wording for each key the server can send. Any other query text,
 * including the `message` older builds showed, belongs to whoever wrote the
 * address and is ignored.
 */
const REFUSALS = new Map<string, string>([
  ['failed', 'ui.auth.refused.failed'],
  ['unavailable', 'ui.auth.refused.unavailable'],
  ['unfinished', 'ui.auth.refused.unfinished'],
  ['unreachable', 'ui.auth.refused.unreachable'],
  ['emailUnverified', 'ui.auth.refused.emailUnverified'],
  ['emailDomain', 'ui.auth.refused.emailDomain'],
  ['notMember', 'ui.auth.refused.notMember'],
  ['linkedElsewhere', 'ui.auth.refused.linkedElsewhere'],
  ['notAllowed', 'ui.auth.refused.notAllowed'],
]);

/** The text key for a sign-in refusal the app issued, or empty for anything else the address carries. */
export function signInRefusalKey(reason: string | null): string {
  return (reason && REFUSALS.get(reason)) ?? '';
}
