import { AdministrationService } from '../application/administration/administration-service.js';
import { OrganisationService } from '../application/organisations/organisation-service.js';
import { PrivacyService } from '../application/privacy/privacy-service.js';
import { postgresAdministrationStore } from '../infrastructure/postgres/stores/administration-store.js';
import { postgresOrganisationAdminStore } from '../infrastructure/postgres/stores/organisation-admin-store.js';
import { postgresOrganisationStore } from '../infrastructure/postgres/stores/organisation-store.js';
import { postgresPrivacyStore } from '../infrastructure/postgres/stores/privacy-store.js';
import { financialRetentionYears } from '../infrastructure/postgres/retention.js';
import type { Definitions } from './definitions.js';
import type { Files } from './files.js';
import type { Identity } from './identity.js';
import type { Base, Cryptography } from './infrastructure.js';

/** An organisation's own administration: limits and usage, its identity, and consent and erasure. */
export function wireAdministration(base: Base, { definitions }: Definitions, { sensitive }: Cryptography, { apiKeys }: Identity, { files }: Files) {
  const { tm, owner, options } = base;
  return {
    privacy: new PrivacyService(tm, postgresPrivacyStore(), definitions, sensitive, financialRetentionYears(options.retention)),
    administration: new AdministrationService(tm, postgresAdministrationStore(base.sequences), owner.tenants, definitions, (tenantId) => files.usageOf(tenantId), apiKeys.defaultLimit),
    organisation: new OrganisationService(tm, postgresOrganisationStore, postgresOrganisationAdminStore, owner.tenants, files, {
      installationEmail: !!options.defaultEmailTransport,
    }),
  };
}
export type Administration = ReturnType<typeof wireAdministration>;
