import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import type { FieldDef, RecordTypeDef } from '../../definitions/types.js';
import type { InternalTransitionOptions, SaveResult } from '../../records/ports/record-result.js';

/** The record operations approving a request needs; the record engine implements them. */
export interface ApprovalRecords {
  transition(
    ctx: TenantContext,
    id: string,
    transitionKey: string,
    input: { data?: Record<string, unknown>; expectedVersion: number },
    internal?: InternalTransitionOptions,
  ): Promise<SaveResult>;
  /** Record data as read from the database, its sensitive values decrypted. */
  openData(tenantId: string, typeKey: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  readonly sensitive: { openValue(type: RecordTypeDef, f: FieldDef, value: unknown): unknown };
}
