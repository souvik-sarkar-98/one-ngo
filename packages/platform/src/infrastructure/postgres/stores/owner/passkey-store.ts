import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import { NOW } from '../../sql-fragments.js';
import type {
  PasskeyChallengeRow,
  PasskeyCredentialRow,
  PasskeyStore,
} from '../../../../domain/identity/ports/passkey-store.js';

const LIVE_CREDENTIAL = ['id', 'user_id', 'credential_id', 'public_key', 'counter', 'transports', 'device_type', 'backed_up', 'name', 'created_at', 'last_used_at', 'revoked_at'] as const;

/** The owner-level passkey capability: credentials and one-time challenges, reachable only through the owner role. */
export function pgPasskeyStore(db: Database): PasskeyStore {
  const toRow = (row: {
    id: string;
    user_id: string;
    credential_id: string;
    public_key: Buffer;
    counter: string | number;
    transports: string[];
    device_type: string;
    backed_up: boolean;
    name: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }): PasskeyCredentialRow => ({
    ...row,
    public_key: new Uint8Array(row.public_key),
    counter: Number(row.counter),
  });

  return {
    async addChallenge(input) {
      const row = await db.asSystem((tx) =>
        typed(tx)
          .insertInto('passkey_challenge')
          .values({
            tenant_id: input.tenantId,
            purpose: input.purpose,
            user_id: input.userId,
            challenge: input.challenge,
            expires_at: sql<Date>`now() + make_interval(secs => ${input.ttlSeconds})`,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      return row.id;
    },

    async useChallenge(input) {
      // A single conditional update: a challenge is consumed by exactly one ceremony, and only inside its window.
      const row = await db.asSystem((tx) =>
        typed(tx)
          .updateTable('passkey_challenge')
          .set({ used_at: NOW })
          .where('id', '=', input.id)
          .where('purpose', '=', input.purpose)
          .where('tenant_id', '=', input.tenantId)
          .where(sql<boolean>`user_id is not distinct from ${input.userId ?? null}::uuid`)
          .where('used_at', 'is', null)
          .where('expires_at', '>', NOW)
          .returning(['id', 'tenant_id', 'purpose', 'user_id', 'challenge'])
          .executeTakeFirst(),
      );
      return row as PasskeyChallengeRow | undefined;
    },

    async listForUser(userId) {
      const rows = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('passkey_credential')
          .select([...LIVE_CREDENTIAL])
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .orderBy('created_at', 'asc')
          .execute(),
      );
      return rows.map(toRow);
    },

    async byCredentialId(credentialId) {
      const row = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('passkey_credential')
          .select([...LIVE_CREDENTIAL])
          .where('credential_id', '=', credentialId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst(),
      );
      return row ? toRow(row) : undefined;
    },

    async add(input) {
      const row = await db.asSystem((tx) =>
        typed(tx)
          .insertInto('passkey_credential')
          .values({
            user_id: input.userId,
            credential_id: input.credentialId,
            public_key: Buffer.from(input.publicKey),
            counter: String(input.counter),
            transports: input.transports,
            device_type: input.deviceType,
            backed_up: input.backedUp,
            name: input.name,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      return row.id;
    },

    async advanceCounter(id, previous, next) {
      const done = await db.asSystem((tx) =>
        typed(tx)
          .updateTable('passkey_credential')
          .set({ counter: String(next), last_used_at: NOW })
          .where('id', '=', id)
          .where('counter', '=', String(previous))
          .where('revoked_at', 'is', null)
          .executeTakeFirst(),
      );
      return done.numUpdatedRows > 0n;
    },

    async touch(id) {
      await db.asSystem((tx) => typed(tx).updateTable('passkey_credential').set({ last_used_at: NOW }).where('id', '=', id).execute());
    },

    async rename(userId, id, name) {
      const done = await db.asSystem((tx) =>
        typed(tx)
          .updateTable('passkey_credential')
          .set({ name })
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst(),
      );
      return done.numUpdatedRows > 0n;
    },

    async revoke(userId, id) {
      const done = await db.asSystem((tx) =>
        typed(tx)
          .updateTable('passkey_credential')
          .set({ revoked_at: NOW })
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst(),
      );
      return done.numUpdatedRows > 0n;
    },

    async revokeAll(userId) {
      await db.asSystem((tx) =>
        typed(tx).updateTable('passkey_credential').set({ revoked_at: NOW }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute(),
      );
    },

    async countLive(userId) {
      const row = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('passkey_credential')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .executeTakeFirstOrThrow(),
      );
      return Number(row.n);
    },
  };
}
