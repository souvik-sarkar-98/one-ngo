import { sql } from 'kysely';
import type { IssuerSource } from '../../../domain/receipts/ports/receipt-store.js';
import { pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;

/** The organisation's identity as it stands now, for a receipt issued on `onDate`. */
export const pgIssuerSource: IssuerSource = {
  async snapshot(tx, onDate) {
    const k = pg(tx);
    const tenant = await k.selectFrom('tenant').select(['name', 'legal_name']).where('id', '=', APP_TENANT).executeTakeFirstOrThrow();
    const p = await k.selectFrom('organisation_profile').selectAll().where('tenant_id', '=', APP_TENANT).executeTakeFirst();
    const day = sql<Date>`${onDate}::date`;
    const registrations = await k
      .selectFrom('organisation_registration')
      .select(['type', 'number', 'issuing_authority'])
      .where('tenant_id', '=', APP_TENANT)
      .where((eb) => eb.or([eb('issued_on', 'is', null), eb('issued_on', '<=', day)]))
      .where((eb) => eb.or([eb('expires_on', 'is', null), eb('expires_on', '>=', day)]))
      .orderBy('type')
      .orderBy('number')
      .execute();
    const logo = await k.selectFrom('tenant_asset').select(['file_id', 'version']).where('tenant_id', '=', APP_TENANT).where('kind', '=', 'logo').executeTakeFirst();
    const signature = await k.selectFrom('tenant_asset').select(['file_id', 'version']).where('tenant_id', '=', APP_TENANT).where('kind', '=', 'signatory').executeTakeFirst();
    const signatoryName = p?.signatory_name ?? null;
    const signatoryDesignation = p?.signatory_designation ?? null;
    const signatoryFile = signature ? { fileId: signature.file_id, version: signature.version } : null;
    return {
      displayName: tenant.name,
      legalName: tenant.legal_name,
      contact: { email: p?.email ?? null, phone: p?.phone ?? null, website: p?.website ?? null },
      address:
        p?.address_line1 && p.city && p.postal_code && p.country
          ? { line1: p.address_line1, line2: p.address_line2, city: p.city, state: p.state, postalCode: p.postal_code, country: p.country }
          : null,
      registrations: registrations.map((r) => ({ type: r.type, number: r.number, issuingAuthority: r.issuing_authority })),
      logo: logo ? { fileId: logo.file_id, version: logo.version } : null,
      signatory: signatoryName || signatoryDesignation || signatoryFile ? { name: signatoryName, designation: signatoryDesignation, file: signatoryFile } : null,
    };
  },
};
