import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import type { RetentionScan } from '../../../../application/files/ports/retention-scan.js';

/** The owner-level retention capability. */
export function pgRetentionScan(db: Database): RetentionScan {
  return {
    async tenantsWithStaleUploads(unlinkedHours) {
      const rows = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('file_object as f')
          .select('f.tenant_id')
          .distinct()
          .where('f.record_id', 'is', null)
          .where('f.deleted_at', 'is', null)
          .where('f.created_at', '<', sql<Date>`now() - make_interval(hours => ${unlinkedHours})`)
          .where((eb) =>
            eb.not(
              eb.or([
                eb.exists(eb.selectFrom('tenant_asset as a').select(eb.lit(1).as('one')).whereRef('a.file_id', '=', 'f.id')),
                eb.exists(eb.selectFrom('receipt_issuer as ri').select(eb.lit(1).as('one')).whereRef('ri.logo_file_id', '=', 'f.id')),
                eb.exists(eb.selectFrom('receipt_issuer as ri').select(eb.lit(1).as('one')).whereRef('ri.signatory_file_id', '=', 'f.id')),
                eb.exists(eb.selectFrom('organisation_signatory as s').select(eb.lit(1).as('one')).whereRef('s.file_id', '=', 'f.id')),
                eb.exists(eb.selectFrom('receipt_signatory_file as rs').select(eb.lit(1).as('one')).whereRef('rs.file_id', '=', 'f.id')),
                eb.exists(eb.selectFrom('published_report_signatory as ps').select(eb.lit(1).as('one')).whereRef('ps.file_id', '=', 'f.id')),
              ]),
            ),
          )
          .execute(),
      );
      return rows.map((r) => r.tenant_id);
    },
  };
}
