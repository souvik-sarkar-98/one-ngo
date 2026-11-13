import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import { NOW } from '../../sql-fragments.js';
import type { SystemIdentity } from '../../../../domain/identity/ports/identity-directory.js';

class OidcRefusal extends Error {
  constructor(readonly reason: 'no-member' | 'linked-elsewhere') {
    super(reason);
  }
}

/** The owner-level identity capability. */
export function pgSystemIdentity(db: Database): SystemIdentity {
  return {
    async startOidcLogin(login) {
      await db.asSystem((tx) =>
        typed(tx)
          .insertInto('oidc_login')
          .values({ ...login, expires_at: sql<Date>`now() + interval '10 minutes'` })
          .execute(),
      );
    },
    useOidcLogin(stateHash) {
      return db.asSystem((tx) =>
        typed(tx)
          .updateTable('oidc_login')
          .set({ used_at: NOW })
          .where('state_hash', '=', stateHash)
          .where('used_at', 'is', null)
          .where('expires_at', '>', NOW)
          .returning(['tenant_id', 'provider', 'nonce', 'code_verifier', 'next_path'])
          .executeTakeFirst(),
      );
    },
    async oidcMember(tenantId, c) {
      try {
        const userId = await db.asSystem(async (tx) => {
          const k = typed(tx);
          const linked = await k.selectFrom('user_identity').select('user_id').where('issuer', '=', c.iss).where('subject', '=', c.sub).executeTakeFirst();
          let userId = linked?.user_id;
          if (!userId) {
            const user = await k
              .selectFrom('app_user')
              .select('id')
              .where((eb) => eb(eb.fn('lower', ['email']), '=', c.email))
              .where('status', '=', 'active')
              .executeTakeFirst();
            if (!user) throw new OidcRefusal('no-member');
            const member = await k
              .selectFrom('tenant_member')
              .select((eb) => eb.lit(1).as('one'))
              .where('tenant_id', '=', tenantId)
              .where('user_id', '=', user.id)
              .where('status', '=', 'active')
              .executeTakeFirst();
            if (!member) throw new OidcRefusal('no-member');
            const other = await k
              .selectFrom('user_identity')
              .select((eb) => eb.lit(1).as('one'))
              .where('issuer', '=', c.iss)
              .where('user_id', '=', user.id)
              .executeTakeFirst();
            if (other) throw new OidcRefusal('linked-elsewhere');
            const inserted = await k
              .insertInto('user_identity')
              .values({ issuer: c.iss, subject: c.sub, user_id: user.id, email_at_link: c.email })
              .onConflict((oc) => oc.doNothing())
              .returning('user_id')
              .executeTakeFirst();
            if (inserted) userId = inserted.user_id;
            else {
              const winner = await k
                .selectFrom('user_identity')
                .select('user_id')
                .where('issuer', '=', c.iss)
                .where('subject', '=', c.sub)
                .executeTakeFirst();
              if (!winner || winner.user_id !== user.id) throw new OidcRefusal('linked-elsewhere');
              userId = winner.user_id;
            }
          }
          const member = await k
            .selectFrom('tenant_member')
            .select((eb) => eb.lit(1).as('one'))
            .where('tenant_id', '=', tenantId)
            .where('user_id', '=', userId)
            .where('status', '=', 'active')
            .executeTakeFirst();
          if (!member) throw new OidcRefusal('no-member');
          return userId;
        });
        return { userId };
      } catch (error) {
        if (error instanceof OidcRefusal) return { refused: error.reason };
        throw error;
      }
    },
    apiKey(id, rateSetting) {
      return db.asSystem((tx) =>
        typed(tx)
          .selectFrom('api_key as k')
          .innerJoin('tenant as t', (j) => j.onRef('t.id', '=', 'k.tenant_id').on('t.status', '=', 'active'))
          .leftJoin('role as r', (j) => j.onRef('r.tenant_id', '=', 'k.tenant_id').onRef('r.key', '=', 'k.role_key'))
          .select((eb) => [
            'k.tenant_id',
            'k.name',
            'k.secret_hash',
            'k.role_key',
            'k.feed_key',
            'r.permissions',
            'k.revoked_at',
            eb
              .selectFrom('tenant_setting as s')
              .select('s.value')
              .whereRef('s.tenant_id', '=', 'k.tenant_id')
              .where('s.key', '=', rateSetting)
              .as('rate'),
          ])
          .where('k.id', '=', id)
          .executeTakeFirst(),
      );
    },
    async touchApiKey(id) {
      await db.asSystem((tx) =>
        typed(tx)
          .updateTable('api_key')
          .set({ last_used_at: sql<Date>`now()` })
          .where('id', '=', id)
          .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', sql<Date>`now() - interval '1 minute'`)]))
          .execute(),
      );
    },
  };
}
