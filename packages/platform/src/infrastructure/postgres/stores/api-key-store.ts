import { sql } from 'kysely';
import type { ApiKeyStore } from '../../../domain/identity/ports/api-key-store.js';
import { writeAudit } from './audit-store.js';
import { executorOf, pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;
const KEY_COLUMNS = ['id', 'name', 'role_key', 'feed_key', 'created_by', 'created_at', 'last_used_at', 'revoked_at'] as const;

export const postgresApiKeyStore: ApiKeyStore = {
  list(tx) {
    return pg(tx)
      .selectFrom('api_key')
      .select(KEY_COLUMNS)
      .where('tenant_id', '=', APP_TENANT)
      .orderBy((eb) => eb('revoked_at', 'is not', null))
      .orderBy((eb) => eb.fn('lower', ['name']))
      .orderBy('created_at', 'desc')
      .execute();
  },

  role(tx, role) {
    return pg(tx).selectFrom('role').select(['key', 'label', 'permissions']).where('tenant_id', '=', APP_TENANT).where('key', '=', role).executeTakeFirst();
  },

  async activeRole(tx, name) {
    const row = await pg(tx)
      .selectFrom('api_key as k')
      .innerJoin('role as r', (j) => j.onRef('r.tenant_id', '=', 'k.tenant_id').onRef('r.key', '=', 'k.role_key'))
      .select(['k.role_key', 'r.permissions'])
      .where('k.tenant_id', '=', APP_TENANT)
      .where('k.name', '=', name)
      .where('k.revoked_at', 'is', null)
      .where('k.role_key', 'is not', null)
      .executeTakeFirst();
    if (!row?.role_key) return undefined;
    return { role_key: row.role_key, permissions: row.permissions };
  },

  async activeNameTaken(tx, name) {
    const taken = await pg(tx)
      .selectFrom('api_key')
      .select((eb) => eb.lit(1).as('one'))
      .where('tenant_id', '=', APP_TENANT)
      .where((eb) => eb(eb.fn('lower', ['name']), '=', eb.fn('lower', [eb.val(name)])))
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return !!taken;
  },

  async insert(tx, key) {
    const created = await pg(tx)
      .insertInto('api_key')
      .values({ tenant_id: APP_TENANT, name: key.name, secret_hash: key.secretHash, role_key: key.role, feed_key: key.feed, created_by: key.createdBy })
      .returning(KEY_COLUMNS)
      .executeTakeFirst();
    return created!;
  },

  revoke(tx, id) {
    return pg(tx)
      .updateTable('api_key')
      .set({ revoked_at: sql<Date>`now()` })
      .where('tenant_id', '=', APP_TENANT)
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .returning('name')
      .executeTakeFirst();
  },

  audit: (tx, entry) => writeAudit(executorOf(tx), entry),
};
