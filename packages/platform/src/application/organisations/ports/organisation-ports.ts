import type { Registration } from '../../../domain/organisations/organisation.js';
import type { Actor, TenantContext } from '../../../domain/ports/tenant-context.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { ModuleManifest } from '../../../runtime/definitions/types.js';
import type { UploadInput } from '../../files/file-service.js';
import type { RoleInput } from '../../identity/identity-service.js';
import type { OrganisationBranding, OrganisationProfileInput, OrganisationView, SetupChecklist, SignInIdentity, StoredLogo } from '../organisation-service.js';

/** What the organisation routes ask of the organisation's own profile, logo and sign-in page. */

/** The organisation's identity, registrations, logo and setup checklist. */
export interface OrganisationProfile {
  branding(ctx: TenantContext): Promise<OrganisationBranding>;
  logo(ctx: TenantContext): Promise<StoredLogo>;
  keptLogo(ctx: TenantContext, fileId: string): Promise<StoredLogo>;
  view(ctx: TenantContext): Promise<OrganisationView>;
  saveProfile(ctx: TenantContext, input: OrganisationProfileInput): Promise<OrganisationView>;
  addRegistration(ctx: TenantContext, input: unknown): Promise<Registration>;
  updateRegistration(ctx: TenantContext, id: string, input: unknown): Promise<Registration>;
  removeRegistration(ctx: TenantContext, id: string): Promise<void>;
  setup(ctx: TenantContext): Promise<SetupChecklist>;
  confirmSetup(ctx: TenantContext, step: string): Promise<SetupChecklist>;
  setLogo(ctx: TenantContext, upload: Pick<UploadInput, 'body' | 'name'>): Promise<OrganisationView>;
  removeLogo(ctx: TenantContext): Promise<void>;
  saveSignatory(ctx: TenantContext, input: unknown): Promise<OrganisationView>;
  setSignatoryImage(ctx: TenantContext, upload: Pick<UploadInput, 'body' | 'name'>): Promise<OrganisationView>;
  removeSignatory(ctx: TenantContext): Promise<void>;
  keptSignatory(ctx: TenantContext, fileId: string, shownOnReadableReceipt?: boolean): Promise<StoredLogo>;
}

/** The signature image a receipt shows, once the person is known to be allowed to read its record. */
export interface ReceiptSignatures {
  signatureFile(ctx: TenantContext, receiptId: string): Promise<string | null>;
}

/** An active organisation's logo, found by its code. */
export interface SignInLogos {
  signInLogo(rawCode: string): Promise<StoredLogo>;
  /** A square install icon. The shared heart when the organisation has no logo. */
  installIcon(rawCode: string, size: number): Promise<Buffer>;
}

/** An active organisation's display name, logo and published theme, found by its code. */
export interface SignInIdentities {
  signInIdentity(rawCode: string): Promise<SignInIdentity>;
}

/** The sign-in providers an organisation offers. */
export interface SignInProviders {
  providersFor(tenantKey: string): Promise<{ id: string; label: string }[]>;
}

/** What onboarding asks of the services it drives. */
export interface ModuleEnabler {
  enableModule(ctx: TenantContext, manifest: ModuleManifest): Promise<{ materialised: string[] }>;
}

export interface OnboardingIdentity {
  upsertRole(ctx: TenantContext, role: RoleInput): Promise<void>;
  addMember(ctx: TenantContext, input: { email: string; displayName: string; roles: string[] }, alongside?: (tx: Tx, userId: string) => Promise<void>): Promise<string>;
  inviteMember(ctx: TenantContext, userId: string): Promise<void>;
}

export interface FiscalYearOpener {
  openFiscalYear(tx: Tx, actor: Actor, key: string): Promise<void>;
}
