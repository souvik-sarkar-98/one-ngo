import type { ConnectorRequest } from './ports/connector-runtime.js';

export type HttpMode = 'send' | 'lookup';
export type HttpContentType = 'json' | 'form' | 'text';

/**
 * http: a request built from templates. `url`, header values and `body` may
 * use placeholders such as {{record.x}}, {{message.to}}, {{secrets.n}} or
 * {{credential.accessToken}}, optionally with an encoder: {{ message.mime | base64url }}.
 */
export interface HttpConfig {
  mode: HttpMode;
  method: ConnectorRequest['method'];
  url: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: HttpContentType;
  /** Key of the oauth connector whose access token {{credential.accessToken}} is. */
  credential?: string;
  timeoutMs?: number;
  /** Response statuses that count as success; absent means any 2xx. */
  success?: number[];
  emailSender?: boolean;
  /** The From address used when `emailSender` is true. */
  from?: string;
  /** lookup: the record fields the request may use. */
  inputs?: string[];
  /** lookup: field -> JSON path in the response. */
  responseMap?: Record<string, string>;
}

/** The values placeholders read; a missing record field or message part renders as empty text. */
export interface HttpBinding {
  record?: Record<string, unknown>;
  message?: { to?: string; subject?: string; text?: string; from?: string; mime?: string };
  organisation?: { name: string };
}

/** Which placeholders a template may use. `secrets` lists the secret names that exist; absent accepts any valid name. */
export interface AllowedPlaceholders {
  mode: HttpMode;
  inputs?: readonly string[];
  secrets?: readonly string[];
  /** Whether {{credential.accessToken}} is available; default true. */
  credential?: boolean;
}

export interface RenderedHttp {
  request: ConnectorRequest;
  /** Every secret value substituted, raw and as encoded, for redaction. */
  secrets: string[];
}

/** A template that cannot be rendered; raised before any call is made. */
export class HttpTemplateError extends Error {
  constructor(
    message: string,
    readonly placeholders: string[],
  ) {
    super(message);
    this.name = 'HttpTemplateError';
  }
}

const MODES: readonly HttpMode[] = ['send', 'lookup'];
const METHODS: readonly ConnectorRequest['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const CONTENT_TYPES: readonly HttpContentType[] = ['json', 'form', 'text'];
const MESSAGE_PARTS = ['to', 'subject', 'text', 'from', 'mime'] as const;
const PLACEHOLDER = /\{\{([^}]*)\}\}/g;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const CONTENT_TYPE: Record<HttpContentType, string> = { json: 'application/json', form: 'application/x-www-form-urlencoded', text: 'text/plain; charset=utf-8' };

type Encoder = 'base64url' | 'base64' | 'json';
const ENCODERS: Record<Encoder, (value: unknown) => string> = {
  base64url: (v) => Buffer.from(text(v), 'utf8').toString('base64url'),
  base64: (v) => Buffer.from(text(v), 'utf8').toString('base64'),
  json: (v) => JSON.stringify(v ?? null),
};

type Location = 'url' | 'header' | HttpContentType;
const LOCATION: Record<Location, (v: string) => string> = {
  url: encodeURIComponent,
  header: (v) => v.replace(/[\r\n]/g, ''),
  json: (v) => JSON.stringify(v).slice(1, -1),
  form: encodeURIComponent,
  text: (v) => v,
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isEncoder = (v: string): v is Encoder => Object.hasOwn(ENCODERS, v);

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

interface Token {
  name: string;
  encoder?: Encoder;
}

/** The placeholder's name and encoder, or undefined when it is malformed or not allowed. */
function parseToken(inner: string, allowed: AllowedPlaceholders): Token | undefined {
  const parts = inner.split('|').map((p) => p.trim());
  if (parts.length > 2) return undefined;
  const [name, encoder] = parts as [string, string | undefined];
  if (encoder !== undefined && !isEncoder(encoder)) return undefined;
  if (!placeholderAllowed(name, allowed)) return undefined;
  return encoder === undefined ? { name } : { name, encoder };
}

function placeholderAllowed(name: string, allowed: AllowedPlaceholders): boolean {
  const dot = name.indexOf('.');
  if (dot < 0) return false;
  const scope = name.slice(0, dot);
  const rest = name.slice(dot + 1);
  switch (scope) {
    case 'record':
      return FIELD.test(rest) && (allowed.mode === 'send' || (allowed.inputs ?? []).includes(rest));
    case 'message':
      return allowed.mode === 'send' && (MESSAGE_PARTS as readonly string[]).includes(rest);
    case 'organisation':
      return rest === 'name';
    case 'secrets':
      return SECRET_NAME.test(rest) && (allowed.secrets === undefined || allowed.secrets.includes(rest));
    case 'credential':
      return rest === 'accessToken' && allowed.credential !== false;
    default:
      return false;
  }
}

/** The placeholders in `template` (as written, trimmed) that are malformed, use an unknown encoder, or are not allowed. */
export function unknownPlaceholders(template: string, allowed: AllowedPlaceholders): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const inner = m[1]!.trim();
    if (!parseToken(inner, allowed) && !out.includes(inner)) out.push(inner);
  }
  return out;
}

/** The templates of a config: its url, header values and body. */
function templates(config: HttpConfig): string[] {
  return [config.url, ...Object.values(config.headers ?? {}), ...(config.body === undefined ? [] : [config.body])];
}

/**
 * Builds the request for an http connector. Every placeholder is checked
 * before anything is rendered, so a bad template never reaches the network.
 */
export function renderHttp(
  config: HttpConfig,
  binding: HttpBinding,
  secrets: Record<string, string>,
  credential?: { accessToken?: string },
): RenderedHttp {
  const allowed: AllowedPlaceholders = {
    mode: config.mode,
    inputs: config.inputs ?? [],
    secrets: Object.keys(secrets),
    credential: credential?.accessToken !== undefined,
  };
  const bad = [...new Set(templates(config).flatMap((t) => unknownPlaceholders(t, allowed)))];
  if (bad.length) {
    throw new HttpTemplateError(`The connector request uses placeholders it may not use: ${bad.map((b) => `{{${b}}}`).join(', ')}.`, bad);
  }

  const used = new Set<string>();
  const value = (name: string): { value: unknown; secret: boolean } => {
    const dot = name.indexOf('.');
    const scope = name.slice(0, dot);
    const rest = name.slice(dot + 1);
    if (scope === 'record') return { value: binding.record?.[rest], secret: false };
    if (scope === 'message') return { value: binding.message?.[rest as (typeof MESSAGE_PARTS)[number]], secret: false };
    if (scope === 'organisation') return { value: binding.organisation?.name, secret: false };
    if (scope === 'secrets') return { value: secrets[rest], secret: true };
    return { value: credential?.accessToken, secret: true };
  };
  const fill = (template: string, location: Location): string =>
    template.replace(PLACEHOLDER, (_m, inner: string) => {
      const token = parseToken(inner.trim(), allowed)!;
      const v = value(token.name);
      const encoded = token.encoder ? ENCODERS[token.encoder](v.value) : text(v.value);
      if (v.secret) {
        const raw = text(v.value);
        if (raw) used.add(raw);
        if (encoded) used.add(encoded);
      }
      return LOCATION[location](encoded);
    });

  const contentType = config.contentType ?? 'json';
  const headers: Record<string, string> = {};
  for (const [name, v] of Object.entries(config.headers ?? {})) headers[name.toLowerCase()] = fill(v, 'header');
  const request: ConnectorRequest = { url: fill(config.url, 'url'), method: config.method, headers };
  if (config.body !== undefined && config.method !== 'GET') {
    request.body = fill(config.body, contentType);
    headers['content-type'] ??= CONTENT_TYPE[contentType];
  }
  if (config.timeoutMs !== undefined) request.timeoutMs = config.timeoutMs;
  return { request, secrets: [...used] };
}

const stringRecord = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === 'string');
const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The http config in a stored object, or undefined when mode, method or url is missing or of the wrong type. Optional settings of the wrong type are left out. */
export function parseHttpConfig(raw: unknown): HttpConfig | undefined {
  if (!isObject(raw)) return undefined;
  const { mode, method, url } = raw;
  if (!MODES.includes(mode as HttpMode) || !METHODS.includes(method as ConnectorRequest['method']) || typeof url !== 'string') return undefined;
  const config: HttpConfig = { mode: mode as HttpMode, method: method as ConnectorRequest['method'], url };
  if (stringRecord(raw.headers)) config.headers = raw.headers;
  if (typeof raw.body === 'string') config.body = raw.body;
  if (CONTENT_TYPES.includes(raw.contentType as HttpContentType)) config.contentType = raw.contentType as HttpContentType;
  if (typeof raw.credential === 'string') config.credential = raw.credential;
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)) config.timeoutMs = raw.timeoutMs;
  if (Array.isArray(raw.success) && raw.success.every((s) => Number.isInteger(s))) config.success = raw.success as number[];
  if (typeof raw.emailSender === 'boolean') config.emailSender = raw.emailSender;
  if (typeof raw.from === 'string') config.from = raw.from;
  if (stringArray(raw.inputs)) config.inputs = raw.inputs;
  if (stringRecord(raw.responseMap)) config.responseMap = raw.responseMap;
  return config;
}
