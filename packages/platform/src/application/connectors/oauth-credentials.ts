import { createHash, randomBytes } from 'node:crypto';
import { pkceChallenge } from '@onengo/kernel/oidc';
import { notFound, ruleViolation } from '@onengo/kernel/errors';
import { demand } from '../../domain/permissions.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { ConnectorHttp, ConnectorOauthStates, ConnectorSecretBox } from './ports/connector-runtime.js';
import type { ConnectorRow, ConnectorStore } from './ports/connector-store.js';

/** oauth: an OAuth 2.0 authorization-code credential that http connectors use as {{credential.accessToken}}. */
export interface OauthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
}

export type OauthCallbackResult =
  | { ok: true; tenantKey: string; connectorKey: string }
  | { ok: false; tenantKey?: string; connectorKey?: string; error: string };

/** Raised when a credential cannot give an access token until an administrator connects it again. */
export class CredentialNeedsReconnect extends Error {
  constructor() {
    super('credential needs reconnect');
    this.name = 'CredentialNeedsReconnect';
  }
}

const PERMISSION = 'admin:connectors';
/** A token closer than this to expiring is refreshed first. */
const EXPIRY_MARGIN_MS = 60_000;
/** Assumed lifetime when a provider does not say. */
const DEFAULT_EXPIRES_IN_S = 3600;
/** Token responses can carry an id token; keep enough of the body to parse them. */
const TOKEN_BODY_BYTES = 64_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const randomToken = (bytes: number) => randomBytes(bytes).toString('base64url');

/** The oauth config in a stored object, or undefined when authorizationUrl, tokenUrl or clientId is missing. */
export function parseOauthConfig(raw: unknown): OauthConfig | undefined {
  if (!isObject(raw)) return undefined;
  const { authorizationUrl, tokenUrl, clientId, scopes } = raw;
  if (typeof authorizationUrl !== 'string' || typeof tokenUrl !== 'string' || typeof clientId !== 'string') return undefined;
  return {
    authorizationUrl,
    tokenUrl,
    clientId,
    scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [],
  };
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/**
 * Connects oauth connectors (authorization code with PKCE) and hands out
 * their access tokens, refreshing them when they are about to expire. Tokens
 * are stored with the connector's other secrets and never logged or audited.
 */
export class OAuthCredentials {
  constructor(
    private readonly states: ConnectorOauthStates,
    private readonly tm: TransactionManager,
    private readonly store: ConnectorStore,
    private readonly secretBox: ConnectorSecretBox,
    private readonly http: ConnectorHttp,
    private readonly audit: AuditTrail,
    private readonly publicBaseUrl: string,
  ) {}

  get redirectUri(): string {
    return `${this.publicBaseUrl.replace(/\/+$/, '')}/api/connectors/oauth/callback`;
  }

  /** The provider address to send the administrator's browser to. */
  async start(ctx: TenantContext, key: string): Promise<string> {
    demand(ctx.actor, PERMISSION);
    const row = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.connector(tx, key));
    if (!row || row.type !== 'oauth') throw notFound(`OAuth connector '${key}' is not set up.`);
    const config = parseOauthConfig(row.config);
    if (!config) throw ruleViolation('Finish setting up the connector before connecting it.');
    const state = randomToken(32);
    const verifier = randomToken(48);
    await this.states.startConnectorOauth({ stateHash: sha256(state), tenantId: ctx.tenantId, connectorKey: key, codeVerifier: verifier, actorId: ctx.actor.id });
    const url = new URL(config.authorizationUrl);
    const params = {
      client_id: config.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: config.scopes.join(' '),
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url.toString();
  }

  /** Finishes a connect: exchanges the code and stores the tokens. Provider error text is never passed on. */
  async callback(query: { code?: string; state?: string; error?: string }): Promise<OauthCallbackResult> {
    const { code, state } = query;
    if (!state) return { ok: false, error: 'The connection was cancelled or failed. Try again.' };
    const login = await this.states.useConnectorOauth(sha256(state));
    if (!login) return { ok: false, error: 'This connection attempt has expired. Start again.' };
    const key = login.connector_key;
    if (query.error || !code) return { ok: false, connectorKey: key, error: 'The connection was cancelled or failed. Try again.' };

    const loaded = await this.tm.withTenant(login.tenant_id, async (tx) => {
      const org = await this.store.organisation(tx);
      const row = await this.store.connector(tx, key);
      return { tenantKey: org?.key, row };
    });
    const failed = (error: string): OauthCallbackResult => ({ ok: false, ...(loaded.tenantKey ? { tenantKey: loaded.tenantKey } : {}), connectorKey: key, error });
    const config = loaded.row?.type === 'oauth' ? parseOauthConfig(loaded.row.config) : undefined;
    if (!loaded.row || !config || !loaded.tenantKey) return failed('This connector is no longer set up.');
    const clientSecret = this.decrypt(loaded.row).clientSecret;
    if (!clientSecret) return failed('Set the client secret before connecting.');

    const tokens = await this.token(config.tokenUrl, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: config.clientId,
      code_verifier: login.code_verifier,
      client_secret: clientSecret,
    });
    if (!tokens) return failed('The provider did not grant access. Try again.');

    await this.tm.withTenant(login.tenant_id, async (tx) => {
      const row = await this.store.lockConnector(tx, key);
      if (!row) return;
      const secrets = { ...this.decrypt(row), clientSecret, ...tokens.secrets };
      await this.store.updateSecrets(tx, key, this.secretBox.encrypt(JSON.stringify(secrets)));
      await this.audit.audit(tx, {
        actorId: login.actor_id,
        action: 'connector.saved',
        entity: 'connector',
        entityId: key,
        after: { kind: 'oauth', secrets: Object.keys(secrets).sort() },
      });
    });
    return { ok: true, tenantKey: loaded.tenantKey, connectorKey: key };
  }

  /** A current access token for the oauth connector, refreshed first when it expires within a minute. */
  accessToken(tenantId: string, key: string): Promise<string> {
    return this.tm.withTenant(tenantId, async (tx) => {
      const row = await this.store.lockConnector(tx, key);
      if (!row || row.type !== 'oauth') throw notFound(`OAuth connector '${key}' is not set up.`);
      const secrets = this.decrypt(row);
      const expiresAt = Date.parse(secrets.accessTokenExpiresAt ?? '');
      if (secrets.accessToken && expiresAt - Date.now() > EXPIRY_MARGIN_MS) return secrets.accessToken;
      return this.refresh(tx, row, secrets);
    });
  }

  private async refresh(tx: Tx, row: ConnectorRow, secrets: Record<string, string>): Promise<string> {
    const config = parseOauthConfig(row.config);
    if (!config || !secrets.refreshToken || !secrets.clientSecret) throw new CredentialNeedsReconnect();
    const tokens = await this.token(config.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: secrets.refreshToken,
      client_id: config.clientId,
      client_secret: secrets.clientSecret,
    });
    if (!tokens) throw new CredentialNeedsReconnect();
    const next = { ...secrets, ...tokens.secrets };
    await this.store.updateSecrets(tx, row.key, this.secretBox.encrypt(JSON.stringify(next)));
    return tokens.secrets.accessToken;
  }

  /** Calls the token endpoint; undefined when the provider refuses or cannot be reached. */
  private async token(
    tokenUrl: string,
    form: Record<string, string>,
  ): Promise<{ secrets: { accessToken: string; accessTokenExpiresAt: string; refreshToken?: string } } | undefined> {
    let parsed: TokenResponse;
    try {
      const res = await this.http({
        url: tokenUrl,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        maxBodyBytes: TOKEN_BODY_BYTES,
      });
      if (res.status < 200 || res.status >= 300) return undefined;
      parsed = JSON.parse(res.body) as TokenResponse;
    } catch {
      return undefined;
    }
    if (!isObject(parsed) || typeof parsed.access_token !== 'string' || !parsed.access_token) return undefined;
    const given = Number(parsed.expires_in);
    const expiresIn = Number.isFinite(given) && given > 0 ? given : DEFAULT_EXPIRES_IN_S;
    return {
      secrets: {
        accessToken: parsed.access_token,
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        ...(typeof parsed.refresh_token === 'string' && parsed.refresh_token ? { refreshToken: parsed.refresh_token } : {}),
      },
    };
  }

  private decrypt(row: ConnectorRow): Record<string, string> {
    if (!row.secret_enc) return {};
    const parsed = JSON.parse(this.secretBox.decrypt(row.secret_enc)) as unknown;
    return isObject(parsed) ? (parsed as Record<string, string>) : {};
  }
}
