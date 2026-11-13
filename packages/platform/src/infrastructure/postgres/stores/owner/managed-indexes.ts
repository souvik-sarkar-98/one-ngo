import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import { anyText } from '../../sql-fragments.js';
import { fieldExpr, sqlKey, typePredicate } from '../../query-compiler/index-expressions.js';
import type { ManagedIndexes } from '../../../../runtime/definitions/ports/managed-indexes.js';

const INDEX_DDL = /^(create (unique )?index |drop index )/;

/**
 * The owner-level indexes capability. `isInvalid` is the PostgreSQL catalog check, kept with the other
 * catalog checks in tenant-directory.ts (the file test/raw-sql-baseline.json names for them).
 */
export function pgManagedIndexes(db: Database, isInvalid: (name: string) => Promise<boolean>): ManagedIndexes {
  return {
    createStatement(ix, concurrently) {
      const how = concurrently ? 'concurrently ' : '';
      const unique = ix.unique ? 'unique ' : '';
      return `create ${unique}index ${how}if not exists ${ix.name} on record (tenant_id, ${fieldExpr(ix.field, ix.cast)}) where ${typePredicate(ix.typeKey)}`;
    },
    assertKey(key) {
      sqlKey(key);
    },
    async markNeeded(rows) {
      await db.asSystem(async (tx) => {
        for (const row of rows) {
          await typed(tx)
            .insertInto('managed_index')
            .values(row)
            .onConflict((oc) => oc.column('name').doUpdateSet({ last_needed_at: sql<Date>`now()` }))
            .execute();
        }
      });
    },
    states(names) {
      return db.asSystem((tx) =>
        typed(tx)
          .selectFrom('managed_index as m')
          .select([
            'm.name',
            'm.status',
            sql<boolean>`exists (select 1 from pg_indexes i where i.indexname = m.name and i.schemaname = current_schema())`.as('present'),
          ])
          .where('m.name', '=', anyText(names))
          .execute(),
      );
    },
    async markReady(name) {
      await db.asSystem((tx) => typed(tx).updateTable('managed_index').set({ status: 'ready', error: null }).where('name', '=', name).execute());
    },
    async markFailed(name, error) {
      await db.asSystem((tx) => typed(tx).updateTable('managed_index').set({ status: 'failed', error }).where('name', '=', name).execute());
    },
    async unneededFor(days) {
      const rows = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('managed_index')
          .select('name')
          .where('last_needed_at', '<', sql<Date>`now() - make_interval(days => ${days})`)
          .execute(),
      );
      return rows.map((r) => r.name);
    },
    async forget(name) {
      await db.asSystem((tx) => typed(tx).deleteFrom('managed_index').where('name', '=', name).execute());
    },
    async readyAmong(names) {
      const rows = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('managed_index')
          .select('name')
          .where('status', '=', 'ready')
          .where('name', '=', anyText(names))
          .execute(),
      );
      return rows.map((r) => r.name);
    },
    async uniqueField(name) {
      const row = await db.asSystem((tx) =>
        typed(tx).selectFrom('managed_index').select('field').where('name', '=', name).where('kind', '=', 'unique').executeTakeFirst(),
      );
      return row?.field;
    },
    isInvalid,
    async runDdl(statement) {
      if (!INDEX_DDL.test(statement)) throw new Error('Only managed index statements run here.');
      await db.exec(statement);
    },
  };
}
