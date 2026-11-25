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
 * Blocking: a new record starts in the `initial` state of its workflow, and a posting or receipt
 * rule fires when a record enters its `whenStatus` (`save/effects.ts`). A rule on that state would
 * post a journal entry or issue a receipt for every migrated row, and `quiet` does not stop it.
 * A parallel workflow without `startsWhen` also starts on create, so its initial state counts too.
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
  const [posting, receipt, scripts] = await Promise.all([defs.list(tenantId, 'postingRule'), defs.list(tenantId, 'receiptRule'), defs.list(tenantId, 'script')]);
  for (const key of wanted) {
    const label = types.get(key)?.label ?? key;
    const guard: TypeGuard = { blocking: [], warnings: [] };
    const starts = (await defs.workflowsFor(tenantId, key)).map((w) => w.body).filter((w) => isPrimary(w) || w.startsWhen === undefined);
    const fires = (r: { whenStatus: string; workflow?: string }) =>
      starts.some((w) => (r.workflow ? r.workflow === w.key : isPrimary(w)) && w.initial === r.whenStatus);
    for (const d of posting) {
      if (d.body.recordType === key && fires(d.body)) {
        guard.blocking.push(`${label}: saving these records would post a journal entry (posting rule '${d.key}' fires on the starting state '${d.body.whenStatus}').`);
      }
    }
    for (const d of receipt) {
      if (d.body.recordType === key && fires(d.body)) {
        guard.blocking.push(`${label}: saving these records would issue a receipt (receipt rule '${d.key}' fires on the starting state '${d.body.whenStatus}').`);
      }
    }
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
