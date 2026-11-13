import type { PublishedFormat, PublishedReportInsert, PublishedReportRow, PublishedReportStore, PublishedSnapshot } from '../../../application/reports/published-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { executorOf } from '../tx.js';

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

const COLUMNS = `p.id, p.report_key, p.title, p.params, p.format, p.created_by, app_member_name(u.id) as created_by_name, p.created_at`;
const FROM = `from published_report p left join app_user u on u.id::text = p.created_by`;

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
    const rows = await executorOf(tx).query<{ id: string }>(
      `insert into published_report (tenant_id, report_key, title, params, format, model, created_by)
       values (app_tenant(), $1, $2, $3::jsonb, $4, $5::jsonb, $6)
       returning id`,
      [row.reportKey, row.title, JSON.stringify(row.params), row.format, JSON.stringify(row.model), row.createdBy],
    );
    return { id: rows[0]!.id };
  }

  async list(tx: Tx, reportKey: string): Promise<PublishedReportRow[]> {
    const rows = await executorOf(tx).query<Stored>(
      `select ${COLUMNS} ${FROM}
        where p.tenant_id = app_tenant() and p.report_key = $1
        order by p.created_at desc
        limit 100`,
      [reportKey],
    );
    return rows.map(rowOf);
  }

  async get(tx: Tx, id: string): Promise<(PublishedReportRow & { model: PublishedSnapshot }) | undefined> {
    const rows = await executorOf(tx).query<Stored>(
      `select ${COLUMNS}, p.model ${FROM} where p.tenant_id = app_tenant() and p.id = $1::uuid`,
      [id],
    );
    const row = rows[0];
    const model = row ? snapshotOf(row.model) : undefined;
    return row && model ? { ...rowOf(row), model } : undefined;
  }
}
