import { sql } from 'kysely';
import type { FileCatalog, FileRow, NewFile } from '../../../application/files/ports/file-catalog.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;
const FILE_COLUMNS = ['id', 'name', 'mime', 'size', 'storage_key', 'store_ref', 'record_id', 'field_key', 'created_by', 'created_at'] as const;

const usedBytes = (tx: Tx) =>
  pg(tx)
    .selectFrom('file_object')
    .select(sql<string>`coalesce(sum(size), 0)`.as('n'))
    .where('tenant_id', '=', APP_TENANT)
    .where('deleted_at', 'is', null);

export class PgFileCatalog implements FileCatalog {
  async usedBytes(tx: Tx): Promise<number> {
    const total = await usedBytes(tx).executeTakeFirstOrThrow();
    return Number(total.n);
  }

  async usage(tx: Tx, quotaSetting: string): Promise<{ used: number; quota: unknown }> {
    const row = await pg(tx)
      .selectNoFrom((eb) => [
        usedBytes(tx).as('used'),
        eb.selectFrom('tenant_setting').select('value').where('tenant_id', '=', APP_TENANT).where('key', '=', quotaSetting).as('quota'),
      ])
      .executeTakeFirst();
    return { used: Number(row?.used ?? 0), quota: row?.quota ?? null };
  }

  add(tx: Tx, f: NewFile): Promise<FileRow> {
    return pg(tx)
      .insertInto('file_object')
      .values({ id: f.id, tenant_id: APP_TENANT, name: f.name, mime: f.mime, size: f.size, sha256: f.sha256, storage_key: f.storageKey, store_ref: f.storeRef, created_by: f.createdBy })
      .returning(FILE_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  file(tx: Tx, id: string): Promise<FileRow | undefined> {
    return pg(tx).selectFrom('file_object').select(FILE_COLUMNS).where('tenant_id', '=', APP_TENANT).where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  }

  names(tx: Tx, ids: string[]): Promise<{ id: string; name: string }[]> {
    return pg(tx)
      .selectFrom('file_object')
      .select(['id', 'name'])
      .where('tenant_id', '=', APP_TENANT)
      .where((eb) => eb(eb.cast('id', 'text'), '=', sql<string>`any(${ids}::text[])`))
      .where('deleted_at', 'is', null)
      .execute();
  }

  removeUnlinked(tx: Tx, unlinkedHours: number, limit: number): Promise<{ id: string; storage_key: string; store_ref: string }[]> {
    return pg(tx)
      .updateTable('file_object')
      .set({ deleted_at: sql<Date>`now()` })
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('file_object as f')
          .select('f.id')
          .where('f.tenant_id', '=', APP_TENANT)
          .where('f.record_id', 'is', null)
          .where('f.deleted_at', 'is', null)
          .where('f.created_at', '<', sql<Date>`now() - make_interval(hours => ${unlinkedHours})`)
          .where(({ not, or, exists, selectFrom, lit }) =>
            not(
              or([
                exists(
                  selectFrom('record_import as i')
                    .select(lit(1).as('one'))
                    .whereRef('i.file_id', '=', 'f.id')
                    .where('i.status', 'not in', ['done', 'failed']),
                ),
                exists(selectFrom('migration_source as ms').select(lit(1).as('one')).whereRef('ms.file_id', '=', 'f.id')),
                exists(selectFrom('tenant_asset as a').select(lit(1).as('one')).whereRef('a.file_id', '=', 'f.id')),
                exists(selectFrom('receipt_issuer as ri').select(lit(1).as('one')).whereRef('ri.logo_file_id', '=', 'f.id')),
                exists(selectFrom('receipt_issuer as ri').select(lit(1).as('one')).whereRef('ri.signatory_file_id', '=', 'f.id')),
              ]),
            ),
          )
          .orderBy('f.created_at')
          .orderBy('f.id')
          .limit(limit),
      )
      .where('record_id', 'is', null)
      .where('deleted_at', 'is', null)
      .returning(['id', 'storage_key', 'store_ref'])
      .execute();
  }
}
