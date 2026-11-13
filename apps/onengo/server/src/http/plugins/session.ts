import type { FastifyInstance } from 'fastify';
import type { PinInput, SessionApi } from '@onengo/platform/main';
import { contextOf } from '../context.js';
import {
  passkeyNameRequest,
  passkeyReauthRequest,
  passkeyRegisterRequest,
  twoStepBeginRequest,
  twoStepConfirmRequest,
  type PasskeyNameRequest,
  type PasskeyReauthRequest,
  type PasskeyRegisterRequest,
  type TwoStepBeginRequest,
  type TwoStepConfirmRequest,
} from '@onengo/platform/contracts';

/** The signed-in person's own session, app definitions, pins, two-step setup and notifications. Signed-in scope only. */
export async function sessionRoutes(api: FastifyInstance, { deps }: { deps: SessionApi }): Promise<void> {
  api.get('/api/people/me', async (req) => deps.me.of(contextOf(req)));

  /** Record types, workflows, groups, actions and pages the signed-in person may use, in their language. */
  api.get<{ Querystring: { locale?: string } }>('/api/runtime/definitions', async (req) =>
    deps.runtime.definitions(contextOf(req), req.query.locale),
  );

  /** Screen text in the person's language: the shipped catalogue, then the organisation's own wording. */
  api.get<{ Querystring: { locale?: string } }>('/api/runtime/messages', async (req) =>
    deps.runtime.messages(contextOf(req), req.query.locale),
  );

  api.put<{ Body: { locale?: string } }>('/api/me/locale', async (req) =>
    deps.runtime.setLocale(contextOf(req), String(req.body?.locale ?? '')),
  );

  /** Lists pinned to the caller's own Home: { label, listView, address } where address is a record list of the app. */
  api.get('/api/me/pins', async (req) => deps.pins.list(contextOf(req)));
  api.post<{ Body: PinInput }>('/api/me/pins', async (req, reply) => reply.status(201).send(await deps.pins.add(contextOf(req), req.body ?? {})));
  api.put<{ Body: { ids?: unknown } }>('/api/me/pins/order', async (req) => deps.pins.reorder(contextOf(req), req.body?.ids));
  api.patch<{ Params: { id: string }; Body: { label?: unknown } }>('/api/me/pins/:id', async (req) =>
    deps.pins.rename(contextOf(req), req.params.id, req.body?.label),
  );
  api.delete<{ Params: { id: string } }>('/api/me/pins/:id', async (req, reply) => {
    await deps.pins.remove(contextOf(req), req.params.id);
    return reply.status(204).send();
  });

  api.post<{ Body: TwoStepBeginRequest }>('/api/auth/two-step/begin', { schema: { body: twoStepBeginRequest } }, async (req) =>
    deps.identity.beginTwoStep(contextOf(req), { password: req.body.password, totpCode: req.body.totpCode, ip: req.ip }),
  );
  api.post<{ Body: TwoStepConfirmRequest }>('/api/auth/two-step/confirm', { schema: { body: twoStepConfirmRequest } }, async (req, reply) => {
    await deps.identity.confirmTwoStep(contextOf(req), req.body.code);
    return reply.status(204).send();
  });

  /** The person's passkeys. Adding and removing one re-proves the person first, once two-step is on. */
  api.get('/api/me/passkeys', async (req) => deps.passkeys.list(contextOf(req)));
  api.post<{ Body: PasskeyReauthRequest }>('/api/me/passkeys/begin', { schema: { body: passkeyReauthRequest } }, async (req) =>
    deps.passkeys.registrationOptions(contextOf(req), { ...(req.body ?? {}), ip: req.ip }),
  );
  api.post<{ Body: PasskeyRegisterRequest }>('/api/me/passkeys/confirm', { schema: { body: passkeyRegisterRequest } }, async (req, reply) =>
    reply.status(201).send(await deps.passkeys.register(contextOf(req), req.body)),
  );
  api.patch<{ Params: { id: string }; Body: PasskeyNameRequest }>('/api/me/passkeys/:id', { schema: { body: passkeyNameRequest } }, async (req) =>
    deps.passkeys.rename(contextOf(req), req.params.id, req.body.name),
  );
  api.post<{ Params: { id: string }; Body: PasskeyReauthRequest }>('/api/me/passkeys/:id/revoke', { schema: { body: passkeyReauthRequest } }, async (req, reply) => {
    await deps.passkeys.revoke(contextOf(req), req.params.id, { ...(req.body ?? {}), ip: req.ip });
    return reply.status(204).send();
  });

  /** Newest first, as before; `x-next-before` carries the cursor for the next page when there is one. */
  api.get<{ Querystring: { unread?: string; limit?: string; before?: string } }>('/api/notifications', async (req, reply) => {
    const page = await deps.notifications.inboxPage(contextOf(req), {
      unreadOnly: req.query.unread === 'true',
      limit: Number(req.query.limit) || undefined,
      before: req.query.before || undefined,
    });
    if (page.next) reply.header('x-next-before', page.next);
    return page.items;
  });
  api.post('/api/notifications/read-all', async (req) => ({ marked: await deps.notifications.markAllRead(contextOf(req)) }));
  api.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (req, reply) => {
    await deps.notifications.markRead(contextOf(req), req.params.id);
    return reply.status(204).send();
  });
}
