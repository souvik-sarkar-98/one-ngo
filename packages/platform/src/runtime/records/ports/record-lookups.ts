import type { FieldIssue } from '@onengo/kernel/errors';

/** The scalar values a lookup connector's responseMap read, by response key, or why it could not. */
export type RecordLookupResult = { values: Record<string, string | number | boolean | null> } | { issues: FieldIssue[] };

/**
 * What a record save uses to fill fields from a lookup connector. Calls go out
 * over HTTP, so they are made with no transaction open; composition injects the connector service.
 */
export interface RecordLookups {
  lookup(tenantId: string, key: string, binding: { record: Record<string, unknown>; recordId?: string | null }): Promise<RecordLookupResult>;
}
