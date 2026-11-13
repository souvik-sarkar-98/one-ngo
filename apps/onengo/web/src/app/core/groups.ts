import { lowerLabel, t } from './i18n/i18n';
import type { RuntimeDefinitions } from './models';
import { plural, recordGroups } from './shell/shell';

/** Above this many record types the Records screen offers a search box. */
export const SEARCH_FROM = 9;

const listLink = (key: string) => `/records/${encodeURIComponent(key)}`;

/** One record group as a Home card: its record types, each with "New" when the person can create. No counts. */
export interface GroupCard {
  key: string;
  label: string;
  items: { label: string; to: string; create?: { label: string; to: string } }[];
}

export function homeGroups(defs: RuntimeDefinitions | null): GroupCard[] {
  return recordGroups(defs).map((g) => ({
    key: g.key,
    label: g.label,
    items: g.types.map((x) => ({
      label: plural(x),
      to: listLink(x.key),
      ...(x.canCreate ? { create: { label: t('ui.records.new', { type: lowerLabel(x.label) }), to: `${listLink(x.key)}?create=new` } } : {}),
    })),
  }));
}

export interface RecordsSection {
  key: string;
  label: string;
  collapsed: boolean;
  types: { key: string; label: string; hint?: string; link: string }[];
}

export interface RecordsModel {
  /** Whether the search box is shown: more than eight record types. */
  search: boolean;
  sections: RecordsSection[];
  /** Nothing matches the search. */
  empty: boolean;
}

/**
 * The Records screen: a section per record group, collapsed as the person
 * left it. While searching, matching record types show in open sections and
 * groups with no match are hidden. No counts.
 */
export function recordsModel(defs: RuntimeDefinitions | null, query: string, collapsed: ReadonlySet<string>): RecordsModel {
  const groups = recordGroups(defs);
  const search = groups.reduce((n, g) => n + g.types.length, 0) >= SEARCH_FROM;
  const q = search ? query.trim().toLocaleLowerCase() : '';
  const sections = groups
    .map((g) => ({
      key: g.key,
      label: g.label,
      collapsed: !q && collapsed.has(g.key),
      types: g.types
        .filter((x) => !q || [x.label, x.pluralLabel, x.description, g.label].some((v) => v?.toLocaleLowerCase().includes(q)))
        .map((x) => ({ key: x.key, label: plural(x), ...(x.description ? { hint: x.description } : {}), link: listLink(x.key) })),
    }))
    .filter((s) => s.types.length);
  return { search, sections, empty: !!q && !sections.length };
}

/** Where the collapsed groups are kept: local storage in the app, a map in tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The groups a person collapsed on the Records screen, kept on the device per organisation. */
export class CollapsedGroups {
  private readonly key: string;
  private keys: Set<string>;

  constructor(
    private readonly store: KeyValueStore,
    tenant: string,
    area = 'groups',
  ) {
    this.key = `ngo.${area}.collapsed.${tenant}`;
    this.keys = new Set(this.read());
  }

  get value(): ReadonlySet<string> {
    return this.keys;
  }

  toggle(group: string): ReadonlySet<string> {
    const next = new Set(this.keys);
    if (!next.delete(group)) next.add(group);
    this.keys = next;
    try {
      this.store.setItem(this.key, JSON.stringify([...next]));
    } catch {
      // Storage full or blocked: the choice lasts until the screen closes.
    }
    return next;
  }

  private read(): string[] {
    try {
      const v: unknown = JSON.parse(this.store.getItem(this.key) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
}
