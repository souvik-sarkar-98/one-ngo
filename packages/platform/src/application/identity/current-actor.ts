import type { Actor } from '../../domain/ports/tenant-context.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import { narrowed } from '../../domain/permissions.js';
import { API_ACTOR_PREFIX } from '../../domain/identity/api-key-policy.js';
import type { ApiKeyStore } from '../../domain/identity/ports/api-key-store.js';
import type { MemberStore } from '../../domain/identity/ports/member-store.js';

const PERSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What an actor may do in the organisation now, for work that started earlier
 * (background jobs): a person's roles while they are an active member, an API
 * key's role while it is not revoked, in both cases never more than the actor
 * held when the work started. Null when they may no longer act there.
 * Actors that are neither (the system) are returned as they are.
 */
export function currentActor(
  transactions: TransactionManager,
  members: Pick<MemberStore, 'actor'>,
  apiKeys: Pick<ApiKeyStore, 'activeRole'>,
): (tenantId: string, actor: Actor) => Promise<Actor | null> {
  const within = (started: Actor, now: Actor): Actor => ({ id: started.id, roles: now.roles, permissions: narrowed(started.permissions, now.permissions) });
  return async (tenantId, actor) => {
    if (PERSON.test(actor.id)) {
      const now = await transactions.withTenant(tenantId, (tx) => members.actor(tx, actor.id));
      return now ? within(actor, now) : null;
    }
    if (!actor.id.startsWith(API_ACTOR_PREFIX)) return actor;
    const key = await transactions.withTenant(tenantId, (tx) => apiKeys.activeRole(tx, actor.id.slice(API_ACTOR_PREFIX.length)));
    return key ? within(actor, { id: actor.id, roles: [key.role_key], permissions: key.permissions }) : null;
  };
}
