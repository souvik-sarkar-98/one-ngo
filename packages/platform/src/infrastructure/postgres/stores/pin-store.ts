import { sql } from 'kysely';
import type { PinStore } from '../../../domain/identity/ports/pin-store.js';
import { pg } from '../tx.js';

const PIN_COLUMNS = ['id', 'label', 'list_view', 'address', 'position'] as const;
const APP_TENANT = sql<string>`app_tenant()`;
// Text comparisons: actor ids (e.g. api:<name>) and pin ids from the address need not be uuids.
const userIs = (actorId: string) => sql<boolean>`user_id::text = ${actorId}`;
const idIs = (id: string) => sql<boolean>`id::text = ${id}`;

export const postgresPinStore: PinStore = {
  list(tx, actorId) {
    return pg(tx)
      .selectFrom('member_pin')
      .select(PIN_COLUMNS)
      .where('tenant_id', '=', APP_TENANT)
      .where(userIs(actorId))
      .orderBy('position')
      .orderBy('created_at')
      .execute();
  },

  async count(tx, actorId) {
    const { n } = (await pg(tx)
      .selectFrom('member_pin')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('tenant_id', '=', APP_TENANT)
      .where(userIs(actorId))
      .executeTakeFirst()) ?? { n: 0 };
    return n;
  },

  add(tx, actorId, { label, listView, address }) {
    const k = pg(tx);
    return k
      .insertInto('member_pin')
      .columns(['tenant_id', 'user_id', 'label', 'list_view', 'address', 'position'])
      .expression(
        k
          .selectFrom('tenant_member as m')
          .select((eb) => [
            APP_TENANT.as('tenant_id'),
            'm.user_id',
            eb.val(label).as('label'),
            eb.val(listView).as('list_view'),
            eb.val(address).as('address'),
            eb.fn
              .coalesce(
                eb
                  .selectFrom('member_pin as p')
                  .select((e) => e(e.fn.max('p.position'), '+', e.lit(1)).as('next'))
                  .where('p.tenant_id', '=', APP_TENANT)
                  .whereRef('p.user_id', '=', 'm.user_id'),
                eb.lit(0),
              )
              .as('position'),
          ])
          .where('m.tenant_id', '=', APP_TENANT)
          .where(sql<boolean>`m.user_id::text = ${actorId}`),
      )
      .returning(PIN_COLUMNS)
      .executeTakeFirst();
  },

  rename(tx, actorId, id, label) {
    return pg(tx)
      .updateTable('member_pin')
      .set({ label })
      .where('tenant_id', '=', APP_TENANT)
      .where(userIs(actorId))
      .where(idIs(id))
      .returning(PIN_COLUMNS)
      .executeTakeFirst();
  },

  async move(tx, actorId, id, position) {
    await pg(tx).updateTable('member_pin').set({ position }).where('tenant_id', '=', APP_TENANT).where(userIs(actorId)).where(idIs(id)).execute();
  },

  async remove(tx, actorId, id) {
    const gone = await pg(tx)
      .deleteFrom('member_pin')
      .where('tenant_id', '=', APP_TENANT)
      .where(userIs(actorId))
      .where(idIs(id))
      .returning((eb) => eb.lit(1).as('one'))
      .execute();
    return gone.length > 0;
  },
};
