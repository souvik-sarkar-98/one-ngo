export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

/** One row as every list draws it, whatever it lists: records, approvals, definitions, members. */
export interface RowView {
  id: string;
  title: string;
  subtitle?: string;
  /** Further lines a card shows under the subtitle. */
  lines?: string[];
  meta?: string;
  badge?: { label: string; tone: Tone };
  /** Dimmed, as a notification already read. */
  muted?: boolean;
  cells: { key: string; label: string; value: string }[];
  /** Badges an editable table draws in a column instead of its cell value, by column key. */
  cellBadges?: Record<string, { label: string; tone: Tone }[]>;
  /** Row menu entries, or the row's buttons when a list shows them inline; `divider` starts a new group. */
  actions: { id: string; label: string; divider?: boolean; tone?: Tone }[];
}
