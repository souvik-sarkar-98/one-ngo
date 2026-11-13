import type { Readable } from 'node:stream';
import { forbidden, notFound } from '@onengo/kernel/errors';
import type { CredentialCrypto } from '@onengo/kernel/ports';
import { demand } from '../../domain/permissions.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import { can } from '../../domain/permissions.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { actionPermission } from '../../runtime/definitions/action-permissions.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { IssuerSignatory, IssuerSnapshot, OrganisationAddress, OrganisationContact } from '../../domain/organisations/organisation.js';
import type { ReceiptContent } from '../../domain/receipts/receipt-content.js';
import type { Receipt, ReceiptService } from '../../domain/receipts/receipt-service.js';
import type { ReceiptLinkStore } from '../../domain/receipts/ports/receipt-link-store.js';
import type { FileService } from '../files/file-service.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import type { RecordService } from '../../runtime/records/record-service.js';

const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
const SEALED = /^enc:v1:/;
const MISSING = 'Receipt not found.';

export interface PublicReceipt {
  number: string;
  date: string;
  amount: string;
  title: string;
  status: 'issued' | 'void';
  voidReason: string | null;
  /** The title field, when it is plain text that can be shown. */
  donor: { label: string; value: string } | null;
  recordTypeLabel: string;
  recordNumber: string | null;
  /** The other filled-in fields, in definition order. No reference, file, or sensitive values. */
  fields: { label: string; value: string; kind: 'text' | 'date' | 'money' | 'boolean' }[];
  issuerSource: 'issued' | 'current';
  issuer: {
    displayName: string;
    legalName: string | null;
    contact: OrganisationContact;
    address: OrganisationAddress | null;
    registrations: { type: string; number: string; issuingAuthority: string | null }[];
  };
  signatory: { name: string | null; designation: string | null } | null;
  hasLogo: boolean;
  hasSignature: boolean;
  /** Wording kept when the receipt was issued. Null when the receipt predates layouts. */
  content: ReceiptContent | null;
}

export interface StoredReceiptImage {
  file: { name: string; mime: string; size: number };
  body: Readable;
}

/** A public address for one receipt, and the receipt a valid token may show. */
export class ReceiptLinkService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: ReceiptLinkStore,
    private readonly defs: DefinitionService,
    private readonly records: Pick<RecordService, 'get'>,
    private readonly receipts: ReceiptService,
    private readonly files: FileService,
    private readonly crypto: Pick<CredentialCrypto, 'sha256' | 'randomToken' | 'encryptSecret' | 'decryptSecret'>,
    private readonly audit: AuditTrail,
  ) {}

  /**
   * Whether this person may publish or revoke a public link: they can run a
   * published action that opens the receipt, such as Print receipt.
   */
  async mayPublish(ctx: TenantContext, recordType: string): Promise<boolean> {
    const actions = await this.defs.list(ctx.tenantId, 'action');
    return actions.some(
      (action) =>
        action.body.recordType === recordType &&
        action.body.steps.some((step) => step.type === 'openReceipt') &&
        can(ctx.actor, actionPermission(action.body)),
    );
  }

  /** The path of the live link, for someone who can already read the receipt. Null when there is none. */
  async currentPath(tx: Tx, receiptId: string): Promise<string | null> {
    const link = await this.store.link(tx, receiptId);
    if (!link || link.revoked) return null;
    return `/r/${this.crypto.decryptSecret(link.tokenEnc)}`;
  }

  /** Creates the link, or returns the one that is already live. */
  async ensure(ctx: TenantContext, receiptId: string): Promise<{ path: string }> {
    const receipt = await this.changeable(ctx, receiptId);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const existing = await this.store.link(tx, receipt.id);
      if (existing && !existing.revoked) return { path: `/r/${this.crypto.decryptSecret(existing.tokenEnc)}` };
      const token = this.crypto.randomToken(32);
      await this.store.saveLink(tx, {
        receiptId: receipt.id,
        exists: !!existing,
        tokenHash: this.crypto.sha256(token),
        tokenEnc: this.crypto.encryptSecret(token),
        actorId: ctx.actor.id,
      });
      await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'receipt.link.created', entity: 'receipt', entityId: receipt.id });
      return { path: `/r/${token}` };
    });
  }

  async revoke(ctx: TenantContext, receiptId: string): Promise<void> {
    const receipt = await this.changeable(ctx, receiptId);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const revoked = await this.store.revokeLink(tx, receipt.id, ctx.actor.id);
      if (!revoked) throw notFound(MISSING);
      await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'receipt.link.revoked', entity: 'receipt', entityId: receipt.id });
    });
  }

  async view(token: string): Promise<PublicReceipt> {
    const found = await this.find(token);
    return this.transactions.withTenant(found.tenantId, async (tx) => {
      const opened = await this.open(tx, found.receiptId);
      const lines = opened.content
        ? { donor: null, recordTypeLabel: '', recordNumber: null, fields: [] }
        : await this.lines(tx, opened.receipt.recordId, found.tenantId);
      const signatory = publicSignatory(opened.issuer.signatory);
      return {
        number: opened.receipt.number,
        date: opened.receipt.date,
        amount: opened.receipt.amount,
        title: opened.content?.title || opened.title,
        status: opened.receipt.status,
        voidReason: opened.receipt.voidReason,
        ...lines,
        content: opened.content,
        issuerSource: opened.source,
        issuer: {
          displayName: opened.issuer.displayName,
          legalName: opened.issuer.legalName,
          contact: opened.issuer.contact,
          address: opened.issuer.address,
          registrations: opened.issuer.registrations,
        },
        signatory,
        hasLogo: !!opened.issuer.logo,
        hasSignature: !!opened.issuer.signatory?.file,
      };
    });
  }

  async image(token: string, kind: 'logo' | 'signature'): Promise<StoredReceiptImage> {
    const found = await this.find(token);
    return this.transactions.withTenant(found.tenantId, async (tx) => {
      const opened = await this.open(tx, found.receiptId);
      const fileId = kind === 'logo' ? opened.issuer.logo?.fileId : opened.issuer.signatory?.file?.fileId;
      if (!fileId) throw notFound(MISSING);
      const row = await this.store.file(tx, fileId);
      if (!row) throw notFound(MISSING);
      return { file: { name: row.name, mime: row.mime, size: row.size }, body: await this.files.read({ storage_key: row.storageKey, store_ref: row.storeRef }) };
    });
  }

  private async find(token: string): Promise<{ tenantId: string; receiptId: string }> {
    if (!TOKEN.test(token)) throw notFound(MISSING);
    const found = await this.store.findLive(this.crypto.sha256(token));
    if (!found) throw notFound(MISSING);
    return found;
  }

  private async readable(ctx: TenantContext, receiptId: string): Promise<{ receipt: Receipt; recordType: string }> {
    const receipt = await this.transactions.withTenant(ctx.tenantId, (tx) => this.receipts.get(tx, receiptId));
    if (!receipt?.recordId) throw notFound(MISSING);
    const record = await this.records.get(ctx, receipt.recordId);
    return { receipt, recordType: record.type };
  }

  /** A receipt the person may change and can print, as making or ending its public link needs. */
  private async changeable(ctx: TenantContext, receiptId: string): Promise<Receipt> {
    const { receipt, recordType } = await this.readable(ctx, receiptId);
    demand(ctx.actor, `record:${recordType}:update`);
    if (!(await this.mayPublish(ctx, recordType))) throw forbidden('Only people who can print this receipt can share a public link.');
    return receipt;
  }

  private async open(tx: Tx, receiptId: string): Promise<{ receipt: Receipt; issuer: IssuerSnapshot; source: 'issued' | 'current'; title: string; content: ReceiptContent | null }> {
    const receipt = await this.receipts.get(tx, receiptId);
    if (!receipt) throw notFound(MISSING);
    const kept = await this.receipts.issuer(tx, receipt.id);
    const issuer = kept ?? (await this.receipts.currentIssuer(tx, receipt.date));
    const series = await this.receipts.series(tx, receipt.seriesKey);
    return {
      receipt,
      issuer: { ...issuer, signatory: issuer.signatory ?? null },
      source: kept ? 'issued' : 'current',
      title: series?.label || receipt.seriesKey,
      content: (await this.receipts.content(tx, receipt.id)) ?? null,
    };
  }

  private async lines(tx: Tx, recordId: string | null, tenantId: string): Promise<Pick<PublicReceipt, 'donor' | 'recordTypeLabel' | 'recordNumber' | 'fields'>> {
    const empty = { donor: null, recordTypeLabel: '', recordNumber: null, fields: [] };
    if (!recordId) return empty;
    const row = await this.store.record(tx, recordId);
    if (!row) return empty;
    const published = await this.defs.get(tenantId, 'recordType', row.typeKey);
    const body = published?.body as { label?: string; titleField?: string | null; fields?: ReceiptField[] } | undefined;
    const data = typeof row.data === 'string' ? (JSON.parse(row.data) as Record<string, unknown>) : (row.data as Record<string, unknown>);
    const fields = body?.fields ?? [];
    const titleKey = body?.titleField;
    const title = titleKey ? fields.find((f) => f.key === titleKey) : undefined;
    const donorValue = title ? shownText(data?.[title.key]) : null;
    return {
      donor: title?.label && donorValue && !title.sensitive ? { label: title.label, value: donorValue } : null,
      recordTypeLabel: body?.label || row.typeKey,
      recordNumber: row.number,
      fields: fields.flatMap((field) => {
        if (!field.label || field.key === titleKey || field.key === 'amount' || HIDDEN.has(field.type ?? '') || field.sensitive) return [];
        const line = shownField(field, data?.[field.key]);
        return line ? [{ label: field.label, ...line }] : [];
      }),
    };
  }
}

interface ReceiptField {
  key: string;
  label?: string;
  type?: string;
  sensitive?: boolean;
  choices?: { value: string; label: string }[];
}

const HIDDEN = new Set(['longText', 'richText', 'reference', 'file', 'signature']);

function shownText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || SEALED.test(value)) return null;
  return value.trim();
}

function shownField(field: ReceiptField, value: unknown): { value: string; kind: 'text' | 'date' | 'money' | 'boolean' } | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && SEALED.test(value)) return null;
  if (field.type === 'boolean') return value === true || value === false ? { value: String(value), kind: 'boolean' } : null;
  if (field.type === 'date' && typeof value === 'string') return { value, kind: 'date' };
  if (field.type === 'money' && (typeof value === 'number' || (typeof value === 'string' && value.trim()))) return { value: String(value), kind: 'money' };
  if (field.type === 'choice' && (typeof value === 'string' || typeof value === 'number')) {
    const label = field.choices?.find((c) => c.value === String(value))?.label;
    return { value: label || String(value), kind: 'text' };
  }
  if (typeof value === 'string' || typeof value === 'number') return { value: String(value), kind: 'text' };
  return null;
}

function publicSignatory(signatory: IssuerSignatory | null | undefined): { name: string | null; designation: string | null } | null {
  if (!signatory) return null;
  if (!signatory.name && !signatory.designation && !signatory.file) return null;
  return { name: signatory.name, designation: signatory.designation };
}
