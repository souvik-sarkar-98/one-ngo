import type { ApiKeyView, ConnectorSummary, ConnectorTestRequest, ConnectorView, CreatedApiKey, SettingsRequest } from '../contracts';
import type { ThemeTokens } from '../models';
import type { PersonItem, RoleOption } from '../people/people';

export interface RoleSummary {
  key: string;
  label: string;
  requireTwoStep: boolean;
  members: number;
}

export interface RoleMembersPage {
  role: RoleOption;
  items: PersonItem[];
  total: number;
  roles: RoleOption[];
}

export type ConnectorKind = 'sms' | 'whatsapp' | 'webhook' | 'http' | 'oauth';
export type DeliveryStatus = 'pending' | 'sent' | 'failed';

/** Secrets are listed by name only; their values never reach the app. */
export type { ConnectorSummary, ConnectorTestRequest, ConnectorView };

/** `message` carries what a lookup read or that an access token was renewed. */
export interface ConnectorTestResult {
  ok: boolean;
  status: number | null;
  error?: string;
  message?: string;
}

export interface SaveConnector {
  kind?: ConnectorKind;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** Only secrets being set or replaced. */
  secrets?: Record<string, string>;
}

export interface Delivery {
  id: string;
  event: string;
  recordId: string | null;
  status: DeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
}

export type ApiKey = ApiKeyView;

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRow {
  id: string;
  kind: string;
  label?: string;
  status: JobStatus;
  progress: number;
  total: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdBy: string;
  createdByName?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobItem {
  seq: number;
  status: 'done' | 'failed' | 'skipped';
  recordId?: string;
  message?: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  area: string | null;
  recordType: string | null;
}

export interface OrganisationSettings {
  name: string;
  legalName: string | null;
  defaultLanguage: string;
  languages: string[];
  storage: { usedBytes: number; quotaBytes: number };
  apiRequestsPerMinute: number;
  /** Exact browser origins that may read this organisation's data feeds. */
  corsOrigins: string[];
  /** 1 (January) to 12. */
  financialYearStartMonth: number;
  /** A financial year is open or a receipt issued, so the start month can no longer change. */
  financialYearFixed: boolean;
}

export type SettingsChange = SettingsRequest;

/** The published navigation order. Null items mean the app's own arrangement. */
export interface OrganisationLayout {
  items: string[] | null;
  listLayout: 'cards' | 'table';
  icons: Record<string, string> | null;
}

export interface PublishedLayout {
  items: string[];
  listLayout: 'cards' | 'table';
  icons?: Record<string, string>;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface JobsQuery {
  status?: JobStatus[];
  limit: number;
  offset: number;
}

export interface AuditQuery {
  person?: string;
  area?: string;
  recordType?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/** Administration's server calls, except People; the only implementation that talks HTTP is in http-admin.ts. */
export interface AdminGateway {
  roles(): Promise<RoleSummary[]>;
  roleMembers(role: string): Promise<RoleMembersPage>;
  /** Active and invited people matching the text, to give a role to. */
  candidates(q: string): Promise<PersonItem[]>;
  addRoleMembers(role: string, userIds: string[]): Promise<void>;
  removeRoleMember(role: string, userId: string): Promise<void>;
  connectors(): Promise<ConnectorSummary[]>;
  connector(key: string): Promise<ConnectorView>;
  saveConnector(key: string, body: SaveConnector): Promise<ConnectorView>;
  testConnector(key: string, input?: ConnectorTestRequest): Promise<ConnectorTestResult>;
  /** The provider address an oauth connector's Connect sends the browser to. */
  startOauth(key: string): Promise<{ url: string }>;
  deliveries(key: string): Promise<Delivery[]>;
  retryDelivery(key: string, id: string): Promise<void>;
  apiKeys(): Promise<ApiKey[]>;
  /** Published data feeds a new key can be bound to. */
  dataFeeds(): Promise<{ key: string; label: string }[]>;
  /** `{ name, role }` for a staff key, or `{ name, feed }` for a data-feed key. */
  createApiKey(input: { name: string; role?: string; feed?: string }): Promise<CreatedApiKey>;
  revokeApiKey(id: string): Promise<void>;
  jobs(q: JobsQuery): Promise<Paged<JobRow>>;
  job(id: string): Promise<JobRow>;
  failedItems(id: string): Promise<JobItem[]>;
  cancelJob(id: string): Promise<JobRow>;
  audit(q: AuditQuery): Promise<Paged<AuditEntry>>;
  settings(): Promise<OrganisationSettings>;
  saveSettings(change: SettingsChange): Promise<OrganisationSettings>;
  saveTheme(body: ThemeTokens): Promise<ThemeTokens>;
  layout(): Promise<OrganisationLayout>;
  saveLayout(body: PublishedLayout): Promise<PublishedLayout>;
}

/** Keeps a snapshot and tells listeners about every change. */
export class Snapshots<S> {
  private readonly listeners = new Set<(s: S) => void>();
  constructor(private snap: S) {}

  get value(): S {
    return this.snap;
  }

  subscribe(fn: (s: S) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<S>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }
}
