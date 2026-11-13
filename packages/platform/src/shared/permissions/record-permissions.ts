import type { RecordTypeDef } from '../definitions/types.js';

export type SharingPermission = 'read:all' | 'share';

/**
 * The "See all" and "Share" permissions of each restricted record type,
 * sorted by record type key, for permission catalogues. Other record types
 * are visible to everyone who may read them, so they have neither.
 */
export function sharingPermissionsByType(types: Pick<RecordTypeDef, 'key' | 'visibility'>[]): Record<string, { key: SharingPermission; permission: string }[]> {
  const out: Record<string, { key: SharingPermission; permission: string }[]> = {};
  for (const t of [...types].sort((a, b) => a.key.localeCompare(b.key))) {
    if (t.visibility !== 'restricted') continue;
    out[t.key] = (['read:all', 'share'] as const).map((key) => ({ key, permission: `record:${t.key}:${key}` }));
  }
  return out;
}

/** The "Bulk operations" permission of every record type, sorted by record type key, for permission catalogues. */
export function bulkPermissionsByType(types: Pick<RecordTypeDef, 'key'>[]): Record<string, string> {
  return Object.fromEntries([...types].sort((a, b) => a.key.localeCompare(b.key)).map((t) => [t.key, `record:${t.key}:bulk`]));
}
