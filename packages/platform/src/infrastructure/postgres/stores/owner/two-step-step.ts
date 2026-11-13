import type { SqlExecutor } from '../../db.js';
import { typed } from '../../kysely.js';

/** Records `step` as the account's last accepted two-step time step; false when that step or a later one was already used. */
export async function useTwoStepStep(tx: SqlExecutor, userId: string, step: number): Promise<boolean> {
  const done = await typed(tx)
    .updateTable('app_user')
    .set({ totp_last_step: String(step) })
    .where('id', '=', userId)
    .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', String(step))]))
    .executeTakeFirst();
  return done.numUpdatedRows > 0n;
}
