import { describe, expect, it } from 'vitest';
import { parseEmailConfig } from '../../../packages/platform/src/domain/connectors/email-config.js';
import { renderEmailHttp } from '../../../packages/platform/src/application/connectors/email-connector.js';
import { HTTP_SEND_MESSAGE_PARTS, unknownPlaceholders } from '../../../packages/platform/src/application/connectors/http-template.js';

describe('email connectors', () => {
  it('parses gmail and http providers', () => {
    expect(parseEmailConfig({ provider: 'gmail', credential: 'google-mail' })).toEqual({ provider: 'gmail', credential: 'google-mail', userId: 'me' });
    expect(parseEmailConfig({ provider: 'http', method: 'POST', url: 'https://api.mail.test/send' })).toMatchObject({ provider: 'http', method: 'POST', url: 'https://api.mail.test/send' });
    expect(parseEmailConfig({ provider: 'gcs' })).toBeUndefined();
  });

  it('base64url-encodes message.mime for HTTPS mail APIs', () => {
    const mime = 'From: a@example.org\r\nSubject: Héllo\r\n\r\nBody';
    const { request } = renderEmailHttp(
      { provider: 'http', method: 'POST', url: 'https://api.mail.test/send', body: '{"raw":"{{ message.mime | base64url }}"}', contentType: 'json' },
      { message: { mime, to: 'b@example.org', from: 'a@example.org', subject: 'Héllo', text: 'Body' }, organisation: { name: 'Asha' } },
      {},
    );
    expect(JSON.parse(request.body!).raw).toBe(Buffer.from(mime).toString('base64url'));
  });

  it('rejects message.mime on a generic http send template', () => {
    expect(
      unknownPlaceholders('{"raw":"{{ message.mime | base64url }}"}', {
        mode: 'send',
        secrets: [],
        messageParts: HTTP_SEND_MESSAGE_PARTS,
      }),
    ).toEqual(['message.mime | base64url']);
  });
});