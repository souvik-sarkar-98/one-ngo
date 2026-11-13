import { sql } from 'kysely';
import type { Database, SqlExecutor } from '../../db.js';
import { typed } from '../../kysely.js';
import { NOW } from '../../sql-fragments.js';
import type { SessionStore, SessionRotation } from '../../../../domain/identity/ports/identity-directory.js';
import type { AssuranceLevel, AuthenticationEvidence } from '../../../../domain/identity/ports/assurance.js';

async function insertRefreshToken(
  tx: SqlExecutor,
  userId: string,
  tenantId: string,
  familyId: string | null,
  tokenHash: string,
  ttlSeconds: number,
  evidence: AuthenticationEvidence,
): Promise<string> {
  const k = typed(tx);
  const row = await k
    .insertInto('refresh_token')
    .values({
      family_id: sql<string>`coalesce(${familyId}::uuid, gen_random_uuid())`,
      user_id: userId,
      tenant_id: tenantId,
      token_hash: tokenHash,
      expires_at: sql<Date>`now() + make_interval(secs => ${ttlSeconds})`,
      method: evidence.method,
      assurance: evidence.assurance,
      auth_time: evidence.authTime,
      amr: evidence.amr,
      acr: evidence.acr,
      provider_issuer: evidence.providerIssuer,
      provider_sid: evidence.providerSid,
    })
    .returning('family_id')
    .executeTakeFirst();
  if (!familyId) {
    await k.updateTable('tenant_member').set({ last_signed_in_at: NOW }).where('tenant_id', '=', tenantId).where('user_id', '=', userId).execute();
  }
  return row!.family_id;
}

/** The owner-level sessions capability. */
export function pgSessionStore(db: Database): SessionStore {
  return {
    start(userId, tenantId, tokenHash, ttlSeconds, evidence) {
      return db.asSystem((tx) => insertRefreshToken(tx, userId, tenantId, null, tokenHash, ttlSeconds, evidence));
    },
    rotate(tokenHash, nextHash, ttlSeconds) {
      return db.asSystem(async (tx): Promise<SessionRotation> => {
        const k = typed(tx);
        const row = await k
          .selectFrom('refresh_token')
          .select([
            'id',
            'family_id',
            'user_id',
            'tenant_id',
            'revoked_at',
            'method',
            'assurance',
            'auth_time',
            'amr',
            'acr',
            'provider_issuer',
            'provider_sid',
            sql<boolean>`expires_at <= now()`.as('expired'),
          ])
          .where('token_hash', '=', tokenHash)
          .forUpdate()
          .executeTakeFirst();
        if (!row) return { refused: 'ended' };
        if (row.revoked_at) return { reusedFamily: row.family_id };
        if (row.expired) return { refused: 'ended' };
        const member = await k
          .selectFrom('tenant_member as m')
          .innerJoin('app_user as u', 'u.id', 'm.user_id')
          .innerJoin('tenant as t', 't.id', 'm.tenant_id')
          .select((eb) => eb.lit(1).as('one'))
          .where('m.tenant_id', '=', row.tenant_id)
          .where('m.user_id', '=', row.user_id)
          .where('m.status', '=', 'active')
          .where('u.status', '=', 'active')
          .where('t.status', '=', 'active')
          .executeTakeFirst();
        if (!member) return { refused: 'removed' };
        const evidence: AuthenticationEvidence = {
          method: row.method,
          assurance: row.assurance as AssuranceLevel,
          authTime: row.auth_time,
          amr: row.amr,
          ...(row.acr ? { acr: row.acr } : {}),
          ...(row.provider_issuer ? { providerIssuer: row.provider_issuer } : {}),
          ...(row.provider_sid ? { providerSid: row.provider_sid } : {}),
        };
        const familyId = await insertRefreshToken(tx, row.user_id, row.tenant_id, row.family_id, nextHash, ttlSeconds, evidence);
        await k
          .updateTable('refresh_token')
          .set((eb) => ({
            revoked_at: NOW,
            replaced_by: eb.selectFrom('refresh_token').select('id').where('token_hash', '=', nextHash),
          }))
          .where('id', '=', row.id)
          .execute();
        return { userId: row.user_id, tenantId: row.tenant_id, familyId, evidence };
      });
    },
    async endFamily(familyId) {
      await db.asSystem((tx) =>
        typed(tx).updateTable('refresh_token').set({ revoked_at: NOW }).where('family_id', '=', familyId).where('revoked_at', 'is', null).execute(),
      );
    },
    async isLive(familyId, userId, tenantId) {
      if (![familyId, userId, tenantId].every((id) => /^[0-9a-f-]{36}$/i.test(id))) return false;
      const row = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('refresh_token')
          .select((eb) => eb.lit(1).as('one'))
          .where('family_id', '=', familyId)
          .where('user_id', '=', userId)
          .where('tenant_id', '=', tenantId)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', NOW)
          .limit(1)
          .executeTakeFirst(),
      );
      return !!row;
    },
    async endByToken(tokenHash) {
      await db.asSystem((tx) =>
        typed(tx)
          .updateTable('refresh_token')
          .set({ revoked_at: NOW })
          .where('family_id', '=', (eb) => eb.selectFrom('refresh_token').select('family_id').where('token_hash', '=', tokenHash))
          .where('revoked_at', 'is', null)
          .execute(),
      );
    },
    async endForMember(tenantId, userId) {
      await db.asSystem((tx) =>
        typed(tx)
          .updateTable('refresh_token')
          .set({ revoked_at: NOW })
          .where('user_id', '=', userId)
          .where('tenant_id', '=', tenantId)
          .where('revoked_at', 'is', null)
          .execute(),
      );
    },
    async endForMethod(tenantId, userId, method) {
      await db.asSystem((tx) =>
        typed(tx)
          .updateTable('refresh_token')
          .set({ revoked_at: NOW })
          .where('user_id', '=', userId)
          .where('tenant_id', '=', tenantId)
          .where('method', '=', method)
          .where('revoked_at', 'is', null)
          .execute(),
      );
    },
    async endForTenantMethod(tenantId, method) {
      await db.asSystem((tx) =>
        typed(tx)
          .updateTable('refresh_token')
          .set({ revoked_at: NOW })
          .where('tenant_id', '=', tenantId)
          .where('method', '=', method)
          .where('revoked_at', 'is', null)
          .execute(),
      );
    },
  };
}
