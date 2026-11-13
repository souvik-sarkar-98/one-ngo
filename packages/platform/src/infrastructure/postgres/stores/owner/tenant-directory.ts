import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import type { TenantDirectory } from '../../../../domain/organisations/ports/organisation-directory.js';

/** The tenant directory: the organisations the scheduler and services work across. */
export function pgTenantDirectory(db: Database): TenantDirectory {
  return {
    async activeIdByKey(key) {
      const row = await db.asSystem((tx) =>
        typed(tx).selectFrom('tenant').select('id').where('key', '=', key).where('status', '=', 'active').executeTakeFirst(),
      );
      return row?.id;
    },
    async activeIds() {
      const rows = await db.asSystem((tx) => typed(tx).selectFrom('tenant').select('id').where('status', '=', 'active').execute());
      return rows.map((r) => r.id);
    },
    async activeIdsByTickOrder() {
      const rows = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('tenant')
          .select('id')
          .where('status', '=', 'active')
          .orderBy(sql`last_tick_at nulls first`)
          .orderBy('id')
          .execute(),
      );
      return rows.map((r) => r.id);
    },
    async markTicked(tenantId, at) {
      await db.asSystem((tx) => typed(tx).updateTable('tenant').set({ last_tick_at: at.toISOString() }).where('id', '=', tenantId).execute());
    },
    keyAndName(tenantId) {
      return db.asSystem((tx) => typed(tx).selectFrom('tenant').select(['key', 'name']).where('id', '=', tenantId).executeTakeFirst());
    },
    async updateIdentity(tenantId, changes) {
      await db.asSystem((tx) =>
        typed(tx)
          .updateTable('tenant')
          .set((eb) => ({
            name: eb.fn.coalesce(eb.val(changes.name ?? null), 'name'),
            legal_name: changes.legalName === undefined ? eb.ref('legal_name') : eb.val(changes.legalName),
            default_locale: eb.fn.coalesce(eb.val(changes.defaultLanguage ?? null), 'default_locale'),
          }))
          .where('id', '=', tenantId)
          .execute(),
      );
    },
  };
}
