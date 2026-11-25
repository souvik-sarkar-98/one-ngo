import { sql } from 'kysely';
import type { AttachmentInfo, AttachmentItem, KeyedRecord, LinkedPerson, MigrationStore, NewSource, ProfileRow, SourceCounts, SourceRow } from '../../../application/migration/ports/migration-store.js';
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
  'purged_at',
] as const;
const SOURCE_COLUMNS = ['id', 'profile_id', 'file_id', 'file_name', 'columns', 'row_count', 'position', 'mapping', 'purged_at'] as const;

type Books = Parameters<MigrationStore['saveBooks']>[2];
type Check = Parameters<MigrationStore['saveCheck']>[2];
type Status = Parameters<MigrationStore['setStatus']>[2];
type Mapping = Parameters<MigrationStore['saveMapping']>[3];
type Columns = Parameters<MigrationStore['setColumns']>[3];
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

  async markChecking(tx: Tx, profileId: string, jobId: string): Promise<void> {
    await pg(tx)
      .updateTable('migration_profile')
      .set({ check_result: JSON.stringify({ pending: jobId }), status: 'draft', updated_at: NOW })
      .where('id', '=', profileId)
      .where('status', '!=', 'running')
      .execute();
  }

  async saveCheck(tx: Tx, profileId: string, check: Check, jobId: string): Promise<boolean> {
    const row = await pg(tx)
      .updateTable('migration_profile')
      .set({ check_result: JSON.stringify(check), status: 'checked', updated_at: NOW })
      .where('id', '=', profileId)
      .where(sql<boolean>`check_result->>'pending' = ${jobId}`)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  async clearChecking(tx: Tx, profileId: string, jobId: string): Promise<void> {
    await pg(tx)
      .updateTable('migration_profile')
      .set({ check_result: null, updated_at: NOW })
      .where('id', '=', profileId)
      .where(sql<boolean>`check_result->>'pending' = ${jobId}`)
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

  async personKeys(tx: Tx, oldIds: string[]): Promise<Map<string, LinkedPerson>> {
    if (!oldIds.length) return new Map();
    const rows = await pg(tx)
      .selectFrom('migration_person_key as k')
      .innerJoin('tenant_member as m', (j) => j.onRef('m.tenant_id', '=', 'k.tenant_id').onRef('m.user_id', '=', 'k.user_id'))
      .innerJoin('app_user as u', 'u.id', 'k.user_id')
      .select(['k.old_id', 'k.user_id', 'u.email', sql<string>`coalesce(m.display_name, u.display_name)`.as('name')])
      .where('k.old_id', 'in', oldIds)
      .execute();
    return new Map(rows.map((r) => [r.old_id, { userId: r.user_id, email: r.email.toLowerCase(), name: r.name }]));
  }

  async memberEmails(tx: Tx, emails: string[]): Promise<Set<string>> {
    if (!emails.length) return new Set();
    const rows = await pg(tx)
      .selectFrom('tenant_member as m')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select('u.email')
      .where('m.tenant_id', '=', APP_TENANT)
      .where((eb) => eb(eb.fn('lower', ['u.email']), 'in', emails))
      .execute();
    return new Set(rows.map((r) => r.email.toLowerCase()));
  }

  async putPersonKey(tx: Tx, k: { oldId: string; userId: string; profileId: string }): Promise<void> {
    await pg(tx)
      .insertInto('migration_person_key')
      .values({ tenant_id: APP_TENANT, old_id: k.oldId, user_id: k.userId, profile_id: k.profileId })
      .onConflict((oc) => oc.columns(['tenant_id', 'old_id']).doNothing())
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

  async recentFailed(tx: Tx, jobId: string, limit: number): Promise<{ seq: number; message: string | null; sourceId: string | null }[]> {
    const rows = await pg(tx)
      .selectFrom('job_item')
      .select(['seq', 'message', sql<string | null>`data->>'sourceId'`.as('sourceId')])
      .where('job_id', '=', jobId)
      .where('status', '=', 'failed')
      .orderBy('seq', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({ seq: Number(r.seq), message: r.message, sourceId: r.sourceId }));
  }

  async counts(tx: Tx, jobId: string): Promise<Map<string, SourceCounts>> {
    const rows = await pg(tx)
      .selectFrom('job_item')
      .select([
        sql<string>`data->>'sourceId'`.as('source_id'),
        sql<number>`coalesce(sum((data->>'created')::int) filter (where status = 'done'), 0)::int`.as('created'),
        sql<number>`coalesce(sum((data->>'updated')::int) filter (where status = 'done'), 0)::int`.as('updated'),
        sql<number>`count(*) filter (where status = 'failed')::int`.as('failed'),
        sql<number>`coalesce(sum((data->>'warned')::int) filter (where status = 'done'), 0)::int`.as('warned'),
      ])
      .where('job_id', '=', jobId)
      .groupBy(sql`data->>'sourceId'`)
      .execute();
    return new Map(rows.filter((r) => r.source_id).map((r) => [r.source_id, { created: r.created, updated: r.updated, failed: r.failed, ...(r.warned ? { warned: r.warned } : {}) }]));
  }

  async setColumns(tx: Tx, profileId: string, sourceId: string, columns: Columns): Promise<void> {
    await pg(tx).updateTable('migration_source').set({ columns: JSON.stringify(columns), updated_at: NOW }).where('profile_id', '=', profileId).where('id', '=', sourceId).execute();
  }

  async markSourcePurged(tx: Tx, profileId: string, sourceId: string, columns: Columns): Promise<void> {
    await pg(tx)
      .updateTable('migration_source')
      .set({ columns: JSON.stringify(columns), purged_at: NOW, updated_at: NOW })
      .where('profile_id', '=', profileId)
      .where('id', '=', sourceId)
      .where('purged_at', 'is', null)
      .execute();
  }

  async markProfilePurged(tx: Tx, profileId: string): Promise<boolean> {
    const row = await pg(tx)
      .updateTable('migration_profile')
      .set({ purged_at: NOW, updated_at: NOW })
      .where('id', '=', profileId)
      .where('purged_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  async blankFailedCells(tx: Tx, jobId: string, sourceId: string, positions: number[]): Promise<void> {
    if (!positions.length) return;
    await sql`
      update job_item set data = jsonb_set(data, '{cells}', (
        select coalesce(jsonb_agg(case when (c.n - 1) = any(${positions}::int[]) then '""'::jsonb else c.v end order by c.n), '[]'::jsonb)
          from jsonb_array_elements(data->'cells') with ordinality as c(v, n)))
       where job_id = ${jobId} and status = 'failed' and data->>'sourceId' = ${sourceId} and jsonb_typeof(data->'cells') = 'array'`.execute(pg(tx));
  }

  async clearFailedCells(tx: Tx, jobId: string): Promise<void> {
    await sql`update job_item set data = data - 'cells' where job_id = ${jobId} and status = 'failed' and data->'cells' is not null`.execute(pg(tx));
  }

  expiredProfiles(tx: Tx, days: number, limit: number): Promise<ProfileRow[]> {
    return pg(tx)
      .selectFrom('migration_profile')
      .select(PROFILE_COLUMNS)
      .where('purged_at', 'is', null)
      .where('status', 'in', ['done', 'failed'])
      .where('updated_at', '<', sql<Date>`now() - make_interval(days => ${days})`)
      .orderBy('updated_at')
      .orderBy('id')
      .limit(limit)
      .$castTo<ProfileRow>()
      .execute();
  }

  async attachmentTotals(tx: Tx, profileId: string): Promise<{ count: number; bytes: number }> {
    const row = await pg(tx)
      .selectFrom('migration_attachment')
      .select([sql<number>`count(*)::int`.as('count'), sql<string>`coalesce(sum(size), 0)`.as('bytes')])
      .where('profile_id', '=', profileId)
      .executeTakeFirstOrThrow();
    return { count: row.count, bytes: Number(row.bytes) };
  }

  async addAttachment(tx: Tx, a: { profileId: string; path: string; fileId: string; size: number; uploadedBy: string }): Promise<boolean> {
    const row = await pg(tx)
      .insertInto('migration_attachment')
      .values({ tenant_id: APP_TENANT, profile_id: a.profileId, path: a.path, file_id: a.fileId, size: a.size, uploaded_by: a.uploadedBy })
      .onConflict((oc) => oc.expression(sql`profile_id, lower(path)`).doNothing())
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  async attachmentPage(tx: Tx, profileId: string, page: { q: string; limit: number; offset: number }): Promise<{ items: AttachmentItem[]; total: number }> {
    const like = `%${page.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const where = sql<boolean>`a.profile_id = ${profileId} and (${page.q} = '' or lower(a.path) like lower(${like}) escape '\\')`;
    const total = await sql<{ n: number }>`select count(*)::int as n from migration_attachment a where ${where}`.execute(pg(tx));
    const rows = await sql<{ id: string; path: string; size: string; mime: string; used: boolean }>`
      select a.id, a.path, a.size, f.mime, (f.record_id is not null) as used
        from migration_attachment a join file_object f on f.id = a.file_id
       where ${where}
       order by lower(a.path), a.id
       limit ${page.limit} offset ${page.offset}`.execute(pg(tx));
    return { total: total.rows[0]?.n ?? 0, items: rows.rows.map((r) => ({ id: r.id, path: r.path, size: Number(r.size), mime: r.mime, usedBy: r.used ? 1 : 0 })) };
  }

  async attachmentsByPath(tx: Tx, profileId: string, lowerPaths: string[]): Promise<Map<string, AttachmentInfo>> {
    if (!lowerPaths.length) return new Map();
    const rows = await pg(tx)
      .selectFrom('migration_attachment as a')
      .innerJoin('file_object as f', 'f.id', 'a.file_id')
      .select(['a.id', 'a.path', 'a.file_id', 'a.size', 'a.uploaded_by', 'f.mime', 'f.record_id'])
      .where('a.profile_id', '=', profileId)
      .where('f.deleted_at', 'is', null)
      .where(sql<boolean>`lower(a.path) = any(${lowerPaths}::text[])`)
      .execute();
    return new Map(
      rows.map((r) => [
        r.path.toLowerCase(),
        { id: r.id, path: r.path, fileId: r.file_id, size: Number(r.size), mime: r.mime, uploadedBy: r.uploaded_by, recordId: r.record_id },
      ]),
    );
  }

  async attachmentFileIds(tx: Tx, profileId: string): Promise<string[]> {
    const rows = await pg(tx).selectFrom('migration_attachment').select('file_id').where('profile_id', '=', profileId).execute();
    return rows.map((r) => r.file_id);
  }

  async removeAttachment(tx: Tx, profileId: string, attachmentId: string): Promise<string | undefined> {
    const row = await pg(tx).deleteFrom('migration_attachment').where('profile_id', '=', profileId).where('id', '=', attachmentId).returning('file_id').executeTakeFirst();
    return row?.file_id;
  }

  async clearAttachments(tx: Tx, profileId: string): Promise<string[]> {
    const rows = await pg(tx).deleteFrom('migration_attachment').where('profile_id', '=', profileId).returning('file_id').execute();
    return rows.map((r) => r.file_id);
  }
}
