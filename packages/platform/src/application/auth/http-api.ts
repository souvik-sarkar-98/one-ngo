import type { IdentityService } from '../identity/identity-service.js';
import type { ApiKeyService } from '../identity/api-key-service.js';
import type { OidcService } from '../identity/oidc.js';
import type { PasskeyService } from '../identity/passkey-service.js';
import type { OAuthCredentials } from '../connectors/oauth-credentials.js';
import type { HttpLogger, RequestContext } from '../shared/http-api.js';
import type { SignIn } from './sign-in.js';

/** Signing in and out: the calls the public auth routes make. */
export interface AuthApi {
  signIn: SignIn;
  identity: Pick<IdentityService, 'requestEmailCode' | 'logout' | 'requestPasswordReset' | 'passwordTokenUsable' | 'completePasswordToken'>;
  oidc: Pick<OidcService, 'providersFor' | 'start' | 'callback'>;
  /** Passkey sign-in: usernameless, for organisations that enable it. */
  passkeys: Pick<PasskeyService, 'available' | 'signInOptions' | 'signIn'>;
  /** Where a connector's OAuth provider sends the administrator back; the tenant comes from the stored state. */
  connectorOauth: Pick<OAuthCredentials, 'callback'>;
  logger: HttpLogger;
}

/** Who a Bearer token or an API key belongs to: the request's TenantContext before its body is read. */
export interface Authenticator {
  bearer(accessToken: string): Promise<RequestContext>;
  apiKey(credential: string): Promise<RequestContext>;
}

export class RequestAuthenticator implements Authenticator {
  constructor(
    private readonly identity: Pick<IdentityService, 'authenticate'>,
    private readonly apiKeys: Pick<ApiKeyService, 'authenticate'>,
  ) {}

  bearer(accessToken: string): Promise<RequestContext> {
    return this.identity.authenticate(accessToken);
  }

  apiKey(credential: string): Promise<RequestContext> {
    return this.apiKeys.authenticate(credential);
  }
}
