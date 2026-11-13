import { displayValue } from '../../fields/fields';
import { t } from '../../i18n/i18n';
import type { RecordQueryBody, RecordView } from '../../models';
import { asGatewayError, type RecordsGateway } from '../gateway/gateway';
import { recordTitle, rowModel, showValue, type DetailSection } from './present';
import type { ListSpec, RelatedSpec } from '../spec';

export const RELATED_LIMIT = 10;

/** A related section as loaded for one record: how many there are, their total, and the latest few. */
export interface RelatedSection extends RelatedSpec {
  count: number;
  sum?: number;
  items: RecordView[];
  error: string;
}

/** The query for the records of a related section that point at record `id`, newest first. */
export function relatedQuery(section: RelatedSpec, id: string): { recordType: string; body: RecordQueryBody } {
  return {
    recordType: section.recordType,
    body: {
      filters: { [section.field]: { in: [id] } },
      sort: { field: 'createdAt', dir: 'desc' },
      limit: RELATED_LIMIT,
      sum: section.total ? [section.total] : [],
    },
  };
}

/** Loads every related section of a record. A section that fails is empty with its error; the others still show. */
export function loadRelated(gateway: RecordsGateway, spec: ListSpec, id: string): Promise<RelatedSection[]> {
  return Promise.all(
    spec.related.map(async (section): Promise<RelatedSection> => {
      const { recordType, body } = relatedQuery(section, id);
      try {
        const res = await gateway.query(recordType, body);
        return { ...section, count: res.total, sum: section.total ? (res.sums?.[section.total] ?? 0) : undefined, items: res.items, error: '' };
      } catch (e) {
        return { ...section, count: 0, items: [], error: asGatewayError(e, t('ui.records.loadRelatedFailed')).message };
      }
    }),
  );
}

/** The detail section id of a related section, so a tapped row can be told apart from receipts. */
export const relatedSectionId = (section: RelatedSpec) => `related:${section.id}`;

/**
 * Related sections as the detail draws them: "Donations · 3 · ₹8,500.00",
 * then the latest records by number (or title), with the total field and the
 * status. Each row opens in its own list.
 */
export function relatedDetail(sections: RelatedSection[], specOf: (type: string) => ListSpec | null): DetailSection[] {
  return sections.map((s) => {
    const spec = specOf(s.recordType);
    const totalField = s.total ? spec?.type.fields.find((f) => f.key === s.total) : undefined;
    const total = s.sum !== undefined ? (totalField ? displayValue(totalField, s.sum) : String(s.sum)) : '';
    return {
      kind: 'items',
      id: relatedSectionId(s),
      title: total ? t('ui.records.relatedTitleTotal', { label: s.label, count: s.count, total }) : t('ui.records.relatedTitle', { label: s.label, count: s.count }),
      selectable: true,
      note: s.error || undefined,
      items: s.items.map((r) => {
        if (!spec) return { id: r.id, title: r.number ?? r.id };
        const row = rowModel(spec, r);
        const value = s.total ? showValue(spec.type, spec.workflow, r, s.total) : row.subtitle;
        return { id: r.id, title: r.number ?? row.title, subtitle: value && value !== '—' ? value : undefined, badge: row.badge };
      }),
    };
  });
}

/** "New donation for Ravi": a related type the person may create, opened with this record already chosen through a preset. */
export interface RelatedCreate {
  id: string;
  label: string;
  recordType: string;
  presets: Record<string, string>;
}

/** The "New … for this record" actions of a record's related sections; only types with a preset for the pointing field. */
export function relatedCreates(spec: ListSpec, record: RecordView, specOf: (type: string) => ListSpec | null): RelatedCreate[] {
  return spec.related.flatMap((s) => {
    const other = specOf(s.recordType);
    const preset = other?.presets.find((p) => p.field === s.field);
    if (!other?.type.canCreate || !preset) return [];
    return [
      {
        id: s.id,
        label: t('ui.records.newFor', { type: other.type.label.toLowerCase(), title: recordTitle(spec, record) }),
        recordType: s.recordType,
        presets: { [preset.param]: record.id },
      },
    ];
  });
}
