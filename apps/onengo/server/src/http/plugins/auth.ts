import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { asApplicationError, forbidden, signInRefusalOf, type AuthApi } from '@onengo/platform/main';
import {
  emailCodeVerifyRequest,
  emailRequest,
  loginRequest,
  passkeyOptionsRequest,
  passkeySignInRequest,
  passwordResetCompleteRequest,
  passwordTokenCheckRequest,
  passwordTokenCheckResponse,
  tokenResponse,
  twoStepCompleteRequest,
  type EmailCodeVerifyRequest,
  type EmailRequest,
  type LoginRequest,
  type PasskeyOptionsRequest,
  type PasskeySignInRequest,
  type PasswordResetCompleteRequest,
  type PasswordTokenCheckRequest,
  type TwoStepCompleteRequest,
} from '@onengo/platform/contracts';
import { crossSiteOrigin } from '../cors.js';
import type { ServerOptions } from '../server.js';

const REFRESH_COOKIE = 'ngo_rt';

/**
 * Back to the sign-in page after a provider sign-in failed, naming the refusal
 * by key. The page keeps its own wording for each key, so no text the request
 * carried is ever shown.
 */
const signInRefused = (error: unknown) => `/sign-in?${new URLSearchParams({ reason: signInRefusalOf(error) })}`;
const signedIn = { response: { 200: tokenResponse } };

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Signing in and out: public, so these routes sit outside the signed-in scope. */
export async function authRoutes(app: FastifyInstance, { deps, corsOrigins }: { deps: AuthApi } & Pick<ServerOptions, 'corsOrigins'>): Promise<void> {
  const allowedOrigins = new Set(corsOrigins ?? []);
  const log = deps.logger;

  const setRefreshCookie = (reply: FastifyReply, req: FastifyRequest, token: string | null, maxAge: number) => {
    const crossSite = !!crossSiteOrigin(req, allowedOrigins);
    const parts = [
      `${REFRESH_COOKIE}=${token ? encodeURIComponent(token) : ''}`,
      'HttpOnly',
      crossSite ? 'SameSite=None' : 'SameSite=Strict',
      'Path=/api/auth',
      `Max-Age=${token ? maxAge : 0}`,
      'Secure',
    ];
    reply.header('set-cookie', parts.join('; '));
  };
  const sendTokens = (reply: FastifyReply, req: FastifyRequest, pair: { accessToken: string; refreshToken: string; expiresIn: number }) => {
    setRefreshCookie(reply, req, pair.refreshToken, 30 * 24 * 3600);
    return reply.send({ accessToken: pair.accessToken, expiresIn: pair.expiresIn });
  };

  app.post<{ Body: LoginRequest }>('/api/auth/login', { schema: { body: loginRequest, ...signedIn } }, async (req, reply) => {
    const b = req.body;
    const pair = await deps.signIn.withPassword({ tenant: b.tenant, email: b.email, password: b.password, totpCode: b.totpCode, ip: req.ip });
    return sendTokens(reply, req, pair);
  });

  app.post<{ Body: EmailRequest }>('/api/auth/email-code/request', { schema: { body: emailRequest } }, async (req, reply) => {
    await deps.identity.requestEmailCode({ tenantKey: req.body.tenant, email: req.body.email, ip: req.ip });
    return reply.status(202).send({ message: 'If that address belongs to a member, a code is on its way.' });
  });

  app.post<{ Body: EmailCodeVerifyRequest }>(
    '/api/auth/email-code/verify',
    { schema: { body: emailCodeVerifyRequest, ...signedIn } },
    async (req, reply) => {
      const pair = await deps.signIn.withEmailCode({
        tenant: req.body.tenant,
        email: req.body.email,
        code: req.body.code,
        totpCode: req.body.totpCode,
        ip: req.ip,
      });
      return sendTokens(reply, req, pair);
    },
  );

  /**
   * Refresh and sign-out act on the refresh cookie alone, which is
   * `SameSite=None` once cross-site sign-in is allowed. A browser always names
   * the calling page in `Origin` (and `Sec-Fetch-Site`), so a request from a
   * site that is neither this one nor an allowed origin is refused.
   */
  const assertSameSiteOrAllowed = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== 'null') {
      if (allowedOrigins.has(origin)) return;
      let host: string | undefined;
      try {
        host = new URL(origin).host;
      } catch {
        host = undefined;
      }
      if (host && host === req.headers.host) return;
      throw forbidden('This request must come from this site.');
    }
    if (origin === 'null' || req.headers['sec-fetch-site'] === 'cross-site') throw forbidden('This request must come from this site.');
  };

  app.post('/api/auth/refresh', { schema: signedIn }, async (req, reply) => {
    assertSameSiteOrAllowed(req);
    const token = readCookie(req, REFRESH_COOKIE);
    if (!token) throw forbidden('Sign in first.');
    return sendTokens(reply, req, await deps.signIn.refresh(token));
  });

  app.post('/api/auth/logout', async (req, reply) => {
    assertSameSiteOrAllowed(req);
    const token = readCookie(req, REFRESH_COOKIE);
    if (token) await deps.identity.logout(token);
    setRefreshCookie(reply, req, null, 0);
    return reply.status(204).send();
  });

  app.post<{ Body: EmailRequest }>('/api/auth/password-reset/request', { schema: { body: emailRequest } }, async (req, reply) => {
    await deps.identity.requestPasswordReset({ tenantKey: req.body.tenant, email: req.body.email, ip: req.ip });
    return reply.status(202).send({ message: 'If that address belongs to a member, a reset link is on its way.' });
  });

  /** Read-only, so the set-password page can show "expired" instead of a form it cannot submit. The link is not spent. */
  app.post<{ Body: PasswordTokenCheckRequest }>(
    '/api/auth/password-reset/check',
    { schema: { body: passwordTokenCheckRequest, response: { 200: passwordTokenCheckResponse } } },
    async (req) => ({ usable: await deps.identity.passwordTokenUsable(req.body.token) }),
  );

  app.post<{ Body: PasswordResetCompleteRequest }>('/api/auth/password-reset/complete', { schema: { body: passwordResetCompleteRequest } }, async (req) =>
    deps.identity.completePasswordToken({ token: req.body.token, password: req.body.password }),
  );

  app.post<{ Body: TwoStepCompleteRequest }>('/api/auth/two-step/complete', { schema: { body: twoStepCompleteRequest, ...signedIn } }, async (req, reply) =>
    sendTokens(reply, req, await deps.signIn.withTwoStepTicket({ ticket: req.body.ticket, totpCode: req.body.totpCode })),
  );

  /** Whether the organisation offers passkeys on its sign-in page. */
  app.get<{ Querystring: { tenant?: string } }>('/api/auth/passkey/available', async (req) => ({
    enabled: await deps.passkeys.available(String(req.query.tenant ?? '').toLowerCase()),
  }));

  /** Starts a usernameless passkey sign-in; the answer carries a one-time challenge id. */
  app.post<{ Body: PasskeyOptionsRequest }>('/api/auth/passkey/options', { schema: { body: passkeyOptionsRequest } }, async (req) =>
    deps.passkeys.signInOptions({ tenantKey: req.body.tenant.toLowerCase(), ip: req.ip }),
  );

  /** Completes a passkey sign-in. Answers with a session, or with a two-step ticket when the person also has an authenticator app. */
  app.post<{ Body: PasskeySignInRequest }>('/api/auth/passkey/sign-in', { schema: { body: passkeySignInRequest } }, async (req, reply) => {
    const outcome = await deps.passkeys.signIn({
      tenantKey: req.body.tenant.toLowerCase(),
      challengeId: req.body.challengeId,
      response: req.body.response,
      ip: req.ip,
    });
    if (outcome.kind === 'twoStep') return reply.status(200).send({ ticket: outcome.ticket });
    return sendTokens(reply, req, outcome.pair);
  });

  app.get<{ Querystring: { tenant?: string } }>('/api/auth/providers', async (req) =>
    deps.oidc.providersFor(String(req.query.tenant ?? '').toLowerCase()),
  );

  app.get<{ Params: { provider: string }; Querystring: { tenant?: string; next?: string } }>(
    '/api/auth/oidc/:provider/start',
    async (req, reply) => {
      try {
        const url = await deps.oidc.start(String(req.query.tenant ?? '').toLowerCase(), req.params.provider, req.query.next);
        return reply.redirect(url, 302);
      } catch (error) {
        const known = asApplicationError(error);
        if (!known) log.log('ERROR', 'Provider sign-in could not start', { trace: req.requestId }, error);
        return reply.redirect(signInRefused(error), 302);
      }
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/oidc/callback', async (req, reply) => {
    try {
      const result = await deps.oidc.callback(req.query);
      if (result.kind === 'twoStep') {
        return reply.redirect(`/sign-in?${new URLSearchParams({ ticket: result.ticket, next: result.next })}`, 302);
      }
      setRefreshCookie(reply, req, result.pair.refreshToken, 30 * 24 * 3600);
      return reply.redirect(result.next, 302);
    } catch (error) {
      const known = asApplicationError(error);
      if (known) {
        log.log('WARNING', 'Sign-in failed', { trace: req.requestId, path: '/api/auth/oidc/callback', ip: req.ip, reason: known.name });
      } else log.log('ERROR', 'Provider sign-in failed', { trace: req.requestId }, error);
      return reply.redirect(signInRefused(error), 302);
    }
  });

  /** A connector's OAuth provider sends the administrator back here; the query carries only `connected=1` or a short `error` code. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/connectors/oauth/callback', async (req, reply) => {
    const { code, state, error } = req.query;
    let result: Awaited<ReturnType<AuthApi['connectorOauth']['callback']>>;
    try {
      result = await deps.connectorOauth.callback({ code, state, error });
    } catch (e) {
      log.log('ERROR', 'Connector connection failed', { trace: req.requestId }, e);
      result = { ok: false, error: 'failed' };
    }
    if (!result.connectorKey) {
      if (!result.ok) log.log('WARNING', 'Connector connection failed', { trace: req.requestId, path: '/api/connectors/oauth/callback', reason: 'unknown_state' });
      return reply.redirect('/admin/connectors?error=1', 302);
    }
    const page = `/admin/connectors/${encodeURIComponent(result.connectorKey)}`;
    if (result.ok) return reply.redirect(`${page}?connected=1`, 302);
    log.log('WARNING', 'Connector connection failed', { trace: req.requestId, path: '/api/connectors/oauth/callback', connector: result.connectorKey });
    return reply.redirect(`${page}?${new URLSearchParams({ error: error ? 'denied' : 'failed' })}`, 302);
  });
}
