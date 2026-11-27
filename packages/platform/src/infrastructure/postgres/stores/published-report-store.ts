import { sql } from 'kysely';
import type { PublishedFormat, PublishedReportInsert, PublishedReportRow, PublishedReportStore, PublishedSnapshot } from '../../../application/reports/ports/published-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { pg } from '../tx.js';

const TENANT = sql<string>`app_tenant()`;

interface Stored {
  id: string;
  report_key: string;
  title: string;
  params: Record<string, unknown> | null;
  format?: string | null;
  model?: PublishedSnapshot | string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string | Date;
}

const COLUMNS = ['p.id', 'p.report_key', 'p.title', 'p.params', 'p.format', 'p.created_by', 'p.created_at'] as const;

const selectPublished = (tx: Tx) =>
  pg(tx)
    .selectFrom('published_report as p')
    .leftJoin('app_user as u', (join) => join.on((eb) => eb(eb.cast<string>('u.id', 'text'), '=', eb.ref('p.created_by'))))
    .select([...COLUMNS, sql<string | null>`app_member_name(u.id)`.as('created_by_name')])
    .where('p.tenant_id', '=', TENANT);

const formatOf = (value: string | null | undefined): PublishedFormat => (value === 'excel' ? 'excel' : 'pdf');

const snapshotOf = (value: PublishedSnapshot | string | null | undefined): PublishedSnapshot | undefined => {
  if (value == null) return undefined;
  const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('model' in raw)) return undefined;
  return raw as PublishedSnapshot;
};

const rowOf = (row: Stored): PublishedReportRow => ({
  id: row.id,
  reportKey: row.report_key,
  title: row.title,
  params: row.params ?? {},
  format: formatOf(row.format),
  createdBy: row.created_by,
  createdByName: row.created_by_name,
  createdAt: new Date(row.created_at).toISOString(),
});

/** Published report files for one organisation, kept in the open tenant transaction. */
export class PgPublishedReportStore implements PublishedReportStore {
  async insert(tx: Tx, row: PublishedReportInsert): Promise<{ id: string }> {
    const k = pg(tx);
    const { id } = await k
      .insertInto('published_report')
      .values({
        tenant_id: TENANT,
        report_key: row.reportKey,
        title: row.title,
        params: JSON.stringify(row.params),
        format: row.format,
        model: JSON.stringify(row.model),
        created_by: row.createdBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const files = (row.signatoryFiles ?? []).map((file) => ({ published_report_id: id, tenant_id: TENANT, file_id: file.fileId, position: file.position }));
    if (files.length) await k.insertInto('published_report_signatory').values(files).execute();
    return { id };
  }

  async list(tx: Tx, reportKey: string): Promise<PublishedReportRow[]> {
    const rows = await selectPublished(tx).where('p.report_key', '=', reportKey).orderBy('p.created_at', 'desc').limit(100).$castTo<Stored>().execute();
    return rows.map(rowOf);
  }

  async get(tx: Tx, id: string): Promise<(PublishedReportRow & { model: PublishedSnapshot }) | undefined> {
    const row = await selectPublished(tx).select('p.model').where('p.id', '=', id).$castTo<Stored>().executeTakeFirst();
    const model = row ? snapshotOf(row.model) : undefined;
    return row && model ? { ...rowOf(row), model } : undefined;
  }
}
