import type { Database } from './db.js';
import { typed } from './kysely.js';

export interface ProvisionTenantInput {
  key: string;
  name: string;
  region?: string;
}

export async function provisionTenant(db: Database, input: ProvisionTenantInput): Promise<string> {
  const row = await db.asSystem((tx) =>
    typed(tx)
      .insertInto('tenant')
      .values({ key: input.key, name: input.name, region: input.region ?? null })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}
