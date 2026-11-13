import { contracted, type ApiKeyView, type CreateApiKeyRequest, type CreatedApiKey, type RoleMembersRequest, type SettingsRequest } from '../contracts';
import type { HttpLike } from '../http/http';
import type { PersonItem } from '../people/people';
import type { AdminGateway, AuditEntry, ConnectorSummary, ConnectorView, Delivery, JobItem, JobRow, OrganisationLayout, OrganisationSettings, Paged, PublishedLayout, RoleMembersPage, RoleSummary, SaveConnector } from './admin';
import type { ThemeTokens } from '../models';

const enc = encodeURIComponent;

function qs(params: Record<string, string | number | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== undefined && v !== '') p.set(k, String(v));
  }
  return p.toString();
}

/** The address of the API documentation, generated from the organisation's own setup. */
export const API_DOCUMENTATION = '/api/openapi.json';

/** The administration routes with fixed contracts. */
export interface AdminRoutes {
  'POST /api/admin/roles/:key/members': { body: RoleMembersRequest; answer: void };
  'GET /api/admin/connectors': { answer: ConnectorSummary[] };
  'GET /api/admin/connectors/:key': { answer: ConnectorView };
  'PUT /api/admin/connectors/:key': { body: SaveConnector; answer: ConnectorView };
  'GET /api/admin/api-keys': { answer: ApiKeyView[] };
  'GET /api/admin/api-keys/feeds': { answer: { key: string; label: string }[] };
  'POST /api/admin/api-keys': { body: CreateApiKeyRequest; answer: CreatedApiKey };
  'PUT /api/admin/settings': { body: SettingsRequest; answer: OrganisationSettings };
}

export function httpAdmin(http: HttpLike): AdminGateway {
  const send = contracted<AdminRoutes>(http);
  const connector = (key: string) => `/api/admin/connectors/${enc(key)}`;
  const role = (key: string) => `/api/admin/roles/${enc(key)}/members`;
  return {
    roles: () => http.get<RoleSummary[]>('/api/admin/roles'),
    roleMembers: (key) => http.get<RoleMembersPage>(`${role(key)}?limit=200`),
    candidates: async (q) => (await http.get<{ items: PersonItem[] }>(`/api/admin/people?${qs({ q, status: ['active', 'invited'], limit: 10 })}`)).items,
    addRoleMembers: async (key, userIds) => {
      await send('POST /api/admin/roles/:key/members', { key }, { userIds });
    },
    removeRoleMember: (key, userId) => http.delete<void>(`${role(key)}/${enc(userId)}`),
    connectors: () => send('GET /api/admin/connectors'),
    connector: (key) => send('GET /api/admin/connectors/:key', { key }),
    saveConnector: (key, body) => send('PUT /api/admin/connectors/:key', { key }, body),
    testConnector: (key, input) => http.post(`${connector(key)}/test`, input ?? {}),
    startOauth: (key) => http.post<{ url: string }>(`${connector(key)}/oauth/start`),
    deliveries: (key) => http.get<Delivery[]>(`${connector(key)}/deliveries?limit=100`),
    retryDelivery: (key, id) => http.post<void>(`${connector(key)}/deliveries/${enc(id)}/retry`),
    apiKeys: () => send('GET /api/admin/api-keys'),
    dataFeeds: () => send('GET /api/admin/api-keys/feeds'),
    createApiKey: (input) => send('POST /api/admin/api-keys', input),
    revokeApiKey: (id) => http.delete<void>(`/api/admin/api-keys/${enc(id)}`),
    jobs: (q) => http.get<Paged<JobRow>>(`/api/admin/jobs?${qs({ status: q.status, limit: q.limit, offset: q.offset })}`),
    job: (id) => http.get<JobRow>(`/api/jobs/${enc(id)}`),
    failedItems: async (id) => (await http.get<{ items: JobItem[] }>(`/api/jobs/${enc(id)}/items?status=failed`)).items,
    cancelJob: (id) => http.post<JobRow>(`/api/jobs/${enc(id)}/cancel`),
    audit: (q) => http.get<Paged<AuditEntry>>(`/api/admin/audit?${qs({ ...q })}`),
    settings: () => http.get<OrganisationSettings>('/api/admin/settings'),
    saveSettings: (change) => send('PUT /api/admin/settings', change),
    saveTheme: (body) => http.put<ThemeTokens>('/api/admin/theme', body),
    layout: () => http.get<OrganisationLayout>('/api/admin/layout'),
    saveLayout: (body) => http.put<PublishedLayout>('/api/admin/layout', body),
  };
}
