import type { DefinitionKind } from '../models';
import type { ModuleDefinition } from './http-access';

/** Kinds in the order the "Choose what shows" panel lists them. */
const PANEL_ORDER: DefinitionKind[] = ['recordType', 'recordGroup', 'listView', 'workflow', 'action', 'page', 'report', 'reportGroup'];

export interface VisibilityGroup {
  kind: DefinitionKind;
  items: ModuleDefinition[];
}

/** How many of a module's definitions are kept out of menus. */
export function hiddenCount(defs: readonly ModuleDefinition[]): number {
  return defs.filter((d) => d.hideable && d.hidden).length;
}

/** The definitions people see, grouped by kind, each group in panel order. */
export function visibilityGroups(defs: readonly ModuleDefinition[]): VisibilityGroup[] {
  return PANEL_ORDER.map((kind) => ({ kind, items: defs.filter((d) => d.kind === kind && d.hideable) })).filter((g) => g.items.length > 0);
}

/** Definitions that never show in menus, listed without a checkbox. */
export function behindTheScenes(defs: readonly ModuleDefinition[]): ModuleDefinition[] {
  return defs.filter((d) => !d.hideable);
}

/** The name people know a definition by: its label, else its key. */
export function definitionName(d: Pick<ModuleDefinition, 'label' | 'key'>): string {
  return d.label || d.key;
}
