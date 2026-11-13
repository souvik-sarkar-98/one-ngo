import { sql } from 'kysely';
import type { ImportRow, ImportStore, NewImport } from '../../../application/records/ports/import-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { pg } from '../tx.js';

const COLUMNS = [
  'id',
  'type_key',
  'file_id',
  'file_name',
  'columns',
  'row_count',
  'mapping',
  'options',
  'status',
  'check_result',
  'job_id',
  'created_by',
  'created_at',
  'updated_at',
] as const;
const NOW = sql<Date>`now()`;

type Mapping = Parameters<ImportStore['saveMapping']>[2];
type Options = Parameters<ImportStore['saveMapping']>[3];
type Check = Parameters<ImportStore['saveCheck']>[2];
type Status = Parameters<ImportStore['setStatus']>[2];

export class PgImportStore implements ImportStore {
  add(tx: Tx, i: NewImport): Promise<ImportRow> {
    return pg(tx)
      .insertInto('record_import')
      .values({
        tenant_id: sql<string>`app_tenant()`,
        type_key: i.typeKey,
        file_id: i.fileId,
        file_name: i.fileName,
        columns: JSON.stringify(i.columns),
        row_count: i.rowCount,
        created_by: i.createdBy,
      })
      .returning(COLUMNS)
      .$castTo<ImportRow>()
      .executeTakeFirstOrThrow();
  }

  get(tx: Tx, id: string): Promise<ImportRow | undefined> {
    return pg(tx).selectFrom('record_import').select(COLUMNS).where('id', '=', id).$castTo<ImportRow>().executeTakeFirst();
  }

  saveMapping(tx: Tx, id: string, mapping: Mapping, options: Options): Promise<ImportRow | undefined> {
    return pg(tx)
      .updateTable('record_import')
      .set({ mapping: JSON.stringify(mapping), options: JSON.stringify(options), status: 'mapped', check_result: null, updated_at: NOW })
      .where('id', '=', id)
      .where('status', 'in', ['uploaded', 'mapped', 'checked'])
      .returning(COLUMNS)
      .$castTo<ImportRow>()
      .executeTakeFirst();
  }

  async saveCheck(tx: Tx, id: string, result: Check): Promise<void> {
    await pg(tx)
      .updateTable('record_import')
      .set({ check_result: JSON.stringify(result), status: 'checked', updated_at: NOW })
      .where('id', '=', id)
      .where('status', 'in', ['mapped', 'checked'])
      .execute();
  }

  async claim(tx: Tx, id: string): Promise<boolean> {
    const claimed = await pg(tx)
      .updateTable('record_import')
      .set({ status: 'running', updated_at: NOW })
      .where('id', '=', id)
      .where('status', 'in', ['mapped', 'checked'])
      .returning('id')
      .executeTakeFirst();
    return !!claimed;
  }

  setJob(tx: Tx, id: string, jobId: string): Promise<ImportRow | undefined> {
    return pg(tx)
      .updateTable('record_import')
      .set({ job_id: jobId, updated_at: NOW })
      .where('id', '=', id)
      .returning(COLUMNS)
      .$castTo<ImportRow>()
      .executeTakeFirst();
  }

  setStatus(tx: Tx, id: string, status: Status): Promise<ImportRow | undefined> {
    return pg(tx)
      .updateTable('record_import')
      .set({ status, updated_at: NOW })
      .where('id', '=', id)
      .returning(COLUMNS)
      .$castTo<ImportRow>()
      .executeTakeFirst();
  }

  failedRows(tx: Tx, jobId: string, after: number, limit: number) {
    return pg(tx)
      .selectFrom('job_item')
      .select(['seq', 'message', 'data'])
      .where('job_id', '=', jobId)
      .where('status', '=', 'failed')
      .where('seq', '>', after)
      .orderBy('seq')
      .limit(limit)
      .$castTo<{ seq: number; message: string | null; data: { cells?: string[] } | null }>()
      .execute();
  }

  counts(tx: Tx, jobId: string) {
    return pg(tx)
      .selectFrom('job_item')
      .select([
        sql<number>`count(*) filter (where status = 'done' and data->>'action' = 'created')::int`.as('created'),
        sql<number>`count(*) filter (where status = 'done' and data->>'action' = 'updated')::int`.as('updated'),
        sql<number>`count(*) filter (where status = 'failed')::int`.as('failed'),
      ])
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
  }
}
