import type { RecordView, RuntimeAction } from '../../models';
import type { RowView } from '../../rows';
import { actionMenu, actionNeedsPanel, recordActions } from '../record/actions';
import type { Viewer } from '../record/forms';
import { rowModel } from '../record/present';
import { labelOf, type ListSpec } from '../spec';
import type { PanelMode } from './url';

export interface ColumnModel {
  key: string;
  label: string;
  sortable: boolean;
}

/** The table's columns: all of them on desktops, the compact ones on tablets. Sortable headers write the same sort as the Sort menu. */
export function tableColumns(spec: ListSpec, wide: boolean): ColumnModel[] {
  const sortable = new Set(spec.sortable);
  return (wide ? spec.columns : spec.compactColumns).map((key) => ({ key, label: labelOf(spec.type, key), sortable: sortable.has(key) }));
}

/** A record as a row. Its menu holds edit, the allowed steps, then the configured row actions. */
export function recordRow(spec: ListSpec, record: RecordView, viewer: Viewer, chip?: string): RowView {
  const { record: _record, ...row } = rowModel(spec, record);
  return { ...row, actions: actionMenu(recordActions(spec, record, viewer, chip), 'row') };
}

/** What a row menu entry does: open the record in a panel mode, or run a configured action at once. */
export type RowIntent = { panel: PanelMode } | { run: RuntimeAction };

export function rowIntent(spec: ListSpec, entry: string): RowIntent | null {
  if (entry === 'edit') return { panel: { kind: 'edit' } };
  if (entry.startsWith('step:') && entry.length > 5) return { panel: { kind: 'step', step: entry.slice(5) } };
  if (entry.startsWith('action:')) {
    const action = spec.actions.find((a) => a.key === entry.slice(7));
    if (!action) return null;
    return actionNeedsPanel(action) ? { panel: { kind: 'action', action: action.key } } : { run: action };
  }
  return null;
}

/** The record panel a row menu entry opens; actions that run at once open none. */
export function rowPanel(spec: ListSpec, entry: string): PanelMode | null {
  const intent = rowIntent(spec, entry);
  return intent && 'panel' in intent ? intent.panel : null;
}

/** A record as a row whose menu holds only what the row can do. */
export function panelRow(spec: ListSpec, record: RecordView, viewer: Viewer, chip?: string): RowView {
  const row = recordRow(spec, record, viewer, chip);
  return { ...row, actions: row.actions.filter((a) => rowIntent(spec, a.id)) };
}

/** A related or picked record drawn without a menu. */
export function plainRecordRow(spec: ListSpec, record: RecordView): RowView {
  const { record: _record, ...row } = rowModel(spec, record);
  return { ...row, actions: [] };
}
