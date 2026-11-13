import { sql } from 'kysely';
import type { OrganisationAdminStore } from '../../../application/organisations/ports/organisation-admin-store.js';
import { pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;

export const postgresOrganisationAdminStore: OrganisationAdminStore = {
  identity(tx) {
    return pg(tx).selectFrom('tenant').select(['key', 'name', 'legal_name']).where('id', '=', APP_TENANT).executeTakeFirst();
  },

  async name(tx) {
    const tenant = await pg(tx).selectFrom('tenant').select('name').where('id', '=', APP_TENANT).executeTakeFirstOrThrow();
    return tenant.name;
  },

  logo(tx) {
    return pg(tx).selectFrom('tenant_asset').select(['file_id', 'version', 'updated_at']).where('tenant_id', '=', APP_TENANT).where('kind', '=', 'logo').executeTakeFirst();
  },

  logoFile(tx, fileId) {
    return pg(tx)
      .selectFrom('file_object as f')
      .select(['f.name', 'f.mime', sql<number>`f.size::int`.as('size'), 'f.storage_key', 'f.store_ref'])
      .where('f.tenant_id', '=', APP_TENANT)
      .where('f.deleted_at', 'is', null)
      .$if(fileId === null, (qb) =>
        qb.where((eb) => eb.exists(eb.selectFrom('tenant_asset as a').select(eb.lit(1).as('one')).whereRef('a.file_id', '=', 'f.id').where('a.kind', '=', 'logo'))),
      )
      .$if(fileId !== null, (qb) =>
        qb
          .where('f.id', '=', fileId!)
          .where((eb) =>
            eb.or([
              eb.exists(eb.selectFrom('tenant_asset as a').select(eb.lit(1).as('one')).whereRef('a.file_id', '=', 'f.id')),
              eb.exists(eb.selectFrom('receipt_issuer as ri').select(eb.lit(1).as('one')).whereRef('ri.logo_file_id', '=', 'f.id')),
            ]),
          ),
      )
      .executeTakeFirst();
  },

  async putLogo(tx, fileId, actorId) {
    await pg(tx)
      .insertInto('tenant_asset')
      .values({ tenant_id: APP_TENANT, kind: 'logo', file_id: fileId, version: 1, updated_by: actorId })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'kind']).doUpdateSet((eb) => ({
          file_id: eb.ref('excluded.file_id'),
          version: eb('tenant_asset.version', '+', eb.lit(1)),
          updated_by: eb.ref('excluded.updated_by'),
          updated_at: sql<Date>`now()`,
        })),
      )
      .execute();
  },

  removeLogo(tx) {
    return pg(tx).deleteFrom('tenant_asset').where('tenant_id', '=', APP_TENANT).where('kind', '=', 'logo').returning('file_id').executeTakeFirst();
  },

  async signatoryText(tx) {
    const row = await pg(tx).selectFrom('organisation_profile').select(['signatory_name', 'signatory_designation']).where('tenant_id', '=', APP_TENANT).executeTakeFirst();
    return { name: row?.signatory_name ?? null, designation: row?.signatory_designation ?? null };
  },

  async saveSignatoryText(tx, actorId, name, designation) {
    const before = await pg(tx).selectFrom('organisation_profile').select(['signatory_name', 'signatory_designation']).where('tenant_id', '=', APP_TENANT).executeTakeFirst();
    await pg(tx)
      .insertInto('organisation_profile')
      .values({ tenant_id: APP_TENANT, signatory_name: name, signatory_designation: designation, updated_by: actorId, updated_at: sql<Date>`now()` })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ signatory_name: name, signatory_designation: designation, updated_by: actorId, updated_at: sql<Date>`now()` }))
      .execute();
    return { name: before?.signatory_name ?? null, designation: before?.signatory_designation ?? null };
  },

  async clearSignatoryText(tx, actorId) {
    await pg(tx)
      .updateTable('organisation_profile')
      .set({ signatory_name: null, signatory_designation: null, updated_by: actorId, updated_at: sql<Date>`now()` })
      .where('tenant_id', '=', APP_TENANT)
      .execute();
  },

  signatory(tx) {
    return pg(tx).selectFrom('tenant_asset').select(['file_id', 'version', 'updated_at']).where('tenant_id', '=', APP_TENANT).where('kind', '=', 'signatory').executeTakeFirst();
  },

  signatoryFile(tx, fileId) {
    return pg(tx)
      .selectFrom('file_object as f')
      .select(['f.name', 'f.mime', sql<number>`f.size::int`.as('size'), 'f.storage_key', 'f.store_ref'])
      .where('f.tenant_id', '=', APP_TENANT)
      .where('f.deleted_at', 'is', null)
      .$if(fileId === null, (qb) =>
        qb.where((eb) => eb.exists(eb.selectFrom('tenant_asset as a').select(eb.lit(1).as('one')).whereRef('a.file_id', '=', 'f.id').where('a.kind', '=', 'signatory'))),
      )
      .$if(fileId !== null, (qb) =>
        qb
          .where('f.id', '=', fileId!)
          .where((eb) =>
            eb.or([
              eb.exists(eb.selectFrom('tenant_asset as a').select(eb.lit(1).as('one')).whereRef('a.file_id', '=', 'f.id').where('a.kind', '=', 'signatory')),
              eb.exists(eb.selectFrom('receipt_issuer as ri').select(eb.lit(1).as('one')).whereRef('ri.signatory_file_id', '=', 'f.id')),
            ]),
          ),
      )
      .executeTakeFirst();
  },

  async putSignatory(tx, fileId, actorId) {
    await pg(tx)
      .insertInto('tenant_asset')
      .values({ tenant_id: APP_TENANT, kind: 'signatory', file_id: fileId, version: 1, updated_by: actorId })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'kind']).doUpdateSet((eb) => ({
          file_id: eb.ref('excluded.file_id'),
          version: eb('tenant_asset.version', '+', eb.lit(1)),
          updated_by: eb.ref('excluded.updated_by'),
          updated_at: sql<Date>`now()`,
        })),
      )
      .execute();
  },

  removeSignatory(tx) {
    return pg(tx).deleteFrom('tenant_asset').where('tenant_id', '=', APP_TENANT).where('kind', '=', 'signatory').returning('file_id').executeTakeFirst();
  },

  async setupFacts(tx, administratorRole) {
    const k = pg(tx);
    const facts = await k
      .selectNoFrom((eb) => [
        eb
          .exists(
            k
              .selectFrom('fiscal_period')
              .select(eb.lit(1).as('one'))
              .where('tenant_id', '=', APP_TENANT)
              .where('status', '=', 'open')
              .where('starts_on', '<=', sql<Date>`current_date`)
              .where('ends_on', '>=', sql<Date>`current_date`),
          )
          .as('fiscalYear'),
        eb.exists(k.selectFrom('receipt_series').select(eb.lit(1).as('one')).where('tenant_id', '=', APP_TENANT)).as('series'),
        eb
          .exists(
            k
              .selectFrom('role_assignment as ra')
              .innerJoin('tenant_member as m', (j) => j.onRef('m.tenant_id', '=', 'ra.tenant_id').onRef('m.user_id', '=', 'ra.user_id'))
              .select(eb.lit(1).as('one'))
              .where('ra.tenant_id', '=', APP_TENANT)
              .where('ra.role_key', '<>', administratorRole)
              .where('m.status', '=', 'active'),
          )
          .as('operationalRole'),
        eb
          .exists(
            k
              .selectFrom('connector')
              .select(eb.lit(1).as('one'))
              .where('tenant_id', '=', APP_TENANT)
              .where('enabled', '=', true)
              .where((w) => w.or([w('type', '=', 'smtp'), w.and([w('type', '=', 'http'), w(sql<string>`config->>'emailSender'`, '=', 'true')])])),
          )
          .as('smtp'),
        eb
          .exists(
            k.selectFrom('connector').select(eb.lit(1).as('one')).where('tenant_id', '=', APP_TENANT).where('type', 'in', ['razorpay', 'cashfree']).where('enabled', '=', true),
          )
          .as('payments'),
      ])
      .executeTakeFirstOrThrow();
    return {
      fiscalYear: Boolean(facts.fiscalYear),
      series: Boolean(facts.series),
      operationalRole: Boolean(facts.operationalRole),
      smtp: Boolean(facts.smtp),
      payments: Boolean(facts.payments),
    };
  },

  async publishedTheme(tx) {
    const row = await pg(tx)
      .selectFrom('definition as d')
      .select('body')
      .where('d.kind', '=', 'theme')
      .where('d.key', '=', 'organisation')
      .where('d.status', '=', 'published')
      .where((eb) =>
        eb.or([
          eb('d.tenant_id', '=', APP_TENANT),
          eb.and([
            eb('d.tenant_id', 'is', null),
            eb('d.module_key', '=', 'platform'),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('definition as t')
                  .select(sql`1`.as('one'))
                  .where('t.tenant_id', '=', APP_TENANT)
                  .where('t.kind', '=', 'theme')
                  .where('t.key', '=', 'organisation')
                  .where('t.status', '=', 'published'),
              ),
            ),
          ]),
        ]),
      )
      .orderBy(sql`case when d.tenant_id is null then 1 else 0 end`)
      .orderBy('d.version', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.body ?? null;
  },
};
