export const EMAIL_PROVIDERS = ['gmail', 'http'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const CONTENT_TYPES = ['json', 'form', 'text'] as const;

export interface GmailEmailConfig {
  provider: 'gmail';
  credential: string;
  userId: string;
}

/** Admin-saved HTTPS mail API (SendGrid, Postmark, custom). */
export interface HttpEmailConfig {
  provider: 'http';
  method: (typeof METHODS)[number];
  url: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: (typeof CONTENT_TYPES)[number];
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
  if (!METHODS.includes(method as HttpEmailConfig['method']) || typeof url !== 'string') return undefined;
  const config: HttpEmailConfig = { provider: 'http', method: method as HttpEmailConfig['method'], url };
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

/** Whether the oauth connector lists the Gmail send scope. */
export function oauthHasGmailSend(scopes: unknown): boolean {
  if (!Array.isArray(scopes)) return false;
  return scopes.some((s) => typeof s === 'string' && (s === GMAIL_SEND_SCOPE || s.endsWith('/gmail.send')));
}
