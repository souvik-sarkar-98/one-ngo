import { sql, type SelectQueryBuilder } from 'kysely';
import type {
  ApprovalListQuery,
  ApprovalListRow,
  ApprovalPair,
  ApprovalSortField,
  ApprovalStore,
  RequestRow,
  RequestStatus,
} from '../../../runtime/workflows/ports/approval-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { pg } from '../tx.js';

/**
 * Infrastructure cannot import the runtime's `likePattern` (runtime/definitions/list-params.ts). This
 * one escapes the same characters but leaves case alone because the search below compares with
 * `ilike`; test/infrastructure-parity.test.ts keeps the two in step.
 */
export const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const APP_TENANT = sql<string>`app_tenant()`;
const TITLE = sql<string | null>`r.data ->> p.title_field`;

/** Pending requests for the eligible (record type, step) pairs, neither the person's own nor already decided by them. */
const eligible = (tx: Tx, actorId: string, pairs: ApprovalPair[]) =>
  pg(tx)
    .selectFrom('approval_request as a')
    .innerJoin('record as r', 'r.id', 'a.record_id')
    .innerJoin(
      sql<{ type_key: string; step: string; type_label: string; step_label: string; title_field: string | null }>`unnest(
        ${pairs.map((p) => p.type)}::text[], ${pairs.map((p) => p.step)}::text[], ${pairs.map((p) => p.typeLabel)}::text[],
        ${pairs.map((p) => p.stepLabel)}::text[], ${pairs.map((p) => p.titleField)}::text[])`.as<'p'>(sql`p(type_key, step, type_label, step_label, title_field)`),
      (j) => j.onRef('p.type_key', '=', 'r.type_key').onRef('p.step', '=', 'a.transition_key'),
    )
    .leftJoin('app_user as u', (j) => j.on((eb) => eb(eb.cast('u.id', 'text'), '=', eb.ref('a.requested_by'))))
    .where('a.tenant_id', '=', APP_TENANT)
    .where('a.status', '=', 'pending')
    .where('a.requested_by', '<>', actorId)
    .where((eb) =>
      eb.not(eb.exists(eb.selectFrom('approval_decision as d').select(eb.lit(1).as('one')).whereRef('d.request_id', '=', 'a.id').where('d.user_id', '=', actorId))),
    );

type EligibleQuery<O> = ReturnType<typeof eligible> extends SelectQueryBuilder<infer D, infer T, object> ? SelectQueryBuilder<D, T, O> : never;

const SORT: Record<ApprovalSortField, <O>(qb: EligibleQuery<O>, dir: 'asc' | 'desc') => EligibleQuery<O>> = {
  waiting: (qb, dir) => qb.orderBy('a.created_at', dir === 'desc' ? 'asc' : 'desc'),
  record: (qb, dir) => qb.orderBy('r.number', (ob) => ob[dir]().nullsLast()).orderBy(sql`title`, (ob) => ob[dir]().nullsLast()),
  type: (qb, dir) => qb.orderBy('p.type_label', dir),
  step: (qb, dir) => qb.orderBy('p.step_label', dir),
  requestedBy: (qb, dir) => qb.orderBy(sql`coalesce(app_member_name(u.id), a.requested_by)`, dir),
};

export class PgApprovalStore implements ApprovalStore {
  requests(tx: Tx, actorId: string, requestId: string | null): Promise<RequestRow[]> {
    return pg(tx)
      .selectFrom('approval_request as a')
      .innerJoin('record as r', 'r.id', 'a.record_id')
      .leftJoin('app_user as u', (j) => j.on((eb) => eb(eb.cast('u.id', 'text'), '=', eb.ref('a.requested_by'))))
      .select((eb) => [
        'a.id',
        'a.record_id',
        'a.transition_key',
        'a.requested_by',
        'a.data',
        'a.record_version',
        'a.required_approvals',
        'a.status',
        'r.type_key',
        'r.number',
        'r.version as current_version',
        'a.created_at',
        sql<string | null>`app_member_name(u.id)`.as('requester_name'),
        eb
          .selectFrom('approval_decision as d')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('d.request_id', '=', 'a.id')
          .where('d.decision', '=', 'approve')
          .as('approvals'),
        eb
          .exists(eb.selectFrom('approval_decision as d').select(eb.lit(1).as('one')).whereRef('d.request_id', '=', 'a.id').where('d.user_id', '=', actorId))
          .as('decided_by_me'),
      ])
      .where('a.tenant_id', '=', APP_TENANT)
      .$call((qb) => (requestId ? qb.where('a.id', '=', requestId) : qb.where('a.status', '=', 'pending')))
      .orderBy('a.created_at')
      .$castTo<RequestRow>()
      .execute();
  }

  async addDecision(tx: Tx, requestId: string, actorId: string, decision: 'approve' | 'reject', comment: string | null): Promise<boolean> {
    const inserted = await pg(tx)
      .insertInto('approval_decision')
      .values({ request_id: requestId, tenant_id: APP_TENANT, user_id: actorId, decision, comment })
      .onConflict((oc) => oc.doNothing())
      .returning('user_id')
      .execute();
    return inserted.length > 0;
  }

  async approvalsGiven(tx: Tx, requestId: string): Promise<number> {
    const { n } = await pg(tx)
      .selectFrom('approval_decision')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('request_id', '=', requestId)
      .where('decision', '=', 'approve')
      .executeTakeFirstOrThrow();
    return n;
  }

  async setStatus(tx: Tx, requestId: string, status: RequestStatus, onlyIfPending = false): Promise<void> {
    await pg(tx)
      .updateTable('approval_request')
      .set({ status, decided_at: sql<Date>`now()` })
      .where('id', '=', requestId)
      .$if(onlyIfPending, (qb) => qb.where('status', '=', 'pending'))
      .execute();
  }

  async eligible(tx: Tx, actorId: string, pairs: ApprovalPair[], q: ApprovalListQuery): Promise<{ rows: ApprovalListRow[]; total: number }> {
    let matching = eligible(tx, actorId, pairs);
    if (q.types?.length) matching = matching.where('p.type_key', '=', sql<string>`any(${q.types}::text[])`);
    if (q.steps?.length) matching = matching.where('p.step', '=', sql<string>`any(${q.steps}::text[])`);
    if (q.requestedBy?.length) matching = matching.where('a.requested_by', '=', sql<string>`any(${q.requestedBy}::text[])`);
    if (q.search) {
      const s = likePattern(q.search);
      matching = matching.where((eb) => eb.or([eb('r.number', 'ilike', s), eb(TITLE, 'ilike', s)]));
    }
    const { n } = await matching.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const rows = await SORT[q.sort.field](
      matching.select((eb) => [
        'a.id',
        'a.record_id',
        'r.type_key',
        'a.transition_key',
        'r.number',
        sql<string | null>`nullif(${TITLE}, '')`.as('title'),
        'r.status',
        'r.workflow_state',
        'a.requested_by',
        sql<string | null>`app_member_name(u.id)`.as('requester_name'),
        'a.required_approvals',
        'a.created_at',
        eb
          .selectFrom('approval_decision as d')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('d.request_id', '=', 'a.id')
          .where('d.decision', '=', 'approve')
          .as('approvals'),
      ]),
      q.sort.dir,
    )
      .orderBy('a.created_at')
      .orderBy('a.id')
      .limit(q.limit)
      .offset(q.offset)
      .$castTo<ApprovalListRow>()
      .execute();
    return { rows, total: n };
  }

  async eligibleCount(tx: Tx, actorId: string, pairs: ApprovalPair[]): Promise<number> {
    const row = await eligible(tx, actorId, pairs)
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirst();
    return row?.n ?? 0;
  }
}
