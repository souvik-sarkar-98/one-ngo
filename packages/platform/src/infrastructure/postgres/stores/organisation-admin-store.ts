import { sql, type SqlBool } from 'kysely';
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

  signatories(tx) {
    return pg(tx)
      .selectFrom('organisation_signatory')
      .select(['id', 'name', 'designation', 'file_id', 'version', 'updated_at'])
      .where('tenant_id', '=', APP_TENANT)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  },

  signatoryUses(tx) {
    return pg(tx)
      .selectFrom('organisation_signatory_use')
      .select(['signatory_id', 'document_key', 'position'])
      .where('tenant_id', '=', APP_TENANT)
      .orderBy('document_key')
      .orderBy('position')
      .execute();
  },

  assigned(tx, documentKey) {
    return pg(tx)
      .selectFrom('organisation_signatory as s')
      .innerJoin('organisation_signatory_use as u', 'u.signatory_id', 's.id')
      .select(['s.id', 's.name', 's.designation', 's.file_id', 's.version', 's.updated_at'])
      .where('s.tenant_id', '=', APP_TENANT)
      .where('u.tenant_id', '=', APP_TENANT)
      .where('u.document_key', '=', documentKey)
      .orderBy('u.position')
      .execute();
  },

  async addSignatory(tx, actorId, name, designation) {
    const row = await pg(tx)
      .insertInto('organisation_signatory')
      .values({ tenant_id: APP_TENANT, name, designation, created_by: actorId, updated_by: actorId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },

  async updateSignatory(tx, id, actorId, name, designation) {
    const row = await pg(tx)
      .updateTable('organisation_signatory')
      .set({ name, designation, updated_by: actorId, updated_at: sql<Date>`now()` })
      .where('tenant_id', '=', APP_TENANT)
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  },

  async putSignatoryImage(tx, id, fileId, actorId) {
    const before = await pg(tx).selectFrom('organisation_signatory').select('file_id').where('tenant_id', '=', APP_TENANT).where('id', '=', id).executeTakeFirst();
    if (!before) return undefined;
    await pg(tx)
      .updateTable('organisation_signatory')
      .set({ file_id: fileId, version: sql<number>`version + 1`, updated_by: actorId, updated_at: sql<Date>`now()` })
      .where('tenant_id', '=', APP_TENANT)
      .where('id', '=', id)
      .execute();
    return { file_id: before.file_id };
  },

  async removeSignatory(tx, id) {
    // A shared `receipt` default was kept before each receipt rule chose its own signatories; nothing reads it now, so it never holds one back.
    await pg(tx).deleteFrom('organisation_signatory_use').where('tenant_id', '=', APP_TENANT).where('signatory_id', '=', id).where('document_key', '=', 'receipt').execute();
    const used = await pg(tx)
      .selectFrom('organisation_signatory_use')
      .select(sql<number>`1`.as('one'))
      .where('tenant_id', '=', APP_TENANT)
      .where('signatory_id', '=', id)
      .executeTakeFirst();
    if (used) return 'in_use';
    return pg(tx).deleteFrom('organisation_signatory').where('tenant_id', '=', APP_TENANT).where('id', '=', id).returning('file_id').executeTakeFirst();
  },

  async replaceDocumentSignatories(tx, documentKey, signatoryIds) {
    const k = pg(tx);
    await k.deleteFrom('organisation_signatory_use').where('tenant_id', '=', APP_TENANT).where('document_key', '=', documentKey).execute();
    const rows = signatoryIds.map((signatory_id, position) => ({ tenant_id: APP_TENANT, signatory_id, document_key: documentKey, position }));
    if (rows.length) await k.insertInto('organisation_signatory_use').values(rows).execute();
  },

  signatoryFile(tx, fileId) {
    return pg(tx)
      .selectFrom('file_object as f')
      .select(['f.name', 'f.mime', sql<number>`f.size::int`.as('size'), 'f.storage_key', 'f.store_ref'])
      .where('f.tenant_id', '=', APP_TENANT)
      .where('f.deleted_at', 'is', null)
      .where('f.id', '=', fileId)
      .where((eb) =>
        eb.or([
          eb.exists(eb.selectFrom('organisation_signatory as s').select(eb.lit(1).as('one')).whereRef('s.file_id', '=', 'f.id')),
          eb.exists(eb.selectFrom('receipt_issuer as ri').select(eb.lit(1).as('one')).whereRef('ri.signatory_file_id', '=', 'f.id')),
          eb.exists(eb.selectFrom('receipt_signatory_file as rs').select(eb.lit(1).as('one')).whereRef('rs.file_id', '=', 'f.id')),
          eb.exists(eb.selectFrom('published_report_signatory as ps').select(eb.lit(1).as('one')).whereRef('ps.file_id', '=', 'f.id')),
        ]),
      )
      .executeTakeFirst();
  },

  async setupFacts(tx, administratorRole, settings) {
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
              .selectFrom('tenant_setting as s')
              .innerJoin('connector as c', (j) => j.onRef('c.tenant_id', '=', 's.tenant_id').on(sql<SqlBool>`c.key = (s.value #>> '{}')`))
              .select(eb.lit(1).as('one'))
              .where('s.tenant_id', '=', APP_TENANT)
              .where('s.key', '=', settings.mailConnector)
              .where('c.enabled', '=', true)
              .where('c.type', '=', 'email'),
          )
          .as('email'),
        eb
          .exists(
            k
              .selectFrom('tenant_setting as s')
              .innerJoin('connector as c', (j) => j.onRef('c.tenant_id', '=', 's.tenant_id').on(sql<SqlBool>`c.key = (s.value #>> '{}')`))
              .select(eb.lit(1).as('one'))
              .where('s.tenant_id', '=', APP_TENANT)
              .where('s.key', '=', settings.fileStore)
              .where('c.enabled', '=', true)
              .where('c.type', '=', 'storage'),
          )
          .as('fileStore'),
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
      email: Boolean(facts.email),
      fileStore: Boolean(facts.fileStore),
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
