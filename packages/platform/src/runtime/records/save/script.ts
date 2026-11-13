import type { Tx } from '../../../domain/ports/transaction.js';
import { ScriptFailure } from '../../../domain/script-failure.js';
import { normaliseData } from '../validator.js';
import type { RecordStore } from '../ports/record-store.js';
import { calculatedData } from './calculate.js';
import type { SaveContext, ScriptRun } from './context.js';
import { failedScripts, hold, runScript } from './script-run.js';

export { failedScripts };

/**
 * Runs the before-save scripts in order and holds what they propose, then
 * recomputes calculated fields so scripts cannot override them.
 */
export async function script(tx: Tx, s: SaveContext): Promise<void> {
  const { ctx, type, previous, status } = s;
  const fields = new Set(type.fields.map((f) => f.key));
  const hooks = s.loaded.beforeSave;
  for (const h of hooks) {
    const out = await runScript(tx, s, h, 'beforeSave', { record: s.data, savedRecordId: s.current?.id ?? null });
    for (const k of Object.keys(out.record!)) {
      if (!fields.has(k)) {
        const e = new ScriptFailure('script_failed', `Script '${h.key}' set unknown field '${k}'.`, out.logs);
        if (!s.dryRun) failedScripts.set(e, [...s.scripts.slice(0, -1), { ...s.scripts.at(-1)!, outcome: 'failed', message: e.message }]);
        throw e;
      }
    }
    s.data = normaliseData(out.record!);
    if (!s.dryRun) hold(s, h, out.effects);
  }
  if (hooks.length) s.data = calculatedData(ctx, type, s.data, status, previous);
}

/** Validate-hook scripts: after the before-save scripts and calculated fields; they refuse with ctx.fail and change nothing. */
export async function validateScripts(tx: Tx, s: SaveContext): Promise<void> {
  for (const h of s.loaded.validateScripts) {
    await runScript(tx, s, h, 'validate', { record: { ...s.data }, savedRecordId: s.current?.id ?? null });
  }
}

/** Workflow-guard scripts, when a step is asked for, after its guard expression; they refuse with ctx.fail. */
export async function guardScripts(tx: Tx, s: SaveContext): Promise<void> {
  if (!s.transition) return;
  for (const h of s.loaded.workflowGuard) {
    await runScript(tx, s, h, 'workflowGuard', {
      record: { ...s.data },
      extra: { transition: s.transition.key, to: s.move.status },
      savedRecordId: s.current?.id ?? null,
    });
  }
}

export async function logScripts(store: RecordStore, tx: Tx, runs: ScriptRun[], recordId: string | null): Promise<void> {
  for (const r of runs) {
    await store.logScript(tx, r, recordId);
  }
}
