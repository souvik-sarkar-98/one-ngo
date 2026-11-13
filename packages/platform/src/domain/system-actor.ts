import type { Actor } from './ports/tenant-context.js';

/** The id prefix of platform-run actors. src/infrastructure/postgres/db.ts keeps an identical copy (test/infrastructure-parity.test.ts). */
export const SYSTEM_ACTOR_PREFIX = 'system:';

export function systemActor(name: string): Actor {
  return { id: `${SYSTEM_ACTOR_PREFIX}${name}`, roles: ['system'], permissions: ['*'] };
}
