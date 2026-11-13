import { sql } from 'kysely';
import type { Database } from '../db.js';
import { typed } from '../kysely.js';

/**
 * Fixed-window limiter stored in the database, shared by every instance. Used
 * for actions that send messages, such as sign-in codes.
 */
export async function hitSharedLimit(db: Database, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const row = await db.asSystem((tx) =>
    typed(tx)
      .insertInto('rate_limit')
      .values({ key, window_started_at: sql<Date>`now()`, hits: 1 })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet((eb) => {
          const expired = eb('rate_limit.window_started_at', '<', sql<Date>`now() - make_interval(secs => ${windowSeconds})`);
          return {
            hits: eb.case().when(expired).then(eb.lit(1)).else(eb('rate_limit.hits', '+', eb.lit(1))).end(),
            window_started_at: eb.case().when(expired).then(sql<Date>`now()`).else(eb.ref('rate_limit.window_started_at')).end(),
          };
        }),
      )
      .returning('hits')
      .executeTakeFirst(),
  );
  return (row?.hits ?? 1) <= limit;
}
