import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { PlatformError } from '@onengo/kernel/errors';
import type { OperatorControlPlane, OperatorPrincipal } from '@onengo/platform/operator';
import { verifiedOperatorPrincipal } from '@onengo/platform/operator';
import type {
  OperatorActionContract,
  OperatorCreateRequest,
  OperatorDisableRequest,
  OperatorGrantsRequest,
  OperatorLifecycleRequest,
  OperatorOnboardRequest,
  OperatorProviderPolicyRequest,
  OperatorProviderRequest,
  OperatorRelinkRequest,
  OperatorSignInChange,
  OperatorSignInPolicyRequest,
  OperatorStepUpActionContract,
} from '@onengo/platform/contracts';
import { OperatorDirectory, operatorActions, type OperatorActor } from '../operators/directory.js';
import { OperatorProvider, verifyIap } from '../operators/provider.js';
import { SESSION_COOKIE, STEP_UP_ACTIONS, OperatorStore, canonicalTarget, type Session } from '../operators/security.js';

const LIFECYCLE_ACTIONS = ['suspend', 'reactivate', 'close'] as const;
const PLATFORM_STATUS: Partial<Record<PlatformError['code'], number>> = { forbidden: 403, not_found: 404, conflict: 409, rate_limited: 429 };

export interface OperatorServerDeps {
  store: OperatorStore;
  provider: OperatorProvider;
  control: OperatorControlPlane;
  directory?: OperatorDirectory;
  webRoot?: string;
  iapAudience?: string;
}
const cookie = (req: FastifyRequest): string | undefined => req.headers.cookie?.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
const setCookie = (reply: FastifyReply, token: string, maxAge = 28_800) =>
  reply.header('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
const clearCookie = (reply: FastifyReply) => setCookie(reply, '', 0);

function principal(session: Session): OperatorPrincipal {
  return verifiedOperatorPrincipal({
    operatorId: session.operatorId, issuer: session.issuer, subject: session.subject, display: session.display,
    authTime: session.authTime, amr: session.amr, acr: session.acr, assurance: 'mfa', sessionId: session.id,
    actions: session.actions,
  });
}

export function buildOperatorServer(deps: OperatorServerDeps) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    // Health is open so a deploy can curl it. The provider logout call
    // authenticates itself with its signed token, because the provider
    // cannot pass an Identity-Aware Proxy assertion through.
    if (path === '/health' || path === '/op/auth/backchannel-logout') return;
    try {
      await verifyIap(typeof req.headers['x-goog-iap-jwt-assertion'] === 'string' ? req.headers['x-goog-iap-jwt-assertion'] : undefined, deps.iapAudience);
    } catch (error) {
      return reply.status(401).send({ code: 'iap_required', message: (error as Error).message });
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.headers({
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'strict-transport-security': 'max-age=31536000; includeSubDomains', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'cache-control': req.url.startsWith('/op/') || req.url.split('?')[0] === '/health' ? 'no-store' : 'public, max-age=300',
    });
    return payload;
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof PlatformError) {
      const status = PLATFORM_STATUS[error.code] ?? 400;
      return reply.status(status).send({ code: error.code, message: error.message, issues: error.issues });
    }
    const message = error instanceof Error ? error.message : 'Request failed.';
    const status = /required|invalid|refused|grant|session|mfa|assurance/i.test(message) ? 403 : 400;
    reply.status(status).send({ code: status === 403 ? 'forbidden' : 'invalid_request', message });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/op/auth/login', async (req, reply) => {
    const next = (req.query as { next?: string }).next ?? '/organisations';
    const auth = await deps.provider.authorize(next);
    await deps.store.saveLogin(auth.login, deps.provider.config.issuer);
    return reply.redirect(auth.url);
  });
  app.get('/op/auth/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) throw new Error('Authorization code and state are required.');
    const login = await deps.store.consumeLogin(state);
    if (!login) throw new Error('Authorization state is invalid or already used.');
    let verified: Awaited<ReturnType<OperatorProvider['callback']>>;
    try {
      verified = await deps.provider.callback(code, login);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/multi-factor|assurance|Fresh operator/i.test(message)) return reply.redirect('/sign-in?refused=mfa');
      if (/provider/i.test(message)) return reply.redirect('/sign-in?refused=provider');
      throw error;
    }
    if (login.stepUp) {
      const current = await deps.store.session(cookie(req) ?? '');
      if (!current || current.id !== login.stepUp.sessionId || current.issuer !== verified.identity.issuer || current.subject !== verified.identity.subject) {
        throw new Error('Step-up identity does not match the operator session.');
      }
      const id = await deps.store.createStepUp(current.id, login.stepUp.action, login.stepUp.target, verified.identity.authTime!, verified.identity.amr);
      return reply.redirect(`${login.nextPath}${login.nextPath.includes('?') ? '&' : '?'}stepUpId=${encodeURIComponent(id)}`);
    }
    const created = await deps.store.createSession({
      ...verified.identity, display: verified.identity.email ?? verified.identity.subject,
      authTime: verified.identity.authTime!, provider: verified.tokens,
    });
    if (!created) {
      const refused = new URLSearchParams({ refused: 'unknown', issuer: verified.identity.issuer, subject: verified.identity.subject });
      return reply.redirect(`/sign-in?${refused}`);
    }
    setCookie(reply, created.token);
    return reply.redirect(login.nextPath);
  });
  app.get('/op/auth/session', async (req, reply) => {
    const session = await deps.store.session(cookie(req) ?? '');
    return session
      ? { authenticated: true, display: session.display, operatorId: session.operatorId, actions: session.actions, csrfToken: session.csrf }
      : reply.status(401).send({ authenticated: false, actions: [] });
  });
  app.post('/op/auth/refresh', async (req, reply) => {
    const session = await authenticated(req, undefined, true);
    csrf(req, session);
    const next = await deps.store.rotate(session.token);
    if (!next) throw new Error('Operator session cannot be refreshed.');
    setCookie(reply, next);
    return reply.status(204).send();
  });
  app.post('/op/auth/logout', async (req, reply) => {
    const token = cookie(req);
    if (token) {
      const session = await deps.store.session(token);
      if (session) csrf(req, session);
      await deps.store.revoke(token);
    }
    clearCookie(reply);
    return reply.status(204).send();
  });
  app.post('/op/auth/backchannel-logout', async (req, reply) => {
    const body = req.body as { logout_token?: string };
    if (!body?.logout_token) throw new Error('Logout token is required.');
    const event = await deps.provider.verifyBackChannel(body.logout_token);
    await deps.store.revokeSid(event.issuer, event.sid);
    return reply.status(204).send();
  });
  app.post('/op/auth/step-up', async (req, reply) => {
    const session = await authenticated(req, undefined, true);
    csrf(req, session);
    const body = req.body as { action?: OperatorStepUpActionContract; target?: string; returnPath?: string };
    if (!body.action || !STEP_UP_ACTIONS.includes(body.action) || !body.target) throw new Error('A valid step-up action and target are required.');
    const auth = await deps.provider.authorize(body.returnPath ?? '/', { sessionId: session.id, action: body.action, target: canonicalTarget(body.target) });
    await deps.store.saveLogin(auth.login, deps.provider.config.issuer);
    return { redirect: auth.url };
  });

  async function authenticated(req: FastifyRequest, action?: OperatorActionContract, allowNoAction = false): Promise<Session> {
    const session = await deps.store.session(cookie(req) ?? '');
    if (!session) throw new Error('An active operator session is required.');
    if (!allowNoAction && action && !session.actions.includes(action)) throw new Error(`The ${action} grant is required.`);
    return session;
  }
  function csrf(req: FastifyRequest, session: Session): void {
    if (req.headers['x-csrf-token'] !== session.csrf) throw new Error('CSRF token is invalid.');
  }
  app.post('/op/organisations/onboard', async (req) => {
    const session = await authenticated(req, 'onboard'); csrf(req, session);
    const body = req.body as OperatorOnboardRequest;
    return deps.control.onboard(principal(session), body.input, { validateOnly: body.validateOnly === true });
  });
  app.get('/op/organisations', async (req) => {
    await authenticated(req, 'status');
    const query = req.query as { q?: string; status?: string };
    return directory().listOrganisations(query);
  });
  app.get('/op/organisations/status', async (req) => {
    const session = await authenticated(req, 'status');
    const query = req.query as { code?: string; requestId?: string };
    if ((!query.code && !query.requestId) || (query.code && query.requestId)) throw new Error('Provide exactly one code or requestId.');
    return deps.control.status(principal(session), query);
  });
  app.post('/op/organisations/:requestId/retry', async (req) => {
    const session = await authenticated(req, 'retry'); csrf(req, session);
    return deps.control.retry(principal(session), (req.params as { requestId: string }).requestId);
  });
  for (const action of LIFECYCLE_ACTIONS) {
    app.post(`/op/organisations/:code/${action}`, async (req) => {
      const session = await authenticated(req, action); csrf(req, session);
      const code = canonicalTarget((req.params as { code: string }).code);
      const body = req.body as OperatorLifecycleRequest;
      if (!body.stepUpId || !(await deps.store.consumeStepUp(body.stepUpId, session.id, action, code))) throw new Error('A fresh, one-use MFA step-up is required.');
      if ((action === 'suspend' || action === 'close') && !body.reason?.trim()) throw new Error('A reason is required.');
      return deps.control[action](principal(session), code, body.reason ?? '', body.stepUpId);
    });
  }

  app.get('/op/organisations/:code/sign-in', async (req) => {
    const session = await authenticated(req, 'sign_in');
    return deps.control.signIn.get(principal(session), canonicalTarget((req.params as { code: string }).code));
  });
  /** A sign-in change: the grant, CSRF, a one-use step-up for `sign_in` on this organisation, and a reason. */
  async function signInChange(req: FastifyRequest): Promise<{ session: Session; code: string; body: OperatorSignInChange }> {
    const session = await authenticated(req, 'sign_in'); csrf(req, session);
    const code = canonicalTarget((req.params as { code: string }).code);
    const body = (req.body ?? {}) as OperatorSignInChange;
    if (!body.reason?.trim()) throw new Error('A reason is required.');
    if (!body.stepUpId || !(await deps.store.consumeStepUp(body.stepUpId, session.id, 'sign_in', code))) throw new Error('A fresh, one-use MFA step-up is required.');
    return { session, code, body };
  }
  const providerId = (req: FastifyRequest) => (req.params as { id: string }).id;
  app.put('/op/organisations/:code/sign-in/policy', async (req) => {
    const { session, code, body } = await signInChange(req);
    return deps.control.signIn.savePolicy(principal(session), code, (body as OperatorSignInPolicyRequest).policy, body.reason, body.stepUpId);
  });
  app.put('/op/organisations/:code/sign-in/providers/:id', async (req) => {
    const { session, code, body } = await signInChange(req);
    const provider = (body as OperatorProviderRequest).provider;
    return deps.control.signIn.saveProvider(principal(session), code, { ...provider, id: providerId(req) }, body.reason, body.stepUpId);
  });
  app.delete('/op/organisations/:code/sign-in/providers/:id', async (req) => {
    const { session, code, body } = await signInChange(req);
    return deps.control.signIn.removeProvider(principal(session), code, providerId(req), body.reason, body.stepUpId);
  });
  app.put('/op/organisations/:code/sign-in/providers/:id/policy', async (req) => {
    const { session, code, body } = await signInChange(req);
    return deps.control.signIn.setProviderPolicy(principal(session), code, providerId(req), (body as OperatorProviderPolicyRequest).policy, body.reason, body.stepUpId);
  });
  app.post('/op/organisations/:code/sign-in/providers/:id/test', async (req) => {
    const session = await authenticated(req, 'sign_in'); csrf(req, session);
    return deps.control.signIn.testProvider(principal(session), canonicalTarget((req.params as { code: string }).code), providerId(req));
  });

  const directory = (): OperatorDirectory => {
    if (!deps.directory) throw new Error('Operator directory is not configured.');
    return deps.directory;
  };
  const actor = (session: Session): OperatorActor => ({
    operatorId: session.operatorId, display: session.display, issuer: session.issuer, subject: session.subject,
    sessionId: session.id, authTime: session.authTime, amr: session.amr, acr: session.acr,
  });
  async function stepped(req: FastifyRequest, target: string): Promise<{ session: Session; stepUpId: string }> {
    const session = await authenticated(req, 'operators'); csrf(req, session);
    const stepUpId = (req.body as { stepUpId?: string }).stepUpId;
    if (!stepUpId || !(await deps.store.consumeStepUp(stepUpId, session.id, 'operators', canonicalTarget(target)))) {
      throw new Error('A fresh, one-use MFA step-up is required.');
    }
    return { session, stepUpId };
  }
  app.get('/op/operators', async (req) => {
    await authenticated(req, 'operators');
    const query = req.query as { q?: string; status?: string };
    return directory().list(query);
  });
  app.get('/op/operators/:id', async (req) => {
    await authenticated(req, 'operators');
    return directory().get((req.params as { id: string }).id);
  });
  app.post('/op/operators', async (req) => {
    const body = req.body as OperatorCreateRequest;
    operatorActions(body.actions);
    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!subject) throw new Error('A subject ID is required.');
    if (!displayName) throw new Error('A display name is required.');
    const { session, stepUpId } = await stepped(req, subject);
    return directory().create(actor(session), body, deps.provider.config.issuer, stepUpId);
  });
  app.put('/op/operators/:id/grants', async (req) => {
    const id = (req.params as { id: string }).id;
    const actions = operatorActions((req.body as OperatorGrantsRequest).actions);
    const { session, stepUpId } = await stepped(req, id);
    return directory().saveGrants(actor(session), id, actions, stepUpId);
  });
  app.put('/op/operators/:id/login', async (req) => {
    const id = (req.params as { id: string }).id;
    const subject = typeof (req.body as OperatorRelinkRequest).subject === 'string' ? (req.body as OperatorRelinkRequest).subject.trim() : '';
    if (!subject) throw new Error('A subject ID is required.');
    const { session, stepUpId } = await stepped(req, id);
    return directory().relink(actor(session), id, subject, deps.provider.config.issuer, stepUpId);
  });
  app.post('/op/operators/:id/disable', async (req) => {
    const id = (req.params as { id: string }).id;
    const reason = typeof (req.body as OperatorDisableRequest).reason === 'string' ? (req.body as OperatorDisableRequest).reason.trim() : '';
    if (!reason) throw new Error('A reason is required.');
    const { session, stepUpId } = await stepped(req, id);
    return directory().disable(actor(session), id, reason, stepUpId);
  });

  const activityQuery = (req: FastifyRequest, limit: number) => {
    const query = req.query as { q?: string; action?: string; from?: string; to?: string };
    return { q: query.q, action: query.action, from: query.from, to: query.to, limit };
  };
  app.get('/op/audit.csv', async (req, reply) => {
    await authenticated(req, 'audit');
    const csv = await directory().activityCsv(activityQuery(req, 5000));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="operator-activity.csv"').send(csv);
  });
  app.get('/op/audit', async (req) => {
    await authenticated(req, 'audit');
    const query = req.query as { limit?: string };
    const limit = query.limit ? Number(query.limit) : 50;
    if (!Number.isInteger(limit)) throw new Error('The limit is not a whole number.');
    return directory().activity(activityQuery(req, limit));
  });

  if (deps.webRoot) {
    app.register(fastifyStatic, { root: deps.webRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/op/') ? reply.status(404).send({ code: 'not_found' }) : reply.sendFile('index.html'));
  }
  return app;
}
