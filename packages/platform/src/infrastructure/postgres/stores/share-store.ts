import { sql } from 'kysely';
import { writeAudit, type AuditInput } from './audit-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { NewShare, PrincipalKind, ShareAccess, ShareRow, ShareStore } from '../../../runtime/records/ports/share-store.js';
import { executorOf, pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;

export class PgShareStore implements ShareStore {
  list(tx: Tx, recordId: string): Promise<ShareRow[]> {
    return pg(tx)
      .selectFrom('record_share as s')
      .select((eb) => [
        's.id',
        's.principal_kind',
        's.principal',
        's.access',
        's.created_by',
        's.created_at',
        's.expires_at',
        eb.fn
          .coalesce(
            eb
              .case()
              .when('s.principal_kind', '=', 'user')
              .then(
                eb
                  .selectFrom('app_user as u')
                  .select(sql<string>`app_member_name(u.id)`.as('display_name'))
                  .where((w) => w(w.cast('u.id', 'text'), '=', w.ref('s.principal'))),
              )
              .else(eb.selectFrom('role as ro').select('ro.label').where('ro.tenant_id', '=', APP_TENANT).whereRef('ro.key', '=', 's.principal'))
              .end(),
            's.principal',
          )
          .as('name'),
      ])
      .where('s.tenant_id', '=', APP_TENANT)
      .where('s.record_id', '=', recordId)
      .orderBy('s.created_at')
      .orderBy('s.id')
      .$castTo<ShareRow>()
      .execute();
  }

  async isActiveMember(tx: Tx, userId: string): Promise<boolean> {
    const row = await pg(tx)
      .selectFrom('tenant_member as m')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select((eb) => eb.lit(1).as('one'))
      .where('m.tenant_id', '=', APP_TENANT)
      .where('m.user_id', '=', sql<string>`${userId}::uuid`)
      .where('m.status', '=', 'active')
      .where('u.status', '=', 'active')
      .executeTakeFirst();
    return !!row;
  }

  async isRole(tx: Tx, key: string): Promise<boolean> {
    const row = await pg(tx).selectFrom('role').select((eb) => eb.lit(1).as('one')).where('tenant_id', '=', APP_TENANT).where('key', '=', key).executeTakeFirst();
    return !!row;
  }

  lockShare(tx: Tx, recordId: string, principalKind: PrincipalKind, principal: string): Promise<{ id: string; live: boolean } | undefined> {
    return pg(tx)
      .selectFrom('record_share')
      .select(['id', sql<boolean>`(expires_at is null or expires_at > now())`.as('live')])
      .where('tenant_id', '=', APP_TENANT)
      .where('record_id', '=', recordId)
      .where('principal_kind', '=', principalKind)
      .where('principal', '=', principal)
      .forUpdate()
      .executeTakeFirst();
  }

  async changeShare(tx: Tx, id: string, access: ShareAccess, expiresAt: string | null): Promise<string | undefined> {
    const row = await pg(tx).updateTable('record_share').set({ access, expires_at: expiresAt }).where('id', '=', id).returning('id').executeTakeFirst();
    return row?.id;
  }

  async addShare(tx: Tx, s: NewShare): Promise<string | undefined> {
    const row = await pg(tx)
      .insertInto('record_share')
      .values({
        tenant_id: APP_TENANT,
        record_id: s.recordId,
        principal_kind: s.principalKind,
        principal: s.principal,
        access: s.access,
        created_by: s.createdBy,
        expires_at: s.expiresAt,
      })
      .returning('id')
      .executeTakeFirst();
    return row?.id;
  }

  removeShare(tx: Tx, recordId: string, shareId: string) {
    return pg(tx)
      .deleteFrom('record_share')
      .where('tenant_id', '=', APP_TENANT)
      .where('record_id', '=', recordId)
      .where('id', '=', shareId)
      .returning(['principal_kind', 'principal', 'access'])
      .executeTakeFirst();
  }

  async candidates(tx: Tx, { q, like, exceptUserId, max }: { q: string; like: string; exceptUserId: string; max: number }) {
    return {
      people: await pg(tx)
        .selectFrom('tenant_member as m')
        .innerJoin('app_user as u', 'u.id', 'm.user_id')
        .select((eb) => [
          'u.id',
          eb.fn.coalesce('m.display_name', 'u.display_name').as('name'),
          'u.email',
          sql<string[]>`coalesce((
            select array_agg(distinct p)
            from role_assignment ra
            join role r on r.tenant_id = ra.tenant_id and r.key = ra.role_key
            cross join lateral unnest(r.permissions) as p
            where ra.tenant_id = app_tenant() and ra.user_id = u.id
          ), array[]::text[])`.as('permissions'),
        ])
        .where('m.tenant_id', '=', APP_TENANT)
        .where('m.status', '=', 'active')
        .where('u.status', '=', 'active')
        .where((eb) => eb(eb.cast('u.id', 'text'), '<>', exceptUserId))
        .$if(q !== '', (qb) =>
          qb.where(sql<boolean>`(lower(coalesce(m.display_name, u.display_name)) like ${like} escape '\\' or lower(u.email) like ${like} escape '\\')`),
        )
        .orderBy(sql`lower(coalesce(m.display_name, u.display_name))`)
        .orderBy(sql`lower(u.email)`)
        .orderBy('u.id')
        .limit(max)
        .execute(),
      roles: await pg(tx)
        .selectFrom('role')
        .select(['key', 'label', 'permissions'])
        .where('tenant_id', '=', APP_TENANT)
        .$if(q !== '', (qb) => qb.where(sql<boolean>`(lower(label) like ${like} escape '\\' or lower(key) like ${like} escape '\\')`))
        .orderBy(sql`lower(label)`)
        .orderBy('key')
        .limit(max)
        .execute(),
    };
  }

  async userName(tx: Tx, userId: string): Promise<string | undefined> {
    const row = await pg(tx)
      .selectFrom('app_user')
      .select(sql<string>`app_member_name(id)`.as('display_name'))
      .where((eb) => eb(eb.cast('id', 'text'), '=', userId))
      .executeTakeFirst();
    return row?.display_name;
  }

  audit(tx: Tx, input: AuditInput): Promise<void> {
    return writeAudit(executorOf(tx), input);
  }
}
