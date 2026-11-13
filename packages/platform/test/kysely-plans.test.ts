import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalQuery } from '../src/runtime/workflows/approval-service.js';
import type { Actor, Database, SqlExecutor } from '../src/infrastructure/postgres/db.js';
import { likePattern } from '../src/runtime/definitions/list-params.js';
import { createWorld, type TestWorld } from './helpers.js';

/**
 * The SQL these lists ran before Kysely, with `($n is null or …)` filters, is
 * planned against the statements the services send now. Both are planned with
 * their values bound, as node-postgres runs them, and must scan the same
 * tables through the same indexes.
 */
let w: TestWorld;
const owner: Actor = { id: randomUUID(), roles: ['admin'], permissions: ['*'] };
let jobId: string;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  const ctx = w.as(w.ngoA, owner);
  jobId = (await w.platform.jobs.create(ctx, 'index.build', {})).id;
  const publish = async (kind: 'recordType' | 'workflow', body: Record<string, unknown>) => {
    await w.platform.definitions.saveDraft(ctx, kind, body as never);
    await w.platform.definitions.publish(ctx, kind, String(body.key));
  };
  await publish('recordType', {
    key: 'plangrant',
    label: 'Plan grant',
    numbering: { sequence: 'plangrant', format: 'PG/{seq:3}', reset: 'never' },
    titleField: 'title',
    fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
  });
  await publish('workflow', {
    key: 'plangrant',
    recordType: 'plangrant',
    initial: 'draft',
    states: [{ key: 'draft', label: 'Draft' }, { key: 'approved', label: 'Approved', final: true }],
    transitions: [{ key: 'approvePlan', label: 'Approve plan grant', from: ['draft'], to: 'approved', approval: { roles: ['admin'] } }],
  });
  await w.platform.db.exec('analyze');
});
afterAll(() => w.close());

interface Statement {
  sql: string;
  params: unknown[];
}

/** Every statement `run` sends through the database's transactions. */
async function captured(run: () => Promise<unknown>): Promise<Statement[]> {
  const db: Database = w.platform.db;
  const own = db as unknown as Record<string, unknown>;
  const seen: Statement[] = [];
  const recording = (tx: SqlExecutor): SqlExecutor => ({
    query: <R>(sql: string, params?: unknown[]) => {
      seen.push({ sql, params: params ?? [] });
      return tx.query<R>(sql, params);
    },
    queryWithRowCount: <R>(sql: string, params?: unknown[]) => {
      seen.push({ sql, params: params ?? [] });
      return tx.queryWithRowCount<R>(sql, params);
    },
  });
  const withTenant = db.withTenant.bind(db);
  const asSystem = db.asSystem.bind(db);
  own.withTenant = ((tenantId: string, fn: (tx: SqlExecutor) => Promise<unknown>) => withTenant(tenantId, (tx) => fn(recording(tx)))) as Database['withTenant'];
  own.asSystem = ((fn: (tx: SqlExecutor) => Promise<unknown>) => asSystem((tx) => fn(recording(tx)))) as Database['asSystem'];
  try {
    await run();
  } finally {
    delete own.withTenant;
    delete own.asSystem;
  }
  return seen;
}

async function sent(run: () => Promise<unknown>, pattern: RegExp): Promise<Statement> {
  const hits = (await captured(run)).filter((s) => pattern.test(s.sql));
  expect(hits, `one statement matching ${pattern}`).toHaveLength(1);
  return hits[0]!;
}

/** Scan nodes of the plan: kind, index and table, in plan order. */
async function scans(s: Statement, seqscan: boolean, asSystem: boolean): Promise<string[]> {
  const explain = async (tx: SqlExecutor) => {
    if (!seqscan) await tx.query('set local enable_seqscan = off');
    return tx.query<{ 'QUERY PLAN': string }>(`explain ${s.sql}`, s.params);
  };
  const plan = await (asSystem ? w.platform.db.asSystem(explain) : w.platform.db.withTenant(w.ngoA, explain));
  return plan
    .map((r) => r['QUERY PLAN'].match(/((?:Parallel )?(?:Seq|Index Only|Index|Bitmap Index|Bitmap Heap) Scan)(?: using (\S+))? on (\S+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => `${m[1]}${m[2] ? ` using ${m[2]}` : ''} on ${m[3]}`);
}

/** `asSystem`: plan as the owner, for statements the service runs through asSystem(). */
async function expectSamePlans(before: Statement, now: Statement, asSystem = false): Promise<void> {
  for (const seqscan of [true, false]) {
    const old = await scans(before, seqscan, asSystem);
    expect(old.length).toBeGreaterThan(0);    expect(await scans(now, seqscan, asSystem), `enable_seqscan = ${seqscan}`).toEqual(old);
  }
}

const JOB_COLUMNS = `j.id, j.tenant_id, j.kind, j.status, j.input, j.state, j.actor, j.progress, j.total, j.result, j.error, j.cancel_requested,
  j.created_by, j.created_at, j.started_at, j.finished_at`;
const JOB_WHERE = `($1::text[] is null or j.kind = any($1)) and ($2::text[] is null or j.status = any($2))
  and ($3::text is null or j.created_by = $3)
  and ($4::date is null or j.created_at >= $4::date) and ($5::date is null or j.created_at < $5::date + 1)`;

const AUDIT_WHERE = `a.tenant_id = app_tenant()
  and ($1::text is null or a.actor_id = $1)
  and ($2::text[] is null or a.entity = any($2) or a.entity like any($3::text[]))
  and ($4::text is null or a.entity = $4)
  and ($5::date is null or a.at >= $5::date)
  and ($6::date is null or a.at < $6::date + 1)`;

const PEOPLE = `with people as (
  select m.user_id, u.display_name, u.email, m.joined_at, m.last_signed_in_at,
         case when m.status <> 'active' or u.status <> 'active' then 'suspended'
              when m.last_signed_in_at is null then 'invited'
              else 'active' end as status,
         case when u.totp_enabled then 'on'
              when exists (select 1 from role_assignment ra join role r on r.tenant_id = ra.tenant_id and r.key = ra.role_key
                            where ra.tenant_id = m.tenant_id and ra.user_id = m.user_id and r.require_two_step) then 'required-not-set'
              else 'off' end as two_step,
         array(select ra.role_key from role_assignment ra where ra.tenant_id = m.tenant_id and ra.user_id = m.user_id order by ra.role_key) as roles,
         (select max(p.created_at) from password_token p where p.tenant_id = m.tenant_id and p.user_id = m.user_id and p.purpose = 'invite') as invited_at
    from tenant_member m
    join app_user u on u.id = m.user_id
   where m.tenant_id = $1)`;
const PEOPLE_SEARCH = `(lower(display_name) like $2 escape '\\' or lower(email) like $2 escape '\\') and roles && $3::text[]`;

const ELIGIBLE = `from approval_request a
  join record r on r.id = a.record_id
  join unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as p(type_key, step, type_label, step_label, title_field)
    on p.type_key = r.type_key and p.step = a.transition_key
  left join app_user u on u.id::text = a.requested_by
 where a.tenant_id = app_tenant() and a.status = 'pending' and a.requested_by <> $1
   and not exists (select 1 from approval_decision d where d.request_id = a.id and d.user_id = $1)`;
const PAIRS = [['plangrant'], ['approvePlan'], ['Plan grant'], ['Approve plan grant'], ['title']];

describe('query plans after the Kysely migration', () => {
  const jobFilters: Parameters<TestWorld['platform']['jobs']['list']>[1][] = [
    { limit: 20, offset: 0 },
    { kind: ['index.build'], status: ['queued'], startedBy: owner.id, from: '2026-01-01', to: '2026-12-31', limit: 20, offset: 0 },
  ];

  it.each(jobFilters)('job list %#', async (filter) => {
    const params = [filter.kind ?? null, filter.status ?? null, filter.startedBy ?? null, filter.from ?? null, filter.to ?? null];
    const list = () => w.platform.jobs.list(w.as(w.ngoA, owner), filter);
    await expectSamePlans(
      {
        sql: `select ${JOB_COLUMNS}, app_member_name(u.id) as created_by_name from job j left join app_user u on u.id::text = j.created_by
               where ${JOB_WHERE} order by j.created_at desc, j.id limit 20 offset 0`,
        params,
      },
      await sent(list, /app_member_name/),
    );
    await expectSamePlans({ sql: `select count(*)::int as n from job j where ${JOB_WHERE}`, params }, await sent(list, /count\(\*\)/));
  });

  it.each([undefined, 'failed' as const])('job items with status %s', async (status) => {
    await expectSamePlans(
      {
        sql: `select seq, status, record_id, message, data from job_item where job_id = $1 and ($2::text is null or status = $2) order by seq limit $3 offset $4`,
        params: [jobId, status ?? null, 200, 0],
      },
      await sent(() => w.platform.jobs.items(w.as(w.ngoA, owner), jobId, { status }), /job_item/),
    );
  });

  const auditQueries: { person?: string; area?: 'roles'; recordType?: string; from?: string; to?: string }[] = [
    {},
    { person: owner.id, area: 'roles', recordType: 'donation', from: '2026-01-01', to: '2026-12-31' },
  ];

  it.each(auditQueries)('audit log %#', async (query) => {
    const params = [
      query.person ?? null,
      query.area ? ['role'] : null,
      query.area ? [] : null,
      query.recordType ? `record:${query.recordType}` : null,
      query.from ?? null,
      query.to ?? null,
    ];
    const audit = () => w.platform.administration.audit(w.as(w.ngoA, owner), query);
    await expectSamePlans(
      {
        sql: `select a.id, a.at, a.actor_id, app_member_name(u.id) as actor_name, a.action, a.entity, a.entity_id, a.before, a.after
                from audit_event a left join app_user u on u.id::text = a.actor_id
               where ${AUDIT_WHERE} order by a.at desc, a.id desc limit 50 offset 0`,
        params,
      },
      await sent(audit, /app_member_name/),
    );
    await expectSamePlans({ sql: `select count(*)::int as n from audit_event a where ${AUDIT_WHERE}`, params }, await sent(audit, /count\(\*\)/));
  });

  it.each([false, true])('roles, one by key: %s', async (byKey) => {
    const ctx = w.as(w.ngoA, owner);
    const key = byKey ? (await w.platform.roles.list(ctx))[0]!.key : undefined;
    await expectSamePlans(
      {
        sql: `select r.key, r.label, r.permissions, r.require_two_step, r.customised,
                (select count(*)::int from role_assignment ra where ra.tenant_id = r.tenant_id and ra.role_key = r.key) as members
                from role r where r.tenant_id = app_tenant() and ($1::text is null or r.key = $1) order by lower(r.label), r.key`,
        params: [key ?? null],
      },
      await sent(() => (key ? w.platform.roles.get(ctx, key) : w.platform.roles.list(ctx)), /from "role"/),
    );
  });

  it('approval requests waiting for a decision', async () => {
    await expectSamePlans(
      {
        sql: `select a.id, a.record_id, a.transition_key, a.requested_by, a.data, a.record_version, a.required_approvals,
                a.status, r.type_key, r.number, r.version as current_version, a.created_at,
                app_member_name(u.id) as requester_name,
                (select count(*)::int from approval_decision d where d.request_id = a.id and d.decision = 'approve') as approvals,
                exists (select 1 from approval_decision d where d.request_id = a.id and d.user_id = $1) as decided_by_me
           from approval_request a
           join record r on r.id = a.record_id
           left join app_user u on u.id::text = a.requested_by
          where a.tenant_id = app_tenant() and a.status = 'pending'
          order by a.created_at`,
        params: [owner.id],
      },
      await sent(() => w.platform.approvals.inbox(w.as(w.ngoA, owner)), /approval_request/),
    );
  });

  it('members list by name, unfiltered', async () => {
    const list = () => w.platform.people.list(w.as(w.ngoA, owner));
    await expectSamePlans(
      { sql: `${PEOPLE} select * from people order by lower(display_name) asc, lower(email) asc, user_id limit 50 offset 0`, params: [w.ngoA] },
      await sent(list, /select \* from "people"/),
      true,
    );
    await expectSamePlans({ sql: `${PEOPLE} select status, count(*)::int as n from people group by status`, params: [w.ngoA] }, await sent(list, /group by/), true);
  });

  it('members list searched, by role and status, sorted by status', async () => {
    const list = () => w.platform.people.list(w.as(w.ngoA, owner), { q: 'a_b', role: ['admin'], status: ['active', 'invited'], sort: 'status', dir: 'desc', limit: 10, offset: 5 });
    const params = [w.ngoA, likePattern('a_b'), ['admin']];
    await expectSamePlans(
      {
        sql: `${PEOPLE} select * from people where ${PEOPLE_SEARCH} and status = any($4::text[])
               order by case status when 'active' then 0 when 'invited' then 1 else 2 end desc, lower(display_name), user_id limit 10 offset 5`,
        params: [...params, ['active', 'invited']],
      },
      await sent(list, /select \* from "people"/),
      true,
    );
    await expectSamePlans({ sql: `${PEOPLE} select status, count(*)::int as n from people where ${PEOPLE_SEARCH} group by status`, params }, await sent(list, /group by/), true);
  });

  it('members list by date joined', async () => {
    await expectSamePlans(
      { sql: `${PEOPLE} select * from people order by joined_at desc, lower(display_name), user_id limit 50 offset 0`, params: [w.ngoA] },
      await sent(() => w.platform.people.list(w.as(w.ngoA, owner), { sort: 'joined' }), /select \* from "people"/),
      true,
    );
  });

  it('one member by id', async () => {
    const userId = randomUUID();
    await expectSamePlans(
      { sql: `${PEOPLE} select * from people where user_id = any($2::uuid[])`, params: [w.ngoA, [userId]] },
      await sent(() => w.platform.people.member(w.as(w.ngoA, owner), userId).catch(() => undefined), /"user_id" = any/),
      true,
    );
  });

  it('directory searched, by role', async () => {
    const directory = () => w.platform.people.directory(w.as(w.ngoA, owner), { q: 'nobody-matches', role: ['admin'] });
    const where = `where ${PEOPLE_SEARCH} and status = any($4::text[])`;
    const params = [w.ngoA, likePattern('nobody-matches'), ['admin'], ['active']];
    await expectSamePlans(
      { sql: `${PEOPLE} select *, count(*) over ()::int as total from people ${where} order by lower(display_name) asc, lower(email) asc, user_id limit 50 offset 0`, params },
      await sent(directory, /count\(\*\) over/),
      true,
    );
    await expectSamePlans({ sql: `${PEOPLE} select count(*)::int as n from people ${where}`, params }, await sent(directory, /select count\(\*\)::int as "n" from "people"/), true);
  });

  it('approvals waiting, for the badge', async () => {
    await expectSamePlans(
      { sql: `select count(*)::int as n ${ELIGIBLE}`, params: [owner.id, ...PAIRS] },
      await sent(() => w.platform.approvals.count(w.as(w.ngoA, owner)), /unnest/),
    );
  });

  const approvalQueries: { sort: string; query: ApprovalQuery; where: string; params: unknown[] }[] = [
    { sort: 'a.created_at asc', query: {}, where: '', params: [] },
    {
      sort: 'r.number asc nulls last, title asc nulls last',
      query: { search: 'a_b', filters: { type: ['plangrant'], step: ['approvePlan'], requestedBy: [owner.id] }, sort: { field: 'record', dir: 'asc' }, limit: 10, offset: 5 },
      where: `and p.type_key = any($7::text[]) and p.step = any($8::text[]) and a.requested_by = any($9::text[])
              and (r.number ilike $10 or r.data ->> p.title_field ilike $10)`,
      params: [['plangrant'], ['approvePlan'], [owner.id], likePattern('a_b')],
    },
    { sort: 'coalesce(app_member_name(u.id), a.requested_by) desc', query: { sort: { field: 'requestedBy', dir: 'desc' } }, where: '', params: [] },
  ];

  it.each(approvalQueries)('approvals list sorted by $sort', async ({ sort, query, where, params }) => {
    const list = () => w.platform.approvals.query(w.as(w.ngoA, owner), query);
    const all = [owner.id, ...PAIRS, ...params];
    const page = `limit ${query.limit ?? 50} offset ${query.offset ?? 0}`;
    await expectSamePlans({ sql: `select count(*)::int as n ${ELIGIBLE} ${where}`, params: all }, await sent(list, /select count\(\*\)::int as "n" from "approval_request"/));
    await expectSamePlans(
      {
        sql: `select a.id, a.record_id, r.type_key, a.transition_key, r.number, nullif(r.data ->> p.title_field, '') as title,
                r.status, r.workflow_state, a.requested_by, app_member_name(u.id) as requester_name, a.required_approvals, a.created_at,
                (select count(*)::int from approval_decision d where d.request_id = a.id and d.decision = 'approve') as approvals
           ${ELIGIBLE} ${where}
          order by ${sort}, a.created_at, a.id ${page}`,
        params: all,
      },
      await sent(list, /"requester_name"/),
    );
  });

  it('unread notifications before a cursor', async () => {
    const before = randomUUID();
    await expectSamePlans(
      {
        sql: `select id, subject, body, record_id, link, read_at, created_at from notification
               where tenant_id = app_tenant() and channel = 'inApp' and user_id = $1 and read_at is null
                 and (created_at, id) < (select c.created_at, c.id from notification c where c.tenant_id = app_tenant() and c.id = $3 and c.user_id = $1)
               order by created_at desc, id desc limit $2`,
        params: [owner.id, 21, before],
      },
      await sent(() => w.platform.notifications.inboxPage(w.as(w.ngoA, owner), { unreadOnly: true, before, limit: 20 }), /from "notification"/),
    );
  });
});
