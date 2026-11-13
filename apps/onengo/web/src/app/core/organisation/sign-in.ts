/** Codes in sign-in links, as the server looks them up. */
const CODE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A typed or linked organisation code as the server compares it; empty when it cannot be one. */
export function organisationCode(raw: string | null | undefined): string {
  const code = (raw ?? '').trim().toLowerCase();
  return CODE.test(code) ? code : '';
}

/** The organisation's own sign-in page. */
export const organisationSignInPath = (code: string): string => `/o/${encodeURIComponent(code)}/sign-in`;

/** Added to the generic sign-in to keep it there: "Use another organisation". */
export const ANOTHER_ORGANISATION = 'another';

/**
 * Where the generic sign-in sends the person instead: their last
 * organisation's page, keeping where they were going. Not when they asked to
 * use another organisation, or arrive finishing a two-step sign-in or with a
 * message to read.
 */
export function rememberedRedirect(remembered: string | null | undefined, params: Record<string, string | null | undefined>): { path: string; next: string | null } | null {
  const code = organisationCode(remembered);
  if (!code || params[ANOTHER_ORGANISATION] != null || params['ticket'] || params['message']) return null;
  return { path: organisationSignInPath(code), next: params['next'] ?? null };
}

/** Where someone goes once an invitation or reset has set their password: their organisation's sign-in page when the link named it. */
export function afterPasswordSet(org: string | null | undefined): string {
  const code = organisationCode(org);
  return code ? organisationSignInPath(code) : '/sign-in';
}
