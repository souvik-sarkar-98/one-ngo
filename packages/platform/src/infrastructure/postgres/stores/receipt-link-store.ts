import { sql } from 'kysely';
import type { ReceiptImageRecord, ReceiptLinkStore, ReceiptRecordRow, StoredLink } from '../../../domain/receipts/ports/receipt-link-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { Database } from '../db.js';
import { typed } from '../kysely.js';
import { pg } from '../tx.js';

const TENANT = sql<string>`app_tenant()`;

/**
 * Receipt public links. Tenant rows are read and written inside the tenant's transaction. The token
 * lookup runs as the system and matches only the hash of a live token.
 */
export class PostgresReceiptLinkStore implements ReceiptLinkStore {
  constructor(private readonly db: Database) {}

  async findLive(tokenHash: string): Promise<{ tenantId: string; receiptId: string } | null> {
    const row = await this.db.asSystem((tx) =>
      typed(tx).selectFrom('receipt_link').select(['tenant_id', 'receipt_id']).where('token_hash', '=', tokenHash).where('revoked_at', 'is', null).executeTakeFirst(),
    );
    return row ? { tenantId: row.tenant_id, receiptId: row.receipt_id } : null;
  }

  async link(tx: Tx, receiptId: string): Promise<StoredLink | undefined> {
    const row = await pg(tx).selectFrom('receipt_link').select(['token_enc', 'revoked_at']).where('tenant_id', '=', TENANT).where('receipt_id', '=', receiptId).executeTakeFirst();
    return row ? { tokenEnc: row.token_enc, revoked: !!row.revoked_at } : undefined;
  }

  async saveLink(tx: Tx, link: { receiptId: string; exists: boolean; tokenHash: string; tokenEnc: string; actorId: string }): Promise<void> {
    const values = {
      tenant_id: TENANT,
      receipt_id: link.receiptId,
      token_hash: link.tokenHash,
      token_enc: link.tokenEnc,
      created_by: link.actorId,
      created_at: sql<Date>`now()`,
      revoked_at: null,
      revoked_by: null,
    };
    if (!link.exists) await pg(tx).insertInto('receipt_link').values(values).execute();
    else await pg(tx).updateTable('receipt_link').set(values).where('receipt_id', '=', link.receiptId).where('tenant_id', '=', TENANT).execute();
  }

  async revokeLink(tx: Tx, receiptId: string, actorId: string): Promise<boolean> {
    const row = await pg(tx)
      .updateTable('receipt_link')
      .set({ revoked_at: sql<Date>`now()`, revoked_by: actorId })
      .where('tenant_id', '=', TENANT)
      .where('receipt_id', '=', receiptId)
      .where('revoked_at', 'is', null)
      .returning('receipt_id')
      .executeTakeFirst();
    return !!row;
  }

  async file(tx: Tx, fileId: string): Promise<ReceiptImageRecord | undefined> {
    const row = await pg(tx)
      .selectFrom('file_object')
      .select(['name', 'mime', sql<number>`size::int`.as('size'), 'storage_key', 'store_ref'])
      .where('tenant_id', '=', TENANT)
      .where('id', '=', fileId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? { name: row.name, mime: row.mime, size: row.size, storageKey: row.storage_key, storeRef: row.store_ref } : undefined;
  }

  async record(tx: Tx, recordId: string): Promise<ReceiptRecordRow | undefined> {
    const row = await pg(tx).selectFrom('record').select(['type_key', 'number', 'data']).where('tenant_id', '=', TENANT).where('id', '=', recordId).where('deleted_at', 'is', null).executeTakeFirst();
    return row ? { typeKey: row.type_key, number: row.number, data: row.data } : undefined;
  }
}
