import { sql } from 'kysely';
import type { SqlExecutor } from '../db.js';
import { typed } from '../kysely.js';

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
