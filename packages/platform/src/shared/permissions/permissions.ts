import type { Actor } from '../actor.js';
import { forbidden } from '@onengo/kernel/errors';

/**
 * Permissions are colon-separated, e.g. `record:donation:create`.
 * A `*` segment matches any single segment; a trailing `*` matches the rest.
 */
export function permissionMatches(granted: string, required: string): boolean {
  const g = granted.split(':');
  const r = required.split(':');
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '*' && i === g.length - 1) return true;
    if (i >= r.length) return false;
    if (g[i] !== '*' && g[i] !== r[i]) return false;
  }
  return g.length === r.length;
}

export function can(actor: Actor, permission: string): boolean {
  return actor.permissions.some((p) => permissionMatches(p, permission));
}

export function demand(actor: Actor, permission: string): void {
  if (!can(actor, permission)) throw forbidden();
}

/** Passes when the actor holds any one of the permissions. */
export function demandAny(actor: Actor, ...permissions: string[]): void {
  if (!permissions.some((p) => can(actor, p))) throw forbidden();
}

/** The permissions held under both lists: each kept grant is covered by the other list too. */
export function narrowed(a: string[], b: string[]): string[] {
  const within = (p: string, other: string[]) => other.some((o) => permissionMatches(o, p));
  return [...new Set([...a.filter((p) => within(p, b)), ...b.filter((p) => within(p, a))])];
}

/**
 * Whether the actor may hand a role with these permissions to someone (a person
 * or an API key): they manage roles, or they already hold every one of them.
 * A wildcard is only covered by a grant at least as wide.
 */
export function mayGrant(actor: Actor, permissions: string[]): boolean {
  return can(actor, 'admin:roles') || permissions.every((p) => can(actor, p));
}

/** Refuses roles whose permissions go beyond the actor's own, unless they manage roles. */
export function demandGrant(actor: Actor, roles: { key: string; label?: string; permissions: string[] }[]): void {
  const beyond = roles.filter((r) => !mayGrant(actor, r.permissions));
  if (beyond.length) {
    const names = beyond.map((r) => `'${r.label ?? r.key}'`).join(', ');
    throw forbidden(`You cannot give ${beyond.length === 1 ? 'the role' : 'the roles'} ${names}: ${beyond.length === 1 ? 'it allows' : 'they allow'} more than you may do yourself.`);
  }
}
