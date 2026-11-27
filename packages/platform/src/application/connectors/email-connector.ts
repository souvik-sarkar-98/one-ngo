import type { EmailConfig, GmailEmailConfig, HttpEmailConfig } from '../../domain/connectors/email-config.js';
import { EMAIL_MESSAGE_PARTS, renderHttp, unknownPlaceholders, type HttpBinding, type HttpConfig, type RenderedHttp } from './http-template.js';

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
