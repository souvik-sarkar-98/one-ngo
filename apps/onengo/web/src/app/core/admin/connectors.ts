import { issuesByField } from '../fields/fields';
import { formatDate, t } from '../i18n/i18n';
import type { FormValues } from '../records/record/forms';
import { asGatewayError } from '../records/gateway/gateway';
import { Snapshots, type AdminGateway, type ConnectorKind, type ConnectorSummary, type ConnectorTestRequest, type ConnectorView, type Delivery, type DeliveryStatus, type SaveConnector } from './admin';
import { failure, type AdminResult, type Navigate } from './roles';

export const CONNECTOR_KINDS: ConnectorKind[] = ['webhook', 'sms', 'whatsapp', 'http', 'oauth'];

/** A settings field as the forms draw it. */
export interface ConnectorField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'boolean' | 'number';
  required: boolean;
  readOnly: boolean;
  options: { key: string; label: string }[];
  hint?: string;
}

/** How a setting is kept in the saved config: text, a whole number, JSON, a list typed one per line, or a flag. */
type Stored = 'text' | 'number' | 'json' | 'lines' | 'flag';

interface Setting {
  key: string;
  type?: ConnectorField['type'];
  required?: boolean | ((v: FormValues) => boolean);
  options?: string[];
  /** Option labels are translated as ui.admin.connectors.o.<key>.<option>. */
  named?: boolean;
  stored?: Stored;
  /** Shown, and saved, only while this holds for the form's values. */
  when?: (v: FormValues) => boolean;
  hint?: string;
}

const lookup = (v: FormValues) => v['mode'] === 'lookup';
const send = (v: FormValues) => v['mode'] !== 'lookup';

const CONFIG: Record<ConnectorKind, Setting[]> = {
  webhook: [{ key: 'url', required: true }],
  whatsapp: [
    { key: 'baseUrl', required: true },
    { key: 'phoneNumberId', required: true },
  ],
  sms: [
    { key: 'url', required: true },
    { key: 'method', type: 'select', required: true, options: ['GET', 'POST'] },
    { key: 'body', type: 'textarea' },
    { key: 'contentType', type: 'select', options: ['json', 'form', 'text'] },
  ],
  http: [
    { key: 'mode', type: 'select', required: true, options: ['send', 'lookup'], named: true },
    { key: 'method', type: 'select', required: true, options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    { key: 'url', required: true, hint: 'ui.admin.connectors.h.placeholders' },
    { key: 'credential', type: 'select' },
    { key: 'headers', type: 'textarea', stored: 'json', hint: 'ui.admin.connectors.h.headers' },
    { key: 'body', type: 'textarea', hint: 'ui.admin.connectors.h.placeholders' },
    { key: 'contentType', type: 'select', options: ['json', 'form', 'text'] },
    { key: 'inputs', type: 'textarea', stored: 'lines', required: lookup, hint: 'ui.admin.connectors.h.inputs' },
    { key: 'responseMap', type: 'textarea', stored: 'json', required: true, when: lookup, hint: 'ui.admin.connectors.h.responseMap' },
    { key: 'success', type: 'textarea', stored: 'json', hint: 'ui.admin.connectors.h.success' },
    { key: 'timeoutMs', type: 'number', stored: 'number' },
    { key: 'emailSender', type: 'boolean', stored: 'flag', when: send, hint: 'ui.admin.connectors.h.emailSender' },
    { key: 'from', required: (v) => v['emailSender'] === true, when: send },
  ],
  oauth: [
    { key: 'authorizationUrl', required: true },
    { key: 'tokenUrl', required: true },
    { key: 'clientId', required: true },
    { key: 'scopes', type: 'textarea', stored: 'lines', required: true, hint: 'ui.admin.connectors.h.scopes' },
  ],
};

const SECRETS: Record<ConnectorKind, { name: string; required: boolean }[]> = {
  webhook: [{ name: 'signingSecret', required: true }],
  whatsapp: [
    { name: 'accessToken', required: true },
    { name: 'appSecret', required: false },
  ],
  sms: [{ name: 'apiKey', required: false }],
  http: [],
  oauth: [{ name: 'clientSecret', required: true }],
};

/** The server keeps an oauth connector's tokens among its secrets; only the client secret is typed here. */
const NAMED_SECRETS = new Set<ConnectorKind>(['sms', 'whatsapp', 'webhook', 'http']);
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

export const kindLabel = (k: ConnectorKind) => t(`ui.admin.connectors.kind.${k}`);

export function deliveryLabel(s: DeliveryStatus): string {
  return t(s === 'sent' ? 'ui.admin.connectors.del.delivered' : s === 'failed' ? 'ui.admin.connectors.del.failed' : 'ui.admin.connectors.del.pending');
}

/** An account sign-in's state in the list: the summary has no tokens, and `configured` needs the refresh token its connect stored. */
export function summaryState(c: ConnectorSummary): string {
  if (c.kind === 'oauth') return t(c.configured ? 'ui.admin.connectors.connected' : 'ui.admin.connectors.notConnected');
  return !c.configured ? t('ui.admin.connectors.notReady') : c.enabled ? t('ui.more.on') : t('ui.more.off');
}

const isRequired = (s: Setting, v: FormValues) => (typeof s.required === 'function' ? s.required(v) : !!s.required);
const shown = (s: Setting, v: FormValues) => !s.when || s.when(v);

/** The typed text as the value the config keeps; undefined when it does not read as that. */
function parse(stored: Stored, text: string): unknown {
  if (stored === 'number') return /^-?\d+$/.test(text) ? Number(text) : undefined;
  if (stored === 'lines')
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  if (stored === 'json') {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  return text;
}

function shownValue(stored: Stored, v: unknown): FormValues[string] {
  if (stored === 'flag') return v === true;
  if (v === undefined || v === null) return '';
  if (stored === 'json') return JSON.stringify(v, null, 2);
  if (stored === 'lines') return Array.isArray(v) ? v.map(String).join('\n') : String(v);
  return String(v);
}

/** The values a lookup test read, from the server's "Looked up {…}." answer. */
function lookedUp(message: string | undefined): { key: string; value: string }[] | undefined {
  const json = /\{[\s\S]*\}/.exec(message ?? '')?.[0];
  if (!json) return undefined;
  try {
    const values = JSON.parse(json) as unknown;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return undefined;
    return Object.entries(values).map(([key, value]) => ({ key, value: value === null ? '—' : String(value) }));
  } catch {
    return undefined;
  }
}

function dateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface ConnectorsSnapshot {
  items: ConnectorSummary[];
  loading: boolean;
  error: string;
}

/** Administration › Connectors: SMS, WhatsApp, webhooks, HTTP calls and account sign-in with what uses each. */
export class ConnectorsList {
  readonly state = new Snapshots<ConnectorsSnapshot>({ items: [], loading: false, error: '' });
  constructor(private readonly gateway: AdminGateway) {}

  async load(): Promise<void> {
    this.state.set({ loading: true, error: '' });
    try {
      this.state.set({ items: await this.gateway.connectors(), loading: false });
    } catch (e) {
      this.state.set({ loading: false, error: failure(e) });
    }
  }
}

export interface SecretState {
  name: string;
  label: string;
  required: boolean;
  set: boolean;
  /** Being set or replaced: a box for the new value is shown. */
  editing: boolean;
  value: string;
}

/** How Test is offered for the saved settings. */
export type TestMode = 'none' | 'phone' | 'email' | 'sample' | 'lookup';

export interface ConnectorTestOutcome {
  ok: boolean;
  message: string;
  /** A lookup's values, by the field each fills. */
  values?: { key: string; value: string }[];
}

export interface ConnectorSnapshot {
  view: ConnectorView | null;
  /** Not set up yet: saving creates it with the chosen kind. */
  isNew: boolean;
  /** A new connector has no kind until one is chosen. Saving requires one. */
  kindChosen: boolean;
  kind: ConnectorKind;
  values: FormValues;
  secrets: SecretState[];
  /** The name typed for a new http secret. */
  newSecret: string;
  /** Keys of the account sign-in connectors an http call can sign in with. */
  credentials: string[];
  errors: Record<string, string>;
  deliveries: Delivery[];
  chip: 'all' | DeliveryStatus;
  testTo: string;
  /** A lookup test's input values, by input field. */
  testInputs: Record<string, string>;
  testResult: ConnectorTestOutcome | null;
  loading: boolean;
  saving: boolean;
  error: string;
}

/**
 * One connector (`/admin/connectors/:key?result=`): its settings with secrets
 * shown only as set or not set, Test, and the delivery log with Retry now.
 * Secret values are typed here and sent once; they are never read back.
 */
export class ConnectorSession {
  readonly state = new Snapshots<ConnectorSnapshot>({
    view: null,
    isNew: false,
    kindChosen: true,
    kind: 'webhook',
    values: {},
    secrets: [],
    newSecret: '',
    credentials: [],
    errors: {},
    deliveries: [],
    chip: 'all',
    testTo: '',
    testInputs: {},
    testResult: null,
    loading: false,
    saving: false,
    error: '',
  });

  constructor(
    private readonly gateway: AdminGateway,
    readonly key: string,
    private readonly nav: Navigate,
  ) {}

  async load(kindForNew?: ConnectorKind): Promise<void> {
    this.state.set({ loading: true, error: '' });
    void this.loadCredentials();
    try {
      const view = await this.gateway.connector(this.key);
      this.use(view);
      this.state.set({ loading: false, deliveries: await this.gateway.deliveries(this.key) });
    } catch (e) {
      const err = asGatewayError(e, '');
      if (err.code === 'not_found') {
        this.state.set({ loading: false, isNew: true, view: null, kindChosen: false, values: {}, secrets: [] });
        if (kindForNew) this.chooseKind(kindForNew);
      } else this.state.set({ loading: false, error: failure(e) });
    }
  }

  private async loadCredentials(): Promise<void> {
    try {
      const all = await this.gateway.connectors();
      this.state.set({ credentials: all.filter((c) => c.kind === 'oauth' && c.key !== this.key).map((c) => c.key) });
    } catch {
      this.state.set({ credentials: [] });
    }
  }

  chooseKind(kind: ConnectorKind | ''): void {
    if (!this.state.value.isNew) return;
    if (!kind) {
      this.state.set({ kindChosen: false, values: {}, secrets: [], errors: {} });
      return;
    }
    const defaults: FormValues = kind === 'sms' ? { method: 'POST', contentType: 'json' } : kind === 'http' ? { mode: 'send', method: 'POST', contentType: 'json', emailSender: false } : {};
    this.state.set({ kindChosen: true, kind, values: { enabled: false, ...defaults }, secrets: this.secretStates(kind, []), errors: {} });
  }

  fields(): ConnectorField[] {
    if (!this.state.value.kindChosen) return [];
    const { kind, values, credentials } = this.state.value;
    return [
      ...CONFIG[kind]
        .filter((s) => shown(s, values))
        .map((s) => ({
          key: s.key,
          label: t(`ui.admin.connectors.f.${s.key}`),
          type: s.type ?? 'text',
          required: isRequired(s, values),
          readOnly: false,
          options:
            s.key === 'credential'
              ? [{ key: '', label: t('ui.admin.connectors.none') }, ...credentials.map((c) => ({ key: c, label: c }))]
              : (s.options ?? []).map((o) => ({ key: o, label: s.named ? t(`ui.admin.connectors.o.${s.key}.${o}`) : o })),
          ...(s.hint && { hint: t(s.hint) }),
        })),
      { key: 'enabled', label: t('ui.admin.connectors.enabled'), type: 'boolean' as const, required: false, readOnly: false, options: [] },
    ];
  }

  setValues(values: FormValues): void {
    this.state.set({ values, errors: {} });
  }

  editSecret(name: string): void {
    this.state.set({ secrets: this.state.value.secrets.map((s) => (s.name === name ? { ...s, editing: true } : s)) });
  }

  typeSecret(name: string, value: string): void {
    this.state.set({ secrets: this.state.value.secrets.map((s) => (s.name === name ? { ...s, value } : s)) });
  }

  /** Whether secrets can be named here: an http call's placeholders use {{secrets.<name>}}. */
  namesSecrets(): boolean {
    return this.state.value.kind === 'http';
  }

  setNewSecret(name: string): void {
    this.state.set({ newSecret: name, errors: { ...this.state.value.errors, newSecret: '' } });
  }

  /** Adds a box for a secret the http call's settings name; it is sent with the next save. */
  addSecret(): void {
    const s = this.state.value;
    const name = s.newSecret.trim();
    if (!SECRET_NAME.test(name)) {
      this.state.set({ errors: { ...s.errors, newSecret: t('ui.admin.connectors.secretName') } });
      return;
    }
    const secrets = s.secrets.some((x) => x.name === name)
      ? s.secrets.map((x) => (x.name === name ? { ...x, editing: true } : x))
      : [...s.secrets, { name, label: name, required: false, set: false, editing: true, value: '' }];
    this.state.set({ secrets, newSecret: '', errors: { ...s.errors, newSecret: '' } });
  }

  async save(): Promise<AdminResult> {
    const s = this.state.value;
    if (s.isNew && !s.kindChosen) {
      this.state.set({ errors: { kind: t('ui.records.required', { field: t('ui.admin.connectors.col.kind') }) } });
      return { ok: false, message: '' };
    }
    const errors: Record<string, string> = {};
    const config: Record<string, unknown> = { ...(s.view?.config ?? {}) };
    for (const f of CONFIG[s.kind]) {
      const stored = f.stored ?? 'text';
      const raw = s.values[f.key];
      if (!shown(f, s.values) || (stored === 'flag' && raw !== true)) {
        delete config[f.key];
        continue;
      }
      if (stored === 'flag') {
        config[f.key] = true;
        continue;
      }
      const label = t(`ui.admin.connectors.f.${f.key}`);
      const v = String(raw ?? '').trim();
      if (!v) {
        if (isRequired(f, s.values)) errors[f.key] = t('ui.records.required', { field: label });
        delete config[f.key];
        continue;
      }
      const value = parse(stored, v);
      if (value === undefined) errors[f.key] = t(stored === 'number' ? 'ui.admin.connectors.notNumber' : 'ui.admin.connectors.notJson', { field: label });
      else config[f.key] = value;
    }
    if (Object.keys(errors).length) {
      this.state.set({ errors });
      return { ok: false, message: '' };
    }
    const secrets = Object.fromEntries(s.secrets.filter((x) => x.editing && x.value).map((x) => [x.name, x.value]));
    const body: SaveConnector = { ...(s.isNew && { kind: s.kind }), enabled: s.values['enabled'] === true, config, ...(Object.keys(secrets).length && { secrets }) };
    this.state.set({ saving: true, error: '' });
    try {
      this.use(await this.gateway.saveConnector(this.key, body));
      this.state.set({ saving: false });
      return { ok: true, message: t('ui.admin.connectors.saved') };
    } catch (e) {
      const err = asGatewayError(e, t('ui.common.somethingWentWrong'));
      const byField = issuesByField((err.issues ?? []).map((i) => ({ ...i, path: i.path.replace(/^\/(config|secrets)\//, '/') })));
      this.state.set({ saving: false, errors: byField, error: err.message });
      return { ok: false, message: err.message };
    }
  }

  /** Test as the saved settings allow it: a phone number, an email address, a sample send, the lookup's inputs, or nothing to ask. */
  testMode(): TestMode {
    const { view } = this.state.value;
    if (!view) return 'none';
    if (view.kind === 'sms' || view.kind === 'whatsapp') return 'phone';
    if (view.kind !== 'http') return 'none';
    if (view.config['mode'] === 'lookup') return 'lookup';
    return view.config['emailSender'] === true ? 'email' : 'sample';
  }

  /** The saved lookup's input fields, each given a value to test with. */
  lookupInputs(): string[] {
    const inputs = this.state.value.view?.config['inputs'];
    return Array.isArray(inputs) ? inputs.filter((i): i is string => typeof i === 'string') : [];
  }

  setTestTo(to: string): void {
    this.state.set({ testTo: to });
  }

  setTestInput(field: string, value: string): void {
    this.state.set({ testInputs: { ...this.state.value.testInputs, [field]: value } });
  }

  private testRequest(mode: TestMode): ConnectorTestRequest | undefined {
    const s = this.state.value;
    if (mode === 'lookup') return { inputs: Object.fromEntries(this.lookupInputs().map((f) => [f, s.testInputs[f] ?? ''])) };
    if (mode === 'phone' || mode === 'email') {
      const to = s.testTo.trim();
      return to ? { to } : {};
    }
    return mode === 'sample' ? {} : undefined;
  }

  async test(): Promise<void> {
    const mode = this.testMode();
    const kind = this.state.value.kind;
    this.state.set({ saving: true, testResult: null });
    try {
      const out = await this.gateway.testConnector(this.key, this.testRequest(mode));
      const values = out.ok && mode === 'lookup' ? lookedUp(out.message) : undefined;
      const message = !out.ok
        ? t('ui.admin.connectors.testFailed', { error: out.error ?? String(out.status ?? '') })
        : kind === 'oauth'
          ? t('ui.admin.connectors.renewed')
          : mode === 'lookup'
            ? values
              ? t('ui.admin.connectors.lookedUp')
              : (out.message ?? t('ui.admin.connectors.lookedUp'))
            : t('ui.admin.connectors.testOk', { status: out.status ?? '—' });
      const testResult: ConnectorTestOutcome = { ok: out.ok, message, ...(values && { values }) };
      this.state.set({ saving: false, testResult, deliveries: await this.gateway.deliveries(this.key) });
    } catch (e) {
      this.state.set({ saving: false, testResult: { ok: false, message: failure(e) } });
    }
  }

  /** An account sign-in's state, with when its access token expires. */
  oauthState(): string {
    const o = this.state.value.view?.oauth;
    if (!o?.connected) return t('ui.admin.connectors.notConnected');
    return o.expiresAt ? t('ui.admin.connectors.connectedUntil', { time: dateTime(o.expiresAt) }) : t('ui.admin.connectors.connected');
  }

  /** Where Connect sends the browser: the provider's sign-in page. */
  async connect(): Promise<{ url: string } | AdminResult> {
    if (this.state.value.isNew) return { ok: false, message: '' };
    try {
      return await this.gateway.startOauth(this.key);
    } catch (e) {
      return { ok: false, message: failure(e) };
    }
  }

  setChip(chip: string): void {
    this.state.set({ chip: chip as ConnectorSnapshot['chip'] });
  }

  shownDeliveries(): Delivery[] {
    const { chip, deliveries } = this.state.value;
    return chip === 'all' ? deliveries : deliveries.filter((d) => d.status === chip);
  }

  openResult(id: string, replace = false): void {
    this.nav.navigate({ result: id }, replace);
  }

  closeResult(): void {
    this.nav.navigate({ result: null }, true);
  }

  async retry(id: string): Promise<AdminResult> {
    try {
      await this.gateway.retryDelivery(this.key, id);
      this.state.set({ deliveries: await this.gateway.deliveries(this.key) });
      return { ok: true, message: t('ui.admin.connectors.retried') };
    } catch (e) {
      return { ok: false, message: failure(e) };
    }
  }

  private use(view: ConnectorView): void {
    const values: FormValues = { enabled: view.enabled };
    for (const f of CONFIG[view.kind]) values[f.key] = shownValue(f.stored ?? 'text', view.config[f.key]);
    this.state.set({ view, isNew: false, kindChosen: true, kind: view.kind, values, secrets: this.secretStates(view.kind, view.secrets), errors: {} });
  }

  private secretStates(kind: ConnectorKind, set: string[]): SecretState[] {
    const extra = NAMED_SECRETS.has(kind) ? set.filter((n) => !SECRETS[kind].some((s) => s.name === n)).map((name) => ({ name, required: false })) : [];
    return [...SECRETS[kind], ...extra].map(({ name, required }) => {
      const key = `ui.admin.connectors.s.${name}`;
      const label = t(key);
      return { name, label: label === key ? name : label, required, set: set.includes(name), editing: !set.includes(name), value: '' };
    });
  }
}
