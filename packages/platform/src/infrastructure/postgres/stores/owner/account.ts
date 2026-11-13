import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import { useTwoStepStep } from './two-step-step.js';
import type { AccountStore } from '../../../../domain/identity/ports/identity-directory.js';

const ACCOUNT_COLUMNS = ['id', 'email', 'password_hash', 'totp_secret_enc', 'totp_enabled', 'status'] as const;

/** The owner-level accounts capability. */
export function pgAccountStore(db: Database): AccountStore {
  return {
    async add(email, displayName) {
      const user = await db.asSystem((tx) =>
        typed(tx)
          .insertInto('app_user')
          .values({ email, display_name: displayName })
          .onConflict((oc) => oc.expression(sql`lower(email)`).doUpdateSet((eb) => ({ display_name: eb.ref('app_user.display_name') })))
          .returning('id')
          .executeTakeFirst(),
      );
      return user!.id;
    },
    byEmail(email) {
      return db.asSystem((tx) =>
        typed(tx)
          .selectFrom('app_user')
          .select(ACCOUNT_COLUMNS)
          .where((eb) => eb(eb.fn('lower', ['email']), '=', email))
          .executeTakeFirst(),
      );
    },
    byId(userId) {
      return db.asSystem((tx) => typed(tx).selectFrom('app_user').select(ACCOUNT_COLUMNS).where('id', '=', userId).executeTakeFirst());
    },
    summary(userId) {
      return db.asSystem((tx) =>
        typed(tx).selectFrom('app_user').select(['display_name', 'email', 'totp_enabled']).where('id', '=', userId).executeTakeFirst(),
      );
    },
    passwordContext(userId) {
      return db.asSystem(async (tx) => {
        const k = typed(tx);
        const user = await k.selectFrom('app_user').select(['email', 'display_name']).where('id', '=', userId).executeTakeFirst();
        const orgs = await k
          .selectFrom('tenant as t')
          .innerJoin('tenant_member as m', 'm.tenant_id', 't.id')
          .select(['t.name', 't.key'])
          .where('m.user_id', '=', userId)
          .execute();
        return { email: user?.email, displayName: user?.display_name, organisationNames: orgs.flatMap((o) => [o.name, o.key]) };
      });
    },
    async setPasswordHash(userId, hash) {
      await db.asSystem((tx) => typed(tx).updateTable('app_user').set({ password_hash: hash }).where('id', '=', userId).execute());
    },
    async startTwoStep(userId, secretEnc) {
      const user = await db.asSystem((tx) =>
        typed(tx)
          .updateTable('app_user')
          .set({ totp_pending_secret_enc: secretEnc })
          .where('id', '=', userId)
          .returning('email')
          .executeTakeFirst(),
      );
      return user?.email;
    },
    async pendingTwoStepSecret(userId) {
      const user = await db.asSystem((tx) =>
        typed(tx).selectFrom('app_user').select('totp_pending_secret_enc').where('id', '=', userId).executeTakeFirst(),
      );
      return user?.totp_pending_secret_enc;
    },
    async confirmTwoStep(userId, secretEnc) {
      const done = await db.asSystem((tx) =>
        typed(tx)
          .updateTable('app_user')
          .set({ totp_secret_enc: secretEnc, totp_pending_secret_enc: null, totp_enabled: true, totp_last_step: null })
          .where('id', '=', userId)
          .where('totp_pending_secret_enc', '=', secretEnc)
          .executeTakeFirst(),
      );
      return done.numUpdatedRows > 0n;
    },
    useTwoStepStep(userId, step) {
      return db.asSystem((tx) => useTwoStepStep(tx, userId, step));
    },
    async activeEmail(userId) {
      const user = await db.asSystem((tx) =>
        typed(tx).selectFrom('app_user').select('email').where('id', '=', userId).where('status', '=', 'active').executeTakeFirst(),
      );
      return user?.email;
    },
    async isActiveMember(tenantId, userId) {
      const row = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('tenant_member')
          .select((eb) => eb.lit(1).as('one'))
          .where('tenant_id', '=', tenantId)
          .where('user_id', '=', userId)
          .where('status', '=', 'active')
          .executeTakeFirst(),
      );
      return !!row;
    },
    async rolesRequireTwoStep(tenantId, userId) {
      const row = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('role_assignment as ra')
          .innerJoin('role as r', (j) => j.onRef('r.tenant_id', '=', 'ra.tenant_id').onRef('r.key', '=', 'ra.role_key'))
          .select((eb) => eb.lit(1).as('one'))
          .where('ra.tenant_id', '=', tenantId)
          .where('ra.user_id', '=', userId)
          .where((eb) => eb.ref('r.require_two_step'))
          .limit(1)
          .executeTakeFirst(),
      );
      return !!row;
    },
  };
}
