import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pwnedPasswords } from '@onengo/kernel/crypto';
import { connectorSettings } from '../src/connectors.js';
import { MAIL, PATHS } from '../src/constants.js';
import type { Fixture } from '../src/server.js';
import { call, trustedFetch, tempFixture } from './helpers.js';

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex').toUpperCase();
const LINE = /^[0-9A-F]{35}:\d+$/;

let fixture: Fixture;
let cleanup: () => Promise<void>;
beforeAll(async () => ({ fixture, cleanup } = await tempFixture()));
afterAll(() => cleanup());

describe('breached-password range stand-in', () => {
  it('answers in the hash-suffix format and reports only "password" as breached', async () => {
    const hash = sha1('password');
    const res = await call(fixture, `/range/${hash.slice(0, 5)}`);
    expect(res.status).toBe(200);
    const lines = res.text.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toMatch(LINE);
    const hit = lines.find((l) => l.startsWith(`${hash.slice(5)}:`));
    expect(Number(hit?.split(':')[1])).toBeGreaterThan(0);

    const other = sha1('monsoon in the hills');
    const otherLines = (await call(fixture, `/range/${other.slice(0, 5)}`)).text.split('\r\n');
    for (const line of otherLines) expect(line).toMatch(LINE);
    expect(otherLines.some((l) => l.startsWith(`${other.slice(5)}:`))).toBe(false);
  });

  it('adds count-0 lines with Add-Padding and refuses a malformed prefix', async () => {
    const padded = (await call(fixture, '/range/ABCDE', { headers: { 'Add-Padding': 'true' } })).text.split('\r\n');
    expect(padded.some((l) => l.endsWith(':0'))).toBe(true);
    expect((await call(fixture, '/range/XYZ12')).status).toBe(400);
  });

  it('works with the breach check one-ngo uses', async () => {
    const source = pwnedPasswords({ apiBase: fixture.origin, fetch: (url, init) => trustedFetch(fixture)(url, init) });
    expect(await source.breachCount('password')).toBeGreaterThan(0);
    expect(await source.breachCount('monsoon in the hills')).toBeNull();
  });
});

function mime(lines: string[]): string {
  return lines.join('\r\n');
}

function send(raw: string, token: string = MAIL.token) {
  return call(fixture, PATHS.gmailSend, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
  });
}

describe('Gmail-style email sender', () => {
  it('publishes the connector an organisation must save', () => {
    expect(connectorSettings('https://127.0.0.1:8095').gmail).toMatchObject({
      kind: 'email',
      enabled: true,
      config: {
        provider: 'http',
        method: 'POST',
        url: `https://127.0.0.1:8095${PATHS.gmailSend}`,
        headers: { Authorization: `Bearer {{secrets.accessToken}}` },
        body: '{"raw":"{{ message.mime | base64url }}"}',
        contentType: 'json',
      },
      secrets: { accessToken: MAIL.token },
    });
  });

  it('accepts a base64url RFC 822 message and refuses a wrong token or a body that is not a message', async () => {
    const subject = `Sign-in ${randomBytes(4).toString('hex')}`;
    const raw = mime(['From: demo@localhost', 'To: member@asha.org', `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', 'Code 123456']);
    const before = fixture.mailbox.messages.length;
    const sent = await send(raw);
    expect(sent.status).toBe(200);
    expect(sent.json()).toMatchObject({ id: String(before + 1), threadId: String(before + 1), labelIds: ['SENT'] });
    expect(fixture.mailbox.messages[0]).toMatchObject({ from: MAIL.from, fromName: MAIL.from, to: ['member@asha.org'], subject, text: 'Code 123456' });
    expect((await call(fixture, `/mail/${sent.json<{ id: string }>().id}`)).text).toContain('Code 123456');

    expect((await send(raw, 'wrong')).status).toBe(401);
    expect((await send('hello, not a message')).status).toBe(400);
    expect((await call(fixture, PATHS.gmailSend, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }) })).status).toBe(401);
    expect(fixture.mailbox.messages.filter((message) => message.subject === subject)).toHaveLength(1);

    const inbox = (await call(fixture, '/inbox')).json<{ messages: { id: number; subject: string }[] }>();
    expect(inbox.messages.some((message) => message.id === Number(sent.json<{ id: string }>().id))).toBe(true);
    const log = (await call(fixture, '/api/log')).json<{ messages: { subject: string; to: string[] }[] }>();
    const logged = log.messages.find((message) => message.subject === subject);
    expect(logged).toMatchObject({ to: ['member@asha.org'] });
    expect(logged).not.toHaveProperty('raw');
    expect(logged).not.toHaveProperty('text');
  });

  it('returns a multipart message as JSON, with the HTML left unrendered', async () => {
    const subject = 'Thanks Asha';
    const boundary = 'ngo-test';
    const raw = mime([
      'From: Office <demo@localhost>',
      'To: member@asha.org',
      'Cc: clerk@asha.org',
      `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      '<p>Hello</p><script>alert(1)</script>',
      `--${boundary}--`,
      '',
    ]);
    const sent = await send(raw);
    expect(sent.status).toBe(200);
    const message = fixture.mailbox.messages[0]!;
    expect(message).toMatchObject({ from: 'demo@localhost', fromName: 'Office', to: ['member@asha.org'], cc: ['clerk@asha.org'], subject, text: 'Café' });
    const page = await call(fixture, `/inbox/${message.id}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('application/json');
    expect(page.json()).toMatchObject({ subject: 'Thanks Asha', text: 'Café', html: '<p>Hello</p><script>alert(1)</script>' });
    expect(page.text).not.toContain('<html');
    expect((await call(fixture, '/inbox/999999')).status).toBe(404);
  });
});

describe('connector targets', () => {
  it('checks the webhook signature and answers a lookup', async () => {
    const { createHmac } = await import('node:crypto');
    const body = JSON.stringify({ event: 'connector.test' });
    const signature = `sha256=${createHmac('sha256', 'demo-signing-secret').update(body).digest('hex')}`;
    expect((await call(fixture, '/hooks/in', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ngo-signature': signature }, body })).status).toBe(200);
    expect((await call(fixture, '/hooks/in', { method: 'POST', headers: { 'x-ngo-signature': 'sha256=00' }, body })).status).toBe(401);
    expect((await call(fixture, '/lookup/110001')).json()).toMatchObject({ data: { district: 'New Delhi' } });
  });
});
