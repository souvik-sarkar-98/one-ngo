import { moveItem } from '../ui-logic/reorder';
import { isIconName } from '@onengo/platform/icons';
import { defaultNavigationKeys, defaultNavIcon } from '../shell/shell';
import type { Me, RuntimeDefinitions } from '../models';

export interface LayoutDraft {
  /** Destinations in the order every screen follows. */
  items: string[];
  /** Icons that differ from each destination's own. */
  icons: Partial<Record<string, string>>;
  listLayout: 'cards' | 'table';
}

const FIXED = ['home', 'records', 'inbox', 'admin', 'builder', 'guide', 'settings', 'signout'];

function pageKeys(defs: RuntimeDefinitions | null): string[] {
  return (defs?.pages ?? []).map((page) => `page:${page.key}`);
}

/** The published order, or the app's own, with the fixed destinations present and record lists left out unless already chosen. */
export function startingLayout(me: Me | null, defs: RuntimeDefinitions | null): LayoutDraft {
  const published = defs?.navigation;
  const fallback = defaultNavigationKeys(me, defs);
  const base = published?.items.length ? [...published.items] : [...fallback];
  const items: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (key === 'people' || seen.has(key)) return;
    seen.add(key);
    items.push(key);
  };
  for (const key of base) {
    if (key.startsWith('record:')) {
      const typeKey = key.slice('record:'.length);
      if (defs && !defs.recordTypes.some((type) => type.key === typeKey)) continue;
    }
    push(key);
  }
  for (const key of [...FIXED, ...pageKeys(defs)]) push(key);
  if (!seen.has('home')) items.unshift('home');

  const icons: Partial<Record<string, string>> = {};
  for (const [key, value] of Object.entries(published?.icons ?? {})) {
    if (!items.includes(key) || !isIconName(value) || value === defaultNavIcon(key)) continue;
    icons[key] = value;
  }
  return { items, icons, listLayout: defs?.listLayout ?? 'table' };
}

/** Moves one card. An index outside the list leaves the order as it is. */
export function reorderItems(draft: LayoutDraft, from: number, to: number): LayoutDraft {
  return { ...draft, items: moveItem(draft.items, from, to) };
}

/** Adds one record list at the end. Anything else, or a list already present, is left out. */
export function addRecordItem(draft: LayoutDraft, key: string): LayoutDraft {
  if (!key.startsWith('record:') || draft.items.includes(key)) return draft;
  return { ...draft, items: [...draft.items, key] };
}

/** Removes one record list. Home and the other fixed destinations stay. */
export function removeRecordItem(draft: LayoutDraft, key: string): LayoutDraft {
  if (!key.startsWith('record:') || !draft.items.includes(key)) return draft;
  const icons = { ...draft.icons };
  delete icons[key];
  return { ...draft, items: draft.items.filter((item) => item !== key), icons };
}

/** Remembers an icon, or forgets it when it is the destination's own. */
export function setItemIcon(draft: LayoutDraft, key: string, icon: string): LayoutDraft {
  if (!draft.items.includes(key) || !isIconName(icon)) return draft;
  const icons = { ...draft.icons };
  if (icon === defaultNavIcon(key)) delete icons[key];
  else icons[key] = icon;
  return { ...draft, icons };
}

/** The body Administration publishes: one ordered list of destinations. */
export function toPublished(draft: LayoutDraft): { items: string[]; listLayout: 'cards' | 'table'; icons?: Record<string, string> } {
  const icons: Record<string, string> = {};
  for (const [key, icon] of Object.entries(draft.icons)) if (icon) icons[key] = icon;
  return {
    items: [...draft.items],
    listLayout: draft.listLayout,
    ...(Object.keys(icons).length ? { icons } : {}),
  };
}
