import { can, forbidden, notFound, type RequestContext } from '../shared/http-api.js';
import type { OrganisationProfile, ReceiptSignatures, SignInIdentities, SignInLogos, SignInProviders } from './ports/organisation-ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { organisationManifest } from './install-manifest.js';

export type { StoredLogo } from './organisation-service.js';

/** The organisation's own identity, registrations, logo and setup checklist. */
export interface OrganisationApi {
  organisation: OrganisationProfile;
  signatures: SignatoryImage;
}

/** Before sign-in: an organisation's sign-in page and logo, found by its code. */
export interface PublicOrganisationApi {
  signIn: OrganisationSignIn;
  logos: SignInLogos;
}

/** The display name, logo and sign-in providers of an active organisation; unknown and inactive codes get the same 404. */
export class OrganisationSignIn {
  constructor(
    private readonly organisation: SignInIdentities,
    private readonly oidc: SignInProviders,
  ) {}

  async identity(code: string) {
    const identity = await this.organisation.signInIdentity(code);
    return { ...identity, providers: await this.oidc.providersFor(identity.code) };
  }
}

/**
 * A signature image: for people who change settings, or for someone printing
 * a receipt they can read that shows this signature.
 */
export class SignatoryImage {
  constructor(
    private readonly organisation: Pick<OrganisationProfile, 'keptSignatory'>,
    private readonly receipts: ReceiptSignatures,
  ) {}

  async run(ctx: RequestContext, fileId: string, receiptId?: string) {
    if (can(ctx.actor, 'admin:settings')) return this.organisation.keptSignatory(ctx, fileId);
    if (!receiptId) throw forbidden();
    if (!UUID.test(receiptId)) throw notFound('Signature not found.');
    if ((await this.receipts.signatureFile(ctx, receiptId)) !== fileId) throw notFound('Signature not found.');
    return this.organisation.keptSignatory(ctx, fileId, true);
  }
}
