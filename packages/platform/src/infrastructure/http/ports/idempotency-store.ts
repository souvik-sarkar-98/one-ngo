import type { TenantContext } from '../../postgres/db.js';

/** What a key already holds when another request claimed it first. */
export interface IdempotencyClaim {
  request_hash: string;
  status_code: number;
  response: unknown;
}

/** What `IdempotencyStore` needs from the place keys are kept. The PostgreSQL implementation is in src/infrastructure/postgres/stores/idempotency-store.ts. */
export interface IdempotencyKeyStore {
  /**
   * Claims the key for this organisation and actor in one tenant transaction. A stale claim (older than
   * 24 hours, or still running after 5 minutes) is taken over. Null when the claim is this request's;
   * otherwise what the key already holds.
   */
  claim(ctx: TenantContext, key: string, requestHash: string): Promise<IdempotencyClaim | null>;
  /** Keeps the response of the request that claimed the key. */
  complete(ctx: TenantContext, key: string, status: number, body: unknown): Promise<void>;
  /** Removes an unfinished claim, so the request can be retried with the same key. */
  release(ctx: TenantContext, key: string): Promise<void>;
}
