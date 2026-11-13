import { sql } from 'kysely';
import type { Database } from './db.js';
import { typed } from './kysely.js';

export const READY_TIMEOUT_MS = 2_000;

/** True when the database answers a trivial query within `timeoutMs`, including the wait for a pool connection. */
export async function databaseReady(db: Database, timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const probe = db
    .asSystem(async (tx) => {
      const k = typed(tx);
      await sql`select set_config('statement_timeout', ${String(Math.max(1, Math.floor(timeoutMs)))}, true)`.execute(k);
      await k.selectNoFrom(sql<number>`1`.as('one')).execute();
      return true as const;
    })
    .catch(() => false as const);
  try {
    return await Promise.race([probe, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
