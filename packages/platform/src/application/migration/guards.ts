import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import type { RecordTypeDef } from '../../runtime/definitions/types.js';
import { isPrimary } from '../../runtime/definitions/workflows.js';

/** What saving records of one type in a migration would do that the administrator must know about. */
export interface TypeGuard {
  /** Reasons the type cannot be migrated at all; each refuses every row of the type. */
  blocking: string[];
  /** Script effects a migration skips; they warn and do not block. */
  warnings: string[];
}

/** Scripts that run when a record is saved; the others run on a button, a report or a transition. */
const SAVE_HOOKS = new Set(['beforeSave', 'afterSave']);

/**
 * Safety guards for each of the given record types, read from the published definitions.
 *
 * Posting rules are not guarded: a migrated save posts the entries its rules make, and Check predicts them
 * row by row (`ledger.checkPlanned`). Receipt rules are not guarded either: a migrated save issues no
 * receipt (`save/effects.ts`), and the legacy receipt number stays on the row.
 *
 * Scripts (enabled, on a save hook, allowed an effect): `notify` and `connector.call` are skipped
 * by a quiet save (`save/script-run.ts`, block M0), so they only warn. `ledger.propose` is applied
 * through the ledger whatever `quiet` says, so a script that may propose a journal blocks, since
 * Check cannot know whether it will on any row.
 */
export async function typeGuards(defs: DefinitionReader, tenantId: string, types: ReadonlyMap<string, RecordTypeDef>, keys: Iterable<string>): Promise<Map<string, TypeGuard>> {
  const wanted = new Set(keys);
  const out = new Map<string, TypeGuard>();
  if (!wanted.size) return out;
  const scripts = await defs.list(tenantId, 'script');
  for (const key of wanted) {
    const label = types.get(key)?.label ?? key;
    const guard: TypeGuard = { blocking: [], warnings: [] };
    for (const d of scripts) {
      const s = d.body;
      if (s.recordType !== key || s.enabled === false || !SAVE_HOOKS.has(s.hook)) continue;
      const allow = s.effects?.allow ?? [];
      if (allow.includes('ledger.propose')) {
        guard.blocking.push(`${label}: script '${d.key}' may propose journal entries, and a migration does not suppress them.`);
      }
      if (allow.includes('notify') || allow.includes('connector.call')) {
        guard.warnings.push(`${label}: script '${d.key}' notifications and connector calls are skipped during a migration.`);
      }
    }
    out.set(key, guard);
  }
  return out;
}

/** The state keys of each given record type's primary workflow; a type without one has no entry. */
export async function primaryStates(defs: DefinitionReader, tenantId: string, keys: Iterable<string>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const key of new Set(keys)) {
    const primary = (await defs.workflowsFor(tenantId, key)).map((w) => w.body).find((w) => isPrimary(w));
    if (primary) out.set(key, primary.states.map((s) => s.key));
  }
  return out;
}
