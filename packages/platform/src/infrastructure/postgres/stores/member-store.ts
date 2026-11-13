import { sql } from 'kysely';
import type { MemberStore, SharedLimits } from '../../../domain/identity/ports/member-store.js';
import { writeAudit } from './audit-store.js';
import type { Database } from '../db.js';
import { hitSharedLimit } from './rate-limit-store.js';
import { executorOf, pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;

export const postgresMemberStore: MemberStore = {
  async join(tx, userId, displayName) {
    await pg(tx)
      .insertInto('tenant_member')
      .values({ tenant_id: APP_TENANT, user_id: userId, display_name: displayName || null })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'user_id']).doUpdateSet((eb) => ({
          status: 'active',
          display_name: eb.fn.coalesce('tenant_member.display_name', 'excluded.display_name'),
        })),
      )
      .execute();
  },

  async isMember(tx, userId) {
    const member = await pg(tx)
      .selectFrom('tenant_member')
      .select((eb) => eb.lit(1).as('one'))
      .where('tenant_id', '=', APP_TENANT)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return !!member;
  },

  async status(tx, userId) {
    const row = await pg(tx).selectFrom('tenant_member').select('status').where('tenant_id', '=', APP_TENANT).where('user_id', '=', userId).executeTakeFirst();
    return row?.status;
  },

  async setStatus(tx, userId, status) {
    await pg(tx).updateTable('tenant_member').set({ status }).where('tenant_id', '=', APP_TENANT).where('user_id', '=', userId).execute();
  },

  async accessVersion(tx) {
    const tenant = await pg(tx).selectFrom('tenant').select('access_version').where('id', '=', APP_TENANT).where('status', '=', 'active').executeTakeFirst();
    return tenant?.access_version;
  },

  async actor(tx, userId) {
    const rows = await pg(tx)
      .selectFrom('tenant_member as m')
      .innerJoin('app_user as u', (j) => j.onRef('u.id', '=', 'm.user_id').on('u.status', '=', 'active'))
      .leftJoin('role_assignment as ra', (j) => j.onRef('ra.tenant_id', '=', 'm.tenant_id').onRef('ra.user_id', '=', 'm.user_id'))
      .leftJoin('role as r', (j) => j.onRef('r.tenant_id', '=', 'ra.tenant_id').onRef('r.key', '=', 'ra.role_key'))
      .select((eb) => ['ra.role_key', 'r.permissions', eb.lit(true).as('member')])
      .where('m.tenant_id', '=', APP_TENANT)
      .where('m.user_id', '=', userId)
      .where('m.status', '=', 'active')
      .execute();
    if (!rows.length) return null;
    const roles = rows.map((r) => r.role_key).filter((r): r is string => !!r);
    const permissions = [...new Set(rows.flatMap((r) => r.permissions ?? []))];
    return { id: userId, roles, permissions };
  },

  organisation(tx) {
    return pg(tx).selectFrom('tenant').select(['id', 'key', 'name']).where('id', '=', APP_TENANT).executeTakeFirst();
  },

  audit: (tx, entry) => writeAudit(executorOf(tx), entry),
};

export function postgresSharedLimits(db: Database): SharedLimits {
  return { hit: (key, limit, windowSeconds) => hitSharedLimit(db, key, limit, windowSeconds) };
}
