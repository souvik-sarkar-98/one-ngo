import type { FormValue, FormValues } from '../core/records/record/forms';
import type { FilterSpec } from '../core/records/spec';
import type { Criteria } from '../core/records/list/url';

/** Filter values as the filter panel shows them. */
export function criteriaToSheetValues(specs: FilterSpec[], c: Criteria): FormValues {
  const v: FormValues = {};
  for (const { field, kind } of specs) {
    const k = field.key;
    if (kind === 'list') v[k] = (c[k] as string[] | undefined) ?? [];
    else if (kind === 'flag') v[k] = c[k] === true ? 'yes' : c[k] === false ? 'no' : '';
    else if (kind === 'dateRange') {
      v[`${k}From`] = (c[`${k}From`] as string | undefined) ?? '';
      v[`${k}To`] = (c[`${k}To`] as string | undefined) ?? '';
    } else if (kind === 'range') {
      v[`${k}From`] = (c[`${k}From`] as string | undefined) ?? '';
      v[`${k}To`] = (c[`${k}To`] as string | undefined) ?? '';
    } else v[k] = (c[k] as string | undefined) ?? '';
  }
  return v;
}

export function sheetValuesToCriteria(specs: FilterSpec[], values: FormValues): Criteria {
  const c: Criteria = {};
  const text = (x: FormValue | undefined) => (typeof x === 'string' ? x.trim() : '');
  for (const { field, kind } of specs) {
    const k = field.key;
    const val = values[k];
    if (kind === 'list' && Array.isArray(val) && val.length) c[k] = [...val];
    if (kind === 'flag' && (val === 'yes' || val === 'no')) c[k] = val === 'yes';
    if (kind === 'text' && text(val)) c[k] = text(val);
    if (kind === 'range' || kind === 'dateRange') {
      if (text(values[`${k}From`])) c[`${k}From`] = text(values[`${k}From`]);
      if (text(values[`${k}To`])) c[`${k}To`] = text(values[`${k}To`]);
    }
  }
  return c;
}
