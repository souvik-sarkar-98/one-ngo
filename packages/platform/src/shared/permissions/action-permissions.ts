import type { ActionDef } from '../definitions/types.js';

/** The permission that lets someone run a record action. */
export function actionPermission(def: Pick<ActionDef, 'key' | 'recordType' | 'permission'>): string {
  return def.permission ?? `record:${def.recordType}:action:${def.key}`;
}

/** Every action's permission by record type, sorted by action key, for permission catalogues. */
export function actionPermissionsByType(defs: ActionDef[]): Record<string, { action: string; label: string; permission: string }[]> {
  const out: Record<string, { action: string; label: string; permission: string }[]> = {};
  for (const d of [...defs].sort((a, b) => a.key.localeCompare(b.key))) {
    (out[d.recordType] ??= []).push({ action: d.key, label: d.label, permission: actionPermission(d) });
  }
  return out;
}
