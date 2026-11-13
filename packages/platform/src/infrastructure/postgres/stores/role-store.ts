import { sql } from 'kysely';
import type { RoleStore } from '../../../domain/identity/ports/role-store.js';
import { writeAudit } from './audit-store.js';
import { executorOf, pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;

export const postgresRoleStore: RoleStore = {
  async roles(tx, key) {
    const rows = await pg(tx)
      .selectFrom('role as r')
      .select((eb) => [
        'r.key',
        'r.label',
        'r.permissions',
        'r.require_two_step',
        'r.customised',
        eb
          .selectFrom('role_assignment as ra')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('ra.tenant_id', '=', 'r.tenant_id')
          .whereRef('ra.role_key', '=', 'r.key')
          .as('members'),
      ])
      .where('r.tenant_id', '=', APP_TENANT)
      .$if(key !== undefined, (qb) => qb.where('r.key', '=', key!))
      .orderBy((eb) => eb.fn('lower', ['r.label']))
      .orderBy('r.key')
      .execute();
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      permissions: r.permissions,
      requireTwoStep: r.require_two_step,
      customised: r.customised,
      members: r.members!,
    }));
  },

  grants(tx) {
    return pg(tx)
      .selectFrom('role')
      .select(['key', 'label', 'permissions'])
      .where('tenant_id', '=', APP_TENANT)
      .orderBy((eb) => eb.fn('lower', ['label']))
      .orderBy('key')
      .execute();
  },

  label(tx, key) {
    return pg(tx).selectFrom('role').select(['key', 'label']).where('tenant_id', '=', APP_TENANT).where('key', '=', key).executeTakeFirst();
  },

  async exists(tx, key) {
    const role = await pg(tx)
      .selectFrom('role')
      .select((eb) => eb.lit(1).as('one'))
      .where('tenant_id', '=', APP_TENANT)
      .where('key', '=', key)
      .executeTakeFirst();
    return !!role;
  },

  async existing(tx, keys) {
    const rows = await pg(tx)
      .selectFrom('role')
      .select('key')
      .where('tenant_id', '=', APP_TENANT)
      .where((eb) => eb('key', '=', eb.fn.any(eb.val(keys))))
      .execute();
    return rows.map((r) => r.key);
  },

  async save(tx, key, role) {
    await pg(tx)
      .insertInto('role')
      .values({ tenant_id: APP_TENANT, key, label: role.label, permissions: role.permissions, require_two_step: role.requireTwoStep })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'key']).doUpdateSet((eb) => ({
          label: eb.ref('excluded.label'),
          permissions: eb.ref('excluded.permissions'),
          require_two_step: eb.ref('excluded.require_two_step'),
        })),
      )
      .execute();
  },

  async create(tx, key, role) {
    await pg(tx)
      .insertInto('role')
      .values({ tenant_id: APP_TENANT, key, label: role.label, permissions: role.permissions, require_two_step: role.requireTwoStep, customised: true })
      .execute();
  },

  async update(tx, key, role) {
    await pg(tx)
      .updateTable('role')
      .set({ label: role.label, permissions: role.permissions, require_two_step: role.requireTwoStep, customised: true })
      .where('tenant_id', '=', APP_TENANT)
      .where('key', '=', key)
      .execute();
  },

  async remove(tx, key) {
    await pg(tx).deleteFrom('role').where('tenant_id', '=', APP_TENANT).where('key', '=', key).execute();
  },

  async apiKeysUsing(tx, key) {
    const keys = await pg(tx)
      .selectFrom('api_key')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('tenant_id', '=', APP_TENANT)
      .where('role_key', '=', key)
      .executeTakeFirst();
    return keys?.n ?? 0;
  },

  async assigned(tx, userId) {
    const rows = await pg(tx).selectFrom('role_assignment').select('role_key').where('tenant_id', '=', APP_TENANT).where('user_id', '=', userId).orderBy('role_key').execute();
    return rows.map((r) => r.role_key);
  },

  async assign(tx, userId, roleKey, assignedBy) {
    await pg(tx)
      .insertInto('role_assignment')
      .values({ tenant_id: APP_TENANT, user_id: userId, role_key: roleKey, assigned_by: assignedBy })
      .onConflict((oc) => oc.doNothing())
      .execute();
  },

  async add(tx, userId, roleKey, assignedBy) {
    await pg(tx).insertInto('role_assignment').values({ tenant_id: APP_TENANT, user_id: userId, role_key: roleKey, assigned_by: assignedBy }).execute();
  },

  async unassign(tx, userId, roleKey) {
    await pg(tx).deleteFrom('role_assignment').where('tenant_id', '=', APP_TENANT).where('user_id', '=', userId).where('role_key', '=', roleKey).execute();
  },

  async unassignAllExcept(tx, userId, keep) {
    await pg(tx)
      .deleteFrom('role_assignment')
      .where('tenant_id', '=', APP_TENANT)
      .where('user_id', '=', userId)
      .where((eb) => eb.not(eb('role_key', '=', eb.fn.any(eb.val(keep)))))
      .execute();
  },

  async activeHolders(tx) {
    const rows = await pg(tx)
      .selectFrom('role_assignment as ra')
      .innerJoin('role as r', (j) => j.onRef('r.tenant_id', '=', 'ra.tenant_id').onRef('r.key', '=', 'ra.role_key'))
      .innerJoin('tenant_member as m', (j) => j.onRef('m.tenant_id', '=', 'ra.tenant_id').onRef('m.user_id', '=', 'ra.user_id').on('m.status', '=', 'active'))
      .innerJoin('app_user as u', (j) => j.onRef('u.id', '=', 'ra.user_id').on('u.status', '=', 'active'))
      .select(['ra.user_id', 'r.permissions'])
      .where('ra.tenant_id', '=', APP_TENANT)
      .execute();
    return rows.map((r) => ({ userId: r.user_id, permissions: r.permissions }));
  },

  audit: (tx, entry) => writeAudit(executorOf(tx), entry),
};
