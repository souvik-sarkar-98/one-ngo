import type { IssuerSnapshot } from '../../domain/organisations/organisation.js';
import type { ReceiptContent } from '../../domain/receipts/receipt-content.js';
import type { Receipt, ReceiptService } from '../../domain/receipts/receipt-service.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, notFound } from '@onengo/kernel/errors';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import type { RecordService, RecordView } from '../../runtime/records/record-service.js';
import type { ReceiptLinkService } from './receipt-link.js';

export interface ReceiptPrint {
  receipt: Receipt;
  series: { key: string; label: string; prefix: string };
  /** As the person may see it: restricted records need access and sensitive fields stay masked. */
  record: RecordView;
  recordType: { key: string; label: string; titleField: string | null };
  /** The issuer's display name. */
  organisation: { name: string };
  /** `logoUrl` and `signatoryImageUrl` are same-origin addresses that need the person's sign-in. */
  issuer: IssuerSnapshot & { logoUrl: string | null; signatoryImageUrl: string | null };
  /** `issued`: as kept when the receipt was issued; `current`: the receipt predates issuer snapshots. */
  issuerSource: 'issued' | 'current';
  /** The public path, when this receipt has a live link. */
  publicLink: string | null;
  /** Wording kept when the receipt was issued. Null when the receipt predates layouts. */
  content: ReceiptContent | null;
}

const issuerLogoUrl = (fileId: string) => `/api/organisation/logos/${fileId}`;
const signatoryImageUrl = (fileId: string, receiptId: string) => `/api/organisation/signatories/${fileId}?receipt=${receiptId}`;

/** What the browser print view of a receipt needs. Only someone who can run Print receipt may open it. */
export class ReceiptPrintService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly defs: DefinitionService,
    private readonly records: RecordService,
    private readonly receipts: ReceiptService,
    private readonly links: Pick<ReceiptLinkService, 'currentPath' | 'mayPublish'>,
  ) {}

  async receipt(ctx: TenantContext, id: string): Promise<ReceiptPrint> {
    const receipt = await this.transactions.withTenant(ctx.tenantId, (tx) => this.receipts.get(tx, id));
    if (!receipt?.recordId) throw notFound('Receipt not found.');
    const record = await this.records.get(ctx, receipt.recordId);
    if (!(await this.links.mayPublish(ctx, record.type))) throw forbidden('You cannot print this receipt.');
    const type = (await this.defs.get(ctx.tenantId, 'recordType', record.type))?.body;
    const { series, kept, current, publicLink, content } = await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const kept = await this.receipts.issuer(tx, receipt.id);
      const found = await this.receipts.series(tx, receipt.seriesKey);
      return {
        series: found && { key: found.key, label: found.label, prefix: found.prefix },
        kept,
        current: kept ? undefined : await this.receipts.currentIssuer(tx, receipt.date),
        publicLink: await this.links.currentPath(tx, receipt.id),
        content: (await this.receipts.content(tx, receipt.id)) ?? null,
      };
    });
    const issuer = (kept ?? current)!;
    return {
      receipt,
      series: series ?? { key: receipt.seriesKey, label: receipt.seriesKey, prefix: '' },
      record,
      recordType: { key: record.type, label: type?.label ?? record.type, titleField: type?.titleField ?? null },
      organisation: { name: issuer.displayName },
      issuer: {
        ...issuer,
        signatory: issuer.signatory ?? null,
        logoUrl: issuer.logo ? issuerLogoUrl(issuer.logo.fileId) : null,
        signatoryImageUrl: issuer.signatory?.file ? signatoryImageUrl(issuer.signatory.file.fileId, receipt.id) : null,
      },
      issuerSource: kept ? 'issued' : 'current',
      publicLink,
      content,
    };
  }

  /** The signature image a receipt shows, for someone who can read its record; null when it shows none. */
  async signatureFile(ctx: TenantContext, id: string): Promise<string | null> {
    const receipt = await this.transactions.withTenant(ctx.tenantId, (tx) => this.receipts.get(tx, id));
    if (!receipt?.recordId) throw notFound('Receipt not found.');
    await this.records.get(ctx, receipt.recordId);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const issuer = (await this.receipts.issuer(tx, receipt.id)) ?? (await this.receipts.currentIssuer(tx, receipt.date));
      return issuer.signatory?.file?.fileId ?? null;
    });
  }
}
