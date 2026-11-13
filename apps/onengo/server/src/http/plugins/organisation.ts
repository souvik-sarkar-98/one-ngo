import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientAddressKey } from '../client-address.js';
import { organisationManifest, validationFailed, type OrganisationApi, type PublicOrganisationApi, type StoredLogo } from '@onengo/platform/main';
import { contextOf } from '../context.js';
import {
  organisationProfileRequest,
  registrationRequest,
  signatoryRequest,
  type OrganisationProfileRequest,
  type RegistrationRequest,
  type SignatoryRequest,
} from '@onengo/platform/contracts';

function sendLogo(reply: FastifyReply, logo: StoredLogo) {
  return sendImage(reply, logo, 'logo');
}

function sendImage(reply: FastifyReply, image: StoredLogo, filename: string) {
  return reply
    .type(image.file.mime)
    .header('content-length', image.file.size)
    .header('content-disposition', `inline; filename="${filename}"`)
    .header('x-content-type-options', 'nosniff')
    .send(image.body);
}

/** Every lookup answers no sooner than this, found or not, so timing does not tell codes apart. */
export const ORGANISATION_LOOKUP_FLOOR_MS = 150;

/**
 * Before sign-in: the organisation-specific sign-in page (/o/<code>/sign-in)
 * resolves its code to the display name, logo, published theme colours and
 * sign-in providers of an active organisation. The browser reads that
 * organisation's web app manifest from here when the app is installed. Unknown and inactive codes
 * get the same 404. Under
 * /api/auth/, so the sign-in rate limit applies; on top of that the lookups
 * have their own tighter per-address limit and a fixed minimum response time,
 * which slows guessing which codes exist.
 */
export async function publicOrganisationRoutes(
  app: FastifyInstance,
  { deps, limiter }: { deps: PublicOrganisationApi; limiter: { hit(key: string): boolean } },
): Promise<void> {
  const uniform = async <T>(req: FastifyRequest, reply: FastifyReply, answer: () => Promise<T>): Promise<T | FastifyReply> => {
    if (!limiter.hit(`org:${clientAddressKey(req.ip)}`)) {
      return reply.status(429).header('retry-after', '60').send({ code: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' });
    }
    const until = Date.now() + ORGANISATION_LOOKUP_FLOOR_MS;
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
    try {
      const value = await answer();
      await settle();
      return value;
    } catch (error) {
      await settle();
      throw error;
    }
  };
  app.get<{ Params: { code: string } }>('/api/auth/organisations/:code', async (req, reply) =>
    uniform(req, reply, async () => {
      const { logoMime: _logoMime, ...identity } = await deps.signIn.identity(req.params.code);
      return identity;
    }),
  );
  app.get<{ Params: { code: string } }>('/api/auth/organisations/:code/logo', async (req, reply) =>
    uniform(req, reply, async () => sendLogo(reply, await deps.logos.signInLogo(req.params.code))),
  );
  app.get<{ Params: { code: string; size: string } }>('/api/auth/organisations/:code/icon/:size', async (req, reply) =>
    uniform(req, reply, async () => {
      const png = await deps.logos.installIcon(req.params.code, Number(req.params.size));
      return reply.type('image/png').header('content-length', png.length).header('x-content-type-options', 'nosniff').send(png);
    }),
  );
  app.get<{ Params: { code: string } }>('/api/auth/organisations/:code/manifest.webmanifest', async (req, reply) =>
    uniform(req, reply, async () => {
      const identity = await deps.signIn.identity(req.params.code);
      return reply
        .type('application/manifest+json')
        .header('cache-control', 'no-store')
        .send(organisationManifest({ code: identity.code, displayName: identity.displayName, theme: identity.theme, logoUrl: identity.logoUrl, logoMime: identity.logoMime }));
    }),
  );
}

/** The organisation's own identity, registrations, logo and setup checklist. Signed-in scope only. */
export async function organisationRoutes(api: FastifyInstance, { deps }: { deps: OrganisationApi }): Promise<void> {
  /** Any member: the display name and logo for the shell. */
  api.get('/api/organisation', async (req) => deps.organisation.branding(contextOf(req)));
  api.get('/api/organisation/logo', async (req, reply) => sendLogo(reply, await deps.organisation.logo(contextOf(req))));
  /** The current logo or one an issued receipt keeps (the receipt print view). */
  api.get<{ Params: { fileId: string } }>('/api/organisation/logos/:fileId', async (req, reply) =>
    sendLogo(reply, await deps.organisation.keptLogo(contextOf(req), req.params.fileId)),
  );
  /** For settings, or with `?receipt=` naming a receipt the person can read that shows this signature (the print view). */
  api.get<{ Params: { fileId: string }; Querystring: { receipt?: string } }>('/api/organisation/signatories/:fileId', async (req, reply) =>
    sendImage(reply, await deps.signatures.run(contextOf(req), req.params.fileId, req.query.receipt), 'signature'),
  );

  api.get('/api/admin/organisation', async (req) => deps.organisation.view(contextOf(req)));
  api.put<{ Body: OrganisationProfileRequest }>('/api/admin/organisation/profile', { schema: { body: organisationProfileRequest } }, async (req) =>
    deps.organisation.saveProfile(contextOf(req), req.body),
  );
  api.post<{ Body: RegistrationRequest }>('/api/admin/organisation/registrations', { schema: { body: registrationRequest } }, async (req, reply) =>
    reply.status(201).send(await deps.organisation.addRegistration(contextOf(req), req.body)),
  );
  api.put<{ Params: { id: string }; Body: RegistrationRequest }>(
    '/api/admin/organisation/registrations/:id',
    { schema: { body: registrationRequest } },
    async (req) => deps.organisation.updateRegistration(contextOf(req), req.params.id, req.body),
  );
  api.delete<{ Params: { id: string } }>('/api/admin/organisation/registrations/:id', async (req, reply) => {
    await deps.organisation.removeRegistration(contextOf(req), req.params.id);
    return reply.status(204).send();
  });
  api.get('/api/admin/organisation/setup', async (req) => deps.organisation.setup(contextOf(req)));
  /** `identity` or `receiptSeries`. */
  api.post<{ Params: { step: string } }>('/api/admin/organisation/setup/:step/confirm', async (req) =>
    deps.organisation.confirmSetup(contextOf(req), req.params.step),
  );

  api.put<{ Body: SignatoryRequest }>('/api/admin/organisation/signatory', { schema: { body: signatoryRequest } }, async (req) =>
    deps.organisation.saveSignatory(contextOf(req), req.body),
  );

  /** The image itself is the request body, as for file uploads. */
  api.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    scope.put('/api/admin/organisation/signatory/image', async (req) => {
      const ctx = contextOf(req);
      if (/^multipart\//i.test(req.headers['content-type'] ?? '')) throw validationFailed('Send the image itself as the request body, not a form.');
      const body = (req.body as AsyncIterable<Buffer> | undefined) ?? [];
      return deps.organisation.setSignatoryImage(ctx, { body, name: 'signature.png' });
    });
    scope.put('/api/admin/organisation/logo', async (req) => {
      const ctx = contextOf(req);
      if (/^multipart\//i.test(req.headers['content-type'] ?? '')) {
        throw validationFailed('Send the image itself as the request body, not a form.');
      }
      const body = (req.body as AsyncIterable<Buffer> | undefined) ?? [];
      return deps.organisation.setLogo(ctx, { body, name: 'logo' });
    });
  });
  api.delete('/api/admin/organisation/signatory', async (req, reply) => {
    await deps.organisation.removeSignatory(contextOf(req));
    return reply.status(204).send();
  });
  api.delete('/api/admin/organisation/logo', async (req, reply) => {
    await deps.organisation.removeLogo(contextOf(req));
    return reply.status(204).send();
  });
}
