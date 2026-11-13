import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import { NOW, minutesFromNow } from '../../sql-fragments.js';
import { useTwoStepStep } from './two-step-step.js';
import type { SignInStore } from '../../../../domain/identity/ports/identity-directory.js';
import type { AssuranceLevel, AuthenticationEvidence, TenantAuthPolicy } from '../../../../domain/identity/ports/assurance.js';

const DEFAULT_AUTH_POLICY: Readonly<TenantAuthPolicy> = {
  passwordEnabled: true,
  emailCodeEnabled: true,
  passkeyEnabled: false,
  minimumAssurance: 'aal1',
};

const evidenceFrom = (row: {
  sign_in_method: string | null;
  sign_in_assurance: string | null;
  sign_in_auth_time: Date | null;
  sign_in_amr: string[] | null;
  sign_in_acr: string | null;
  sign_in_provider_issuer: string | null;
  sign_in_provider_sid: string | null;
}): AuthenticationEvidence | undefined =>
  row.sign_in_method && row.sign_in_assurance && row.sign_in_auth_time
    ? {
        method: row.sign_in_method,
        assurance: row.sign_in_assurance as AssuranceLevel,
        authTime: row.sign_in_auth_time,
        amr: row.sign_in_amr ?? [],
        ...(row.sign_in_acr ? { acr: row.sign_in_acr } : {}),
        ...(row.sign_in_provider_issuer ? { providerIssuer: row.sign_in_provider_issuer } : {}),
        ...(row.sign_in_provider_sid ? { providerSid: row.sign_in_provider_sid } : {}),
      }
    : undefined;

/** The owner-level signIn capability. */
export function pgSignInStore(db: Database): SignInStore {
  return {
    async addEmailCode(email, tenantId, codeHash, ttlMinutes) {
      await db.asSystem((tx) =>
        typed(tx)
          .insertInto('email_code')
          .values({ email, tenant_id: tenantId, code_hash: codeHash, expires_at: minutesFromNow(ttlMinutes) })
          .execute(),
      );
    },
    useEmailCode(email, tenantId, codeHash) {
      return db.asSystem(async (tx) => {
        const k = typed(tx);
        const row = await k
          .selectFrom('email_code')
          .select(['id', 'code_hash', 'attempts'])
          .where((eb) => eb(eb.fn('lower', ['email']), '=', email))
          .where('tenant_id', '=', tenantId)
          .where('consumed_at', 'is', null)
          .where('expires_at', '>', NOW)
          .orderBy('created_at', 'desc')
          .limit(1)
          .forUpdate()
          .executeTakeFirst();
        if (!row || row.attempts >= 5) return false;
        if (row.code_hash !== codeHash) {
          await k
            .updateTable('email_code')
            .set((eb) => ({ attempts: eb('attempts', '+', eb.lit(1)) }))
            .where('id', '=', row.id)
            .execute();
          return false;
        }
        await k.updateTable('email_code').set({ consumed_at: NOW }).where('id', '=', row.id).execute();
        return true;
      });
    },
    async addPasswordToken(t) {
      await db.asSystem(async (tx) => {
        const k = typed(tx);
        if (t.purpose !== 'two_step') {
          await k
            .updateTable('password_token')
            .set({ used_at: NOW })
            .where('user_id', '=', t.userId)
            .where('purpose', '=', t.purpose)
            .where('used_at', 'is', null)
            .execute();
        }
        await k
          .insertInto('password_token')
          .values({
            user_id: t.userId,
            tenant_id: t.tenantId,
            purpose: t.purpose,
            token_hash: t.tokenHash,
            expires_at: minutesFromNow(t.ttlMinutes),
            created_by: t.createdBy,
            sign_in_method: t.evidence?.method,
            sign_in_assurance: t.evidence?.assurance,
            sign_in_auth_time: t.evidence?.authTime,
            sign_in_amr: t.evidence?.amr,
            sign_in_acr: t.evidence?.acr,
            sign_in_provider_issuer: t.evidence?.providerIssuer,
            sign_in_provider_sid: t.evidence?.providerSid,
          })
          .execute();
      });
    },
    openPasswordToken(tokenHash) {
      return db.asSystem((tx) =>
        typed(tx)
          .selectFrom('password_token as p')
          .innerJoin('tenant as t', 't.id', 'p.tenant_id')
          .select(['p.id', 'p.user_id', 'p.tenant_id', 'p.purpose', 't.key'])
          .where('p.token_hash', '=', tokenHash)
          .where('p.purpose', 'in', ['reset', 'invite'])
          .where('p.used_at', 'is', null)
          .where('p.expires_at', '>', NOW)
          .executeTakeFirst(),
      );
    },
    async finishPasswordTokens(userId) {
      await db.asSystem(async (tx) => {
        const k = typed(tx);
        await k
          .updateTable('password_token')
          .set({ used_at: NOW })
          .where('user_id', '=', userId)
          .where('purpose', 'in', ['reset', 'invite'])
          .where('used_at', 'is', null)
          .execute();
        await k.updateTable('refresh_token').set({ revoked_at: NOW }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
      });
    },
    useTwoStepTicket(tokenHash, verify) {
      return db.asSystem(async (tx) => {
        const k = typed(tx);
        const row = await k
          .selectFrom('password_token as p')
          .innerJoin('app_user as u', 'u.id', 'p.user_id')
          .select([
            'p.id',
            'p.user_id',
            'p.tenant_id',
            'p.attempts',
            'u.totp_secret_enc',
            'p.sign_in_method',
            'p.sign_in_assurance',
            'p.sign_in_auth_time',
            'p.sign_in_amr',
            'p.sign_in_acr',
            'p.sign_in_provider_issuer',
            'p.sign_in_provider_sid',
          ])
          .where('p.token_hash', '=', tokenHash)
          .where('p.purpose', '=', 'two_step')
          .where('p.used_at', 'is', null)
          .where('p.expires_at', '>', NOW)
          .forUpdate('p')
          .executeTakeFirst();
        if (!row || row.attempts >= 5 || !row.totp_secret_enc) return null;
        const step = verify(row.totp_secret_enc);
        if (step === null || !(await useTwoStepStep(tx, row.user_id, step))) {
          await k
            .updateTable('password_token')
            .set((eb) => ({ attempts: eb('attempts', '+', eb.lit(1)) }))
            .where('id', '=', row.id)
            .execute();
          return null;
        }
        await k.updateTable('password_token').set({ used_at: NOW }).where('id', '=', row.id).execute();
        return { userId: row.user_id, tenantId: row.tenant_id, evidence: evidenceFrom(row) };
      });
    },
    async isLocked(keys) {
      const rows = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('auth_throttle')
          .select((eb) => eb.lit(1).as('one'))
          .where((eb) => eb('key', '=', eb.fn.any(eb.val(keys))))
          .where('locked_until', '>', NOW)
          .execute(),
      );
      return rows.length > 0;
    },
    async recordFailures(keys, lockMinutes) {
      await db.asSystem(async (tx) => {
        const k = typed(tx);
        for (const { key, limit } of keys) {
          const windowOver = sql<boolean>`auth_throttle.window_started_at < now() - make_interval(mins => ${lockMinutes})`;
          await k
            .insertInto('auth_throttle')
            .values({ key, failures: 1, window_started_at: NOW })
            .onConflict((oc) =>
              oc.column('key').doUpdateSet((eb) => ({
                failures: eb.case().when(windowOver).then(eb.lit(1)).else(eb('auth_throttle.failures', '+', eb.lit(1))).end(),
                window_started_at: eb.case().when(windowOver).then(NOW).else(eb.ref('auth_throttle.window_started_at')).end(),
              })),
            )
            .execute();
          await k.updateTable('auth_throttle').set({ locked_until: minutesFromNow(lockMinutes) }).where('key', '=', key).where('failures', '>=', limit).execute();
        }
      });
    },
    async clearFailures(key) {
      await db.asSystem((tx) => typed(tx).deleteFrom('auth_throttle').where('key', '=', key).execute());
    },
    async authPolicy(tenantId) {
      const row = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('tenant_auth_policy')
          .select(['password_enabled', 'email_code_enabled', 'passkey_enabled', 'minimum_assurance'])
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst(),
      );
      return row
        ? {
            passwordEnabled: row.password_enabled,
            emailCodeEnabled: row.email_code_enabled,
            passkeyEnabled: row.passkey_enabled,
            minimumAssurance: row.minimum_assurance as AssuranceLevel,
          }
        : { ...DEFAULT_AUTH_POLICY };
    },
    saveAuthPolicy(tenantId, policy, updatedBy) {
      return db.asSystem(async (tx) => {
        const k = typed(tx);
        await k.selectFrom('tenant').select('id').where('id', '=', tenantId).forUpdate().executeTakeFirstOrThrow();
        const previous = await k
          .selectFrom('tenant_auth_policy')
          .select(['password_enabled', 'email_code_enabled', 'passkey_enabled'])
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst();
        // Without passwords, the remaining methods must keep at least two protected administrators able to sign in. Any change made while passwords are off is checked.
        const changesWhilePasswordOff =
          (previous?.password_enabled ?? true) !== policy.passwordEnabled ||
          (previous?.email_code_enabled ?? true) !== policy.emailCodeEnabled ||
          (previous?.passkey_enabled ?? false) !== policy.passkeyEnabled;
        if (!policy.passwordEnabled && changesWhilePasswordOff) {
          const rank = policy.minimumAssurance === 'aal3' ? 3 : policy.minimumAssurance === 'aal2' ? 2 : 1;
          const protectedAdmins = await sql<{ count: string }>`
            select count(distinct m.user_id)::text as count
            from tenant_member m
            join app_user u on u.id = m.user_id
            where m.tenant_id = ${tenantId}::uuid
              and m.status = 'active' and u.status = 'active'
              and exists (
                select 1 from role_assignment ra join role r
                  on r.tenant_id = ra.tenant_id and r.key = ra.role_key
                where ra.tenant_id = m.tenant_id and ra.user_id = m.user_id
                  and (r.permissions @> array['*']::text[] or r.permissions @> array['auth:configure']::text[])
              )
              and (
                (${policy.emailCodeEnabled} and (${rank} = 1 or (${rank} = 2 and u.totp_enabled)))
                or (
                  ${policy.passkeyEnabled} and ${rank} <= 2 and exists (
                    select 1 from passkey_credential pc
                    where pc.user_id = m.user_id and pc.revoked_at is null
                  )
                )
                or exists (
                  select 1 from refresh_token rt
                  join tenant_auth_provider ap
                    on ap.tenant_id = rt.tenant_id and rt.method = 'oidc:' || ap.provider_id
                  where rt.tenant_id = m.tenant_id and rt.user_id = m.user_id
                    and rt.revoked_at is null and rt.expires_at > now() and ap.enabled
                    and case rt.assurance when 'aal3' then 3 when 'aal2' then 2 else 1 end >= ${rank}
                )
              )
          `.execute(k);
          if (Number(protectedAdmins.rows[0]?.count ?? 0) < 2) return 'needs-two-protected-admins';
        }
        await k
          .insertInto('tenant_auth_policy')
          .values({
            tenant_id: tenantId,
            password_enabled: policy.passwordEnabled,
            email_code_enabled: policy.emailCodeEnabled,
            passkey_enabled: policy.passkeyEnabled,
            minimum_assurance: policy.minimumAssurance,
            updated_by: updatedBy,
          })
          .onConflict((oc) =>
            oc.column('tenant_id').doUpdateSet({
              password_enabled: policy.passwordEnabled,
              email_code_enabled: policy.emailCodeEnabled,
              passkey_enabled: policy.passkeyEnabled,
              minimum_assurance: policy.minimumAssurance,
              updated_by: updatedBy,
              updated_at: NOW,
            }),
          )
          .execute();
        return 'saved';
      });
    },
    async providerPolicy(tenantId, providerId) {
      const row = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('tenant_auth_provider')
          .select(['enabled', 'assurance', 'allowed_domains'])
          .where('tenant_id', '=', tenantId)
          .where('provider_id', '=', providerId)
          .executeTakeFirst(),
      );
      return row ? { enabled: row.enabled, assurance: row.assurance as AssuranceLevel, allowedDomains: row.allowed_domains } : undefined;
    },
    async providerPolicies(tenantId) {
      const rows = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('tenant_auth_provider')
          .select(['provider_id', 'enabled', 'assurance', 'allowed_domains', 'updated_at'])
          .where('tenant_id', '=', tenantId)
          .orderBy('provider_id')
          .execute(),
      );
      return rows.map((r) => ({
        providerId: r.provider_id,
        enabled: r.enabled,
        assurance: r.assurance as AssuranceLevel,
        allowedDomains: r.allowed_domains,
        updatedAt: new Date(r.updated_at),
      }));
    },
    async saveProviderPolicy(tenantId, providerId, policy, updatedBy) {
      const domains = policy.allowedDomains === undefined ? {} : { allowed_domains: policy.allowedDomains };
      await db.asSystem((tx) =>
        typed(tx)
          .insertInto('tenant_auth_provider')
          .values({ tenant_id: tenantId, provider_id: providerId, enabled: policy.enabled, assurance: policy.assurance, updated_by: updatedBy, ...domains })
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'provider_id']).doUpdateSet({
              enabled: policy.enabled,
              assurance: policy.assurance,
              updated_by: updatedBy,
              updated_at: NOW,
              ...domains,
            }),
          )
          .execute(),
      );
    },
  };
}
