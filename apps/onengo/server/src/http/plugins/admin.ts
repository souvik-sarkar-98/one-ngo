import type { FastifyInstance } from 'fastify';
import type { AdminApi, SaveConnectorInput } from '@onengo/platform/main';
import { contextOf } from '../context.js';
import { apiKeyFeedListResponse, apiKeyListResponse, createApiKeyRequest, createdApiKeyResponse, type ApiKeyFeedChoice, type ApiKeyView, type CreateApiKeyRequest, type CreatedApiKey } from '@onengo/platform/contracts';
import {
  connectorListResponse,
  connectorOauthStartResponse,
  connectorResponse,
  connectorTestRequest,
  type ConnectorOauthStartResponse,
  type ConnectorSummary,
  type ConnectorTestRequest,
  type ConnectorView,
} from '@onengo/platform/contracts';
import { addMemberRequest, memberRolesRequest, type AddMemberRequest, type MemberRolesRequest } from '@onengo/platform/contracts';
import {
  createRoleRequest,
  roleMembersRequest,
  updateRoleRequest,
  type CreateRoleRequest,
  type RoleMembersRequest,
  type UpdateRoleRequest,
} from '@onengo/platform/contracts';
import { settingsRequest, type SettingsRequest } from '@onengo/platform/contracts';
/** Roles and access, people and members, audit, settings, jobs, connectors, API keys and the OpenAPI document. Signed-in scope only. */
export async function adminRoutes(api: FastifyInstance, { deps }: { deps: AdminApi }): Promise<void> {
  api.get('/api/admin/roles', async (req) => deps.roles.list(contextOf(req)));
  api.post<{ Body: CreateRoleRequest }>('/api/admin/roles', { schema: { body: createRoleRequest } }, async (req, reply) =>
    reply.status(201).send(await deps.roles.create(contextOf(req), req.body)),
  );
  api.get<{ Params: { key: string } }>('/api/admin/roles/:key', async (req) => deps.roles.get(contextOf(req), req.params.key));
  api.put<{ Params: { key: string }; Body: UpdateRoleRequest }>('/api/admin/roles/:key', { schema: { body: updateRoleRequest } }, async (req) =>
    deps.roles.update(contextOf(req), req.params.key, req.body),
  );
  api.delete<{ Params: { key: string } }>('/api/admin/roles/:key', async (req, reply) => {
    await deps.roles.remove(contextOf(req), req.params.key);
    return reply.status(204).send();
  });
  api.get('/api/admin/permission-catalogue', async (req) => deps.roles.catalogue(contextOf(req)));
  api.get<{ Querystring: { q?: string } }>('/api/admin/permission-suggestions', async (req) => deps.access.suggestions(contextOf(req), req.query.q));
  api.get<{ Querystring: { area?: string; recordType?: string; role?: string; problems?: string } }>('/api/admin/access-map', async (req) =>
    deps.access.accessMap(contextOf(req), {
      area: req.query.area,
      recordType: req.query.recordType,
      role: req.query.role,
      problems: req.query.problems === 'true',
    }),
  );

  type ListQuery = { Querystring: Record<string, unknown> };
  const listQuery = (q: Record<string, unknown>) => ({ ...q, role: q.role ?? q['role[]'], status: q.status ?? q['status[]'] });
  /** ?q=&role=&status=&sort=name|joined|status&dir=&limit=&offset= → { items, total, limit, offset, counts, roles }. */
  api.get<ListQuery>('/api/admin/people', async (req) => deps.people.list(contextOf(req), listQuery(req.query)));
  /** { email, displayName, roles[], invite? } → 201 { userId, email, displayName, invited }. */
  api.post<{ Body: AddMemberRequest }>('/api/admin/people', { schema: { body: addMemberRequest } }, async (req, reply) =>
    reply.status(201).send(await deps.people.add(contextOf(req), req.body)),
  );
  api.get<{ Params: { userId: string } }>('/api/admin/people/:userId', async (req) => deps.people.member(contextOf(req), req.params.userId));
  api.put<{ Params: { userId: string }; Body: MemberRolesRequest }>('/api/admin/people/:userId/roles', { schema: { body: memberRolesRequest } }, async (req) => {
    return deps.memberRoles.set(contextOf(req), req.params.userId, req.body);
  });
  /** Also "Resend invitation": a new single-use link, and the earlier one stops working. */
  api.post<{ Params: { userId: string } }>('/api/admin/people/:userId/invite', async (req, reply) => {
    await deps.people.invite(contextOf(req), req.params.userId);
    return reply.status(204).send();
  });
  api.post<{ Params: { userId: string } }>('/api/admin/people/:userId/suspend', async (req) => deps.people.suspend(contextOf(req), req.params.userId));
  api.post<{ Params: { userId: string } }>('/api/admin/people/:userId/reactivate', async (req) =>
    deps.people.reactivate(contextOf(req), req.params.userId),
  );
  /**
   * The directory (`people:read`): active people with name, email and roles.
   * `?pick=1&q=`: active members for a person field's picker.
   */
  api.get<ListQuery>('/api/people', async (req) => {
    const ctx = contextOf(req);
    return req.query.pick ? deps.people.pick(ctx, req.query) : deps.people.directory(ctx, listQuery(req.query));
  });
  api.get<{ Params: { key: string } } & ListQuery>('/api/admin/roles/:key/members', async (req) =>
    deps.people.roleMembers(contextOf(req), req.params.key, listQuery(req.query)),
  );
  api.post<{ Params: { key: string }; Body: RoleMembersRequest }>('/api/admin/roles/:key/members', { schema: { body: roleMembersRequest } }, async (req) =>
    deps.people.addRoleMembers(contextOf(req), req.params.key, req.body),
  );
  api.delete<{ Params: { key: string; userId: string } }>('/api/admin/roles/:key/members/:userId', async (req, reply) => {
    await deps.people.removeRoleMember(contextOf(req), req.params.key, req.params.userId);
    return reply.status(204).send();
  });
  /** ?person=<userId | api:name>&area=&recordType=&from=&to=&limit=&offset= */
  api.get<ListQuery>('/api/admin/audit', async (req) => deps.administration.audit(contextOf(req), req.query));
  api.get('/api/admin/settings', async (req) => deps.administration.settings(contextOf(req)));
  api.put<{ Body: SettingsRequest }>('/api/admin/settings', { schema: { body: settingsRequest } }, async (req) =>
    deps.administration.saveSettings(contextOf(req), req.body),
  );
  api.put('/api/admin/theme', async (req) => deps.administration.saveTheme(contextOf(req), req.body));
  api.get('/api/admin/layout', async (req) => deps.administration.layout(contextOf(req)));
  api.put('/api/admin/layout', async (req) => deps.administration.saveLayout(contextOf(req), req.body));
  /** Everyone's jobs: ?kind=&status=&startedBy=&from=&to=&limit=&offset= */
  api.get<ListQuery>('/api/admin/jobs', async (req) => {
    return deps.jobs.list(contextOf(req), req.query);
  });

  /** Every SMS, WhatsApp and webhook connector, with the published actions, automations and workflows that send through it. */
  api.get<{ Reply: ConnectorSummary[] }>('/api/admin/connectors', { schema: { response: { 200: connectorListResponse } } }, async (req) => {
    return deps.connectorOverview.list(contextOf(req));
  });
  api.post<{ Params: { key: string; id: string } }>('/api/admin/connectors/:key/deliveries/:id/retry', async (req, reply) => {
    await deps.connectors.retry(contextOf(req), req.params.key, req.params.id);
    return reply.status(204).send();
  });
  const connectorView = { response: { 200: connectorResponse } };
  api.get<{ Params: { key: string }; Reply: ConnectorView }>('/api/admin/connectors/:key', { schema: connectorView }, async (req) =>
    deps.connectors.get(contextOf(req), req.params.key),
  );
  api.put<{ Params: { key: string }; Body: SaveConnectorInput; Reply: ConnectorView }>('/api/admin/connectors/:key', { schema: connectorView }, async (req) =>
    deps.connectors.save(contextOf(req), req.params.key, req.body ?? {}),
  );
  /** { to?, inputs? }: `to` for an SMS, WhatsApp or email test, `inputs` for an http lookup's placeholders. */
  api.post<{ Params: { key: string }; Body: ConnectorTestRequest }>('/api/admin/connectors/:key/test', { schema: { body: connectorTestRequest } }, async (req) =>
    deps.connectors.test(contextOf(req), req.params.key, { to: req.body?.to, inputs: req.body?.inputs }),
  );
  /** An oauth connector's provider address; the browser goes there and comes back to /api/connectors/oauth/callback. */
  api.post<{ Params: { key: string }; Reply: ConnectorOauthStartResponse }>(
    '/api/admin/connectors/:key/oauth/start',
    { schema: { response: { 200: connectorOauthStartResponse } } },
    async (req) => ({ url: await deps.connectorOauth.start(contextOf(req), req.params.key) }),
  );
  api.get<{ Params: { key: string }; Querystring: { limit?: string; offset?: string } }>('/api/admin/connectors/:key/deliveries', async (req) =>
    deps.connectors.deliveries(contextOf(req), req.params.key, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    }),
  );

  api.get<{ Reply: ApiKeyView[] }>('/api/admin/api-keys', { schema: { response: { 200: apiKeyListResponse } } }, async (req) =>
    deps.apiKeys.list(contextOf(req)),
  );
  /** Published data feeds a new key can be bound to. */
  api.get<{ Reply: ApiKeyFeedChoice[] }>('/api/admin/api-keys/feeds', { schema: { response: { 200: apiKeyFeedListResponse } } }, async (req) =>
    deps.apiKeys.feeds(contextOf(req)),
  );
  /** { name, role } or { name, feed } → the key with `token` (`<id>.<secret>`), which is shown only this once. */
  api.post<{ Body: CreateApiKeyRequest; Reply: CreatedApiKey }>(
    '/api/admin/api-keys',
    { schema: { body: createApiKeyRequest, response: { 201: createdApiKeyResponse } } },
    async (req, reply) => reply.status(201).send(await deps.apiKeys.create(contextOf(req), req.body)),
  );
  api.delete<{ Params: { id: string } }>('/api/admin/api-keys/:id', async (req, reply) => {
    await deps.apiKeys.revoke(contextOf(req), req.params.id);
    return reply.status(204).send();
  });
  api.get('/api/openapi.json', async (req) => deps.openApi.build(contextOf(req)));
}
