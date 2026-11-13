import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { notFound, ruleViolation, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { EmailTransport, Logger } from '@onengo/kernel/ports';
import { silentLogger } from '../../domain/silent-logger.js';
import { demand } from '../../domain/permissions.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { WebhookRequest } from '../../runtime/automation/run-action.js';
import type { PhoneChannel, PhoneMessage } from '../notifications/notification-service.js';
import { normalisePhone } from '../shared/phone.js';
import { HttpTemplateError, parseHttpConfig, renderHttp, unknownPlaceholders, type HttpBinding, type HttpConfig } from './http-template.js';
import { CredentialNeedsReconnect, parseOauthConfig, type OAuthCredentials } from './oauth-credentials.js';
import { rfc822 } from './rfc822.js';
import type { ConnectorDeliveryPolicy, ConnectorEvent, ConnectorHttp, ConnectorOutbox, ConnectorRequest, ConnectorResponse, ConnectorSecretBox } from './ports/connector-runtime.js';
import type { ConnectorRow, ConnectorStore } from './ports/connector-store.js';

export const CONNECTOR_KINDS = ['sms', 'whatsapp', 'webhook', 'http', 'oauth'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/**
 * sms: a generic HTTP gateway. `url`, header values and `body` may use
 * {{to}}, {{message}} and {{secrets.<name>}}; values are encoded for where
 * they appear (URL, JSON string, form field or plain text).
 */
export interface SmsConfig {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  contentType?: 'json' | 'form' | 'text';
}
/** whatsapp: the WhatsApp Business Cloud API at `<baseUrl>/<phoneNumberId>/messages`. */
export interface WhatsAppConfig {
  baseUrl: string;
  phoneNumberId: string;
}
/** webhook: JSON posted to `url`, signed with the `signingSecret` secret. */
export interface WebhookConfig {
  url: string;
}

export interface ConnectorView {
  key: string;
  kind: ConnectorKind;
  enabled: boolean;
  /** Every secret it needs is set. */
  configured: boolean;
  config: Record<string, unknown>;
  /** Names of the secrets that are set; their values are never returned. */
  secrets: string[];
  /** oauth: whether it has been connected (holds a refresh token) and when its access token expires; null for other kinds. */
  oauth: { connected: boolean; expiresAt: string | null } | null;
  updatedBy: string | null;
  updatedAt: string;
}

/** Where an http call is logged: a queued event (`eventId`) or a direct call (null). */
export interface HttpCallDelivery {
  eventId: string | null;
  event: string;
  recordId: string | null;
  final: boolean;
}

/** The outcome of one http connector call; failures are results, never raw errors. */
export interface HttpCallResult {
  ok: boolean;
  status: number | null;
  /** The answer, with every substituted secret redacted; empty when the call failed. */
  body: string;
  error?: string;
}

/** The scalar values a lookup's responseMap read, by field, or why it could not. */
export type LookupResult = { values: Record<string, string | number | boolean | null> } | { issues: FieldIssue[] };

/** The payload of a `connector.http` outbox event. */
export interface HttpDeliveryPayload {
  connector: string;
  event: string;
  binding: HttpBinding;
  recordId?: string | null;
}

/** What runtime callers (record saves, automations) use to call http connectors. */
export interface ConnectorCalls {
  callHttp(tenantId: string, key: string, binding: HttpBinding, delivery: HttpCallDelivery): Promise<HttpCallResult>;
  lookup(tenantId: string, key: string, binding: HttpBinding & { recordId?: string | null }): Promise<LookupResult>;
}

export interface ConnectorTestResult {
  ok: boolean;
  status: number | null;
  error?: string;
  message?: string;
}

/** A connector in Administration's list: what sends through it and how its last delivery went. */
export interface ConnectorSummary {
  key: string;
  kind: ConnectorKind;
  enabled: boolean;
  configured: boolean;
  /** Labels of the published actions, automations and workflows that send through it. */
  usedBy: string[];
  lastDelivery: { status: Delivery['status']; at: string } | null;
}

/** A published definition that may send through connectors. */
export interface ConnectorUser {
  label: string;
  body: unknown;
}

export interface SaveConnectorInput {
  kind?: unknown;
  enabled?: unknown;
  config?: unknown;
  /** Merged into the stored secrets; null removes one. */
  secrets?: unknown;
}

export interface Delivery {
  id: string;
  event: string;
  recordId: string | null;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
}

interface Loaded {
  row: ConnectorRow;
  kind: ConnectorKind;
  secrets: Record<string, string>;
  configured: boolean;
}

/** Store facts an http config is checked against. */
interface References {
  /** The type of the connector `credential` names, if it exists. */
  credentialType?: string;
  /** The key of the organisation's enabled email sender, if any. */
  emailSender?: string;
}

interface AttemptOptions {
  /** Values to redact from the logged error. */
  secrets?: readonly string[];
  /** Statuses that count as success; absent means any 2xx. */
  success?: readonly number[];
  /** A further check of a successful answer; a message makes the attempt fail. */
  check?: (res: ConnectorResponse) => string | null;
}

const KEY = /^[a-z][a-zA-Z0-9_-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const REQUIRED_SECRETS: Record<ConnectorKind, string[]> = { sms: [], whatsapp: ['accessToken'], webhook: ['signingSecret'], http: [], oauth: ['clientSecret'] };
const PERMISSION = 'admin:connectors';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const LOOKUP_BODY_BYTES = 65_536;
const REDACTED = '[redacted]';

/** Every required secret is set; an oauth connector also needs the refresh token its connect stored. */
const isConfigured = (kind: ConnectorKind, secrets: Record<string, string>) =>
  REQUIRED_SECRETS[kind].every((s) => !!secrets[s]) && (kind !== 'oauth' || !!secrets.refreshToken);

/** Replaces every secret, as written and as encoded for a URL or JSON string, with a marker. */
function redactor(secrets: readonly string[]): (text: string) => string {
  const forms = [...new Set(secrets.flatMap((s) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]))]
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  return (text) => forms.reduce((out, s) => out.split(s).join(REDACTED), text);
}

/** The value at a dot-separated path ("a.b.c") of a parsed JSON answer, or undefined when it is not there. */
function at(value: unknown, path: string): unknown {
  let node = value;
  for (const part of path.split('.')) {
    if (!isObject(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/** Reads each responseMap path from a JSON answer; a missing path or a non-scalar value is an issue on its field. */
function mapResponse(body: string, responseMap: Record<string, string>): LookupResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { issues: Object.keys(responseMap).map((f) => ({ path: `/${f}`, message: 'could not be looked up: the answer is not JSON' })) };
  }
  const values: Record<string, string | number | boolean | null> = {};
  const issues: FieldIssue[] = [];
  for (const [field, path] of Object.entries(responseMap)) {
    const v = at(parsed, path);
    if (v === undefined) issues.push({ path: `/${field}`, message: `could not be looked up: the answer has no '${path}'` });
    else if (v !== null && typeof v === 'object') issues.push({ path: `/${field}`, message: `could not be looked up: '${path}' is not a single value` });
    else values[field] = v as string | number | boolean | null;
  }
  return issues.length ? { issues } : { values };
}

const isKind = (v: unknown): v is ConnectorKind => (CONNECTOR_KINDS as readonly unknown[]).includes(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (v: Date | string) => new Date(v).toISOString();

function httpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether a definition body sends through the connector: a webhook or connector step naming it, or a phone channel of its kind. */
function sendsThrough(node: unknown, key: string, kind: ConnectorKind): boolean {
  if (Array.isArray(node)) return node.some((n) => sendsThrough(n, key, kind));
  if (!isObject(node)) return false;
  if (kind === 'webhook' && node.type === 'webhook' && node.connector === key) return true;
  if (node.type === 'connector' && node.connector === key) return true;
  if (kind !== 'webhook' && Array.isArray(node.channels) && node.channels.includes(kind)) return true;
  return Object.values(node).some((v) => sendsThrough(v, key, kind));
}

function fill(template: string, values: Record<string, string>, encode: (v: string) => string): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => encode(values[name] ?? ''));
}

const ENCODE = {
  url: encodeURIComponent,
  header: (v: string) => v.replace(/[\r\n]/g, ' '),
  json: (v: string) => JSON.stringify(v).slice(1, -1),
  form: encodeURIComponent,
  text: (v: string) => v,
};
const CONTENT_TYPE = { json: 'application/json', form: 'application/x-www-form-urlencoded', text: 'text/plain; charset=utf-8' };

/**
 * Per-organisation SMS, WhatsApp, webhook, http and oauth connectors. Settings
 * are stored with their secrets encrypted, like the email connector, and
 * nothing is sent unless an administrator has configured and enabled the
 * connector. Every outbound call is logged as a delivery.
 */
export class ConnectorService implements ConnectorCalls {
  constructor(
    private readonly tm: TransactionManager,
    private readonly store: ConnectorStore,
    private readonly outbox: ConnectorOutbox,
    private readonly secretBox: ConnectorSecretBox,
    private readonly http: ConnectorHttp,
    private readonly delivery: ConnectorDeliveryPolicy,
    private readonly audit: AuditTrail,
    private readonly oauth: Pick<OAuthCredentials, 'accessToken'>,
    private readonly logger: Logger = silentLogger,
  ) {}

  async get(ctx: TenantContext, key: string): Promise<ConnectorView> {
    demand(ctx.actor, PERMISSION);
    const c = await this.load(ctx.tenantId, key);
    if (!c) throw notFound(`Connector '${key}' is not set up.`);
    return this.view(c);
  }

  /** Every SMS, WhatsApp, webhook, http and oauth connector, with the definitions in `users` that send through it. */
  async list(ctx: TenantContext, users: ConnectorUser[]): Promise<ConnectorSummary[]> {
    demand(ctx.actor, PERMISSION);
    const rows = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.list(tx, CONNECTOR_KINDS));
    return rows
      .filter((r): r is typeof r & { type: ConnectorKind } => isKind(r.type))
      .map((r) => {
        const secrets = r.secret_enc ? this.decrypt(r.secret_enc) : {};
        return {
          key: r.key,
          kind: r.type,
          enabled: r.enabled,
          configured: isConfigured(r.type, secrets),
          usedBy: users.filter((u) => sendsThrough(u.body, r.key, r.type)).map((u) => u.label),
          lastDelivery: r.last_status && r.last_at ? { status: r.last_status, at: iso(r.last_at) } : null,
        };
      });
  }

  /** Sends a queued or failed delivery again now, as one more attempt of the same event. */
  async retry(ctx: TenantContext, key: string, deliveryId: string): Promise<void> {
    demand(ctx.actor, PERMISSION);
    if (!(await this.load(ctx.tenantId, key))) throw notFound(`Connector '${key}' is not set up.`);
    const d = UUID.test(deliveryId)
      ? await this.tm.withTenant(ctx.tenantId, (tx) => this.store.delivery(tx, key, deliveryId))
      : undefined;
    if (!d) throw notFound('This delivery does not exist.');
    if (d.status === 'sent') throw ruleViolation('This delivery was already sent.');
    const outboxEventId = d.outbox_event_id;
    if (!outboxEventId) throw ruleViolation('This delivery was a test and cannot be sent again; use Test instead.');
    await this.outbox.requeue(ctx.tenantId, outboxEventId);
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      await this.store.markDeliveryPending(tx, deliveryId);
      await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'connector.delivery.retried', entity: 'connector', entityId: key, after: { delivery: deliveryId } });
    });
  }

  async save(ctx: TenantContext, key: string, input: SaveConnectorInput): Promise<ConnectorView> {
    demand(ctx.actor, PERMISSION);
    if (!KEY.test(key)) throw validationFailed('The connector key is not valid.', [{ path: '/key', message: 'use letters, digits, - or _, starting with a letter' }]);
    const body = isObject(input) ? input : {};
    const existing = await this.row(ctx.tenantId, key);
    if (existing && !isKind(existing.type)) throw ruleViolation(`'${key}' is a ${existing.type} connector and is managed elsewhere.`);
    const kind = body.kind ?? existing?.type;
    if (!isKind(kind)) throw validationFailed('Choose the kind of connector.', [{ path: '/kind', message: `must be one of ${CONNECTOR_KINDS.join(', ')}` }]);
    if (existing && existing.type !== kind) throw validationFailed('The kind of a connector cannot change.', [{ path: '/kind', message: `is ${existing.type}` }]);

    const issues: FieldIssue[] = [];
    const secrets = { ...(existing?.secret_enc ? this.decrypt(existing.secret_enc) : {}) };
    if (body.secrets !== undefined) {
      if (!isObject(body.secrets)) issues.push({ path: '/secrets', message: 'must be an object' });
      else {
        for (const [name, value] of Object.entries(body.secrets)) {
          if (!SECRET_NAME.test(name)) issues.push({ path: `/secrets/${name}`, message: 'is not a valid secret name' });
          else if (value === null) delete secrets[name];
          else if (typeof value !== 'string' || !value.length || value.length > 4000) issues.push({ path: `/secrets/${name}`, message: 'must be text' });
          else secrets[name] = value;
        }
      }
    }
    const config = body.config === undefined ? (existing?.config ?? {}) : body.config;
    if (!isObject(config)) issues.push({ path: '/config', message: 'must be an object' });
    else issues.push(...this.checkConfig(kind, key, config, secrets, await this.references(ctx.tenantId, kind, config)));
    const enabled = body.enabled === undefined ? (existing?.enabled ?? false) : body.enabled;
    if (typeof enabled !== 'boolean') issues.push({ path: '/enabled', message: 'must be true or false' });
    const missing = REQUIRED_SECRETS[kind].filter((s) => !secrets[s]);
    if (enabled === true) for (const s of missing) issues.push({ path: `/secrets/${s}`, message: 'This secret is needed before the connector can be enabled.' });
    if (issues.length) throw validationFailed('Some connector settings are not valid.', issues);

    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      await this.store.save(tx, {
        key,
        type: kind,
        config,
        secretEnc: Object.keys(secrets).length ? this.secretBox.encrypt(JSON.stringify(secrets)) : null,
        enabled: enabled as boolean,
        actorId: ctx.actor.id,
      });
      await this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: 'connector.saved',
        entity: 'connector',
        entityId: key,
        after: { kind, enabled, config, secrets: Object.keys(secrets).sort() },
      });
    });
    return this.get(ctx, key);
  }

  /**
   * Sends a test message, signed test event, http request or lookup now and
   * logs it, or renews an oauth connector's access token; never calls a
   * disabled connector.
   */
  async test(ctx: TenantContext, key: string, input: { to?: unknown; inputs?: unknown } = {}): Promise<ConnectorTestResult> {
    demand(ctx.actor, PERMISSION);
    const c = await this.load(ctx.tenantId, key);
    if (!c) throw notFound(`Connector '${key}' is not set up.`);
    if (!c.row.enabled || (!c.configured && c.kind !== 'oauth')) throw ruleViolation('Finish setting up and enable the connector before testing it.');
    if (c.kind === 'oauth') {
      try {
        await this.oauth.accessToken(ctx.tenantId, key);
        return { ok: true, status: null, message: 'The access token was renewed.' };
      } catch (error) {
        if (!(error instanceof CredentialNeedsReconnect)) throw error;
        return { ok: false, status: null, error: 'Reconnect needed: connect the credential again.', message: 'Reconnect needed: connect the credential again.' };
      }
    }
    const org = await this.organisation(ctx.tenantId);
    if (c.kind === 'http') return this.testHttp(ctx, c, org, input ?? {});
    let request: ConnectorRequest;
    if (c.kind === 'webhook') {
      request = this.webhookRequest(c, null, {
        event: 'connector.test',
        time: new Date().toISOString(),
        organisation: org,
        record: null,
        data: {},
        actorId: ctx.actor.id,
      });
    } else {
      const to = normalisePhone(input?.to);
      if (!to) throw validationFailed('Give a phone number to send the test to.', [{ path: '/to', message: 'is not a phone number' }]);
      request = this.messageRequest(c, { to, text: `Test message from ${org.name}.`, recordId: null });
    }
    try {
      const res = await this.attempt(ctx.tenantId, key, { eventId: null, event: 'connector.test', recordId: null, final: true }, request);
      return { ok: true, status: res.status };
    } catch (error) {
      const e = error as Error & { status?: number };
      return { ok: false, status: e.status ?? null, error: e.message };
    }
  }

  private async testHttp(ctx: TenantContext, c: Loaded, org: { name: string }, input: { to?: unknown; inputs?: unknown }): Promise<ConnectorTestResult> {
    const config = parseHttpConfig(c.row.config);
    if (!config) throw ruleViolation('Finish setting up the connector before testing it.');
    const d: HttpCallDelivery = { eventId: null, event: 'connector.test', recordId: null, final: true };
    if (config.mode === 'lookup') {
      const inputs = input.inputs ?? {};
      if (!isObject(inputs) || !Object.values(inputs).every((v) => typeof v === 'string')) {
        throw validationFailed('Give the inputs to look up.', [{ path: '/inputs', message: 'must be an object of text values' }]);
      }
      const result = await this.lookupAs(ctx.tenantId, c.row.key, { record: inputs, organisation: { name: org.name } }, d);
      if ('issues' in result) return { ok: false, status: null, error: result.issues.map((i) => `${i.path.slice(1)}: ${i.message}`).join('; ') };
      return { ok: true, status: null, message: `Looked up ${JSON.stringify(result.values)}.` };
    }
    if (input.to !== undefined && (typeof input.to !== 'string' || input.to.length > 320 || /[\r\n]/.test(input.to))) {
      throw validationFailed('Give an address to send the test to.', [{ path: '/to', message: 'must be one line of text' }]);
    }
    const from = config.from ?? '';
    const to = typeof input.to === 'string' && input.to ? input.to : from;
    const result = await this.callHttp(ctx.tenantId, c.row.key, { message: { to, subject: 'Test', text: 'Test', from, mime: '' }, organisation: { name: org.name } }, d);
    return result.ok ? { ok: true, status: result.status } : { ok: false, status: result.status, ...(result.error ? { error: result.error } : {}) };
  }

  async deliveries(ctx: TenantContext, key: string, options: { limit?: number; offset?: number } = {}): Promise<Delivery[]> {
    demand(ctx.actor, PERMISSION);
    if (!(await this.load(ctx.tenantId, key))) throw notFound(`Connector '${key}' is not set up.`);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Math.trunc(options.offset ?? 0) || 0, 0);
    const rows = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.deliveries(tx, key, limit, offset));
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      recordId: r.record_id,
      status: r.status,
      attempts: r.attempts,
      responseStatus: r.response_status,
      error: r.error,
      createdAt: iso(r.created_at),
      lastAttemptAt: r.last_attempt_at ? iso(r.last_attempt_at) : null,
    }));
  }

  /** Dispatcher handler for `connector.webhook`. Throws so the dispatcher retries with backoff. */
  async deliverWebhook(event: ConnectorEvent): Promise<void> {
    const p = event.payload as unknown as WebhookRequest;
    const sent = await this.tm.withTenant(event.tenantId, (tx) => this.store.sentFor(tx, event.id));
    if (sent) return;
    const c = await this.load(event.tenantId, p.connector);
    if (!c || c.kind !== 'webhook') {
      this.logger.log('WARNING', 'Webhook connector is not set up; event dropped', { tenantId: event.tenantId, connector: p.connector, eventId: event.id });
      return;
    }
    if (!c.row.enabled || !c.configured) {
      await this.tm.withTenant(event.tenantId, (tx) =>
        this.store.recordNotSent(tx, {
          connectorKey: p.connector,
          event: p.event,
          recordId: p.record?.id ?? null,
          error: 'Not sent: the connector is not enabled.',
          eventId: event.id,
        }),
      );
      return;
    }
    const request = this.webhookRequest(c, event.id, {
      event: p.event,
      time: p.time ?? new Date().toISOString(),
      organisation: await this.organisation(event.tenantId),
      record: p.record ?? null,
      data: p.body ?? {},
      actorId: p.actorId ?? null,
    });
    await this.attempt(
      event.tenantId,
      c.row.key,
      { eventId: event.id, event: p.event, recordId: p.record?.id ?? null, final: event.attempts >= this.delivery.maxAttempts },
      request,
    );
  }

  /** Dispatcher handler for `connector.http`. Throws so the dispatcher retries with backoff. */
  async deliverHttp(event: ConnectorEvent): Promise<void> {
    const p = event.payload as unknown as HttpDeliveryPayload;
    const sent = await this.tm.withTenant(event.tenantId, (tx) => this.store.sentFor(tx, event.id));
    if (sent) return;
    const d: HttpCallDelivery = { eventId: event.id, event: p.event, recordId: p.recordId ?? null, final: event.attempts >= this.delivery.maxAttempts };
    const ready = await this.ready(event.tenantId, p.connector, d);
    if ('error' in ready) return;
    await this.send(event.tenantId, ready.c, ready.config, p.binding ?? {}, d);
  }

  /**
   * Calls an http connector once and logs it. The connector is read in its
   * own short transaction and the access token fetched before rendering, so
   * no transaction is held across the call. Never throws for a failed call.
   */
  async callHttp(tenantId: string, key: string, binding: HttpBinding, delivery: HttpCallDelivery): Promise<HttpCallResult> {
    const ready = await this.ready(tenantId, key, delivery);
    if ('error' in ready) return { ok: false, status: null, body: '', error: ready.error };
    try {
      const { res, redact } = await this.send(tenantId, ready.c, ready.config, binding, delivery);
      return { ok: true, status: res.status, body: redact(res.body) };
    } catch (error) {
      const e = error as Error & { status?: number };
      return { ok: false, status: e.status ?? null, body: '', error: e.message };
    }
  }

  /** Reads values for a record from a lookup connector. Every failure is an issue on the fields it would have filled. */
  async lookup(tenantId: string, key: string, binding: HttpBinding & { recordId?: string | null }): Promise<LookupResult> {
    return this.lookupAs(tenantId, key, binding, { eventId: null, event: 'lookup', recordId: binding.recordId ?? null, final: true });
  }

  private async lookupAs(tenantId: string, key: string, binding: HttpBinding, d: HttpCallDelivery): Promise<LookupResult> {
    const ready = await this.ready(tenantId, key, d);
    if ('error' in ready) return { issues: [{ path: '/connector', message: ready.error }] };
    const { config } = ready;
    const responseMap = config.responseMap ?? {};
    const fields = Object.keys(responseMap);
    if (config.mode !== 'lookup' || !fields.length) return { issues: [{ path: '/connector', message: `Connector '${key}' is not a lookup.` }] };
    let mapped: LookupResult | undefined;
    const check = (res: ConnectorResponse) => {
      mapped = mapResponse(res.body, responseMap);
      return 'issues' in mapped ? mapped.issues.map((i) => `${i.path.slice(1)} ${i.message}`).join('; ') : null;
    };
    try {
      await this.send(tenantId, ready.c, config, { ...binding, record: binding.record ?? {} }, d, { maxBodyBytes: LOOKUP_BODY_BYTES, check });
      return mapped!;
    } catch (error) {
      if (mapped && 'issues' in mapped) return mapped;
      const message = `could not be looked up: ${(error as Error).message}`;
      return { issues: fields.map((f) => ({ path: `/${f}`, message })) };
    }
  }

  /** The enabled http connector and its parsed config, or why it cannot be called; a queued event that cannot is logged as not sent. */
  private async ready(tenantId: string, key: string, d: HttpCallDelivery): Promise<{ c: Loaded; config: HttpConfig } | { error: string }> {
    const c = await this.load(tenantId, key);
    if (!c || c.kind !== 'http') {
      this.logger.log('WARNING', 'HTTP connector is not set up; call dropped', { tenantId, connector: key, eventId: d.eventId });
      return { error: `Connector '${key}' is not set up.` };
    }
    const config = parseHttpConfig(c.row.config);
    const error = !c.row.enabled ? 'Not sent: the connector is not enabled.' : !config ? 'Not sent: the connector settings are not valid.' : null;
    if (error || !config) {
      const eventId = d.eventId;
      if (eventId) {
        await this.tm.withTenant(tenantId, (tx) => this.store.recordNotSent(tx, { connectorKey: key, event: d.event, recordId: d.recordId, error, eventId }));
      }
      return { error: error ?? 'Not sent: the connector settings are not valid.' };
    }
    return { c, config };
  }

  /**
   * Fetches the credential's access token (in its own locked transaction),
   * renders the request and makes one logged attempt. Throws like attempt();
   * a credential or template failure is logged as the attempt's error.
   */
  private async send(
    tenantId: string,
    c: Loaded,
    config: HttpConfig,
    binding: HttpBinding,
    d: HttpCallDelivery,
    options: { maxBodyBytes?: number; check?: AttemptOptions['check'] } = {},
  ): Promise<{ res: ConnectorResponse; redact: (text: string) => string }> {
    let rendered: ReturnType<typeof renderHttp>;
    try {
      const credential = config.credential ? { accessToken: await this.oauth.accessToken(tenantId, config.credential) } : undefined;
      rendered = renderHttp(config, binding, c.secrets, credential);
    } catch (e) {
      const known = e instanceof CredentialNeedsReconnect || e instanceof HttpTemplateError || (e as { code?: unknown }).code === 'not_found';
      const error = known ? (e as Error).message : 'The request could not be prepared.';
      if (!known) this.logger.log('WARNING', 'HTTP connector request could not be prepared', { tenantId, connector: c.row.key, error: String(e) });
      const status = d.final ? 'failed' : 'pending';
      await this.tm.withTenant(tenantId, (tx) =>
        this.store.recordAttempt(tx, { connectorKey: c.row.key, event: d.event, recordId: d.recordId, status, responseStatus: null, error, eventId: d.eventId }),
      );
      throw new Error(error);
    }
    const request = options.maxBodyBytes ? { ...rendered.request, maxBodyBytes: options.maxBodyBytes } : rendered.request;
    const attempt: AttemptOptions = { secrets: rendered.secrets };
    if (config.success) attempt.success = config.success;
    if (options.check) attempt.check = options.check;
    const res = await this.attempt(tenantId, c.row.key, d, request, attempt);
    return { res, redact: redactor(rendered.secrets) };
  }

  /**
   * The organisation's email through its enabled http email sender, if it has
   * one: each message goes out once as an RFC 822 message, and a failed call
   * throws so the queued email is retried.
   */
  async emailTransport(tenantId: string): Promise<EmailTransport | undefined> {
    const sender = await this.tm.withTenant(tenantId, async (tx) => {
      const row = await this.store.emailSender(tx);
      return row && { key: row.key, from: parseHttpConfig(row.config)?.from ?? '', organisation: (await this.store.organisation(tx))?.name ?? '' };
    });
    if (!sender) return undefined;
    return {
      send: async ({ to, subject, text, html }) => {
        const mime = rfc822({ from: sender.from, to, subject, text, ...(html ? { html } : {}) });
        const result = await this.callHttp(
          tenantId,
          sender.key,
          { message: { to, subject, text, ...(html ? { html } : {}), from: sender.from, mime }, organisation: { name: sender.organisation } },
          { eventId: null, event: 'notification.email', recordId: null, final: true },
        );
        if (!result.ok) throw new Error(`email connector '${sender.key}' failed (status ${result.status ?? 'none'})`);
      },
    };
  }

  /** The notification service's phone sender: the first enabled connector of the channel's kind, if any. */
  async sendMessage(tenantId: string, channel: PhoneChannel, message: PhoneMessage, delivery: { eventId: string; final: boolean }): Promise<boolean> {
    const keys = await this.tm.withTenant(tenantId, (tx) => this.store.enabledKeys(tx, channel));
    for (const key of keys) {
      const c = await this.load(tenantId, key);
      if (!c?.configured) continue;
      await this.attempt(
        tenantId,
        key,
        { eventId: delivery.eventId, event: `notification.${channel}`, recordId: message.recordId, final: delivery.final },
        this.messageRequest(c, message),
      );
      return true;
    }
    return false;
  }

  private webhookRequest(c: Loaded, deliveryId: string | null, payload: Record<string, unknown>): ConnectorRequest {
    const body = JSON.stringify(payload);
    const config = c.row.config as unknown as WebhookConfig;
    return {
      url: config.url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'ngo-platform-webhook',
        'x-ngo-event': String(payload.event),
        ...(deliveryId ? { 'x-ngo-delivery': deliveryId } : {}),
        'x-ngo-signature': `sha256=${this.secretBox.sign(c.secrets.signingSecret!, body)}`,
      },
      body,
    };
  }

  private messageRequest(c: Loaded, message: PhoneMessage): ConnectorRequest {
    if (c.kind === 'whatsapp') {
      const config = c.row.config as unknown as WhatsAppConfig;
      const to = message.to.replace(/^\+/, '');
      const content = message.whatsapp
        ? {
            type: 'template',
            template: {
              name: message.whatsapp.name,
              language: { code: message.whatsapp.language },
              ...(message.whatsapp.parameters.length
                ? { components: [{ type: 'body', parameters: message.whatsapp.parameters.map((text) => ({ type: 'text', text })) }] }
                : {}),
            },
          }
        : { type: 'text', text: { body: message.text.slice(0, 4096) } };
      return {
        url: `${config.baseUrl.replace(/\/+$/, '')}/${config.phoneNumberId}/messages`,
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.secrets.accessToken}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...content }),
      };
    }
    const config = c.row.config as unknown as SmsConfig;
    const values: Record<string, string> = { to: message.to, message: message.text.slice(0, 1600) };
    for (const [name, value] of Object.entries(c.secrets)) values[`secrets.${name}`] = value;
    const contentType = config.contentType ?? 'json';
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers ?? {})) headers[name.toLowerCase()] = fill(value, values, ENCODE.header);
    const request: ConnectorRequest = { url: fill(config.url, values, ENCODE.url), method: config.method, headers };
    if (config.method === 'POST' && config.body !== undefined) {
      request.body = fill(config.body, values, ENCODE[contentType]);
      headers['content-type'] ??= CONTENT_TYPE[contentType];
    }
    return request;
  }

  /** Makes one call and records it; a retried queued event updates the same log row. */
  private async attempt(
    tenantId: string,
    key: string,
    d: { eventId: string | null; event: string; recordId: string | null; final: boolean },
    request: ConnectorRequest,
    options: AttemptOptions = {},
  ): Promise<ConnectorResponse> {
    const redact = redactor(options.secrets ?? []);
    let res: ConnectorResponse | undefined;
    let error: string | null = null;
    try {
      res = await this.http(request);
      const ok = options.success ? options.success.includes(res.status) : res.status >= 200 && res.status < 300;
      if (!ok) error = `The service answered ${res.status}: ${redact(res.body).slice(0, 300)}`;
      else if (options.check) error = options.check(res);
      if (error) error = redact(error).slice(0, 500);
    } catch (e) {
      error = redact(e instanceof Error ? e.message : String(e)).slice(0, 500) || 'The service could not be reached.';
    }
    const status = !error ? 'sent' : d.final ? 'failed' : 'pending';
    await this.tm.withTenant(tenantId, (tx) =>
      this.store.recordAttempt(tx, { connectorKey: key, event: d.event, recordId: d.recordId, status, responseStatus: res?.status ?? null, error, eventId: d.eventId }),
    );
    if (error) throw Object.assign(new Error(error), { status: res?.status });
    return res!;
  }

  /** What an http config points at: the kind of its credential connector and the organisation's current email sender. */
  private async references(tenantId: string, kind: ConnectorKind, config: Record<string, unknown>): Promise<References> {
    if (kind !== 'http') return {};
    return this.tm.withTenant(tenantId, async (tx) => ({
      credentialType: typeof config.credential === 'string' && KEY.test(config.credential) ? (await this.store.connector(tx, config.credential))?.type : undefined,
      emailSender: config.emailSender === true ? (await this.store.emailSender(tx))?.key : undefined,
    }));
  }

  private checkConfig(kind: ConnectorKind, key: string, config: Record<string, unknown>, secrets: Record<string, string>, refs: References): FieldIssue[] {
    const issues: FieldIssue[] = [];
    const allowed: Record<ConnectorKind, string[]> = {
      sms: ['url', 'method', 'headers', 'body', 'contentType'],
      whatsapp: ['baseUrl', 'phoneNumberId'],
      webhook: ['url'],
      http: ['mode', 'method', 'url', 'headers', 'body', 'contentType', 'credential', 'timeoutMs', 'success', 'emailSender', 'from', 'inputs', 'responseMap'],
      oauth: ['authorizationUrl', 'tokenUrl', 'clientId', 'scopes'],
    };
    for (const k of Object.keys(config)) if (!allowed[kind].includes(k)) issues.push({ path: `/config/${k}`, message: 'is not a setting of this kind' });
    if (kind === 'webhook' && !httpsUrl(config.url)) issues.push({ path: '/config/url', message: 'must be an https:// address' });
    if (kind === 'whatsapp') {
      if (!httpsUrl(config.baseUrl)) issues.push({ path: '/config/baseUrl', message: 'must be the https:// address of the Cloud API, including its version' });
      if (typeof config.phoneNumberId !== 'string' || !/^\d{5,30}$/.test(config.phoneNumberId)) {
        issues.push({ path: '/config/phoneNumberId', message: 'must be the phone number id from WhatsApp Business' });
      }
    }
    if (kind === 'sms') {
      const known = (name: string) => name === 'to' || name === 'message' || (name.startsWith('secrets.') && Object.hasOwn(secrets, name.slice(8)));
      const placeholders = (path: string, text: string) => {
        for (const m of text.matchAll(PLACEHOLDER)) {
          if (!known(m[1]!)) issues.push({ path, message: `unknown placeholder '{{${m[1]}}}'; use {{to}}, {{message}} or {{secrets.<name>}}` });
        }
      };
      if (typeof config.url !== 'string' || !httpsUrl(config.url.replace(PLACEHOLDER, 'x'))) issues.push({ path: '/config/url', message: 'must be an https:// address' });
      else placeholders('/config/url', config.url);
      if (config.method !== 'GET' && config.method !== 'POST') issues.push({ path: '/config/method', message: "must be 'GET' or 'POST'" });
      if (config.contentType !== undefined && !['json', 'form', 'text'].includes(config.contentType as string)) {
        issues.push({ path: '/config/contentType', message: "must be 'json', 'form' or 'text'" });
      }
      if (config.body !== undefined) {
        if (typeof config.body !== 'string' || config.body.length > 5000) issues.push({ path: '/config/body', message: 'must be text' });
        else placeholders('/config/body', config.body);
      }
      if (config.headers !== undefined) {
        if (!isObject(config.headers) || Object.keys(config.headers).length > 20) issues.push({ path: '/config/headers', message: 'must be at most 20 name: value pairs' });
        else {
          for (const [name, value] of Object.entries(config.headers)) {
            if (!HEADER_NAME.test(name)) issues.push({ path: `/config/headers/${name}`, message: 'is not a valid header name' });
            else if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 2000) issues.push({ path: `/config/headers/${name}`, message: 'must be one line of text' });
            else placeholders(`/config/headers/${name}`, value);
          }
        }
      }
    }
    if (kind === 'http') issues.push(...this.checkHttp(key, config, secrets, refs));
    if (kind === 'oauth') {
      if (!parseOauthConfig(config)) issues.push({ path: '/config', message: 'needs authorizationUrl, tokenUrl and clientId' });
      if (!httpsUrl(config.authorizationUrl)) issues.push({ path: '/config/authorizationUrl', message: 'must be an https:// address' });
      if (!httpsUrl(config.tokenUrl)) issues.push({ path: '/config/tokenUrl', message: 'must be an https:// address' });
      if (typeof config.clientId !== 'string' || !config.clientId.trim() || config.clientId.length > 500) issues.push({ path: '/config/clientId', message: 'must be the client id from the provider' });
      const scopes = config.scopes;
      if (!Array.isArray(scopes) || !scopes.length || scopes.length > 50 || !scopes.every((s) => typeof s === 'string' && s.trim() && !/\s/.test(s))) {
        issues.push({ path: '/config/scopes', message: 'must be a list of one or more scopes' });
      }
    }
    return issues;
  }

  private checkHttp(key: string, config: Record<string, unknown>, secrets: Record<string, string>, refs: References): FieldIssue[] {
    const issues: FieldIssue[] = [];
    const mode = config.mode;
    if (mode !== 'send' && mode !== 'lookup') issues.push({ path: '/config/mode', message: "must be 'send' or 'lookup'" });
    if (!METHODS.includes(config.method as string)) issues.push({ path: '/config/method', message: `must be one of ${METHODS.join(', ')}` });
    else if (mode === 'lookup' && config.method !== 'GET' && config.method !== 'POST') issues.push({ path: '/config/method', message: "must be 'GET' or 'POST' for a lookup" });
    if (!parseHttpConfig(config) && !issues.length) issues.push({ path: '/config', message: 'needs mode, method and url' });

    const inputs = config.inputs;
    if (mode === 'lookup') {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20 || !inputs.every((f) => typeof f === 'string' && FIELD.test(f))) {
        issues.push({ path: '/config/inputs', message: 'must list the record fields the lookup sends' });
      }
      const map = config.responseMap;
      if (!isObject(map) || !Object.keys(map).length || Object.keys(map).length > 50) issues.push({ path: '/config/responseMap', message: 'must map at least one field to a path in the answer' });
      else {
        for (const [field, path] of Object.entries(map)) {
          if (!FIELD.test(field)) issues.push({ path: `/config/responseMap/${field}`, message: 'is not a valid field name' });
          else if (typeof path !== 'string' || !path || path.length > 200 || path.split('.').some((p) => !p)) issues.push({ path: `/config/responseMap/${field}`, message: 'must be a dot-separated path such as data.name' });
        }
      }
    } else if (inputs !== undefined && (!Array.isArray(inputs) || !inputs.every((f) => typeof f === 'string' && FIELD.test(f)))) {
      issues.push({ path: '/config/inputs', message: 'must be a list of record fields' });
    }

    const credential = config.credential;
    if (credential !== undefined && (typeof credential !== 'string' || refs.credentialType !== 'oauth')) {
      issues.push({ path: '/config/credential', message: 'must be the key of an oauth connector' });
    }
    const allowed = {
      mode: mode === 'lookup' ? ('lookup' as const) : ('send' as const),
      inputs: Array.isArray(inputs) ? inputs.filter((f): f is string => typeof f === 'string') : [],
      secrets: Object.keys(secrets),
      credential: typeof credential === 'string',
    };
    const placeholders = (path: string, text: string) => {
      for (const p of unknownPlaceholders(text, allowed)) {
        issues.push({
          path,
          message:
            mode === 'lookup'
              ? `unknown placeholder '{{${p}}}'; use {{record.<input>}}, {{organisation.name}}, {{secrets.<name>}} or {{credential.accessToken}}`
              : `unknown placeholder '{{${p}}}'; use {{record.<field>}}, {{message.<part>}}, {{organisation.name}}, {{secrets.<name>}} or {{credential.accessToken}}`,
        });
      }
    };
    if (typeof config.url !== 'string' || !httpsUrl(config.url.replace(PLACEHOLDER, 'x'))) issues.push({ path: '/config/url', message: 'must be an https:// address' });
    else placeholders('/config/url', config.url);
    if (config.headers !== undefined) {
      if (!isObject(config.headers) || Object.keys(config.headers).length > 20) issues.push({ path: '/config/headers', message: 'must be at most 20 name: value pairs' });
      else {
        for (const [name, value] of Object.entries(config.headers)) {
          if (!HEADER_NAME.test(name)) issues.push({ path: `/config/headers/${name}`, message: 'is not a valid header name' });
          else if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 2000) issues.push({ path: `/config/headers/${name}`, message: 'must be one line of text' });
          else placeholders(`/config/headers/${name}`, value);
        }
      }
    }
    if (config.body !== undefined) {
      if (typeof config.body !== 'string' || config.body.length > 5000) issues.push({ path: '/config/body', message: 'must be text' });
      else placeholders('/config/body', config.body);
    }
    if (config.contentType !== undefined && !['json', 'form', 'text'].includes(config.contentType as string)) {
      issues.push({ path: '/config/contentType', message: "must be 'json', 'form' or 'text'" });
    }
    const timeout = config.timeoutMs;
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000 || timeout > 30_000)) {
      issues.push({ path: '/config/timeoutMs', message: 'must be a whole number of milliseconds from 1000 to 30000' });
    }
    const success = config.success;
    if (success !== undefined && (!Array.isArray(success) || !success.length || !success.every((s) => Number.isInteger(s) && s >= 100 && s <= 599))) {
      issues.push({ path: '/config/success', message: 'must list one or more HTTP status codes' });
    }
    if (config.emailSender !== undefined && typeof config.emailSender !== 'boolean') issues.push({ path: '/config/emailSender', message: 'must be true or false' });
    if (config.from !== undefined && (typeof config.from !== 'string' || config.from.length > 320 || /[\r\n]/.test(config.from))) {
      issues.push({ path: '/config/from', message: 'must be one line of text' });
    }
    if (config.emailSender === true) {
      if (mode !== 'send') issues.push({ path: '/config/emailSender', message: 'only a send connector can send email' });
      if (refs.emailSender && refs.emailSender !== key) issues.push({ path: '/config/emailSender', message: `'${refs.emailSender}' already sends this organisation's email` });
      if (typeof config.from !== 'string' || !config.from.trim()) issues.push({ path: '/config/from', message: 'is needed when the connector sends email' });
    }
    return issues;
  }

  private view(c: Loaded): ConnectorView {
    return {
      key: c.row.key,
      kind: c.kind,
      enabled: c.row.enabled,
      configured: c.configured,
      config: c.row.config,
      secrets: Object.keys(c.secrets).sort(),
      oauth: c.kind === 'oauth' ? { connected: !!c.secrets.refreshToken, expiresAt: c.secrets.accessTokenExpiresAt ?? null } : null,
      updatedBy: c.row.updated_by,
      updatedAt: iso(c.row.updated_at),
    };
  }

  private async row(tenantId: string, key: string): Promise<ConnectorRow | undefined> {
    return this.tm.withTenant(tenantId, (tx) => this.store.connector(tx, key));
  }

  private async load(tenantId: string, key: string): Promise<Loaded | undefined> {
    const row = await this.row(tenantId, key);
    if (!row || !isKind(row.type)) return undefined;
    const secrets = row.secret_enc ? this.decrypt(row.secret_enc) : {};
    return { row, kind: row.type, secrets, configured: isConfigured(row.type, secrets) };
  }

  private decrypt(value: string): Record<string, string> {
    const parsed = JSON.parse(this.secretBox.decrypt(value)) as unknown;
    return isObject(parsed) ? (parsed as Record<string, string>) : {};
  }

  private async organisation(tenantId: string): Promise<{ id: string; key: string; name: string }> {
    const org = await this.tm.withTenant(tenantId, (tx) => this.store.organisation(tx));
    if (!org) throw notFound('Unknown organisation.');
    return org;
  }
}
