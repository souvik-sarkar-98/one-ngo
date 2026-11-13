import { validationFailed } from '@onengo/kernel/errors';

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_DOMAINS = 50;

/** Email domains a provider may sign in, lowercased and without repeats. Refuses anything that is not a domain name. */
export function emailDomains(values: readonly string[]): string[] {
  const clean = [...new Set(values.map((v) => v.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  const bad = clean.find((d) => !DOMAIN.test(d));
  if (bad) throw validationFailed(`'${bad}' is not an email domain, e.g. asha.org.`);
  if (clean.length > MAX_DOMAINS) throw validationFailed(`List at most ${MAX_DOMAINS} email domains.`);
  return clean;
}

/** Whether the address is in every non-empty list. */
export function emailDomainAllowed(email: string, ...lists: (readonly string[] | undefined)[]): boolean {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return lists.every((list) => !list?.length || list.includes(domain));
}
