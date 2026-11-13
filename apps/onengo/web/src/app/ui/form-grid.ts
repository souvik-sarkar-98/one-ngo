import type { FormColumns } from '../core/models';

/**
 * The columns a form is drawn with: one on a phone whatever the form asks for,
 * otherwise the count its list view or action sets (one when it sets none).
 */
export function drawnColumns(columns: FormColumns | undefined, narrow: boolean): FormColumns {
  return narrow ? 1 : (columns ?? 1);
}
