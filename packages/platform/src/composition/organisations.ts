import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OrganisationLifecycleService } from '../application/organisations/lifecycle-service.js';
import { OrganisationOnboardingService, type ShippedModules } from '../application/organisations/onboarding-service.js';
import type { OrganisationOperations } from '../application/organisations/control-plane.js';
import { postgresOnboardingStore } from '../infrastructure/postgres/stores/onboarding-store.js';
import { ownerCapabilities } from '../infrastructure/postgres/tenant-directory.js';
import { loadModulePackage } from '../runtime/definitions/package-loader.js';
import { transactions } from '../infrastructure/postgres/tx.js';
import type { IdentityService } from '../application/identity/identity-service.js';
import type { OidcService } from '../application/identity/oidc.js';
import { OrganisationSignInService, type SharedProviderSummary } from '../application/organisations/sign-in-service.js';
import type { ConnectorHttp } from '../application/connectors/ports/connector-runtime.js';
import type { LedgerService } from '../domain/ledger/ledger-service.js';
import type { Logger } from '@onengo/kernel/ports';
import type { Database } from '../infrastructure/postgres/db.js';
import type { DefinitionService } from '../runtime/definitions/definition-service.js';
import type { SchemaRegistry } from '../runtime/definitions/schema-registry.js';
import { wireSequences, type Paths } from './infrastructure.js';

/** The services the operator's onboarding and lifecycle work is built from. */
export interface OrganisationOperationsDeps {
  db: Database;
  schemas: SchemaRegistry;
  definitions: DefinitionService;
  identity: IdentityService;
  oidc: OidcService;
  ledger: LedgerService;
  logger: Logger;
}

/** What the operator's sign-in work needs besides the platform: the shared provider and outbound HTTP. */
export interface SignInSettings {
  sharedProviders?: readonly SharedProviderSummary[];
  http?: ConnectorHttp;
}

/**
 * The operator's onboarding and lifecycle services. Only the authenticated
 * operator application builds them; the main process never does.
 */
export function organisationOperations(services: OrganisationOperationsDeps, paths: Paths, signIn: SignInSettings = {}): OrganisationOperations {
  const owner = ownerCapabilities(services.db);
  const shipped: ShippedModules = async (key) => {
    if (!(await readdir(paths.modules)).includes(key)) return undefined;
    const pkg = await loadModulePackage(join(paths.modules, key), services.schemas);
    return (await services.definitions.unpublishedBase(pkg.manifest.key, pkg.definitions)).length ? undefined : pkg.manifest;
  };
  return {
    onboarding: new OrganisationOnboardingService(
      transactions(services.db),
      postgresOnboardingStore(wireSequences()),
      owner.organisations,
      services.definitions,
      services.identity,
      services.ledger,
      shipped,
      services.logger,
    ),
    lifecycle: new OrganisationLifecycleService(owner.organisations, services.logger),
    signIn: new OrganisationSignInService(
      owner.organisations,
      services.identity,
      services.oidc,
      signIn.sharedProviders ?? services.oidc.installationProviderSummaries(),
      signIn.http,
      services.logger,
    ),
  };
}
