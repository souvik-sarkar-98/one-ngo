import { reencryptSecret, type SecretKeys } from '@onengo/kernel/crypto';
import type { Database } from '../postgres/db.js';
import { typed } from '../postgres/kysely.js';

export interface SecretsRewritten {
  /** Two-step sign-in secrets moved to the current key. */
  twoStep: number;
  /** Connector, payment gateway and sign-in provider credentials moved to the current key. */
  connectors: number;
}

/**
 * Rewrites every stored secret that is not under the current key, in one
 * owner transaction with the rows locked. Secrets no configured key opens
 * fail the run, which changes nothing; a second run rewrites nothing.
 */
export async function reencryptStoredSecrets(db: Database, keys: SecretKeys): Promise<SecretsRewritten> {
  return db.asSystem(async (tx) => {
    const q = typed(tx);
    let twoStep = 0;
    const users = await q
      .selectFrom('app_user')
      .select(['id', 'totp_secret_enc', 'totp_pending_secret_enc'])
      .where((eb) => eb.or([eb('totp_secret_enc', 'is not', null), eb('totp_pending_secret_enc', 'is not', null)]))
      .orderBy('id')
      .forUpdate()
      .execute();
    for (const u of users) {
      const enrolled = u.totp_secret_enc === null ? undefined : reencryptSecret(u.totp_secret_enc, keys);
      const pending = u.totp_pending_secret_enc === null ? undefined : reencryptSecret(u.totp_pending_secret_enc, keys);
      if (enrolled === undefined && pending === undefined) continue;
      await q
        .updateTable('app_user')
        .set({ ...(enrolled !== undefined && { totp_secret_enc: enrolled }), ...(pending !== undefined && { totp_pending_secret_enc: pending }) })
        .where('id', '=', u.id)
        .execute();
      twoStep++;
    }
    let connectors = 0;
    const rows = await q
      .selectFrom('connector')
      .select(['tenant_id', 'key', 'secret_enc'])
      .where('secret_enc', 'is not', null)
      .orderBy('tenant_id')
      .orderBy('key')
      .forUpdate()
      .execute();
    for (const c of rows) {
      const next = reencryptSecret(c.secret_enc!, keys);
      if (next === undefined) continue;
      await q.updateTable('connector').set({ secret_enc: next }).where('tenant_id', '=', c.tenant_id).where('key', '=', c.key).execute();
      connectors++;
    }
    return { twoStep, connectors };
  });
}
