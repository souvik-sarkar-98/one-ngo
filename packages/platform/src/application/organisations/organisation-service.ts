import type { Readable } from 'node:stream';
import {
  DUPLICATE_REGISTRATION,
  isTimezone,
  knownKeys,
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  parseAddress,
  parseSignatory,
  parseDocumentSignatories,
  SIGNATORY_DOCUMENT,
  SIGNATORIES_PER_ORGANISATION,
  SIGNATORY_MAX_BYTES,
  parseContact,
  parseRegistration,
  type OrganisationAddress,
  type OrganisationContact,
  type OrganisationProfileState,
  type Registration,
  type RegistrationInput,
} from '../../domain/organisations/organisation.js';
import type { OrganisationStore } from '../../domain/organisations/ports/organisation-store.js';
import type { TenantDirectory } from '../../domain/organisations/ports/organisation-directory.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { conflict, notFound, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { isInstallIconSize, squareInstallIcon } from './square-icon.js';
import { can, demand } from '../../domain/permissions.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { FileService, UploadInput } from '../files/file-service.js';
import type { DefinitionReader } from '../../runtime/definitions/ports/definition-reader.js';
import type { OrganisationAdminStore } from './ports/organisation-admin-store.js';

const SETTINGS = 'admin:settings';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMINISTRATOR_ROLE = 'admin';
/** Codes made before the sign-in link format may be shorter, so lookups accept any plausible code. */
const CODE_LOOKUP = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const UNAVAILABLE = 'This organisation is not available. Check the sign-in link, or ask your organisation for it.';

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

export interface OrganisationView {
  /** The organisation code in sign-in links; set by the operator and never changed. */
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
  /** The ordered signatories of each document that has any, by document key. */
  signatorySets: Record<string, string[]>;
  setup: SetupChecklist;
}

/** The people who can sign, and the ordered signatories chosen for each document. Readable by anyone who can see the setup. */
export interface DocumentSignatories {
  signatories: { id: string; name: string; designation: string }[];
  /** Keyed by document: `receipt`, `receipt:<rule>` or `report:<report>`. */
  sets: Record<string, string[]>;
}

/** Only what the shell and the sign-in page show. */
export interface OrganisationBranding {
  code: string;
  displayName: string;
  /** Same origin; null without a logo. */
  logoUrl: string | null;
}

const THEME_COLOURS = ['brand', 'brandForeground', 'background', 'surface', 'text', 'muted', 'line', 'radius'] as const;

/** Colour tokens from the published organisation theme. Blank tokens are left out. */
export type SignInTheme = Partial<Record<(typeof THEME_COLOURS)[number], string>>;

/** The sign-in page and the install page: branding plus the published colours. */
export interface SignInIdentity extends OrganisationBranding {
  /** Null when the organisation has not published a theme. */
  theme: SignInTheme | null;
  /**
   * The stored logo type, for the install manifest. Null without a logo.
   * The public sign-in response leaves this out.
   */
  logoMime: string | null;
}

/** Keeps only colour tokens, so a stored theme cannot carry names or other organisation data onto a public page. */
export function signInTheme(body: unknown): SignInTheme | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const theme: SignInTheme = {};
  for (const key of THEME_COLOURS) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) theme[key] = text;
  }
  return Object.keys(theme).length ? theme : null;
}

export interface OrganisationProfileInput {
  contact?: unknown;
  address?: unknown;
  timezone?: unknown;
}

export interface StoredLogo {
  file: { name: string; mime: string; size: number };
  body: Readable;
}

const brandingLogoUrl = (code: string, version: number) => `/api/auth/organisations/${code}/logo?v=${version}`;
const memberLogoUrl = (version: number) => `/api/organisation/logo?v=${version}`;
const signatoryImageUrl = (fileId: string, version: number) => `/api/organisation/signatories/${fileId}?v=${version}`;

/** The ordered signatories of each document, from the stored rows in print order. */
function setsOf(uses: { signatory_id: string; document_key: string }[]): Record<string, string[]> {
  const sets: Record<string, string[]> = {};
  for (const use of uses) (sets[use.document_key] ??= []).push(use.signatory_id);
  return sets;
}

function registrationOf(input: unknown): RegistrationInput {
  const issues: FieldIssue[] = [];
  const r = parseRegistration(input, '', issues);
  if (!r || issues.length) throw validationFailed('The registration is not valid.', issues);
  return r;
}

/**
 * The organisation's own identity: names, contact, address, registrations,
 * logo and the setup checklist for its administrators, and the little the
 * sign-in page may show before anyone signs in. The organisation code, region
 * and lifecycle status belong to the operator and are not changed here.
 */
export class OrganisationService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly organisation: OrganisationStore,
    private readonly store: OrganisationAdminStore,
    private readonly tenants: TenantDirectory,
    private readonly files: FileService,
    private readonly definitions: Pick<DefinitionReader, 'list'>,
  ) {}

  async view(ctx: TenantContext): Promise<OrganisationView> {
    demand(ctx.actor, SETTINGS);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const tenant = await this.store.identity(tx);
      if (!tenant) throw notFound('Unknown organisation.');
      const profile = await this.organisation.readProfile(tx);
      const registrations = await this.organisation.registrations(tx);
      const logo = await this.store.logo(tx);
      const signatoryRows = await this.store.signatories(tx);
      const uses = await this.store.signatoryUses(tx);
      const signatories = signatoryRows.map((row) => ({
        id: row.id,
        name: row.name,
        designation: row.designation,
        image: row.file_id ? { url: signatoryImageUrl(row.file_id, row.version), version: row.version, updatedAt: new Date(row.updated_at).toISOString() } : null,
      }));
      return {
        code: tenant.key,
        displayName: tenant.name,
        legalName: tenant.legal_name,
        contact: profile.contact,
        address: profile.address,
        timezone: profile.timezone,
        registrations,
        logo: logo ? { url: memberLogoUrl(logo.version), version: logo.version, updatedAt: new Date(logo.updated_at).toISOString() } : null,
        signatories,
        signatorySets: setsOf(uses),
        setup: await this.finishSetup(tx, ctx, await this.checklist(tx, tenant.legal_name, profile, registrations.length)),
      };
    });
  }

  /** Changes only the parts sent: `contact` fields, the whole `address`, or `timezone`. An empty text clears an optional field. */
  async saveProfile(ctx: TenantContext, input: OrganisationProfileInput): Promise<OrganisationView> {
    demand(ctx.actor, SETTINGS);
    const issues: FieldIssue[] = [];
    knownKeys(input, '', ['contact', 'address', 'timezone'], issues);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.organisation.readProfile(tx);
      const contact = input.contact === undefined ? before.contact : { ...before.contact, ...this.contactChanges(input.contact, issues) };
      const address = input.address === undefined ? before.address : parseAddress(input.address, 'address', issues);
      let timezone = before.timezone;
      if (input.timezone !== undefined) {
        if (typeof input.timezone !== 'string' || !isTimezone(input.timezone)) issues.push({ path: 'timezone', message: 'Use a time zone such as Asia/Kolkata.' });
        else timezone = input.timezone;
      }
      if (issues.length) throw validationFailed('The organisation details are not valid.', issues);
      const after = { contact, address, timezone };
      await this.organisation.writeProfile(tx, ctx.actor.id, after);
      await this.organisation.audit(tx, {
        actorId: ctx.actor.id,
        action: 'organisation.profile.changed',
        entity: 'tenant',
        entityId: ctx.tenantId,
        before: { contact: before.contact, address: before.address, timezone: before.timezone },
        after,
      });
    });
    return this.view(ctx);
  }

  async addRegistration(ctx: TenantContext, input: unknown): Promise<Registration> {
    demand(ctx.actor, SETTINGS);
    const r = registrationOf(input);
    const id = await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      if (await this.organisation.registrationTaken(tx, r, null)) throw conflict(DUPLICATE_REGISTRATION);
      const id = await this.organisation.addRegistration(tx, ctx.actor.id, r);
      await this.organisation.audit(tx, { actorId: ctx.actor.id, action: 'organisation.registration.added', entity: 'tenant', entityId: ctx.tenantId, after: { id, type: r.type } });
      return id;
    });
    return { id, ...r };
  }

  async updateRegistration(ctx: TenantContext, id: string, input: unknown): Promise<Registration> {
    demand(ctx.actor, SETTINGS);
    if (!UUID.test(id)) throw notFound('Registration not found.');
    const r = registrationOf(input);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      if (await this.organisation.registrationTaken(tx, r, id)) throw conflict(DUPLICATE_REGISTRATION);
      if (!(await this.organisation.updateRegistration(tx, ctx.actor.id, id, r))) throw notFound('Registration not found.');
      await this.organisation.audit(tx, { actorId: ctx.actor.id, action: 'organisation.registration.changed', entity: 'tenant', entityId: ctx.tenantId, after: { id, type: r.type } });
    });
    return { id, ...r };
  }

  async removeRegistration(ctx: TenantContext, id: string): Promise<void> {
    demand(ctx.actor, SETTINGS);
    if (!UUID.test(id)) throw notFound('Registration not found.');
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const removed = await this.organisation.removeRegistration(tx, id);
      if (!removed) throw notFound('Registration not found.');
      await this.organisation.audit(tx, { actorId: ctx.actor.id, action: 'organisation.registration.removed', entity: 'tenant', entityId: ctx.tenantId, before: { id, type: removed.type } });
    });
  }

  /** Stores a PNG, JPEG or WebP image of at most 1 MB as the logo; the one it replaces stays only while an issued receipt keeps it. */
  async setLogo(ctx: TenantContext, upload: Pick<UploadInput, 'body' | 'name'>): Promise<OrganisationView> {
    demand(ctx.actor, SETTINGS);
    const file = await this.files.upload(ctx, { ...upload, maxBytes: LOGO_MAX_BYTES });
    if (!LOGO_TYPES.includes(file.mime)) {
      throw validationFailed('The logo must be a PNG, JPEG or WebP image.', [{ path: 'logo', message: 'A PNG, JPEG or WebP image.' }]);
    }
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.store.logo(tx);
      await this.store.putLogo(tx, file.id, ctx.actor.id);
      await this.organisation.audit(tx, {
        actorId: ctx.actor.id,
        action: 'organisation.logo.changed',
        entity: 'tenant',
        entityId: ctx.tenantId,
        before: before ? { fileId: before.file_id } : null,
        after: { fileId: file.id, mime: file.mime, size: file.size },
      });
    });
    return this.view(ctx);
  }

  /** Adds a signatory. Receipt rules and reports print only the signatories chosen for them. */
  async addSignatory(ctx: TenantContext, input: unknown): Promise<OrganisationView> {
    demand(ctx.actor, SETTINGS);
    const issues: FieldIssue[] = [];
    const parsed = parseSignatory(input, issues);
    if (!parsed || issues.length) throw validationFailed('The signatory is not valid.', issues);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const existing = await this.store.signatories(tx);
      if (existing.length >= SIGNATORIES_PER_ORGANISATION) throw validationFailed('An organisation has at most 20 signatories.');
      const id = await this.store.addSignatory(tx, ctx.actor.id, parsed.name, parsed.designation);
      await this.organisation.audit(tx, {
        actorId: ctx.actor.id,
        action: 'organisation.signatory.added',
        entity: 'tenant',
        entityId: ctx.tenantId,
        after: { id, ...parsed },
      });
    });
    return this.view(ctx);
  }

  /** Changes the name and designation. The signature image is uploaded separately. */
  async updateSignatory(ctx: TenantContext, id: string, input: unknown): Promise<OrganisationView> {
    demand(ctx.actor, SETTINGS);
    if (!UUID.test(id)) throw notFound('Signatory not found.');
    const issues: FieldIssue[] = [];
    const parsed = parseSignatory(input, issues);
    if (!parsed || issues.length) throw validationFailed('The signatory is not valid.', issues);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const before = (await this.store.signatories(tx)).find((row) => row.id === id);
      if (!before || !(await this.store.updateSignatory(tx, id, ctx.actor.id, parsed.name, parsed.designation))) throw notFound('Signatory not found.');
      await this.organisation.audit(tx, {
        actorId: ctx.actor.id,
        action: 'organisation.signatory.changed',
        entity: 'tenant',
        entityId: ctx.tenantId,
        before: { id, name: before.name, designation: before.designation },
        after: { id, ...parsed },
      });
    });
    return this.view(ctx);
  }

  /** Stores a PNG of at most 200 kB as this signatory's signature. The one it replaces stays while a receipt or report keeps it. */
  async setSignatoryImage(ctx: TenantContext, id: string, upload: Pick<UploadInput, 'body' | 'name'>): Promise<OrganisationView> {
    demand(ctx.actor, SETTINGS);
    if (!UUID.test(id)) throw notFound('Signatory not found.');
    const file = await this.files.upload(ctx, { ...upload, maxBytes: SIGNATORY_MAX_BYTES, name: upload.name || 'signature.png' });
    if (file.mime !== 'image/png') throw validationFailed('The signature must be a PNG image.', [{ path: 'signatory', message: 'A PNG image.' }]);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.store.putSignatoryImage(tx, id, file.id, ctx.actor.id);
      if (!before) throw notFound('Signatory not found.');
      await this.organisation.audit(tx, {
        actorId: ctx.actor.id,
        action: 'organisation.signatory.image.changed',
        entity: 'tenant',
        entityId: ctx.tenantId,
        before: before.file_id ? { id, fileId: before.file_id } : { id },
        after: { id, fileId: file.id, mime: file.mime, size: file.size },
      });
    });
    return this.view(ctx);
  }

  /** Removes a signatory that is not printed on receipts or reports. */
  async removeSignatory(ctx: TenantContext, id: string): Promise<void> {
    demand(ctx.actor, SETTINGS);
    if (!UUID.test(id)) throw notFound('Signatory not found.');
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const removed = await this.store.removeSignatory(tx, id);
      if (removed === 'in_use') throw conflict('Take this signatory off receipts and reports before removing it.');
      if (!removed) throw notFound('Signatory not found.');
      await this.organisation.audit(tx, {
        actorId: ctx.actor.id,
        action: 'organisation.signatory.removed',
        entity: 'tenant',
        entityId: ctx.tenantId,
        before: { id, fileId: removed.file_id },
      });
    });
  }

  /** The roster and every document's set, for the builder's signatory pickers. Anyone who can read the configuration may see it. */
  async documentSignatories(ctx: TenantContext): Promise<DocumentSignatories> {
    demand(ctx.actor, 'config:read');
    return this.transactions.withTenant(ctx.tenantId, (tx) => this.signatoriesIn(tx));
  }

  private async signatoriesIn(tx: Tx): Promise<DocumentSignatories> {
    return {
      signatories: (await this.store.signatories(tx)).map((row) => ({ id: row.id, name: row.name, designation: row.designation })),
      sets: setsOf(await this.store.signatoryUses(tx)),
    };
  }

  /**
   * Replaces the signatories one document prints: `receipt:<rule>` or
   * `report:<report>`. An empty list clears the document's set; a receipt rule
   * with none issues no receipts. Changing the configuration needs `admin:settings` or `config:publish`.
   */
  async setDocumentSignatories(ctx: TenantContext, documentKey: string, input: unknown): Promise<DocumentSignatories> {
    if (!can(ctx.actor, SETTINGS) && !can(ctx.actor, 'config:publish')) demand(ctx.actor, SETTINGS);
    if (!SIGNATORY_DOCUMENT.test(documentKey)) throw validationFailed('This document does not take signatories.', [{ path: 'document', message: 'Choose a receipt rule or a report.' }]);
    await this.documentExists(ctx, documentKey);
    const issues: FieldIssue[] = [];
    const ids = parseDocumentSignatories(input, issues);
    if (!ids || issues.length) throw validationFailed('The signatories are not valid.', issues);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const known = new Set((await this.store.signatories(tx)).map((row) => row.id));
      if (ids.some((id) => !known.has(id))) {
        throw validationFailed('The signatories are not valid.', [{ path: 'signatories', message: 'Choose a signatory that exists.' }]);
      }
      const before = setsOf(await this.store.signatoryUses(tx))[documentKey] ?? [];
      await this.store.replaceDocumentSignatories(tx, documentKey, ids);
      await this.organisation.audit(tx, {
        actorId: ctx.actor.id,
        action: 'organisation.signatory.sets.changed',
        entity: 'tenant',
        entityId: ctx.tenantId,
        before: { document: documentKey, signatories: before },
        after: { document: documentKey, signatories: ids },
      });
      return this.signatoriesIn(tx);
    });
  }

  /** A receipt rule or a report must exist in this organisation. */
  private async documentExists(ctx: TenantContext, documentKey: string): Promise<void> {
    const isRule = documentKey.startsWith('receipt:');
    const key = documentKey.slice(documentKey.indexOf(':') + 1);
    const defined = await this.definitions.list(ctx.tenantId, isRule ? 'receiptRule' : 'report');
    if (!defined.some((definition) => definition.key === key)) throw notFound('This receipt rule or report does not exist.');
  }

  /**
   * The current signature, or one an issued receipt of this organisation keeps.
   * For people who change settings, or when the caller has checked that a
   * receipt the person can read shows this signature.
   */
  async keptSignatory(ctx: TenantContext, fileId: string, shownOnReadableReceipt = false): Promise<StoredLogo> {
    if (!shownOnReadableReceipt) demand(ctx.actor, SETTINGS);
    if (!UUID.test(fileId)) throw notFound('Signature not found.');
    const row = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.signatoryFile(tx, fileId));
    if (!row) throw notFound('Signature not found.');
    return { file: row, body: await this.files.read(ctx.tenantId, row) };
  }

  async removeLogo(ctx: TenantContext): Promise<void> {
    demand(ctx.actor, SETTINGS);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const removed = await this.store.removeLogo(tx);
      if (!removed) throw notFound('The organisation has no logo.');
      await this.organisation.audit(tx, { actorId: ctx.actor.id, action: 'organisation.logo.removed', entity: 'tenant', entityId: ctx.tenantId, before: { fileId: removed.file_id } });
    });
  }

  /** For every signed-in member: the shell shows the display name and logo. */
  async branding(ctx: TenantContext): Promise<OrganisationBranding> {
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const tenant = await this.store.identity(tx);
      if (!tenant) throw notFound('Unknown organisation.');
      const logo = await this.store.logo(tx);
      return { code: tenant.key, displayName: tenant.name, logoUrl: logo ? memberLogoUrl(logo.version) : null };
    });
  }

  /** The signed-in member's own organisation logo; row-level security keeps every other organisation's out of reach. */
  async logo(ctx: TenantContext): Promise<StoredLogo> {
    const row = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.logoFile(tx, null));
    if (!row) throw notFound('The organisation has no logo.');
    return { file: row, body: await this.files.read(ctx.tenantId, row) };
  }

  /** The current logo or one an issued receipt of this organisation keeps, by file id. */
  async keptLogo(ctx: TenantContext, fileId: string): Promise<StoredLogo> {
    if (!UUID.test(fileId)) throw notFound('Logo not found.');
    const row = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.logoFile(tx, fileId));
    if (!row) throw notFound('Logo not found.');
    return { file: row, body: await this.files.read(ctx.tenantId, row) };
  }

  async setup(ctx: TenantContext): Promise<SetupChecklist> {
    return (await this.view(ctx)).setup;
  }

  /** The administrator confirms the organisation identity or has reviewed the receipt series. */
  async confirmSetup(ctx: TenantContext, step: string): Promise<SetupChecklist> {
    demand(ctx.actor, SETTINGS);
    if (step !== 'identity' && step !== 'receiptSeries') throw notFound('There is no such setup step to confirm.');
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      await this.organisation.confirmSetupStep(tx, ctx.actor.id, step === 'identity' ? 'identity' : 'receipts');
      await this.organisation.audit(tx, { actorId: ctx.actor.id, action: 'organisation.setup.confirmed', entity: 'tenant', entityId: ctx.tenantId, after: { step } });
    });
    const view = await this.view(ctx);
    if (view.setup.complete && !view.setup.completedAt) {
      await this.transactions.withTenant(ctx.tenantId, async (tx) => {
        await this.organisation.confirmSetupStep(tx, ctx.actor.id, 'complete');
        await this.organisation.audit(tx, { actorId: ctx.actor.id, action: 'organisation.setup.completed', entity: 'tenant', entityId: ctx.tenantId });
      });
      return this.setup(ctx);
    }
    return view.setup;
  }

  /**
   * What the organisation's sign-in and install pages show: its display name,
   * logo and published theme colours, nothing else. Unknown codes and
   * organisations that are not active get the same answer.
   */
  /**
   * An active organisation's id, code, display name and published colours for a public page.
   * Unknown and inactive codes are not found.
   */
  async publicHome(rawCode: string): Promise<{ tenantId: string; code: string; displayName: string; theme: SignInTheme | null }> {
    const found = await this.activeByCode(rawCode);
    if (!found) throw notFound(UNAVAILABLE);
    return this.transactions.withTenant(found.tenantId, async (tx) => ({
      ...found,
      displayName: await this.store.name(tx),
      theme: signInTheme(await this.store.publishedTheme(tx)),
    }));
  }

  /** The published colours of an organisation a public link belongs to. Null when none are published. */
  async publicTheme(tenantId: string): Promise<SignInTheme | null> {
    return this.transactions.withTenant(tenantId, async (tx) => signInTheme(await this.store.publishedTheme(tx)));
  }

  async signInIdentity(rawCode: string): Promise<SignInIdentity> {
    const found = await this.activeByCode(rawCode);
    if (!found) throw notFound(UNAVAILABLE);
    return this.transactions.withTenant(found.tenantId, async (tx) => {
      const displayName = await this.store.name(tx);
      const logo = await this.store.logo(tx);
      const file = logo ? await this.store.logoFile(tx, null) : undefined;
      return {
        code: found.code,
        displayName,
        logoUrl: logo ? brandingLogoUrl(found.code, logo.version) : null,
        logoMime: file?.mime ?? null,
        theme: signInTheme(await this.store.publishedTheme(tx)),
      };
    });
  }

  async signInLogo(rawCode: string): Promise<StoredLogo> {
    const found = await this.activeByCode(rawCode);
    const row = found && (await this.transactions.withTenant(found.tenantId, (tx) => this.store.logoFile(tx, null)));
    if (!found || !row) throw notFound(UNAVAILABLE);
    return { file: row, body: await this.files.read(found.tenantId, row) };
  }

  /** A square PNG for the home screen. No logo, or one that cannot be drawn, is the shared heart. */
  async installIcon(rawCode: string, size: number): Promise<Buffer> {
    if (!isInstallIconSize(size)) throw notFound(UNAVAILABLE);
    const found = await this.activeByCode(rawCode);
    if (!found) throw notFound(UNAVAILABLE);
    const row = await this.transactions.withTenant(found.tenantId, (tx) => this.store.logoFile(tx, null));
    if (!row) return squareInstallIcon(Buffer.alloc(0), '', size);
    const chunks: Buffer[] = [];
    for await (const chunk of await this.files.read(found.tenantId, row)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return squareInstallIcon(Buffer.concat(chunks), row.mime, size);
  }

  // --------------------------------------------------------------- internals

  private async activeByCode(rawCode: string): Promise<{ code: string; tenantId: string } | undefined> {
    const code = typeof rawCode === 'string' ? rawCode.trim().toLowerCase() : '';
    const tenantId = CODE_LOOKUP.test(code) ? await this.tenants.activeIdByKey(code) : undefined;
    return code && tenantId ? { code, tenantId } : undefined;
  }

  private contactChanges(value: unknown, issues: FieldIssue[]): Partial<OrganisationContact> {
    const parsed = parseContact(value, 'contact', issues, false);
    const sent = value && typeof value === 'object' ? Object.keys(value) : [];
    return Object.fromEntries(sent.filter((k) => k in parsed).map((k) => [k, parsed[k as keyof OrganisationContact]]));
  }

  private async checklist(tx: Tx, legalName: string | null, profile: OrganisationProfileState, registrations: number): Promise<SetupChecklist> {
    const facts = await this.store.setupFacts(tx, ADMINISTRATOR_ROLE);
    const email = facts.email ? 'organisation' : 'none';
    const items: SetupItem[] = [
      { key: 'identity', required: true, done: !!(profile.identityConfirmedAt && legalName && profile.address && profile.contact.email) },
      { key: 'registrations', required: true, done: registrations > 0 },
      { key: 'fiscalYear', required: true, done: facts.fiscalYear },
      { key: 'receiptSeries', required: true, done: !facts.series || !!profile.receiptsReviewedAt },
      { key: 'operationalRole', required: true, done: facts.operationalRole },
      { key: 'email', required: true, done: email === 'organisation', detail: email },
      { key: 'fileStore', required: true, done: facts.fileStore },
      { key: 'payments', required: false, done: facts.payments },
    ];
    return { complete: items.every((i) => !i.required || i.done), completedAt: profile.setupCompletedAt, items };
  }

  /** Records the moment setup first becomes complete, including when the last step is the email connector. */
  private async finishSetup(tx: Tx, ctx: TenantContext, setup: SetupChecklist): Promise<SetupChecklist> {
    if (!setup.complete || setup.completedAt) return setup;
    await this.organisation.confirmSetupStep(tx, ctx.actor.id, 'complete');
    await this.organisation.audit(tx, { actorId: ctx.actor.id, action: 'organisation.setup.completed', entity: 'tenant', entityId: ctx.tenantId });
    return { ...setup, completedAt: new Date().toISOString() };
  }
}