import { t } from '../i18n/i18n';

export interface GroupBody {
  key: string;
  label: string;
  order?: number;
  recordTypes: string[];
}

export interface GroupPreview {
  key: string;
  label: string;
  /** The group being edited. */
  current: boolean;
  recordTypes: { key: string; label: string }[];
  /** Record types of this group that show in an earlier group instead. */
  shownElsewhere: { key: string; label: string; group: string }[];
}

const asGroup = (b: Record<string, unknown>): GroupBody => ({
  key: String(b['key'] ?? ''),
  label: typeof b['label'] === 'string' ? b['label'] : '',
  ...(typeof b['order'] === 'number' ? { order: b['order'] } : {}),
  recordTypes: Array.isArray(b['recordTypes']) ? b['recordTypes'].filter((x): x is string => typeof x === 'string') : [],
});

/**
 * The Records screen as it would look with the draft group published: groups by
 * order then label, each record type in the first group that lists it, and the
 * rest under "Other" (the server's rule).
 */
export function previewRecordGroups(published: GroupBody[], draft: Record<string, unknown>, types: { key: string; label: string }[]): GroupPreview[] {
  const mine = asGroup(draft);
  const groups = [...published.filter((g) => g.key !== mine.key), mine].sort(
    (a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.label.localeCompare(b.label),
  );
  const label = new Map(types.map((x) => [x.key, x.label || x.key]));
  const placed = new Map<string, string>();
  const out: GroupPreview[] = [];
  for (const g of groups) {
    const current = g.key === mine.key;
    const own = g.recordTypes.filter((k) => label.has(k) && !placed.has(k));
    const shownElsewhere = current ? g.recordTypes.filter((k) => placed.has(k)).map((k) => ({ key: k, label: label.get(k)!, group: placed.get(k)! })) : [];
    for (const k of own) placed.set(k, g.label || g.key);
    if (own.length || current) out.push({ key: g.key, label: g.label || g.key, current, recordTypes: own.map((k) => ({ key: k, label: label.get(k)! })), shownElsewhere });
  }
  const other = types.filter((x) => !placed.has(x.key));
  if (other.length) out.push({ key: 'other', label: t('ui.records.otherGroup'), current: false, recordTypes: other.map((x) => ({ key: x.key, label: x.label || x.key })), shownElsewhere: [] });
  return out;
}
