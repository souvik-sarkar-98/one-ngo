import { t } from '../i18n/i18n';
import type { DefinitionKind } from '../models';
import { directoryTrail, type Crumb } from '@onengo/web-kit';
import type { EditorAddress } from './address';
import { builderPlace, kindsName } from './catalogue';

export type { Crumb };

type Body = Record<string, unknown>;

const items = (v: unknown): Body[] => (Array.isArray(v) ? v.filter((i): i is Body => !!i && typeof i === 'object') : []);
const named = (list: Body[], id: string, ...keys: string[]) => list.find((i) => keys.some((k) => i[k] === id));
const labelOf = (item: Body | undefined, fallback: string) => (typeof item?.['label'] === 'string' && item['label'] ? item['label'] : fallback);

/**
 * The last breadcrumb item of an editor: the selected field, step or section
 * by its label (falling back to its key), the create form, or the tab when it
 * is not the Visual tab. Null when nothing is selected on the Visual tab.
 */
export function selectionLabel(body: Body | null, a: EditorAddress): string | null {
  if (a.tab !== 'visual') return t(`ui.builder.tabs.${a.tab}`);
  if (a.field) return t('ui.builder.crumb.field', { label: labelOf(named(items(body?.['fields']), a.field, 'key'), a.field) });
  if (a.step) return t('ui.builder.crumb.step', { label: labelOf(named(items(body?.['transitions']), a.step, 'key'), a.step) });
  if (a.section) {
    const detail = body?.['detail'] as Body | undefined;
    return t('ui.builder.crumb.section', { label: labelOf(named(items(detail?.['sections']), a.section, 'id', 'label'), a.section) });
  }
  if (a.widget) {
    const w = items(body?.['widgets'])[Number(a.widget)];
    if (w) return t('ui.builder.crumb.widget', { label: labelOf(w, t(`ui.builder.page.type.${String(w['type'])}`)) });
  }
  if (a.create) return t('ui.builder.crumb.createForm');
  return null;
}

/**
 * The Builder's breadcrumb trail: Builder, the home group, the kind, the
 * definition, then the tab or selection. Every item but the last links.
 */
export function builderTrail(kind?: DefinitionKind, key?: string, definition?: string, selection?: string | null): Crumb[] {
  const place = kind ? builderPlace(kind) : undefined;
  const page = kind ? (place ? t(place.row.labelKey) : kindsName(kind)) : '';
  const rest = [
    ...(kind ? [{ label: page, href: place?.row.href ?? `/builder?kind=${kind}` }] : []),
    ...(kind && key ? [{ label: definition || key, href: `/builder/${encodeURIComponent(kind)}/${encodeURIComponent(key)}` }] : []),
    ...(selection ? [{ label: selection }] : []),
  ];
  return directoryTrail(
    { label: t('ui.builder.title'), href: rest.length ? '/builder' : undefined },
    place ? { label: t(place.group.labelKey), href: `/builder#builder-${place.group.id}` } : null,
    rest,
  );
}
