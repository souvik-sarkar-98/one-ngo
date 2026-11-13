import { validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { Tx } from '../../domain/ports/transaction.js';
import { isIconName } from './icon-names.js';
import type { ThemeDef } from './types.js';

/** The one theme an organisation publishes for the whole app. */
export const ORGANISATION_THEME = 'organisation';
/** Where the navigation order, chosen icons and the starting list layout are kept. */
export const LAYOUT_SETTING = 'appearance.layout';

/** Reads one organisation setting inside its tenant transaction. */
export interface SettingReader {
  setting(tx: Tx, key: string): Promise<unknown>;
}

export interface AppearanceLayout {
  /** Destinations in the order every screen follows. The shell adds More only when they do not fit. */
  items: string[];
  /** Where a wide-screen list opens before a person chooses. Phones stay on cards. */
  listLayout: 'cards' | 'table';
  /** Icon chosen for a destination. A missing key keeps that destination's own icon. */
  icons?: Record<string, string>;
}

const SLOT = /^(home|records|inbox|reports|people|admin|builder|guide|settings|signout|record:[a-z][a-zA-Z0-9_-]{0,62}|page:[a-z][a-zA-Z0-9_-]{0,62})$/;
const THEME_FIELDS = ['label', 'brand', 'brandForeground', 'background', 'surface', 'text', 'muted', 'line', 'radius'] as const;

/** The stored layout, or null when nothing has been published or the stored value cannot be read. */
export function readLayout(value: unknown): AppearanceLayout | null {
  if (value == null) return null;
  try {
    return layoutOf(value);
  } catch {
    return null;
  }
}

/** Checks a layout. Home stays in the order, nothing is listed twice, and each icon belongs to a listed destination. */
export function layoutOf(value: unknown): AppearanceLayout {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const issues: FieldIssue[] = [];
  if ('more' in raw) issues.push({ path: 'more', message: 'Navigation is one list.' });
  if ('primary' in raw) issues.push({ path: 'primary', message: 'Navigation is one list.' });
  const listed = raw.items;
  const items = Array.isArray(listed) && listed.every((item) => typeof item === 'string' && SLOT.test(item)) ? listed : null;
  if (!items) issues.push({ path: 'items', message: 'Choose destinations, record lists and pages.' });
  const listLayout = raw.listLayout === 'cards' || raw.listLayout === 'table' ? raw.listLayout : null;
  if (!listLayout) issues.push({ path: 'listLayout', message: 'Choose cards or table.' });
  const order = items ?? [];
  if (items && !items.includes('home')) issues.push({ path: 'items', message: 'Home stays in the navigation.' });
  if (items && new Set(items).size !== items.length) issues.push({ path: 'items', message: 'Each item is listed once.' });
  const placed = new Set(order);
  let icons: Record<string, string> | undefined;
  if (raw.icons !== undefined) {
    const bag = raw.icons;
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) {
      issues.push({ path: 'icons', message: 'Choose an icon for a listed destination.' });
    } else {
      const chosen: Record<string, string> = {};
      for (const [key, icon] of Object.entries(bag)) {
        if (!placed.has(key) || typeof icon !== 'string' || !isIconName(icon)) {
          issues.push({ path: 'icons', message: 'Choose an icon for a listed destination.' });
          break;
        }
        chosen[key] = icon;
      }
      if (Object.keys(chosen).length) icons = chosen;
    }
  }
  if (issues.length) throw validationFailed('The layout is not valid.', issues);
  return { items: items!, listLayout: listLayout!, ...(icons ? { icons } : {}) };
}

/** The organisation theme, with blank tokens left out so the stylesheet shows through. */
export function themeOf(value: unknown): ThemeDef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationFailed('The theme is not valid.');
  const raw = value as Record<string, unknown>;
  if (raw.key !== undefined && raw.key !== ORGANISATION_THEME) {
    throw validationFailed('The organisation theme is named organisation.', [{ path: 'key', message: 'Use organisation.' }]);
  }
  const out: Record<string, string> = { key: ORGANISATION_THEME };
  for (const key of THEME_FIELDS) {
    const item = raw[key];
    if (item === undefined || item === '') continue;
    if (typeof item !== 'string') throw validationFailed('The theme is not valid.', [{ path: key, message: 'Must be text.' }]);
    const text = item.trim();
    if (text) out[key] = text;
  }
  return out as unknown as ThemeDef;
}
