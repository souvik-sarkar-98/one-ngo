/** Public API of the NGO-serving platform. Operator capabilities are intentionally absent. */
export {
  assertDeploymentPrepared,
  createPlatform,
  PATHS,
  type Platform,
  type PlatformOptions,
} from '../platform.js';
export type { Paths } from '../composition/infrastructure.js';
export {
  auditArchiveFromEnvironment,
  connectorHttpFromEnvironment,
  createLogger,
  databaseFailureFields,
  encryptionKeysFromEnvironment,
  fileStoreFromEnvironment,
  installationOidcFromEnvironment,
  openServerDatabase,
  paymentProvidersFromEnvironment,
  smtpFromEnvironment,
  watchMemory,
  type Database,
} from '../composition/entry.js';
export * from '../application/admin/http-api.js';
export * from '../application/auth/http-api.js';
export * from '../application/builder/http-api.js';
export * from '../application/files/http-api.js';
export * from '../application/internal/http-api.js';
export * from '../application/organisations/http-api.js';
export * from '../application/payments/http-api.js';
export * from '../application/privacy/http-api.js';
export * from '../application/records/http-api.js';
export * from '../application/session/http-api.js';
export {
  asApplicationError,
  definitionKindOf,
  demand,
  forbidden,
  validationFailed,
  type ErrorCode,
  type Idempotency,
  type RequestActor,
  type RequestContext,
} from '../application/shared/http-api.js';
export { safeNextPath, type HttpFetch, type OidcProviderConfig } from '../application/identity/oidc.js';
export { signInRefusalOf, type SignInRefusal } from '../application/identity/identity-service.js';
export type { AssuranceLevel, AuthenticationEvidence, TenantAuthPolicy } from '../domain/identity/ports/assurance.js';
export { MemoryRateLimiter } from '@onengo/kernel/http';
export { SCHEMA_LEVEL, SERVER_SCHEMA_MINIMUMS } from '../infrastructure/postgres/schema-compatibility.js';
