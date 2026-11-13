import type { Params } from '../address';
import { memoryPeople } from '../people/testing';
import type { AdminGateway, ApiKey, AuditEntry, ConnectorView, Delivery, JobRow, OrganisationSettings, RoleSummary } from './admin';

const fail = (code: string, message: string) => Object.assign(new Error(message), { code, issues: [] as { path: string; message: string }[] });

/** Administration's API in memory, sharing the people of Journey 21. */
export function memoryAdmin() {
  const people = memoryPeople();
  const calls: { op: string; args: unknown[] }[] = [];
  const log = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const roles: Omit<RoleSummary, 'members'>[] = [
    { key: 'admin', label: 'Admin', requireTwoStep: true },
    { key: 'finance', label: 'Finance', requireTwoStep: true },
    { key: 'viewer', label: 'Viewer', requireTwoStep: false },
  ];
  const keys: ApiKey[] = [{ id: 'k1', name: 'Website form', role: 'finance', feed: null, createdBy: 'u-asha', createdAt: '2026-09-02T00:00:00.000Z', lastUsedAt: null, revokedAt: null }];
  const connectors: ConnectorView[] = [{ key: 'crm', kind: 'webhook', enabled: true, configured: true, config: { url: 'https://crm.test/in' }, secrets: ['signingSecret'], oauth: null, updatedBy: 'u-asha', updatedAt: '2026-10-01T00:00:00.000Z' }];
  const deliveries: Delivery[] = [
    { id: 'd1', event: 'action.tellCrm', recordId: 'r1', status: 'failed', attempts: 5, responseStatus: 500, error: 'down', createdAt: '2026-10-24T09:00:00.000Z', lastAttemptAt: null },
    { id: 'd2', event: 'action.tellCrm', recordId: 'r2', status: 'sent', attempts: 1, responseStatus: 200, error: null, createdAt: '2026-10-24T10:00:00.000Z', lastAttemptAt: null },
  ];
  const jobs: JobRow[] = [
    { id: 'j1', kind: 'import', label: 'Import', status: 'running', progress: 640, total: 1204, result: null, error: null, createdBy: 'u-asha', createdByName: 'Asha Shetty', createdAt: '2026-10-24T10:40:00.000Z', startedAt: null, finishedAt: null },
    { id: 'j2', kind: 'bulk', label: 'Bulk', status: 'failed', progress: 214, total: 214, result: null, error: null, createdBy: 'u-ravi', createdByName: 'Ravi Kumar', createdAt: '2026-10-24T09:58:00.000Z', startedAt: null, finishedAt: null },
  ];
  const audit: AuditEntry[] = Array.from({ length: 45 }, (_, i) => ({
    id: 45 - i,
    at: new Date(Date.UTC(2026, 9, 24, 10, 45 - i)).toISOString(),
    actorId: i % 3 ? 'u-asha' : 'api:Website form',
    actorName: i % 3 ? 'Asha Shetty' : 'Website form',
    action: i % 2 ? 'member.suspended' : 'record.created',
    entity: i % 2 ? 'member' : 'record:donation',
    entityId: `e${i}`,
    area: i % 2 ? 'people' : 'records',
    recordType: i % 2 ? null : 'donation',
  }));
  let settings: OrganisationSettings = { name: 'Demo Foundation', legalName: 'Demo Foundation Trust', defaultLanguage: 'en', languages: ['en', 'hi'], storage: { usedBytes: 412 * 1024 ** 2, quotaBytes: 1024 ** 3 }, apiRequestsPerMinute: 120, corsOrigins: [], financialYearStartMonth: 4, financialYearFixed: false };

  const gateway: AdminGateway = {
    async roles() {
      log('roles');
      return roles.map((r) => ({ ...r, members: people.people.filter((p) => p.roles.includes(r.key)).length }));
    },
    async roleMembers(role) {
      log('roleMembers', role);
      const r = roles.find((x) => x.key === role);
      if (!r) throw fail('not_found', `Role '${role}' does not exist.`);
      const page = await people.gateway.members({ role: [role], limit: 200, offset: 0 });
      return { role: { key: r.key, label: r.label }, items: page.items, total: page.total, roles: page.roles };
    },
    async candidates(q) {
      log('candidates', q);
      return (await people.gateway.members({ q, status: ['active', 'invited'], limit: 10, offset: 0 })).items;
    },
    async addRoleMembers(role, ids) {
      log('addRoleMembers', role, ids);
      await people.gateway.addToRole(role, ids);
    },
    async removeRoleMember(role, id) {
      log('removeRoleMember', role, id);
      await people.gateway.removeFromRole(role, id);
    },
    async connectors() {
      return connectors.map((c) => ({ key: c.key, kind: c.kind, enabled: c.enabled, configured: c.configured, usedBy: ['Tell the CRM'], lastDelivery: { status: 'sent' as const, at: deliveries[1]!.createdAt } }));
    },
    async connector(key) {
      log('connector', key);
      const c = connectors.find((x) => x.key === key);
      if (!c) throw fail('not_found', `Connector '${key}' is not set up.`);
      return c;
    },
    async saveConnector(key, body) {
      log('saveConnector', key, body);
      const existing = connectors.find((x) => x.key === key);
      const secrets = [...new Set([...(existing?.secrets ?? []), ...Object.keys(body.secrets ?? {})])].sort();
      const kind = existing?.kind ?? body.kind!;
      const oauth = kind === 'oauth' ? { connected: secrets.includes('refreshToken'), expiresAt: null } : null;
      const next: ConnectorView = { key, kind, enabled: !!body.enabled, configured: secrets.includes('signingSecret'), config: body.config ?? {}, secrets, oauth, updatedBy: 'u-asha', updatedAt: '2026-10-24T00:00:00.000Z' };
      if (existing) Object.assign(existing, next);
      else connectors.push(next);
      return next;
    },
    async testConnector(key, input) {
      log('testConnector', key, input);
      const c = connectors.find((x) => x.key === key);
      if (c?.kind === 'http' && c.config['mode'] === 'lookup') return { ok: true, status: null, message: `Looked up ${JSON.stringify({ bankName: 'HDFC Bank' })}.` };
      return { ok: true, status: 200 };
    },
    async startOauth(key) {
      log('startOauth', key);
      return { url: `https://provider.test/auth?connector=${key}` };
    },
    async deliveries(key) {
      log('deliveries', key);
      return deliveries.map((d) => ({ ...d }));
    },
    async retryDelivery(key, id) {
      log('retryDelivery', key, id);
      const d = deliveries.find((x) => x.id === id)!;
      if (d.status === 'sent') throw fail('rule_violation', 'This delivery was already sent.');
      d.status = 'pending';
    },
    async apiKeys() {
      log('apiKeys');
      return keys.map((k) => ({ ...k }));
    },
    async dataFeeds() {
      log('dataFeeds');
      return [];
    },
    async createApiKey(input) {
      log('createApiKey', input.name, input.role, input.feed);
      const key: ApiKey = { id: `k${keys.length + 1}`, name: input.name, role: input.role ?? null, feed: input.feed ?? null, createdBy: 'u-asha', createdAt: '2026-10-24T00:00:00.000Z', lastUsedAt: null, revokedAt: null };
      keys.push(key);
      return { ...key, token: `${key.id}.sk_secret_value_123` };
    },
    async revokeApiKey(id) {
      log('revokeApiKey', id);
      keys.find((k) => k.id === id)!.revokedAt = '2026-10-24T00:00:00.000Z';
    },
    async jobs(q) {
      log('jobs', q);
      const all = jobs.filter((j) => !q.status || q.status.includes(j.status));
      return { items: all.slice(q.offset, q.offset + q.limit), total: all.length };
    },
    async job(id) {
      return jobs.find((j) => j.id === id)!;
    },
    async failedItems(id) {
      log('failedItems', id);
      return id === 'j2' ? [{ seq: 31, status: 'failed', recordId: 'DON/00031', message: 'Paid on cannot be before the donation date.' }] : [];
    },
    async cancelJob(id) {
      log('cancelJob', id);
      const j = jobs.find((x) => x.id === id)!;
      if (j.status !== 'running' && j.status !== 'queued') throw fail('conflict', 'This job has already finished.');
      j.status = 'cancelled';
      return { ...j };
    },
    async audit(q) {
      log('audit', q);
      const all = audit.filter((e) => (!q.person || e.actorId === q.person) && (!q.area || e.area === q.area) && (!q.recordType || e.recordType === q.recordType));
      return { items: all.slice(q.offset, q.offset + q.limit), total: all.length };
    },
    async settings() {
      return settings;
    },
    async saveTheme(body) {
      log('saveTheme', body);
      return body;
    },
    async layout() {
      return { items: null, listLayout: 'table' as const, icons: null };
    },
    async saveLayout(body) {
      log('saveLayout', body);
      return body;
    },
    async saveSettings(change) {
      log('saveSettings', change);
      settings = {
        ...settings,
        ...(change.name && { name: change.name }),
        ...(change.defaultLanguage && { defaultLanguage: change.defaultLanguage }),
        ...(change.apiRequestsPerMinute && { apiRequestsPerMinute: change.apiRequestsPerMinute }),
        ...(change.corsOrigins !== undefined && { corsOrigins: change.corsOrigins }),
        ...(change.financialYearStartMonth && { financialYearStartMonth: change.financialYearStartMonth }),
        ...(change.storageQuotaBytes !== undefined && { storage: { ...settings.storage, quotaBytes: change.storageQuotaBytes } }),
      };
      return settings;
    },
  };
  return { gateway, calls, people };
}

/** A fake address bar: records every write and keeps the current parameters. */
export function fakeAddress(start: Record<string, string> = {}, onChange?: (read: (n: string) => string | null) => void) {
  const urls: { params: Params; replace: boolean }[] = [];
  let params: Record<string, string> = { ...start };
  return {
    urls,
    params: () => params,
    read: (n: string) => params[n] ?? null,
    nav: {
      navigate(next: Params, replace: boolean) {
        urls.push({ params: next, replace });
        params = Object.fromEntries(Object.entries({ ...params, ...next }).filter(([, v]) => v !== null)) as Record<string, string>;
        onChange?.((n) => params[n] ?? null);
      },
    },
  };
}
