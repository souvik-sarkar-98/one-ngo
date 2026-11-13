import { sql } from 'kysely';
import type { OrganisationStore } from '../../../domain/organisations/ports/organisation-store.js';
import { writeAudit } from './audit-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { executorOf, pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;
const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

const REGISTRATION_COLUMNS = [
  'id',
  'type',
  'number',
  'issuing_authority',
  sql<string | null>`issued_on::text`.as('issued_on'),
  sql<string | null>`expires_on::text`.as('expires_on'),
  'notes',
] as const;

async function readProfile(tx: Tx) {
  const p = await pg(tx).selectFrom('organisation_profile').selectAll().where('tenant_id', '=', APP_TENANT).executeTakeFirst();
  return {
    contact: { email: p?.email ?? null, phone: p?.phone ?? null, website: p?.website ?? null },
    address:
      p?.address_line1 && p.city && p.postal_code && p.country
        ? { line1: p.address_line1, line2: p.address_line2, city: p.city, state: p.state, postalCode: p.postal_code, country: p.country }
        : null,
    timezone: p?.timezone ?? null,
    identityConfirmedAt: iso(p?.identity_confirmed_at ?? null),
    receiptsReviewedAt: iso(p?.receipts_reviewed_at ?? null),
    setupCompletedAt: iso(p?.setup_completed_at ?? null),
  };
}

export const postgresOrganisationStore: OrganisationStore = {
  readProfile,

  async writeProfile(tx, actorId, p) {
    const values = {
      email: p.contact.email,
      phone: p.contact.phone,
      website: p.contact.website,
      address_line1: p.address?.line1 ?? null,
      address_line2: p.address?.line2 ?? null,
      city: p.address?.city ?? null,
      state: p.address?.state ?? null,
      postal_code: p.address?.postalCode ?? null,
      country: p.address?.country ?? null,
      timezone: p.timezone,
      updated_by: actorId,
      updated_at: sql<Date>`now()`,
    };
    await pg(tx)
      .insertInto('organisation_profile')
      .values({ tenant_id: APP_TENANT, ...values })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet(values))
      .execute();
  },

  async confirmSetupStep(tx, actorId, step) {
    const k = pg(tx);
    await k.insertInto('organisation_profile').values({ tenant_id: APP_TENANT }).onConflict((oc) => oc.column('tenant_id').doNothing()).execute();
    const now = sql<Date>`now()`;
    const row = k.updateTable('organisation_profile').where('tenant_id', '=', APP_TENANT);
    if (step === 'identity') await row.set({ identity_confirmed_at: now, identity_confirmed_by: actorId }).where('identity_confirmed_at', 'is', null).execute();
    else if (step === 'receipts') await row.set({ receipts_reviewed_at: now, receipts_reviewed_by: actorId }).where('receipts_reviewed_at', 'is', null).execute();
    else await row.set({ setup_completed_at: now, setup_completed_by: actorId }).where('setup_completed_at', 'is', null).execute();
  },

  async registrations(tx) {
    const rows = await pg(tx).selectFrom('organisation_registration').select(REGISTRATION_COLUMNS).where('tenant_id', '=', APP_TENANT).orderBy('type').orderBy('number').execute();
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      number: r.number,
      issuingAuthority: r.issuing_authority,
      issuedOn: r.issued_on,
      expiresOn: r.expires_on,
      notes: r.notes,
    }));
  },

  async registrationTaken(tx, r, exceptId) {
    const taken = await pg(tx)
      .selectFrom('organisation_registration')
      .select('id')
      .where('tenant_id', '=', APP_TENANT)
      .where('type', '=', r.type)
      .where('number', '=', r.number)
      .$if(exceptId !== null, (qb) => qb.where('id', '<>', exceptId!))
      .executeTakeFirst();
    return !!taken;
  },

  async addRegistration(tx, actorId, r) {
    const k = pg(tx);
    const row = await k
      .insertInto('organisation_registration')
      .values({
        tenant_id: APP_TENANT,
        type: r.type,
        number: r.number,
        issuing_authority: r.issuingAuthority,
        issued_on: r.issuedOn,
        expires_on: r.expiresOn,
        notes: r.notes,
        created_by: actorId,
        updated_by: actorId,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'type', 'number']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (row) return row.id;
    const existing = await k.selectFrom('organisation_registration').select('id').where('tenant_id', '=', APP_TENANT).where('type', '=', r.type).where('number', '=', r.number).executeTakeFirstOrThrow();
    return existing.id;
  },

  async updateRegistration(tx, actorId, id, r) {
    const row = await pg(tx)
      .updateTable('organisation_registration')
      .set({
        type: r.type,
        number: r.number,
        issuing_authority: r.issuingAuthority,
        issued_on: r.issuedOn,
        expires_on: r.expiresOn,
        notes: r.notes,
        updated_by: actorId,
        updated_at: sql<Date>`now()`,
      })
      .where('tenant_id', '=', APP_TENANT)
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  },

  removeRegistration(tx, id) {
    return pg(tx).deleteFrom('organisation_registration').where('tenant_id', '=', APP_TENANT).where('id', '=', id).returning(['type', 'number']).executeTakeFirst();
  },

  audit: (tx, entry) => writeAudit(executorOf(tx), entry),
};
