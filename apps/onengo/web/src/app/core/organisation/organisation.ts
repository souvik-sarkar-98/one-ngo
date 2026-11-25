import type { OrganisationProfileRequest, RegistrationRequest, SettingsRequest } from '../contracts';
import { currentProductName } from './product-name';

export type { OrganisationProfileRequest, RegistrationRequest };

/**
 * The product name from the server's `ONENGO_PRODUCT_NAME` (OneNGO by default): sign-in, the app bar and every browser title.
 * It is not part of an organisation's identity. Read once the app loads, see `loadProductName`.
 */
export const PRODUCT = currentProductName();

/** A browser title: `<screen or organisation> | OneNGO`, or the product alone. */
export const browserTitle = (screen?: string | null): string => (screen?.trim() ? `${screen.trim()} | ${PRODUCT}` : PRODUCT);

/** As the server checks logos: PNG, JPEG or WebP of at most 1 MB. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 1024 * 1024;
export const SIGNATURE_MAX_BYTES = 200 * 1024;

export interface OrganisationContact {
  email: string | null;
  phone: string | null;
  website: string | null;
}

export interface OrganisationAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  /** Two-letter country code, e.g. IN. */
  country: string;
}

export interface Registration {
  id: string;
  /** e.g. `80g`, `12a`, `fcra`. */
  type: string;
  /** In capitals; unique with its type within the organisation. */
  number: string;
  issuingAuthority: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  notes: string | null;
}

export type SetupKey = 'identity' | 'registrations' | 'fiscalYear' | 'receiptSeries' | 'operationalRole' | 'email' | 'fileStore' | 'payments';

export interface SetupItem {
  key: SetupKey;
  done: boolean;
  /** Optional items are shown but do not hold setup back. */
  required: boolean;
  /** For `email`: `organisation` when its email connector sends mail, otherwise `none`. */
  detail?: string;
}

export interface SetupChecklist {
  complete: boolean;
  completedAt: string | null;
  items: SetupItem[];
}

/** What an administrator sees and changes: the server's organisation view. */
export interface OrganisationView {
  /** Set by the operator and never changed. */
  code: string;
  displayName: string;
  legalName: string | null;
  contact: OrganisationContact;
  address: OrganisationAddress | null;
  timezone: string | null;
  registrations: Registration[];
  logo: { url: string; version: number; updatedAt: string } | null;
  /** Oldest first. */
  signatories: { id: string; name: string; designation: string; image: { url: string; version: number; updatedAt: string } | null }[];
  /** The ordered signatories of each document that has any, by document key: `receipt`, `receipt:<rule>` or `report:<report>`. */
  signatorySets: Record<string, string[]>;
  setup: SetupChecklist;
}

/** The people who can sign, and the ordered signatories chosen for each document. Readable with the configuration. */
export interface DocumentSignatories {
  signatories: { id: string; name: string; designation: string }[];
  sets: Record<string, string[]>;
}

/** The shell's display name and logo; the logo address is same-origin and needs the person's sign-in. */
export interface OrganisationBranding {
  code: string;
  displayName: string;
  logoUrl: string | null;
}

/** Published colour tokens. Anything else from the stored theme is left off this public answer. */
export interface SignInTheme {
  brand?: string;
  brandForeground?: string;
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  line?: string;
  radius?: string;
}

/** What an organisation's own sign-in page shows; the logo needs no sign-in. */
export interface SignInOrganisation extends OrganisationBranding {
  providers: { id: string; label: string }[];
  /** Null when the organisation has not published a theme. */
  theme: SignInTheme | null;
}

/** The two checklist steps an administrator confirms. */
export type ConfirmableStep = 'identity' | 'receiptSeries';

/**
 * The organisation's server calls (identity, registrations, logo, setup and
 * the organisation sign-in page). The only implementation that talks HTTP is
 * in http-organisation.ts.
 */
export interface OrganisationGateway {
  /** Before sign-in: an active organisation's name, logo and sign-in options; 404 for unknown and inactive codes alike. */
  signInOrganisation(code: string): Promise<SignInOrganisation>;
  branding(): Promise<OrganisationBranding>;
  view(): Promise<OrganisationView>;
  saveProfile(change: OrganisationProfileRequest): Promise<OrganisationView>;
  /** The legal name is saved with the organisation settings. */
  saveLegalName(legalName: NonNullable<SettingsRequest['legalName']>): Promise<void>;
  addRegistration(body: RegistrationRequest): Promise<Registration>;
  updateRegistration(id: string, body: RegistrationRequest): Promise<Registration>;
  removeRegistration(id: string): Promise<void>;
  /** The image itself is the request body. */
  setLogo(file: Blob): Promise<OrganisationView>;
  removeLogo(): Promise<void>;
  addSignatory(body: { name: string; designation: string }): Promise<OrganisationView>;
  updateSignatory(id: string, body: { name: string; designation: string }): Promise<OrganisationView>;
  /** The PNG itself is the request body. */
  setSignature(id: string, file: Blob): Promise<OrganisationView>;
  removeSignatory(id: string): Promise<void>;
  /** The roster and every document's set, for the builder's pickers. */
  documentSignatories(): Promise<DocumentSignatories>;
  /** Replaces one document's signatories in order; an empty list clears its own set. */
  saveDocumentSignatories(documentKey: string, signatories: string[]): Promise<DocumentSignatories>;
  setup(): Promise<SetupChecklist>;
  confirmSetup(step: ConfirmableStep): Promise<SetupChecklist>;
  /** A same-origin image that needs the sign-in (the current logo or one a receipt keeps), as bytes. */
  image(url: string): Promise<Blob>;
}
