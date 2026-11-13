import { sql } from 'kysely';
import type { ProfileStore } from '../../../application/identity/ports/profile-store.js';
import { pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;

export const postgresProfileStore: ProfileStore = {
  pickable(tx, { q, pattern, limit }) {
    return pg(tx)
      .selectFrom('tenant_member as m')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select((eb) => ['u.id', eb.fn.coalesce('m.display_name', 'u.display_name').as('name'), 'u.email'])
      .where('m.tenant_id', '=', APP_TENANT)
      .where('m.status', '=', 'active')
      .where('u.status', '=', 'active')
      .where('m.last_signed_in_at', 'is not', null)
      .$if(q !== '', (qb) =>
        qb.where(sql<boolean>`(lower(coalesce(m.display_name, u.display_name)) like ${pattern} escape '\\' or lower(u.email) like ${pattern} escape '\\')`),
      )
      .orderBy(sql`lower(coalesce(m.display_name, u.display_name))`)
      .orderBy((eb) => eb.fn('lower', ['u.email']))
      .orderBy('u.id')
      .limit(limit)
      .execute();
  },
};
