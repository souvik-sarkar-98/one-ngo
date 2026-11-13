import { t } from '../i18n/i18n';
import type { BuilderDetail, DefinitionKind } from '../models';
import type { DetailSection } from '../records/record/present';
import { kindName } from '../starters';

type Body = Record<string, unknown>;

const isObject = (v: unknown): v is Body => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A property name as words: `pluralLabel` → "Plural label". */
export function humanise(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function value(v: unknown): string {
  if (typeof v === 'boolean') return t(v ? 'ui.common.yes' : 'ui.common.no');
  if (Array.isArray(v)) return v.map((i) => (isObject(i) ? '…' : String(i))).join(', ');
  if (isObject(v)) return Object.keys(v).map(humanise).join(', ') || '—';
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

const itemTitle = (i: Body, n: number) => String(i['label'] || i['key'] || i['id'] || i['type'] || n + 1);

/**
 * A definition, read-only, as sections: what it is and where it comes from,
 * its settings, and one list per table in it (fields, states, steps…).
 */
export function summarySections(kind: DefinitionKind, key: string, detail: BuilderDetail | null, body: Body | null): DetailSection[] {
  const about: { label: string; value: string }[] = [
    { label: t('ui.builder.kindLabel'), value: kindName(kind) },
    { label: t('ui.builder.key'), value: key },
    { label: t('ui.builder.catalogue.from'), value: detail?.shipped ? t('ui.builder.catalogue.module') : t('ui.builder.catalogue.fromOrganisation') },
    { label: t('ui.builder.published'), value: detail?.published ? t('ui.common.version', { version: detail.published.version }) : '—' },
  ];
  if (detail?.draft) about.push({ label: t('ui.builder.draft'), value: t('ui.common.version', { version: detail.draft.version }) });
  const sections: DetailSection[] = [{ kind: 'fields', id: 'about', title: t('ui.builder.summary.about'), fields: about }];
  if (!body) return sections;
  const settings: { label: string; value: string }[] = [];
  for (const [name, v] of Object.entries(body)) {
    if (name === 'key') continue;
    if (Array.isArray(v) && v.length && v.every(isObject)) {
      sections.push({
        kind: 'items',
        id: name,
        title: humanise(name),
        items: (v as Body[]).map((i, n) => ({ id: `${name}-${n}`, title: itemTitle(i, n), ...(typeof i['type'] === 'string' && !!i['label'] ? { subtitle: i['type'] } : {}) })),
      });
    } else settings.push({ label: humanise(name), value: value(v) });
  }
  if (settings.length) sections.splice(1, 0, { kind: 'fields', id: 'settings', title: t('ui.builder.summary.settings'), fields: settings });
  return sections;
}
