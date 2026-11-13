import type { TenantContext } from '../../domain/ports/tenant-context.js';
import type { ShareCandidate, ShareInput, ShareService, ShareView } from '../../runtime/records/shares.js';
import type { RecordNotifier } from './ports/record-notifier.js';

/**
 * Sharing a restricted record: the record runtime keeps the shares, and this
 * use case tells the person or role who has just been given access.
 */
export class RecordSharing {
  constructor(
    private readonly shares: ShareService,
    private readonly notifications: RecordNotifier,
  ) {}

  list(ctx: TenantContext, typeKey: string, recordId: string): Promise<ShareView[]> {
    return this.shares.list(ctx, typeKey, recordId);
  }

  /** Adds a share, or changes the access and end of an existing one for the same person or role. */
  async share(ctx: TenantContext, typeKey: string, recordId: string, input: ShareInput): Promise<ShareView> {
    const { shareId, notice } = await this.shares.apply(ctx, typeKey, recordId, input);
    if (notice) await this.notifications.notifyText(ctx.tenantId, await this.shares.message(ctx, notice));
    return this.shares.viewOf(ctx, typeKey, recordId, shareId);
  }

  candidates(ctx: TenantContext, typeKey: string, recordId: string, query: { q?: unknown }): Promise<{ items: ShareCandidate[] }> {
    return this.shares.candidates(ctx, typeKey, recordId, query);
  }

  remove(ctx: TenantContext, typeKey: string, recordId: string, shareId: string): Promise<void> {
    return this.shares.remove(ctx, typeKey, recordId, shareId);
  }
}
