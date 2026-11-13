import { sql } from 'kysely';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { LocaleStore } from '../../../runtime/definitions/ports/locale-store.js';
import { pg } from '../tx.js';

const appTenant = sql<string>`app_tenant()`;

export class PgLocaleStore implements LocaleStore {
  async locale(tx: Tx, userId: string): Promise<string | null> {
    const row = await pg(tx)
      .selectNoFrom((eb) =>
        eb.fn
          .coalesce(
            eb.selectFrom('tenant_member').select('locale').where('tenant_id', '=', appTenant).where(sql`user_id::text`, '=', userId),
            eb.selectFrom('tenant').select('default_locale').where('id', '=', appTenant),
          )
          .as('locale'),
      )
      .executeTakeFirst();
    return row?.locale ?? null;
  }

  async setLocale(tx: Tx, userId: string, locale: string): Promise<boolean> {
    const updated = await pg(tx)
      .updateTable('tenant_member')
      .set({ locale })
      .where('tenant_id', '=', appTenant)
      .where(sql`user_id::text`, '=', userId)
      .returning(sql<number>`1`.as('one'))
      .execute();
    return updated.length > 0;
  }
}
