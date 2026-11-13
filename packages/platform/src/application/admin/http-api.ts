import type { JobsPort } from '../files/http-api.js';
import type { AccessReports, ApiKeyAdmin, AuditAndSettings, ConnectorAdmin, ConnectorCatalogue, MemberLookup, MemberRoleAssignment, PeopleAdmin, PublishedDefinitions, RoleAdmin } from './ports/admin-ports.js';
import { allOf, dateOf, listOf, pageOf } from '../../runtime/definitions/list-params.js';
import type { RequestContext } from '../shared/http-api.js';
import type { OpenApiDocument } from './openapi-document.js';
import type { OAuthCredentials } from '../connectors/oauth-credentials.js';

export type { SaveConnectorInput } from '../connectors/connector-service.js';

/** Roles and access, people and members, audit, settings, jobs, connectors, API keys and the OpenAPI document. */
export interface AdminApi {
  roles: RoleAdmin;
  access: AccessReports;
  people: PeopleAdmin;
  administration: AuditAndSettings;
  apiKeys: ApiKeyAdmin;
  connectors: ConnectorAdmin;
  connectorOauth: Pick<OAuthCredentials, 'start'>;
  memberRoles: MemberRoles;
  jobs: AdminJobs;
  connectorOverview: ConnectorOverview;
  openApi: OpenApiDocument;
}

/** Changes a member's roles and answers with the member as they now are. */
export class MemberRoles {
  constructor(
    private readonly roles: MemberRoleAssignment,
    private readonly people: MemberLookup,
  ) {}

  async set(ctx: RequestContext, userId: string, body: Parameters<MemberRoleAssignment['setMemberRoles']>[2]) {
    await this.roles.setMemberRoles(ctx, userId, body);
    return this.people.member(ctx, userId);
  }
}

/** Everyone's jobs, filtered by a list query's parts. */
export class AdminJobs {
  constructor(private readonly jobs: Pick<JobsPort, 'list'>) {}

  list(ctx: RequestContext, q: Record<string, unknown>) {
    return this.jobs.list(ctx, {
      kind: listOf(q.kind ?? q['kind[]']),
      status: allOf(listOf(q.status ?? q['status[]']), ['queued', 'running', 'done', 'failed', 'cancelled'] as const, 'status'),
      startedBy: typeof q.startedBy === 'string' && q.startedBy ? q.startedBy : undefined,
      from: dateOf(q.from, 'from'),
      to: dateOf(q.to, 'to'),
      ...pageOf(q.limit, q.offset),
    });
  }
}

/** Every connector, with the published actions, automations, workflows, scripts and record types that send through it. */
export class ConnectorOverview {
  constructor(
    private readonly definitions: PublishedDefinitions,
    private readonly connectors: ConnectorCatalogue,
  ) {}

  async list(ctx: RequestContext) {
    const kinds = ['action', 'automation', 'workflow', 'script', 'recordType'] as const;
    const users = (await Promise.all(kinds.map((k) => this.definitions.list(ctx.tenantId, k)))).flat().map((d) => {
      const body = d.body as unknown as { key: string; label?: string };
      return { label: body.label ?? body.key, body };
    });
    return this.connectors.list(ctx, users);
  }
}

export { OpenApiDocument, type OpenApiKit } from './openapi-document.js';
