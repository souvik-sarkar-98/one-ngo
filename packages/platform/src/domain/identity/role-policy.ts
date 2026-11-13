import { permissionMatches } from '../permissions.js';

/** Permission needed to manage roles. */
export const ROLES_PERMISSION = 'admin:roles';
/** A role key starts with a lowercase letter and has up to 41 lowercase letters, digits, dashes or underscores. */
export const ROLE_KEY = /^[a-z][a-z0-9_-]{0,40}$/;
/** A permission is colon-separated words of letters, digits, dashes, underscores or `*`. */
export const PERMISSION_TEXT = /^[A-Za-z0-9_*-]+(:[A-Za-z0-9_*-]+)*$/;
export const MAX_PERMISSIONS = 500;

/** True when the permissions include the right to manage roles (directly or by wildcard). */
export function holdsRoleAdmin(permissions: string[]): boolean {
  return permissions.some((p) => permissionMatches(p, ROLES_PERMISSION));
}
