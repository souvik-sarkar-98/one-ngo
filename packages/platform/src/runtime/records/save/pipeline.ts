import type { Tx } from '../../../domain/ports/transaction.js';
import { authorize } from './authorize.js';
import { calculate } from './calculate.js';
import { conditions } from './conditions.js';
import type { SaveContext, ScriptRun } from './context.js';
import { copyFrom } from './copy-from.js';
import { follow } from './follow.js';
import { merge } from './merge.js';
import { rules } from './rules.js';
import { script, validateScripts } from './script.js';
import { signatures } from './signatures.js';
import { unique } from './unique.js';
import { validate } from './validate.js';

/** The stages before the write, in the order they run. Validate-hook scripts open the validate stage. */
const PRE_WRITE = [authorize, merge, conditions, signatures, copyFrom, follow, calculate, script, validateScripts, validate, unique, rules];

/** Builds the data that will be saved, or throws at the first stage that refuses it. */
export async function prepare(tx: Tx, s: SaveContext): Promise<{ data: Record<string, unknown>; scripts: ScriptRun[] }> {
  for (const stage of PRE_WRITE) await stage(tx, s);
  return { data: s.data, scripts: s.scripts };
}
