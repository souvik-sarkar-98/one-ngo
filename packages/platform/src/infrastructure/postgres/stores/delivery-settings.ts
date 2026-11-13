import { sql } from 'kysely';
import type { Database, SqlExecutor } from '../db.js';
import { typed } from '../kysely.js';

/** The organisation's enabled SMTP connector (its mail server and the encrypted password), if it has one. */
export function enabledSmtpConnector(db: Database, tenantId: string) {
  return db.withTenant(tenantId, (tx) =>
    typed(tx)
      .selectFrom('connector')
      .select(['config', 'secret_enc'])
      .where('tenant_id', '=', sql<string>`app_tenant()`)
      .where('type', '=', 'smtp')
      .where('enabled', '=', true)
      .limit(1)
      .executeTakeFirst(),
  );
}

/** The organisation's named fixed recipients ({ name: { email?, phone? } }) kept in the setting settingKey, or undefined when none are set. */
export async function namedRecipientsSetting(tx: SqlExecutor, settingKey: string): Promise<unknown> {
  const row = await typed(tx)
    .selectFrom('tenant_setting')
    .select('value')
    .where('tenant_id', '=', sql<string>`app_tenant()`)
    .where('key', '=', settingKey)
    .executeTakeFirst();
  return row?.value;
}
