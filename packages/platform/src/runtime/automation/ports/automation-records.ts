import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import type { InternalTransitionOptions, SaveResult } from '../../records/ports/record-result.js';

/** The record saves an automation action or a record action step performs; the record engine implements them. */
export interface ActionRecords {
  create(ctx: TenantContext, typeKey: string, input: Record<string, unknown>): Promise<SaveResult>;
  update(ctx: TenantContext, id: string, input: { data: Record<string, unknown>; expectedVersion: number }): Promise<SaveResult>;
  transition(
    ctx: TenantContext,
    id: string,
    transitionKey: string,
    input: { data?: Record<string, unknown>; expectedVersion: number },
    internal?: InternalTransitionOptions,
  ): Promise<SaveResult>;
}

/** The record operations the automation engine needs: the saves above and reading stored record data. */
export interface AutomationRecords extends ActionRecords {
  /** Record data as read from the database, its sensitive values decrypted. */
  openData(tenantId: string, typeKey: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
}
