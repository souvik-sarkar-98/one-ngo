import {
  EMAIL_MESSAGE_PARTS,
  parseHttpConfig,
  renderHttp,
  unknownPlaceholders,
  type HttpBinding,
  type HttpConfig,
  type RenderedHttp,
} from '../../application/connectors/http-template.js';
import type { ConnectorRequest } from '../../application/connectors/ports/connector-runtime.js';

export const EMAIL_PROVIDERS = ['gmail', 'http'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const METHODS: readonly ConnectorRequest['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const CONTENT_TYPES = ['json', 'form', 'text'] as const;

export interface GmailEmailConfig {
  provider: 'gmail';
  credential: string;
  userId: string;
}

/** Admin-saved HTTPS mail API (SendGrid, Postmark, custom). */
export interface HttpEmailConfig {
  provider: 'http';
  method: ConnectorRequest['method'];
  url: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: HttpConfig['contentType'];
  credential?: string;
  timeoutMs?: number;
  success?: number[];
}

export type EmailConfig = GmailEmailConfig | HttpEmailConfig;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const stringRecord = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === 'string');

function userIdOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 320 || /[\r\n/]/.test(value)) return 'me';
  return value.trim();
}

/** The stored email connector config, or undefined when the provider or required fields are missing. */
export function parseEmailConfig(raw: unknown): EmailConfig | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.provider === 'gmail') {
    if (typeof raw.credential !== 'string' || !raw.credential.trim()) return undefined;
    return { provider: 'gmail', credential: raw.credential.trim(), userId: userIdOf(raw.userId) };
  }
  if (raw.provider !== 'http') return undefined;
  const { method, url } = raw;
  if (!METHODS.includes(method as ConnectorRequest['method']) || typeof url !== 'string') return undefined;
  const config: HttpEmailConfig = { provider: 'http', method: method as ConnectorRequest['method'], url };
  if (stringRecord(raw.headers)) config.headers = raw.headers;
  if (typeof raw.body === 'string') config.body = raw.body;
  if (CONTENT_TYPES.includes(raw.contentType as (typeof CONTENT_TYPES)[number])) {
    config.contentType = raw.contentType as HttpEmailConfig['contentType'];
  }
  if (typeof raw.credential === 'string' && raw.credential.trim()) config.credential = raw.credential.trim();
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)) config.timeoutMs = raw.timeoutMs;
  if (Array.isArray(raw.success) && raw.success.every((s) => Number.isInteger(s))) config.success = raw.success as number[];
  return config;
}

function gmailHttpConfig(config: GmailEmailConfig): HttpConfig {
  const user = encodeURIComponent(config.userId);
  return {
    mode: 'send',
    method: 'POST',
    url: `https://gmail.googleapis.com/gmail/v1/users/${user}/messages/send`,
    headers: { Authorization: 'Bearer {{credential.accessToken}}', 'content-type': 'application/json' },
    body: '{"raw":"{{ message.mime | base64url }}"}',
    contentType: 'json',
    credential: config.credential,
  };
}

function httpProviderHttpConfig(config: HttpEmailConfig): HttpConfig {
  return {
    mode: 'send',
    method: config.method,
    url: config.url,
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.body !== undefined ? { body: config.body } : {}),
    ...(config.contentType ? { contentType: config.contentType } : {}),
    ...(config.credential ? { credential: config.credential } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.success ? { success: config.success } : {}),
  };
}

export function emailHttpConfig(config: EmailConfig): HttpConfig {
  return config.provider === 'gmail' ? gmailHttpConfig(config) : httpProviderHttpConfig(config);
}

/** Builds the HTTPS request for an email connector, including MIME placeholders. */
export function renderEmailHttp(
  config: EmailConfig,
  binding: HttpBinding,
  secrets: Record<string, string>,
  credential?: { accessToken?: string },
): RenderedHttp {
  return renderHttp(emailHttpConfig(config), binding, secrets, credential, EMAIL_MESSAGE_PARTS);
}

/** Placeholders an email http provider may use in url, headers and body. */
export function unknownEmailPlaceholders(template: string, secrets: readonly string[], credential: boolean): string[] {
  return unknownPlaceholders(template, {
    mode: 'send',
    secrets,
    credential,
    messageParts: EMAIL_MESSAGE_PARTS,
  });
}

/** Whether the oauth connector lists the Gmail send scope. */
export function oauthHasGmailSend(scopes: unknown): boolean {
  if (!Array.isArray(scopes)) return false;
  return scopes.some((s) => typeof s === 'string' && (s === GMAIL_SEND_SCOPE || s.endsWith('/gmail.send')));
}