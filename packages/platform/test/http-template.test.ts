import { describe, expect, it } from 'vitest';
import { HttpTemplateError, parseHttpConfig, renderHttp, unknownPlaceholders, type HttpConfig } from '../src/application/connectors/http-template.js';

const send = (over: Partial<HttpConfig> = {}): HttpConfig => ({ mode: 'send', method: 'POST', url: 'https://api.example.org/send', ...over });

describe('http connector templates', () => {
  it('throws on an unknown placeholder or encoder before rendering', () => {
    expect(() => renderHttp(send({ body: '{"to":"{{message.cc}}"}' }), {}, {})).toThrow(HttpTemplateError);
    expect(() => renderHttp(send({ body: '{{ message.to | rot13 }}' }), {}, {})).toThrow(HttpTemplateError);
    expect(() => renderHttp(send({ body: '{{secrets.missing}}' }), {}, {})).toThrow(HttpTemplateError);
    expect(() => renderHttp(send({ headers: { authorization: 'Bearer {{credential.accessToken}}' } }), {}, {})).toThrow(HttpTemplateError);
  });

  it('base64url-encodes a value like Buffer does, then encodes it for the location', () => {
    const mime = 'From: a@example.org\r\nSubject: Héllo ~?\r\n\r\nBody>>>';
    const { request } = renderHttp(send({ body: '{"raw":"{{ message.mime | base64url }}"}' }), { message: { mime } }, {});
    expect(JSON.parse(request.body!).raw).toBe(Buffer.from(mime).toString('base64url'));
    const url = renderHttp(send({ method: 'GET', url: 'https://api.example.org/?q={{message.subject|base64}}' }), { message: { subject: 'a?b>' } }, {}).request.url;
    expect(url).toBe(`https://api.example.org/?q=${encodeURIComponent(Buffer.from('a?b>').toString('base64'))}`);
  });

  it('json encoder writes the whole value as JSON', () => {
    const { request } = renderHttp(send({ contentType: 'text', body: '{"r":{{ record.tags | json }}}' }), { record: { tags: ['a', 'b'] } }, {});
    expect(JSON.parse(request.body!)).toEqual({ r: ['a', 'b'] });
  });

  it('strips CR and LF from header values', () => {
    const { request } = renderHttp(send({ headers: { 'X-Subject': '{{message.subject}}' } }), { message: { subject: 'Hi\r\nInjected: yes' } }, {});
    expect(request.headers['x-subject']).toBe('HiInjected: yes');
  });

  it('lists every substituted secret and access token for redaction', () => {
    const { request, secrets } = renderHttp(
      send({ headers: { authorization: 'Bearer {{credential.accessToken}}' }, body: '{"key":"{{secrets.apiKey}}","to":"{{message.to}}"}', timeoutMs: 5000 }),
      { message: { to: '+911234567890' } },
      { apiKey: 'sk-live-123', unused: 'never' },
      { accessToken: 'tok-abc' },
    );
    expect(JSON.parse(request.body!)).toEqual({ key: 'sk-live-123', to: '+911234567890' });
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.timeoutMs).toBe(5000);
    expect(request.maxBodyBytes).toBeUndefined();
    expect(secrets.sort()).toEqual(['sk-live-123', 'tok-abc']);
  });

  it('lookup mode refuses message placeholders and records outside its inputs', () => {
    const lookup = (body: string): HttpConfig => ({ mode: 'lookup', method: 'POST', url: 'https://api.example.org/find', body, inputs: ['pan'] });
    expect(() => renderHttp(lookup('{"to":"{{message.to}}"}'), { message: { to: '+91' } }, {})).toThrow(HttpTemplateError);
    expect(() => renderHttp(lookup('{"x":"{{record.email}}"}'), { record: { email: 'a@b' } }, {})).toThrow(HttpTemplateError);
    expect(renderHttp(lookup('{"pan":"{{ record.pan }}","org":"{{organisation.name}}"}'), { record: { pan: 'ABCDE1234F' }, organisation: { name: 'Asha' } }, {}).request.body).toBe(
      '{"pan":"ABCDE1234F","org":"Asha"}',
    );
    expect(unknownPlaceholders('{{message.to}} {{record.pan}} {{ record.pan | json }}', { mode: 'lookup', inputs: ['pan'] })).toEqual(['message.to']);
  });

  it('parses a stored config only when mode, method and url are present', () => {
    expect(parseHttpConfig({ mode: 'send', method: 'POST' })).toBeUndefined();
    expect(parseHttpConfig({ mode: 'other', method: 'POST', url: 'https://x' })).toBeUndefined();
    expect(parseHttpConfig({ mode: 'lookup', method: 'GET', url: 'https://x', inputs: ['pan'], timeoutMs: 'slow' })).toEqual({ mode: 'lookup', method: 'GET', url: 'https://x', inputs: ['pan'] });
  });
});
