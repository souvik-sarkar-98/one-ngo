import type { RecordGroupDef } from './types.js';

export interface ResolvedRecordGroup {
  key: string;
  label: string;
  recordTypes: string[];
}

/**
 * Groups for one person: ordered by `order` then label, limited to the record
 * types they can read, each type in its first group only, empty groups left
 * out, and readable types in no group listed last under Other.
 */
export function resolveRecordGroups(groups: RecordGroupDef[], readable: string[]): ResolvedRecordGroup[] {
  const allowed = new Set(readable);
  const placed = new Set<string>();
  const out: ResolvedRecordGroup[] = [];
  const sorted = [...groups].sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.label.localeCompare(b.label));
  for (const g of sorted) {
    const recordTypes = g.recordTypes.filter((t) => allowed.has(t) && !placed.has(t));
    recordTypes.forEach((t) => placed.add(t));
    if (recordTypes.length) out.push({ key: g.key, label: g.label, recordTypes });
  }
  const other = readable.filter((t) => !placed.has(t));
  if (other.length) out.push({ key: 'other', label: 'Other', recordTypes: other });
  return out;
}
