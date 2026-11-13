import { sql } from 'kysely';
import type { OidcStore } from '../../../domain/identity/ports/oidc-store.js';
import { writeAudit } from './audit-store.js';
import { executorOf, pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;
const NOW = sql<Date>`now()`;

export const postgresOidcStore: OidcStore = {
  async saveProvider(tx, p) {
    await pg(tx)
      .insertInto('connector')
      .values({
        tenant_id: APP_TENANT,
        key: p.key,
        type: 'oidc',
        config: p.config,
        secret_enc: p.secretEnc,
        updated_by: p.updatedBy,
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'key']).doUpdateSet((eb) => ({
          config: eb.ref('excluded.config'),
          secret_enc: eb.ref('excluded.secret_enc'),
          updated_by: eb.ref('excluded.updated_by'),
          updated_at: NOW,
          enabled: true,
        })),
      )
      .execute();
  },

  providers(tx) {
    return pg(tx)
      .selectFrom('connector')
      .select(['key', 'config', 'secret_enc'])
      .where('tenant_id', '=', APP_TENANT)
      .where('type', '=', 'oidc')
      .where((eb) => eb.ref('enabled'))
      .execute();
  },

  async providerDetails(tx) {
    const rows = await pg(tx)
      .selectFrom('connector')
      .select(['key', 'config', 'secret_enc', 'updated_at'])
      .where('tenant_id', '=', APP_TENANT)
      .where('type', '=', 'oidc')
      .where((eb) => eb.ref('enabled'))
      .orderBy('key')
      .execute();
    return rows.map((r) => ({ ...r, updated_at: new Date(r.updated_at) }));
  },

  async removeProvider(tx, key, updatedBy) {
    const result = await pg(tx)
      .updateTable('connector')
      .set({ enabled: false, secret_enc: null, updated_by: updatedBy, updated_at: NOW })
      .where('tenant_id', '=', APP_TENANT)
      .where('type', '=', 'oidc')
      .where('key', '=', key)
      .where((eb) => eb.ref('enabled'))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  },

  audit: (tx, entry) => writeAudit(executorOf(tx), entry),
};
