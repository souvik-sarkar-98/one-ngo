import { sql } from 'kysely';
import type { KeyedRecord, MigrationStore, NewSource, ProfileRow, SourceCounts, SourceRow } from '../../../application/migration/ports/migration-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;
const NOW = sql<Date>`now()`;
const PROFILE_COLUMNS = [
  'id',
  'name',
  'status',
  'books',
  'books_applied_at',
  'books_result',
  'check_result',
  'job_id',
  'created_by',
  'created_at',
  'updated_at',
] as const;
const SOURCE_COLUMNS = ['id', 'profile_id', 'file_id', 'file_name', 'columns', 'row_count', 'position', 'mapping'] as const;

type Books = Parameters<MigrationStore['saveBooks']>[2];
type Check = Parameters<MigrationStore['saveCheck']>[2];
type Status = Parameters<MigrationStore['setStatus']>[2];
type Mapping = Parameters<MigrationStore['saveMapping']>[3];
type BooksResult = Parameters<MigrationStore['saveBooksResult']>[2];

export class PgMigrationStore implements MigrationStore {
  addProfile(tx: Tx, p: { name: string; createdBy: string }): Promise<ProfileRow> {
    return pg(tx)
      .insertInto('migration_profile')
      .values({ tenant_id: APP_TENANT, name: p.name, created_by: p.createdBy })
      .returning(PROFILE_COLUMNS)
      .$castTo<ProfileRow>()
      .executeTakeFirstOrThrow();
  }

  profiles(tx: Tx, limit: number): Promise<ProfileRow[]> {
    return pg(tx).selectFrom('migration_profile').select(PROFILE_COLUMNS).orderBy('created_at', 'desc').orderBy('id').limit(limit).$castTo<ProfileRow>().execute();
  }

  profile(tx: Tx, id: string): Promise<ProfileRow | undefined> {
    return pg(tx).selectFrom('migration_profile').select(PROFILE_COLUMNS).where('id', '=', id).$castTo<ProfileRow>().executeTakeFirst();
  }

  lockProfile(tx: Tx, id: string): Promise<ProfileRow | undefined> {
    return pg(tx).selectFrom('migration_profile').select(PROFILE_COLUMNS).where('id', '=', id).forUpdate().$castTo<ProfileRow>().executeTakeFirst();
  }

  sources(tx: Tx, profileId: string): Promise<SourceRow[]> {
    return pg(tx).selectFrom('migration_source').select(SOURCE_COLUMNS).where('profile_id', '=', profileId).orderBy('position').orderBy('id').$castTo<SourceRow>().execute();
  }

  async addSource(tx: Tx, s: NewSource): Promise<SourceRow | undefined> {
    const k = pg(tx);
    const last = await k
      .selectFrom('migration_source')
      .select(sql<number>`coalesce(max(position), -1)::int`.as('n'))
      .where('profile_id', '=', s.profileId)
      .executeTakeFirstOrThrow();
    return k
      .insertInto('migration_source')
      .values({
        tenant_id: APP_TENANT,
        profile_id: s.profileId,
        file_id: s.fileId,
        file_name: s.fileName,
        columns: JSON.stringify(s.columns),
        row_count: s.rowCount,
        position: last.n + 1,
      })
      .onConflict((oc) => oc.columns(['profile_id', 'file_name']).doNothing())
      .returning(SOURCE_COLUMNS)
      .$castTo<SourceRow>()
      .executeTakeFirst();
  }

  async removeSource(tx: Tx, profileId: string, sourceId: string): Promise<boolean> {
    const gone = await pg(tx).deleteFrom('migration_source').where('profile_id', '=', profileId).where('id', '=', sourceId).returning('id').executeTakeFirst();
    return !!gone;
  }

  async saveMapping(tx: Tx, profileId: string, sourceId: string, mapping: Mapping): Promise<boolean> {
    const saved = await pg(tx)
      .updateTable('migration_source')
      .set({ mapping: JSON.stringify(mapping), updated_at: NOW })
      .where('profile_id', '=', profileId)
      .where('id', '=', sourceId)
      .returning('id')
      .executeTakeFirst();
    return !!saved;
  }

  async setOrder(tx: Tx, profileId: string, sourceIds: string[]): Promise<void> {
    for (const [position, id] of sourceIds.entries()) {
      await pg(tx).updateTable('migration_source').set({ position, updated_at: NOW }).where('profile_id', '=', profileId).where('id', '=', id).execute();
    }
  }

  async saveBooks(tx: Tx, profileId: string, books: Books): Promise<void> {
    await pg(tx).updateTable('migration_profile').set({ books: JSON.stringify(books), updated_at: NOW }).where('id', '=', profileId).execute();
  }

  async reset(tx: Tx, profileId: string): Promise<boolean> {
    const row = await pg(tx)
      .updateTable('migration_profile')
      .set({ status: 'draft', check_result: null, updated_at: NOW })
      .where('id', '=', profileId)
      .where('status', '!=', 'running')
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  async saveCheck(tx: Tx, profileId: string, check: Check): Promise<void> {
    await pg(tx)
      .updateTable('migration_profile')
      .set({ check_result: JSON.stringify(check), status: 'checked', updated_at: NOW })
      .where('id', '=', profileId)
      .where('status', '!=', 'running')
      .execute();
  }

  async claim(tx: Tx, profileId: string): Promise<boolean> {
    const row = await pg(tx)
      .updateTable('migration_profile')
      .set({ status: 'running', updated_at: NOW })
      .where('id', '=', profileId)
      .where('status', '=', 'checked')
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  async setJob(tx: Tx, profileId: string, jobId: string): Promise<void> {
    await pg(tx).updateTable('migration_profile').set({ job_id: jobId, updated_at: NOW }).where('id', '=', profileId).execute();
  }

  async setStatus(tx: Tx, profileId: string, status: Status): Promise<void> {
    await pg(tx).updateTable('migration_profile').set({ status, updated_at: NOW }).where('id', '=', profileId).execute();
  }

  async saveBooksResult(tx: Tx, profileId: string, result: BooksResult, applied: boolean): Promise<void> {
    await pg(tx)
      .updateTable('migration_profile')
      .set({ books_result: JSON.stringify(result), ...(applied ? { books_applied_at: NOW } : {}), updated_at: NOW })
      .where('id', '=', profileId)
      .execute();
  }

  async keys(tx: Tx, typeKey: string, oldIds: string[]): Promise<Map<string, KeyedRecord>> {
    if (!oldIds.length) return new Map();
    const rows = await pg(tx)
      .selectFrom('migration_key as k')
      .innerJoin('record as r', 'r.id', 'k.record_id')
      .select(['k.old_id', 'r.id', 'r.version'])
      .where('k.type_key', '=', typeKey)
      .where('k.old_id', 'in', oldIds)
      .where('r.type_key', '=', typeKey)
      .where('r.deleted_at', 'is', null)
      .execute();
    return new Map(rows.map((r) => [r.old_id, { recordId: r.id, version: Number(r.version) }]));
  }

  async putKey(tx: Tx, k: { typeKey: string; oldId: string; recordId: string; profileId: string }): Promise<void> {
    await pg(tx)
      .insertInto('migration_key')
      .values({ tenant_id: APP_TENANT, type_key: k.typeKey, old_id: k.oldId, record_id: k.recordId, profile_id: k.profileId })
      .onConflict((oc) => oc.columns(['tenant_id', 'type_key', 'old_id']).doUpdateSet({ record_id: k.recordId, profile_id: k.profileId }))
      .execute();
  }

  failedRows(tx: Tx, jobId: string, sourceId: string, after: number, limit: number) {
    return pg(tx)
      .selectFrom('job_item')
      .select(['seq', 'message', 'data'])
      .where('job_id', '=', jobId)
      .where('status', '=', 'failed')
      .where(sql<boolean>`data->>'sourceId' = ${sourceId}`)
      .where('seq', '>', after)
      .orderBy('seq')
      .limit(limit)
      .$castTo<{ seq: number; message: string | null; data: { cells?: string[] } | null }>()
      .execute();
  }

  async counts(tx: Tx, jobId: string): Promise<Map<string, SourceCounts>> {
    const rows = await pg(tx)
      .selectFrom('job_item')
      .select([
        sql<string>`data->>'sourceId'`.as('source_id'),
        sql<number>`coalesce(sum((data->>'created')::int) filter (where status = 'done'), 0)::int`.as('created'),
        sql<number>`coalesce(sum((data->>'updated')::int) filter (where status = 'done'), 0)::int`.as('updated'),
        sql<number>`count(*) filter (where status = 'failed')::int`.as('failed'),
      ])
      .where('job_id', '=', jobId)
      .groupBy(sql`data->>'sourceId'`)
      .execute();
    return new Map(rows.filter((r) => r.source_id).map((r) => [r.source_id, { created: r.created, updated: r.updated, failed: r.failed }]));
  }
}
