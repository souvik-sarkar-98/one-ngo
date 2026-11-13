import { sha256 } from '@onengo/kernel/crypto';
import type { TenantContext } from '../postgres/db.js';
import { infrastructureConflict as conflict, infrastructureValidationFailed as validationFailed } from '@onengo/kernel/errors';
import type { IdempotencyKeyStore } from './ports/idempotency-store.js';
import { IDEMPOTENCY_RUNNING as RUNNING } from './idempotency-status.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * `Idempotency-Key` support: the first successful response to a key is kept
 * for 24 hours per organisation and actor, and the same request with the same
 * key gets it back without running again. Failed requests are not kept, so
 * they can be retried with the same key.
 */
export class IdempotencyStore {
  constructor(private readonly store: IdempotencyKeyStore) {}

  static requestHash(method: string, path: string, body: unknown): string {
    return sha256(`${method.toUpperCase()} ${path}\n${canonical(body)}`);
  }

  /** Runs `fn` once per key; `replayed` is true when the response comes from the first request. */
  async run(
    ctx: TenantContext,
    key: string,
    requestHash: string,
    fn: () => Promise<StoredResponse>,
  ): Promise<StoredResponse & { replayed: boolean }> {
    if (!/^[\x21-\x7e]{1,255}$/.test(key)) {
      throw validationFailed('Idempotency-Key must be 1 to 255 visible characters.', [{ path: '/idempotency-key', message: 'is not valid' }]);
    }
    const claimed = await this.store.claim(ctx, key, requestHash);
    if (claimed) {
      if (claimed.request_hash !== requestHash) {
        throw validationFailed('This Idempotency-Key was already used for a different request. Use a new key.', [
          { path: '/idempotency-key', message: 'was used with a different request' },
        ]);
      }
      if (claimed.status_code === RUNNING) throw conflict('A request with this Idempotency-Key is still running. Try again shortly.');
      return { status: claimed.status_code, body: claimed.response, replayed: true };
    }

    let result: StoredResponse;
    try {
      result = await fn();
    } catch (error) {
      await this.release(ctx, key);
      throw error;
    }
    await this.store.complete(ctx, key, result.status, result.body);
    return { ...result, replayed: false };
  }

  private release(ctx: TenantContext, key: string): Promise<void> {
    return this.store.release(ctx, key);
  }
}

/** JSON with object keys sorted, so the same body always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
