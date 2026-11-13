import type { ApiKeyCredential, SystemIdentity } from '../../domain/identity/ports/identity-directory.js';
import type { RequestLimiter, TokenHasher } from '@onengo/kernel/ports';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { conflict, notFound, PlatformError, validationFailed } from '@onengo/kernel/errors';
import { demand, demandGrant } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import { AuthError } from './identity-service.js';
import type { ApiKeyRow, ApiKeyStore } from '../../domain/identity/ports/api-key-store.js';
import { API_ACTOR_PREFIX, API_KEYS_PERMISSION, API_RATE_SETTING, apiActorId, apiKeyToken, isApiKeyId, keyNameOf, parseApiKeyToken, rateLimitOf } from '../../domain/identity/api-key-policy.js';

export { API_ACTOR_PREFIX, API_RATE_SETTING };
const PERMISSION = API_KEYS_PERMISSION;

const FEED_KEY = /^[a-z][a-zA-Z0-9_-]{0,62}$/;
const INVALID_KEY = 'This API key is not valid.';

export interface ApiKeyFeedChoice {
  key: string;
  label: string;
}

export interface ApiKeyView {
  id: string;
  name: string;
  /** The role a staff key acts as. Null when the key reads one data feed. */
  role: string | null;
  /** The data feed a feed key reads. Null when the key acts as a role. */
  feed: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);
const toView = (r: ApiKeyRow): ApiKeyView => ({
  id: r.id,
  name: r.name,
  role: r.role_key,
  feed: r.feed_key,
  createdBy: r.created_by,
  createdAt: iso(r.created_at)!,
  lastUsedAt: iso(r.last_used_at),
  revokedAt: iso(r.revoked_at),
});

export interface ApiKeyOptions {
  /** Requests per minute per key when the organisation has not set `api.rateLimitPerMinute`. */
  defaultRateLimitPerMinute?: number;
}

/**
 * Keys for programs calling the API. A staff key acts as its own actor `api:<name>`
 * with one role's permissions. A feed key reads one published data feed and is not
 * a person, so people's two-step sign-in rules do not apply. Only the hash of the secret is stored.
 */
export class ApiKeyService {
  private readonly limiters = new Map<number, RequestLimiter>();
  /** Requests per minute per key when the organisation has not chosen its own. */
  readonly defaultLimit: number;

  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: ApiKeyStore,
    private readonly system: SystemIdentity,
    private readonly crypto: TokenHasher,
    private readonly definitions: DefinitionService,
    /** A per-minute in-memory limiter allowing limit calls per key. */
    private readonly newLimiter: (limit: number) => RequestLimiter,
    options: ApiKeyOptions = {},
  ) {
    this.defaultLimit = options.defaultRateLimitPerMinute ?? 120;
  }

  async list(ctx: TenantContext): Promise<ApiKeyView[]> {
    demand(ctx.actor, PERMISSION);
    const rows = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.list(tx));
    return rows.map(toView);
  }

  /** Published data feeds a new key can be bound to. */
  async feeds(ctx: TenantContext): Promise<ApiKeyFeedChoice[]> {
    demand(ctx.actor, PERMISSION);
    const list = await this.definitions.list(ctx.tenantId, 'dataFeed');
    return list.map((d) => ({ key: d.body.key, label: d.body.label })).sort((a, b) => a.label.localeCompare(b.label));
  }

  /** The secret is in `token` (`<id>.<secret>`) and is never shown again. Exactly one of `role` and `feed` is set. */
  async create(ctx: TenantContext, input: { name?: unknown; role?: unknown; feed?: unknown }): Promise<ApiKeyView & { token: string }> {
    demand(ctx.actor, PERMISSION);
    const name = keyNameOf(input.name);
    const role = typeof input.role === 'string' && input.role ? input.role : undefined;
    const feed = typeof input.feed === 'string' && input.feed ? input.feed : undefined;
    if (!!role === !!feed) {
      throw validationFailed('Choose a role or a data feed for the key.', [
        { path: role ? '/feed' : '/role', message: 'Choose one: a role, or a published data feed.' },
      ]);
    }
    const secret = this.crypto.randomToken(32);
    const subject = role ? await this.roleSubject(ctx, role) : await this.feedSubject(ctx, feed!);
    const row = await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      if (await this.store.activeNameTaken(tx, name)) throw conflict(`An active key is already called '${name}'.`);
      const created = await this.store.insert(tx, { name, secretHash: this.crypto.sha256(secret), role: subject.role, feed: subject.feed, createdBy: ctx.actor.id });
      await this.store.audit(tx, { actorId: ctx.actor.id, action: 'api-key.created', entity: 'api_key', entityId: created.id, after: { name, ...subject.after } });
      return created;
    });
    return { ...toView(row), token: apiKeyToken(row.id, secret) };
  }

  async revoke(ctx: TenantContext, id: string): Promise<void> {
    demand(ctx.actor, PERMISSION);
    if (!isApiKeyId(id)) throw notFound('API key not found.');
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.store.revoke(tx, id);
      if (!row) throw notFound('API key not found.');
      await this.store.audit(tx, { actorId: ctx.actor.id, action: 'api-key.revoked', entity: 'api_key', entityId: id, before: { name: row.name } });
    });
  }

  /** Resolves `<id>.<secret>` from an `Authorization: ApiKey` header to the key's organisation and actor. A feed key is refused. */
  async authenticate(credential: string): Promise<TenantContext> {
    const { id, row } = await this.credential(credential);
    if (!row.role_key) throw new AuthError(INVALID_KEY);
    this.spend(id, row);
    await this.system.touchApiKey(id);
    return { tenantId: row.tenant_id, actor: { id: apiActorId(row.name), roles: [row.role_key], permissions: row.permissions ?? [] } };
  }

  /**
   * Accepts a key bound to `feedKey` in `tenantId`. A staff key, a key for another feed,
   * another organisation, or a revoked key is the same refusal. Does not build a staff actor.
   */
  async authenticateFeed(credential: string, tenantId: string, feedKey: string): Promise<void> {
    const { id, row } = await this.credential(credential);
    if (row.feed_key !== feedKey || row.tenant_id !== tenantId) throw new AuthError(INVALID_KEY);
    this.spend(id, row);
    await this.system.touchApiKey(id);
  }

  private async credential(credential: string): Promise<{ id: string; row: ApiKeyCredential }> {
    const { id, secret } = parseApiKeyToken(credential);
    if (!isApiKeyId(id) || !secret) throw new AuthError(INVALID_KEY);
    // The organisation is not known until the key is found, so this lookup runs as the owner.
    const row = await this.system.apiKey(id, API_RATE_SETTING);
    const hash = this.crypto.sha256(secret);
    const matches = this.crypto.safeEqual(hash, row?.secret_hash ?? this.crypto.sha256(''));
    if (!matches || !row || row.revoked_at) throw new AuthError(INVALID_KEY);
    return { id, row };
  }

  private spend(id: string, row: ApiKeyCredential): void {
    if (!this.limiterFor(this.rateOf(row.rate)).hit(id)) {
      throw new PlatformError('rate_limited', 'This API key has made too many requests. Wait a minute and try again.');
    }
  }

  private async roleSubject(ctx: TenantContext, role: string): Promise<{ role: string; feed: null; after: { role: string } }> {
    const granted = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.role(tx, role));
    if (!granted) throw validationFailed('Choose a role for the key.', [{ path: '/role', message: 'is not a role of this organisation' }]);
    demandGrant(ctx.actor, [granted]);
    return { role, feed: null, after: { role } };
  }

  private async feedSubject(ctx: TenantContext, feed: string): Promise<{ role: null; feed: string; after: { feed: string } }> {
    if (!FEED_KEY.test(feed)) throw validationFailed('Choose a published data feed.', [{ path: '/feed', message: 'is not a data feed key' }]);
    const published = await this.definitions.get(ctx.tenantId, 'dataFeed', feed);
    if (!published) throw validationFailed('Choose a published data feed.', [{ path: '/feed', message: 'is not a published data feed' }]);
    return { role: null, feed, after: { feed } };
  }

  private rateOf(value: unknown): number {
    return rateLimitOf(value, this.defaultLimit);
  }

  private limiterFor(limit: number): RequestLimiter {
    let limiter = this.limiters.get(limit);
    if (!limiter) this.limiters.set(limit, (limiter = this.newLimiter(limit)));
    return limiter;
  }
}
