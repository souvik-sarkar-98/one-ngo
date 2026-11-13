import { operatorControlPlane, type OperatorControlPlane } from '../application/organisations/control-plane.js';
import { organisationOperations, type OrganisationOperationsDeps, type SignInSettings } from '../composition/organisations.js';
import type { Paths } from '../composition/infrastructure.js';
import { createPlatform, PATHS } from '../platform.js';
import {
  connectorHttpFromEnvironment,
  createLogger,
  encryptionKeysFromEnvironment,
  installationOidcSummaryFromEnvironment,
  openOperatorDatabase,
  smtpFromEnvironment,
} from '../composition/entry.js';

export {
  verifiedOperatorPrincipal,
  type OperatorAction,
  type OperatorPrincipal,
  type OperatorPrincipalInput,
} from '../application/organisations/operator-principal.js';
export type { OperatorControlPlane, OperatorSignInControl } from '../application/organisations/control-plane.js';
export type { OrganisationStatus } from '../application/organisations/lifecycle-service.js';
export type { OnboardingOutcome, OnboardingPlan } from '../application/organisations/onboarding-service.js';
export type { OrganisationSignIn, ProviderCheck, SharedProviderSummary } from '../application/organisations/sign-in-service.js';
export type { SignInSettings } from '../composition/organisations.js';

export interface OperatorControlPlaneOptions {
  /** Product schemas, modules and worker entry. Required outside repository tests. */
  paths: Paths;
  signIn?: SignInSettings;
}

export {
  PATHS,
  connectorHttpFromEnvironment,
  createLogger,
  encryptionKeysFromEnvironment,
  installationOidcSummaryFromEnvironment,
  openOperatorDatabase,
  smtpFromEnvironment,
};
export type { Database, Logger } from '../composition/entry.js';

/** Composes the engine for the isolated operator process without exposing the main HTTP host. */
export async function createOperatorRuntime(
  db: Parameters<typeof createPlatform>[0],
  options: Parameters<typeof createPlatform>[1],
  signIn: SignInSettings = {},
): Promise<{ control: OperatorControlPlane; close(): Promise<void> }> {
  const platform = await createPlatform(db, { ...options, autoRunJobs: false });
  return {
    control: createOperatorControlPlane(platform, { paths: options.paths ?? PATHS, signIn }),
    close: () => db.close(),
  };
}

/** Builds only the operator facade; the NGO HTTP composition never calls or exports this function. */
export function createOperatorControlPlane(services: OrganisationOperationsDeps, options: OperatorControlPlaneOptions): OperatorControlPlane {
  return operatorControlPlane(organisationOperations(services, options.paths, options.signIn));
}
