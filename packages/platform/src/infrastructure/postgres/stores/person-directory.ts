import { sql } from 'kysely';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { PersonDirectory } from '../../../runtime/records/ports/person-directory.js';
import { pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;

export class PgPersonDirectory implements PersonDirectory {
  async activeMembers(tx: Tx, ids: string[]): Promise<Set<string>> {
    const rows = await pg(tx)
      .selectFrom('tenant_member as m')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select('m.user_id')
      .where('m.tenant_id', '=', APP_TENANT)
      .where('m.status', '=', 'active')
      .where('u.status', '=', 'active')
      .where('m.user_id', '=', sql<string>`any(${ids}::uuid[])`)
      .execute();
    return new Set(rows.map((r) => r.user_id));
  }

  async names(tx: Tx, ids: string[]): Promise<Map<string, string>> {
    const rows = await pg(tx)
      .selectFrom('app_user as u')
      .innerJoin('tenant_member as m', (j) => j.onRef('m.user_id', '=', 'u.id').on('m.tenant_id', '=', APP_TENANT))
      .select((eb) => ['u.id', eb.fn.coalesce('m.display_name', 'u.display_name').as('display_name')])
      .where('u.id', '=', sql<string>`any(${ids}::uuid[])`)
      .execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  }

  async identities(tx: Tx, ids: string[]): Promise<Map<string, { name: string; email: string }>> {
    if (!ids.length) return new Map();
    const rows = await pg(tx)
      .selectFrom('app_user as u')
      .innerJoin('tenant_member as m', (j) => j.onRef('m.user_id', '=', 'u.id').on('m.tenant_id', '=', APP_TENANT))
      .select((eb) => ['u.id', 'u.email', eb.fn.coalesce('m.display_name', 'u.display_name').as('name')])
      .where('u.id', '=', sql<string>`any(${ids}::uuid[])`)
      .execute();
    return new Map(rows.map((r) => [r.id, { name: String(r.name), email: r.email }]));
  }

  async memberStatus(tx: Tx, userId: string): Promise<string | undefined> {
    const m = await pg(tx).selectFrom('tenant_member').select('status').where('tenant_id', '=', APP_TENANT).where('user_id', '=', userId).executeTakeFirst();
    return m?.status;
  }

  async find(tx: Tx, by: { userId: string } | { email: string }): Promise<{ userId: string; active: boolean } | undefined> {
    const row = await pg(tx)
      .selectFrom('tenant_member as m')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select(['m.user_id', sql<boolean>`(m.status = 'active' and u.status = 'active')`.as('active')])
      .where('m.tenant_id', '=', APP_TENANT)
      .$call((qb) => ('userId' in by ? qb.where('m.user_id', '=', sql<string>`${by.userId}::uuid`) : qb.where(sql<boolean>`lower(u.email) = lower(${by.email})`)))
      .executeTakeFirst();
    return row ? { userId: row.user_id, active: row.active } : undefined;
  }
}
