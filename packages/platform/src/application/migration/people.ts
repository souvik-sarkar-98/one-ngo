import type { PeopleSpec } from './mapping.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const MAX_EMAIL = 254;
export const MAX_NAME = 120;
export const MAX_OLD_ID = 200;

/** Said when a legacy user id already stands for another email here. */
export const LINKED_ELSEWHERE = 'This legacy user id is already linked to someone else here.';
/** Said for a globally disabled account; it must not say more (see risk R3). */
export const CANNOT_ADD = 'This email cannot be added. Ask the person to contact support.';

/** What the organisation's roles allow, for the person doing the migration. */
export interface RoleRule {
  requireTwoStep: boolean;
  /** The person migrating may give this role (they hold everything it allows, or manage roles). */
  grantable: boolean;
}

export interface PersonEnv {
  roles: ReadonlyMap<string, RoleRule>;
  /** Language codes the organisation offers. */
  locales: ReadonlySet<string>;
}

export interface ParsedPerson {
  oldId: string;
  /** Trimmed and lowercased. */
  email: string;
  name: string;
  /** Role keys, mapped and without duplicates. */
  roles: string[];
  status: 'active' | 'suspended';
  locale: string | null;
}

export interface PersonProblem {
  column?: string;
  message: string;
}

/** The person a row describes, or why the row cannot be loaded. Pure: nothing is looked up or saved. */
export function readPersonRow(spec: PeopleSpec, cell: (column: string) => string, env: PersonEnv): { person?: ParsedPerson; problems: PersonProblem[] } {
  const problems: PersonProblem[] = [];
  const oldId = cell(spec.oldId);
  if (!oldId) problems.push({ column: spec.oldId, message: `${spec.oldId} is empty; every row needs a legacy id` });
  else if (oldId.length > MAX_OLD_ID) problems.push({ column: spec.oldId, message: `${spec.oldId} is longer than ${MAX_OLD_ID} characters` });

  const email = cell(spec.email).toLowerCase();
  if (!EMAIL.test(email) || email.length > MAX_EMAIL) problems.push({ column: spec.email, message: 'Email is not a valid address' });

  const name = cell(spec.name);
  if (!name) problems.push({ column: spec.name, message: 'Name is required' });
  else if (name.length > MAX_NAME) problems.push({ column: spec.name, message: `Name is longer than ${MAX_NAME} characters` });

  const roles = rolesOf(spec, cell, env, problems);

  let status: 'active' | 'suspended' = 'active';
  if (spec.status) {
    const value = cell(spec.status.column);
    const same = (v: string) => v.toLowerCase() === value.toLowerCase();
    if (spec.status.active.some(same)) status = 'active';
    else if (spec.status.suspended.some(same)) status = 'suspended';
    else problems.push({ column: spec.status.column, message: `Status '${value}' is in neither the active nor the suspended list` });
  }

  let locale: string | null = null;
  if (spec.locale) {
    const value = cell(spec.locale);
    if (value) {
      if (env.locales.has(value)) locale = value;
      else problems.push({ column: spec.locale, message: `Language '${value}' is not offered by this organisation` });
    }
  }
  return problems.length ? { problems } : { person: { oldId, email, name, roles, status, locale }, problems };
}

function rolesOf(spec: PeopleSpec, cell: (column: string) => string, env: PersonEnv, problems: PersonProblem[]): string[] {
  if (!spec.roles) return [];
  const column = 'column' in spec.roles ? spec.roles.column : undefined;
  let wanted: string[];
  if ('fixed' in spec.roles) wanted = spec.roles.fixed;
  else {
    const separator = spec.roles.separator ?? ';';
    const map = spec.roles.map ?? {};
    wanted = [];
    for (const raw of cell(spec.roles.column).split(separator)) {
      const value = raw.trim();
      if (!value) continue;
      const hit = Object.hasOwn(map, value) ? value : Object.keys(map).find((k) => k.toLowerCase() === value.toLowerCase());
      const mapped = hit === undefined ? value : map[hit];
      if (mapped !== null && mapped !== undefined) wanted.push(mapped);
    }
  }
  const out: string[] = [];
  for (const key of new Set(wanted)) {
    const rule = env.roles.get(key);
    if (!rule) problems.push({ column, message: `Role '${key}' does not exist` });
    else if (rule.requireTwoStep) {
      problems.push({ column, message: `Role '${key}' requires two-step sign-in, so it cannot be given here. Give it after the person has signed in and set up two-step` });
    } else if (!rule.grantable) problems.push({ column, message: `You cannot give the role '${key}'` });
    else out.push(key);
  }
  return out;
}
