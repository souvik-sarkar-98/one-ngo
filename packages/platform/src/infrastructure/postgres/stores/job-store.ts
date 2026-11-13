import { sql } from 'kysely';
import type { JobItemRow, JobListFilter, JobRow, JobStore } from '../../jobs/ports/job-store.js';
import type { Database, SqlExecutor, TenantContext } from '../db.js';
import type { JobData } from '../db-json.js';
import { typed } from '../kysely.js';

const LEASE_END = sql<Date>`now() + interval '2 minutes'`;
export const JOB_COLUMNS = [
  'id',
  'tenant_id',
  'kind',
  'status',
  'input',
  'state',
  'actor',
  'progress',
  'total',
  'result',
  'error',
  'cancel_requested',
  'created_by',
  'created_at',
  'started_at',
  'finished_at',
] as const;
const COLUMNS = JOB_COLUMNS;
const J_COLUMNS = COLUMNS.map((c) => `j.${c}` as const);

/** The job tables in PostgreSQL: the statements of the job runner, so the runner itself holds none. */
export class PostgresJobStore implements JobStore {
  constructor(private readonly db: Database) {}

  async insert(
    tx: SqlExecutor,
    ctx: TenantContext,
    kind: string,
    input: Record<string, unknown>,
    options: { total?: number; unlessQueued?: boolean } = {},
  ): Promise<JobRow | null> {
    if (options.unlessQueued) {
      const queued = await typed(tx)
        .selectFrom('job')
        .select(sql<number>`1`.as('queued'))
        .where('kind', '=', kind)
        .where('status', '=', 'queued')
        .where('input', '=', sql<JobData>`${JSON.stringify(input)}::jsonb`)
        .limit(1)
        .executeTakeFirst();
      if (queued) return null;
    }
    return typed(tx)
      .insertInto('job')
      .values({
        tenant_id: sql<string>`app_tenant()`,
        kind,
        input: JSON.stringify(input),
        total: options.total ?? null,
        actor: JSON.stringify(ctx.actor),
        created_by: ctx.actor.id,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
  }

  create(ctx: TenantContext, kind: string, input: Record<string, unknown>, options: { total?: number; unlessQueued?: boolean }): Promise<JobRow | null> {
    return this.db.withTenant(ctx.tenantId, (tx) => this.insert(tx, ctx, kind, input, options));
  }

  find(ctx: TenantContext, id: string): Promise<JobRow | undefined> {
    return this.db.withTenant(ctx.tenantId, (tx) => typed(tx).selectFrom('job').select(COLUMNS).where('id', '=', id).executeTakeFirst());
  }

  items(ctx: TenantContext, id: string, options: { status: string | null; limit: number; offset: number }): Promise<JobItemRow[]> {
    const { status } = options;
    return this.db.withTenant(ctx.tenantId, (tx) =>
      typed(tx)
        .selectFrom('job_item')
        .select(['seq', 'status', 'record_id', 'message', 'data'])
        .where('job_id', '=', id)
        .$if(status !== null, (q) => q.where('status', '=', status!))
        .orderBy('seq')
        .limit(options.limit)
        .offset(options.offset)
        .execute(),
    );
  }

  list(ctx: TenantContext, filter: JobListFilter): Promise<{ rows: (JobRow & { created_by_name: string | null })[]; total: number }> {
    const { kind, status, startedBy, from, to } = filter;
    return this.db.withTenant(ctx.tenantId, async (tx) => {
      const matching = typed(tx)
        .selectFrom('job as j')
        .$if(kind != null, (q) => q.where('j.kind', '=', sql<string>`any(${kind}::text[])`))
        .$if(status != null, (q) => q.where('j.status', '=', sql<string>`any(${status}::text[])`))
        .$if(startedBy != null, (q) => q.where('j.created_by', '=', startedBy!))
        .$if(from != null, (q) => q.where('j.created_at', '>=', sql<Date>`${from}::date`))
        .$if(to != null, (q) => q.where('j.created_at', '<', sql<Date>`${to}::date + 1`));
      const rows = await matching
        .leftJoin('app_user as u', (join) => join.on((eb) => eb(eb.cast<string>('u.id', 'text'), '=', eb.ref('j.created_by'))))
        .select([...J_COLUMNS, sql<string | null>`app_member_name(u.id)`.as('created_by_name')])
        .orderBy('j.created_at', 'desc')
        .orderBy('j.id')
        .limit(filter.limit)
        .offset(filter.offset)
        .execute();
      const count = await matching.select((eb) => eb.cast<number>(eb.fn.countAll(), 'integer').as('n')).executeTakeFirst();
      return { rows, total: count!.n };
    });
  }

  requestCancel(ctx: TenantContext, id: string): Promise<JobRow | undefined> {
    return this.db.withTenant(ctx.tenantId, (tx) =>
      typed(tx)
        .updateTable('job')
        .set((eb) => ({
          cancel_requested: true,
          status: eb.case().when('status', '=', 'queued').then('cancelled').else(eb.ref('status')).end(),
          finished_at: eb.case().when('status', '=', 'queued').then(sql<Date>`now()`).else(eb.ref('finished_at')).end(),
        }))
        .where('id', '=', id)
        .returning(COLUMNS)
        .executeTakeFirst(),
    );
  }

  claim(kinds: string[], exclusive: string[], skipped: string[]): Promise<JobRow | undefined> {
    return this.db.asSystem((tx) =>
      typed(tx)
        .updateTable('job')
        .set({ status: 'running', started_at: sql<Date>`coalesce(started_at, now())`, locked_until: LEASE_END })
        .where('id', '=', (eb) =>
          eb
            .selectFrom('job as j')
            .select('j.id')
            .where((w) =>
              w.and([
                w('j.status', 'in', ['queued', 'running']),
                w.or([w('j.locked_until', 'is', null), w('j.locked_until', '<', sql<Date>`now()`)]),
                w('j.kind', '=', sql<string>`any(${kinds}::text[])`),
                w.not(w('j.id', '=', sql<string>`any(${skipped}::uuid[])`)),
                w.not(
                  w.and([
                    w('j.kind', '=', sql<string>`any(${exclusive}::text[])`),
                    w.exists(
                      w
                        .selectFrom('job as o')
                        .select(sql<number>`1`.as('earlier'))
                        .whereRef('o.tenant_id', '=', 'j.tenant_id')
                        .where('o.kind', '=', sql<string>`any(${exclusive}::text[])`)
                        .where('o.status', 'in', ['queued', 'running'])
                        .where((o) => o(o.refTuple('o.created_at', 'o.id'), '<', o.refTuple('j.created_at', 'j.id'))),
                    ),
                  ]),
                ),
              ]),
            )
            .orderBy('j.created_at')
            .orderBy('j.id')
            .limit(1)
            .forUpdate()
            .skipLocked(),
        )
        .returning(COLUMNS)
        .executeTakeFirst(),
    );
  }

  async cancelRequested(jobId: string): Promise<boolean | undefined> {
    const flags = await this.db.asSystem((tx) => typed(tx).selectFrom('job').select('cancel_requested').where('id', '=', jobId).executeTakeFirst());
    return flags?.cancel_requested;
  }

  async accessVersion(tenantId: string): Promise<number | undefined> {
    const row = await this.db.asSystem((tx) => typed(tx).selectFrom('tenant').select('access_version').where('id', '=', tenantId).executeTakeFirst());
    return row?.access_version;
  }

  async extendLease(jobId: string): Promise<void> {
    await this.db.asSystem((tx) => typed(tx).updateTable('job').set({ locked_until: LEASE_END }).where('id', '=', jobId).where('status', '=', 'running').execute());
  }

  async releaseLease(jobId: string): Promise<void> {
    await this.db.asSystem((tx) => typed(tx).updateTable('job').set({ locked_until: null }).where('id', '=', jobId).execute());
  }

  async saveBatch(job: JobRow, state: JobData, items: Parameters<JobStore['saveBatch']>[2], progress: number, total: number | null): Promise<void> {
    await this.db.asSystem(async (tx) => {
      const k = typed(tx);
      for (const item of items) {
        await k
          .insertInto('job_item')
          .values({
            tenant_id: job.tenant_id,
            job_id: job.id,
            seq: item.seq,
            status: item.status,
            record_id: item.recordId ?? null,
            message: item.message?.slice(0, 2000) ?? null,
            data: item.data === undefined ? null : JSON.stringify(item.data),
          })
          .onConflict((oc) =>
            oc.columns(['job_id', 'seq']).doUpdateSet((eb) => ({
              status: eb.ref('excluded.status'),
              record_id: eb.ref('excluded.record_id'),
              message: eb.ref('excluded.message'),
              data: eb.ref('excluded.data'),
            })),
          )
          .execute();
      }
      await k
        .updateTable('job')
        .set((eb) => ({
          state: JSON.stringify(state),
          progress,
          total: eb.fn.coalesce(eb.val(total), 'total'),
          locked_until: LEASE_END,
        }))
        .where('id', '=', job.id)
        .execute();
    });
  }

  finish(jobId: string, status: 'done' | 'failed' | 'cancelled', result: string | null, error: string | null): Promise<JobRow | undefined> {
    return this.db.asSystem((tx) =>
      typed(tx)
        .updateTable('job')
        .set((eb) => ({
          status,
          result: eb.fn<string | null>('coalesce', [eb.val(result), 'result']),
          error,
          finished_at: sql<Date>`now()`,
          locked_until: null,
        }))
        .where('id', '=', jobId)
        .where('status', '=', 'running')
        .returning(COLUMNS)
        .executeTakeFirst(),
    );
  }

  counts(jobId: string): Promise<{ done: number; failed: number; skipped: number } | undefined> {
    return this.db.asSystem((tx) =>
      typed(tx)
        .selectFrom('job_item')
        .select((eb) => [
          eb.cast<number>(eb.fn.countAll().filterWhere('status', '=', 'done'), 'integer').as('done'),
          eb.cast<number>(eb.fn.countAll().filterWhere('status', '=', 'failed'), 'integer').as('failed'),
          eb.cast<number>(eb.fn.countAll().filterWhere('status', '=', 'skipped'), 'integer').as('skipped'),
        ])
        .where('job_id', '=', jobId)
        .executeTakeFirst(),
    );
  }
}
