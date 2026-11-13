import { sql } from 'kysely';
import type { OnboardingStore } from '../../../application/organisations/ports/onboarding-store.js';
import type { PostgresSequenceStore } from './sequence-store.js';
import { pg } from '../tx.js';
import { postgresOrganisationStore } from './organisation-store.js';

const APP_TENANT = sql<string>`app_tenant()`;

export const postgresOnboardingStore = (sequences: PostgresSequenceStore): OnboardingStore => ({
  writeProfile: postgresOrganisationStore.writeProfile,
  addRegistration: postgresOrganisationStore.addRegistration,
  audit: postgresOrganisationStore.audit,

  async setReceiptPrefix(tx, prefix, series) {
    const changed = await pg(tx)
      .updateTable('receipt_series as s')
      .set({ prefix })
      .where('s.tenant_id', '=', APP_TENANT)
      .where('s.key', 'in', series)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('receipt as r').select(eb.lit(1).as('one')).whereRef('r.tenant_id', '=', 's.tenant_id').whereRef('r.series_key', '=', 's.key'))))
      .returning('s.key')
      .execute();
    return changed.map((c) => c.key);
  },

  async fiscalYearOpened(tx, key) {
    const opened = await pg(tx).selectFrom('fiscal_period').select('key').where('tenant_id', '=', APP_TENANT).where('key', '=', key).executeTakeFirst();
    return !!opened;
  },

  async setFiscalYearStart(tx, startMonth, actorId) {
    await pg(tx)
      .insertInto('tenant_setting')
      .values({ tenant_id: APP_TENANT, key: sequences.rules.settingKey, value: JSON.stringify(startMonth), updated_by: actorId })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet((eb) => ({ value: eb.ref('excluded.value'), updated_by: eb.ref('excluded.updated_by') })))
      .execute();
  },

  async readiness(tx, q) {
    const k = pg(tx);
    const tenant = await k.selectFrom('tenant').select(['name', 'legal_name']).where('id', '=', APP_TENANT).executeTakeFirst();
    const profile = await k.selectFrom('organisation_profile').selectAll().where('tenant_id', '=', APP_TENANT).executeTakeFirst();
    const role = await k.selectFrom('role').select('permissions').where('tenant_id', '=', APP_TENANT).where('key', '=', q.administratorRole).executeTakeFirst();
    const admin = await k
      .selectFrom('tenant_member as m')
      .innerJoin('role_assignment as ra', (j) => j.onRef('ra.tenant_id', '=', 'm.tenant_id').onRef('ra.user_id', '=', 'm.user_id').on('ra.role_key', '=', q.administratorRole))
      .select('m.user_id')
      .where('m.tenant_id', '=', APP_TENANT)
      .where('m.user_id', '=', q.administratorId)
      .where('m.status', '=', 'active')
      .executeTakeFirst();
    const enabled = q.modules ? await k.selectFrom('tenant_module').select('module_key').where('tenant_id', '=', APP_TENANT).where('enabled', '=', true).execute() : null;
    const present = q.series.length ? await k.selectFrom('receipt_series').select('key').where('tenant_id', '=', APP_TENANT).where('key', 'in', q.series).execute() : null;
    const year = await k.selectFrom('fiscal_period').select('status').where('tenant_id', '=', APP_TENANT).where('key', '=', q.fiscalYear).executeTakeFirst();
    return {
      tenant,
      profile,
      administratorRole: role?.permissions,
      administrator: !!admin,
      enabledModules: enabled && enabled.map((e) => e.module_key),
      presentSeries: present && present.map((p) => p.key),
      fiscalYear: year?.status,
    };
  },
});
