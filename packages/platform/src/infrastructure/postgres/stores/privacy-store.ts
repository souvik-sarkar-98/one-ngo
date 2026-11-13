import { sql } from 'kysely';
import type { ConsentEvent, ErasureRow, PrivacyStore, StoredRecord } from '../../../application/privacy/ports/privacy-store.js';
import { pg } from '../tx.js';

const TENANT = sql<string>`app_tenant()`;
const NOW = sql<Date>`now()`;
const iso = (v: Date | string) => new Date(v).toISOString();
const anyUuid = (ids: string[]) => sql<string>`any(${ids}::uuid[])`;

const RECORD = ['id', 'type_key', 'number', 'data'] as const;
const toRecord = (r: { id: string; type_key: string; number: string | null; data: unknown }): StoredRecord => ({
  id: r.id,
  typeKey: r.type_key,
  number: r.number,
  data: (r.data ?? {}) as Record<string, unknown>,
});

const toConsent = (r: { purpose: string; state: string; source: string; recorded_by: string; recorded_at: Date | string }): ConsentEvent => ({
  purpose: r.purpose,
  state: r.state as ConsentEvent['state'],
  source: r.source as ConsentEvent['source'],
  recordedBy: r.recorded_by,
  recordedAt: iso(r.recorded_at),
});

const toErasure = (r: {
  id: string;
  subject_kind: string;
  subject_id: string;
  reason: string;
  summary: unknown;
  requested_by: string;
  completed_at: Date | string;
}): ErasureRow => ({
  id: r.id,
  subjectKind: r.subject_kind as ErasureRow['subjectKind'],
  subjectId: r.subject_id,
  reason: r.reason as ErasureRow['reason'],
  summary: r.summary,
  requestedBy: r.requested_by,
  completedAt: iso(r.completed_at),
});

const ERASURE = ['id', 'subject_kind', 'subject_id', 'reason', 'summary', 'requested_by', 'completed_at'] as const;
const CONSENT = ['purpose', 'state', 'source', 'recorded_by', 'recorded_at'] as const;

export function postgresPrivacyStore(): PrivacyStore {
  return {
    async lockSubject(tx, kind, subjectId) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`privacy:${kind}:${subjectId}`} || app_tenant()::text, 0))`.execute(pg(tx));
    },

    async addConsent(tx, e) {
      const row = await pg(tx)
        .insertInto('consent_event')
        .values({ tenant_id: TENANT, subject_kind: e.kind, subject_id: e.subjectId, purpose: e.purpose, state: e.state, source: e.source, recorded_by: e.actorId })
        .returning(CONSENT)
        .executeTakeFirstOrThrow();
      return toConsent(row);
    },
    async consentHistory(tx, kind, subjectId) {
      const rows = await pg(tx)
        .selectFrom('consent_event')
        .select(CONSENT)
        .where('tenant_id', '=', TENANT)
        .where('subject_kind', '=', kind)
        .where('subject_id', '=', subjectId)
        .orderBy('id')
        .execute();
      return rows.map(toConsent);
    },

    async erasure(tx, kind, subjectId) {
      const row = await pg(tx)
        .selectFrom('erasure_request')
        .select(ERASURE)
        .where('tenant_id', '=', TENANT)
        .where('subject_kind', '=', kind)
        .where('subject_id', '=', subjectId)
        .executeTakeFirst();
      return row && toErasure(row);
    },
    async addErasure(tx, e) {
      const row = await pg(tx)
        .insertInto('erasure_request')
        .values({
          id: e.id,
          tenant_id: TENANT,
          subject_kind: e.subjectKind,
          subject_id: e.subjectId,
          reason: e.reason,
          summary: JSON.stringify(e.summary),
          requested_by: e.requestedBy,
        })
        .returning(ERASURE)
        .executeTakeFirstOrThrow();
      return toErasure(row);
    },

    async record(tx, id) {
      const row = await pg(tx).selectFrom('record').select(RECORD).where('tenant_id', '=', TENANT).where('id', '=', id).forUpdate().executeTakeFirst();
      return row && toRecord(row);
    },
    async recordsWhere(tx, typeKey, field, value) {
      const rows = await pg(tx)
        .selectFrom('record')
        .select(RECORD)
        .where('tenant_id', '=', TENANT)
        .where('type_key', '=', typeKey)
        .where(sql<string>`data->>${field}`, '=', value)
        .orderBy('id')
        .forUpdate()
        .execute();
      return rows.map(toRecord);
    },
    async rewriteRecord(tx, id, next) {
      await pg(tx)
        .updateTable('record')
        .set((eb) => ({
          data: JSON.stringify(next.data),
          blind_index: JSON.stringify(next.blindIndex),
          search_text: next.searchText,
          version: eb('version', '+', eb.lit(1)),
          updated_by: next.actorId,
          updated_at: NOW,
        }))
        .where('tenant_id', '=', TENANT)
        .where('id', '=', id)
        .execute();
    },
    async detachFiles(tx, recordId, fieldKeys) {
      if (!fieldKeys.length) return [];
      const rows = await pg(tx)
        .updateTable('file_object')
        .set({ record_id: null, field_key: null, name: 'erased' })
        .where('tenant_id', '=', TENANT)
        .where('record_id', '=', recordId)
        .where('field_key', '=', sql<string>`any(${fieldKeys}::text[])`)
        .where('deleted_at', 'is', null)
        .returning('id')
        .execute();
      return rows.map((r) => r.id);
    },
    async eraseAuditValues(tx, typeKey, recordId, keys) {
      if (!keys.length) return 0;
      const { rows } = await sql<{ n: number }>`select app_erase_audit_values(${`record:${typeKey}`}, ${recordId}, ${keys}::text[]) as n`.execute(pg(tx));
      return Number(rows[0]?.n ?? 0);
    },
    async eraseNotifications(tx, recordIds) {
      if (!recordIds.length) return 0;
      const rows = await pg(tx)
        .updateTable('notification')
        .set({ to_address: null, subject: '[erased]', body: '[erased]' })
        .where('tenant_id', '=', TENANT)
        .where('record_id', '=', anyUuid(recordIds))
        .returning('id')
        .execute();
      return rows.length;
    },
    async eraseSideData(tx, e) {
      const { rows } = await sql<{ counts: Record<string, number> }>`select app_erase_side_data(${e.erasureId}::uuid, ${JSON.stringify(e.records)}::jsonb, ${e.memberId}::uuid, ${e.fileIds}::text[]) as counts`.execute(pg(tx));
      return rows[0]?.counts ?? {};
    },
    async financialRows(tx, recordIds) {
      if (!recordIds.length) return { receipts: 0, journalEntries: 0, paymentIntents: 0, latestDate: null };
      const k = pg(tx);
      const receipts = await k
        .selectFrom('receipt')
        .select([sql<number>`count(*)::int`.as('n'), sql<string | null>`max(receipt_date)::text`.as('latest')])
        .where('tenant_id', '=', TENANT)
        .where('record_id', '=', anyUuid(recordIds))
        .executeTakeFirstOrThrow();
      const journals = await k
        .selectFrom('journal_entry')
        .select([sql<number>`count(*)::int`.as('n'), sql<string | null>`max(entry_date)::text`.as('latest')])
        .where('tenant_id', '=', TENANT)
        .where('source_record_id', '=', anyUuid(recordIds))
        .executeTakeFirstOrThrow();
      const intents = await k
        .selectFrom('payment_intent')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('tenant_id', '=', TENANT)
        .where('record_id', '=', anyUuid(recordIds))
        .executeTakeFirstOrThrow();
      const dates = [receipts.latest, journals.latest].filter((d): d is string => !!d).sort();
      return { receipts: receipts.n, journalEntries: journals.n, paymentIntents: intents.n, latestDate: dates.at(-1) ?? null };
    },

    async memberStatus(tx, userId) {
      const row = await pg(tx).selectFrom('tenant_member').select('status').where('tenant_id', '=', TENANT).where('user_id', '=', userId).executeTakeFirst();
      return row?.status as 'active' | 'suspended' | undefined;
    },
    async eraseAccount(tx, userId, name, email) {
      const { rows } = await sql<{ outcome: string }>`select app_erase_account(${userId}::uuid, ${name}, ${email}) as outcome`.execute(pg(tx));
      return rows[0]!.outcome as 'erased' | 'shared';
    },

    async audit(tx, e) {
      await pg(tx)
        .insertInto('audit_event')
        .values({ tenant_id: TENANT, actor_id: e.actorId, action: e.action, entity: e.entity, entity_id: e.entityId, after: JSON.stringify(e.after) })
        .execute();
    },
  };
}
