import { sql } from 'kysely';
import type { AdministrationStore } from '../../../application/administration/ports/administration-store.js';
import { writeAudit } from './audit-store.js';
import type { PostgresSequenceStore } from './sequence-store.js';
import { executorOf, pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;

export const postgresAdministrationStore = (sequences: PostgresSequenceStore): AdministrationStore => ({
  async auditPage(tx, { person, area, entity, from, to }, page) {
    const filtered = pg(tx)
      .selectFrom('audit_event as a')
      .where('a.tenant_id', '=', APP_TENANT)
      .$if(person !== null, (qb) => qb.where('a.actor_id', '=', person!))
      .$if(area !== null, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('a.entity', '=', sql<string>`any(${area!.entities}::text[])`),
            eb('a.entity', 'like', sql<string>`any(${area!.prefixes.map((p) => `${p}%`)}::text[])`),
          ]),
        ),
      )
      .$if(entity !== null, (qb) => qb.where('a.entity', '=', entity!))
      .$if(from !== null, (qb) => qb.where('a.at', '>=', sql<Date>`${from}::date`))
      .$if(to !== null, (qb) => qb.where('a.at', '<', sql<Date>`${to}::date + 1`));
    const rows = await filtered
      .leftJoin('app_user as u', (j) => j.on((eb) => eb(eb.cast('u.id', 'text'), '=', eb.ref('a.actor_id'))))
      .select(['a.id', 'a.at', 'a.actor_id', sql<string | null>`app_member_name(u.id)`.as('actor_name'), 'a.action', 'a.entity', 'a.entity_id', 'a.before', 'a.after'])
      .orderBy('a.at', 'desc')
      .orderBy('a.id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    const count = await filtered.select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
    return { rows, total: count!.n };
  },

  settings(tx, rateSetting) {
    return pg(tx)
      .selectFrom('tenant as t')
      .select((eb) => [
        't.key',
        't.name',
        't.legal_name',
        't.default_locale',
        eb.selectFrom('tenant_setting').select('value').where('tenant_id', '=', APP_TENANT).where('key', '=', rateSetting).as('rate'),
      ])
      .where('t.id', '=', APP_TENANT)
      .executeTakeFirst();
  },

  fiscalYearStartMonth: (tx) => sequences.fiscalYearStartMonth(executorOf(tx)),

  async financialYearFixed(tx) {
    const k = pg(tx);
    const row = await k
      .selectNoFrom((eb) => [
        eb.exists(k.selectFrom('fiscal_period').select(sql<number>`1`.as('one')).where('tenant_id', '=', APP_TENANT)).as('period'),
        eb.exists(k.selectFrom('receipt').select(sql<number>`1`.as('one')).where('tenant_id', '=', APP_TENANT)).as('receipt'),
      ])
      .executeTakeFirstOrThrow();
    return Boolean(row.period || row.receipt);
  },

  holdFiscalYearStart: (tx) => sequences.holdFiscalYearStart(executorOf(tx), 'exclusive'),

  async putSetting(tx, key, value, actorId) {
    await pg(tx)
      .insertInto('tenant_setting')
      .values({ tenant_id: APP_TENANT, key, value: JSON.stringify(value), updated_by: actorId })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'key']).doUpdateSet({
          value: (eb) => eb.ref('excluded.value'),
          updated_by: (eb) => eb.ref('excluded.updated_by'),
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();
  },

  async setting(tx, key) {
    const row = await pg(tx).selectFrom('tenant_setting').select('value').where('tenant_id', '=', APP_TENANT).where('key', '=', key).executeTakeFirst();
    return row?.value;
  },

  audit: (tx, entry) => writeAudit(executorOf(tx), entry),
});
