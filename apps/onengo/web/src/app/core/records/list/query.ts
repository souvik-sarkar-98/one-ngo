import type { FieldFilter, RecordQueryBody } from '../../models';
import type { FilterSpec, ListSpec } from '../spec';
import type { Criteria, ListState } from './url';

const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

/** Converts list criteria into the query API's field filters. */
export function criteriaToFilters(specs: FilterSpec[], criteria: Criteria): Record<string, FieldFilter> {
  const out: Record<string, FieldFilter> = {};
  for (const { field, kind } of specs) {
    const k = field.key;
    if (kind === 'list' && present(criteria[k])) out[k] = { in: (criteria[k] as string[]).map(String) };
    if (kind === 'flag' && typeof criteria[k] === 'boolean') out[k] = { eq: criteria[k] };
    if (kind === 'text' && present(criteria[k])) out[k] = { in: [String(criteria[k])] };
    if ((kind === 'range' || kind === 'dateRange') && (present(criteria[`${k}From`]) || present(criteria[`${k}To`]))) {
      const conv = (v: unknown) => (present(v) ? (kind === 'range' ? Number(v) : String(v)) : null);
      out[k] = { from: conv(criteria[`${k}From`]), to: conv(criteria[`${k}To`]) };
    }
  }
  return out;
}

/** Combines field filters. A later filter on the same field narrows it and keeps the earlier operators. */
export function mergeFieldFilters(
  base: Record<string, FieldFilter> | undefined,
  extra: Record<string, FieldFilter> | undefined,
): Record<string, FieldFilter> {
  const out: Record<string, FieldFilter> = { ...(base ?? {}) };
  for (const [key, filter] of Object.entries(extra ?? {})) out[key] = out[key] ? { ...out[key], ...filter } : filter;
  return out;
}

/** The query for one page of the list. */
export function queryBody(spec: ListSpec, state: ListState, offset: number, limit: number): RecordQueryBody {
  const chip = spec.chips.find((c) => c.id === state.chip);
  return {
    statusIn: chip?.statusIn,
    owner: chip?.owner,
    ...(chip?.sharedWithMe ? { sharedWithMe: true as const } : {}),
    search: state.q.trim() || undefined,
    filters: mergeFieldFilters(chip?.filters, criteriaToFilters(spec.filters, state.criteria)),
    sort: state.sort,
    limit,
    offset,
  };
}
