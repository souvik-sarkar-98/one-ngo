import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import { NOW } from '../../sql-fragments.js';
import type { ConnectorOauthStates } from '../../../../application/connectors/ports/connector-runtime.js';

/** The owner-level store of pending oauth connector connects. */
export function pgConnectorOauthState(db: Database): ConnectorOauthStates {
  return {
    async startConnectorOauth(s) {
      await db.asSystem((tx) =>
        typed(tx)
          .insertInto('connector_oauth_state')
          .values({
            state_hash: s.stateHash,
            tenant_id: s.tenantId,
            connector_key: s.connectorKey,
            code_verifier: s.codeVerifier,
            actor_id: s.actorId,
            expires_at: sql<Date>`now() + interval '10 minutes'`,
          })
          .execute(),
      );
    },
    useConnectorOauth(stateHash) {
      return db.asSystem((tx) =>
        typed(tx)
          .updateTable('connector_oauth_state')
          .set({ used_at: NOW })
          .where('state_hash', '=', stateHash)
          .where('used_at', 'is', null)
          .where('expires_at', '>', NOW)
          .returning(['tenant_id', 'connector_key', 'code_verifier', 'actor_id'])
          .executeTakeFirst(),
      );
    },
  };
}
