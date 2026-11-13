import { sql } from 'kysely';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { Database } from '../db.js';
import { typed } from '../kysely.js';
import { pg } from '../tx.js';

const TENANT = sql<string>`app_tenant()`;

export interface StoredPublicLink {
  tokenEnc: string;
  revoked: boolean;
}

export interface CatalogueHit {
  id: string;
  number: string | null;
  status: string | null;
  data: Record<string, unknown>;
}

/**
 * Secret links for a record a visitor submitted. Tenant rows are read and written inside the
 * tenant's transaction. The token lookup runs as the system and matches only the hash of a live token.
 */
export class PostgresPublicFormLinkStore {
  constructor(private readonly db: Database) {}

  async findLive(tokenHash: string): Promise<{ tenantId: string; recordId: string } | null> {
    const row = await this.db.asSystem((tx) =>
      typed(tx)
        .selectFrom('public_form_link')
        .select(['tenant_id', 'record_id'])
        .where('token_hash', '=', tokenHash)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    return row ? { tenantId: row.tenant_id, recordId: row.record_id } : null;
  }

  async link(tx: Tx, recordId: string): Promise<StoredPublicLink | undefined> {
    const row = await pg(tx)
      .selectFrom('public_form_link')
      .select(['token_enc', 'revoked_at'])
      .where('tenant_id', '=', TENANT)
      .where('record_id', '=', recordId)
      .executeTakeFirst();
    return row ? { tokenEnc: row.token_enc, revoked: !!row.revoked_at } : undefined;
  }

  async saveLink(tx: Tx, link: { recordId: string; tokenHash: string; tokenEnc: string; actorId: string }): Promise<void> {
    await pg(tx)
      .insertInto('public_form_link')
      .values({
        tenant_id: TENANT,
        record_id: link.recordId,
        token_hash: link.tokenHash,
        token_enc: link.tokenEnc,
        created_by: link.actorId,
        created_at: sql<Date>`now()`,
        revoked_at: null,
        revoked_by: null,
      })
      .execute();
  }

  async revokeLink(tx: Tx, recordId: string, actorId: string): Promise<boolean> {
    const row = await pg(tx)
      .updateTable('public_form_link')
      .set({ revoked_at: sql<Date>`now()`, revoked_by: actorId })
      .where('tenant_id', '=', TENANT)
      .where('record_id', '=', recordId)
      .where('revoked_at', 'is', null)
      .returning('record_id')
      .executeTakeFirst();
    return !!row;
  }

  /** One page of catalogue hits. `limit` includes one extra row so the caller can tell that more exist. */
  async search(
    tx: Tx,
    spec: { typeKey: string; statusIn: string[]; searchFields: string[]; q: string; limit: number },
  ): Promise<CatalogueHit[]> {
    let query = pg(tx)
      .selectFrom('record')
      .select(['id', 'number', 'status', 'data'])
      .where('tenant_id', '=', TENANT)
      .where('type_key', '=', spec.typeKey)
      .where('deleted_at', 'is', null)
      .where('status', 'in', spec.statusIn);
    const needle = spec.q.trim();
    if (needle && spec.searchFields.length) {
      const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) => eb.or(spec.searchFields.map((field) => eb(sql`data->>${field}`, 'ilike', like))));
    }
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(spec.limit).execute();
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      data: typeof row.data === 'string' ? (JSON.parse(row.data) as Record<string, unknown>) : (row.data as Record<string, unknown>),
    }));
  }
}
