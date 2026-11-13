import { sql, type QueryCreator, type SelectQueryBuilder } from 'kysely';
import type { Database, SqlExecutor } from '../../db.js';
import { typed } from '../../kysely.js';
import type { MemberDirectory, MemberStatus, TwoStepState, MemberRow, MemberFilters, MemberSort } from '../../../../domain/identity/ports/identity-directory.js';

// Runs as the owner: two-step state lives on the account, which the runtime role cannot read.
const people = (tx: SqlExecutor, tenantId: string) =>
  typed(tx).with('people', (db) =>
    db
      .selectFrom('tenant_member as m')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select((eb) => [
        'm.user_id',
        eb.fn.coalesce('m.display_name', 'u.display_name').as('display_name'),
        'u.email',
        'm.joined_at',
        'm.last_signed_in_at',
        eb
          .case()
          .when(eb.or([eb('m.status', '<>', 'active'), eb('u.status', '<>', 'active')]))
          .then('suspended')
          .when('m.last_signed_in_at', 'is', null)
          .then('invited')
          .else('active')
          .end()
          .$castTo<MemberStatus>()
          .as('status'),
        eb
          .case()
          .when(eb.ref('u.totp_enabled'))
          .then('on')
          .when(
            eb.exists(
              eb
                .selectFrom('role_assignment as ra')
                .innerJoin('role as r', (j) => j.onRef('r.tenant_id', '=', 'ra.tenant_id').onRef('r.key', '=', 'ra.role_key'))
                .select(eb.lit(1).as('one'))
                .whereRef('ra.tenant_id', '=', 'm.tenant_id')
                .whereRef('ra.user_id', '=', 'm.user_id')
                .where((r) => r.ref('r.require_two_step')),
            ),
          )
          .then('required-not-set')
          .else('off')
          .end()
          .$castTo<TwoStepState>()
          .as('two_step'),
        // `array${subquery}`: the subquery brings its own parentheses; array((…)) would be a one-element array.
        sql<string[]>`array${eb
          .selectFrom('role_assignment as ra')
          .select('ra.role_key')
          .whereRef('ra.tenant_id', '=', 'm.tenant_id')
          .whereRef('ra.user_id', '=', 'm.user_id')
          .orderBy('ra.role_key')}`.as('roles'),
        eb
          .selectFrom('password_token as p')
          .select((p) => p.fn.max('p.created_at').as('max'))
          .whereRef('p.tenant_id', '=', 'm.tenant_id')
          .whereRef('p.user_id', '=', 'm.user_id')
          .where('p.purpose', '=', 'invite')
          .as('invited_at'),
      ])
      .where('m.tenant_id', '=', tenantId),
  );

type PeopleDb = ReturnType<typeof people> extends QueryCreator<infer D> ? D : never;
type PeopleQuery<O> = SelectQueryBuilder<PeopleDb, 'people', O>;

const ORDER: Record<MemberSort, <O>(qb: PeopleQuery<O>, dir: 'asc' | 'desc') => PeopleQuery<O>> = {
  name: (qb, d) =>
    qb
      .orderBy((eb) => eb.fn('lower', ['display_name']), d)
      .orderBy((eb) => eb.fn('lower', ['email']), d)
      .orderBy('user_id'),
  joined: (qb, d) => qb.orderBy('joined_at', d).orderBy((eb) => eb.fn('lower', ['display_name'])).orderBy('user_id'),
  status: (qb, d) =>
    qb
      .orderBy((eb) => eb.case('status').when('active').then(eb.lit(0)).when('invited').then(eb.lit(1)).else(eb.lit(2)).end(), d)
      .orderBy((eb) => eb.fn('lower', ['display_name']))
      .orderBy('user_id'),
};

function filtered<O>(qb: PeopleQuery<O>, f: MemberFilters): PeopleQuery<O> {
  if (f.pattern) {
    const p = f.pattern;
    qb = qb.where(sql<boolean>`(lower(display_name) like ${p} escape '\\' or lower(email) like ${p} escape '\\')`);
  }
  if (f.role?.length) qb = qb.where(sql<boolean>`roles && ${f.role}::text[]`);
  if (f.status?.length) qb = qb.where('status', '=', sql<MemberStatus>`any(${f.status}::text[])`);
  if (f.userIds) qb = qb.where('user_id', '=', sql<string>`any(${f.userIds}::uuid[])`);
  return qb;
}


function roleOptions(tx: SqlExecutor, tenantId: string): Promise<{ key: string; label: string }[]> {
  return typed(tx)
    .selectFrom('role')
    .select(['key', 'label'])
    .where('tenant_id', '=', tenantId)
    .orderBy((eb) => eb.fn('lower', ['label']))
    .orderBy('key')
    .execute();
}

/** The owner-level members capability. */
export function pgMemberDirectory(db: Database): MemberDirectory {
  return {
    list(tenantId, filters, sort, dir, page) {
      return db.asSystem(async (tx) => {
        const rows: MemberRow[] = await ORDER[sort](filtered(people(tx, tenantId).selectFrom('people').selectAll(), filters), dir)
          .limit(page.limit)
          .offset(page.offset)
          .execute();
        const byStatus = await filtered(
          people(tx, tenantId)
            .selectFrom('people')
            .select(['status', sql<number>`count(*)::int`.as('n')]),
          { ...filters, status: undefined },
        )
          .groupBy('status')
          .execute();
        return { rows, byStatus, roles: await roleOptions(tx, tenantId) };
      });
    },
    byName(tenantId, filters, dir, page) {
      return db.asSystem(async (tx) => {
        const rows = await ORDER.name(
          filtered(
            people(tx, tenantId)
              .selectFrom('people')
              .selectAll()
              .select(sql<number>`count(*) over ()::int`.as('total')),
            filters,
          ),
          dir,
        )
          .limit(page.limit)
          .offset(page.offset)
          .execute();
        const total =
          rows[0]?.total ??
          (await filtered(people(tx, tenantId).selectFrom('people').select(sql<number>`count(*)::int`.as('n')), filters).executeTakeFirstOrThrow()).n;
        return { rows, total, roles: await roleOptions(tx, tenantId) };
      });
    },
    rows(tenantId, userIds) {
      return db.asSystem((tx) => filtered(people(tx, tenantId).selectFrom('people').selectAll(), { userIds }).execute());
    },
    accountByEmail(tenantId, email) {
      return db.asSystem((tx) =>
        typed(tx)
          .selectFrom('app_user as u')
          .leftJoin('tenant_member as m', (j) => j.onRef('m.user_id', '=', 'u.id').on('m.tenant_id', '=', tenantId))
          .select((eb) => [eb.fn.coalesce('m.display_name', 'u.display_name').as('display_name'), 'u.status', 'm.status as member_status'])
          .where((eb) => eb(eb.fn('lower', ['u.email']), '=', email))
          .executeTakeFirst(),
      );
    },
    member(tenantId, userId) {
      return db.asSystem((tx) =>
        typed(tx)
          .selectFrom('tenant_member as m')
          .innerJoin('app_user as u', 'u.id', 'm.user_id')
          .select((eb) => [
            eb.fn.coalesce('m.display_name', 'u.display_name').as('display_name'),
            'u.email',
            sql<string>`case when m.status = 'active' and u.status = 'active' then 'active' else 'suspended' end`.as('status'),
          ])
          .where('m.tenant_id', '=', tenantId)
          .where('m.user_id', '=', userId)
          .executeTakeFirst(),
      );
    },
  };
}
