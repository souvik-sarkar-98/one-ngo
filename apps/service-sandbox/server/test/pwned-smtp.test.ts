import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pwnedPasswords } from '@onengo/kernel/crypto';
import { SmtpTransport } from '@onengo/kernel/notify';
import { INTEGRATION_FIXTURE_ORIGIN } from '../../../onengo/server/src/fixture-hosts.js';
import { ORIGIN, SMTP } from '../src/constants.js';
import type { Fixture } from '../src/server.js';
import { call, fixtureFetch, tempFixture } from './helpers.js';

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex').toUpperCase();
const LINE = /^[0-9A-F]{35}:\d+$/;

let fixture: Fixture;
let cleanup: () => Promise<void>;
beforeAll(async () => ({ fixture, cleanup } = await tempFixture()));
afterAll(() => cleanup());

it('listens where one-ngo sends Cloud Storage and breached-password calls', () => {
  expect(ORIGIN).toBe(INTEGRATION_FIXTURE_ORIGIN);
});

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
    const viaRewrite = fixtureFetch(fixture);
    const source = pwnedPasswords({ fetch: (url, init) => viaRewrite(url, init) });
    expect(await source.breachCount('password')).toBeGreaterThan(0);
    expect(await source.breachCount('monsoon in the hills')).toBeNull();
  });
});

describe('SMTP stand-in', () => {
  it('accepts mail from the demo user through one-ngo\'s transport and refuses a wrong password', async () => {
    const transport = new SmtpTransport({ host: '127.0.0.1', port: fixture.smtpPort, secure: false, user: SMTP.user, password: SMTP.password, from: SMTP.from });
    await transport.send({ to: 'member@asha.org', subject: 'Your sign-in code', text: 'Code 123456' });
    expect(fixture.smtp.messages[0]).toMatchObject({ from: SMTP.from, to: ['member@asha.org'], subject: 'Your sign-in code' });
    expect(fixture.smtp.messages[0]!.raw).toContain('Code 123456');
    expect((await call(fixture, `/mail/${fixture.smtp.messages[0]!.id}`)).text).toContain('Code 123456');

    const wrong = new SmtpTransport({ host: '127.0.0.1', port: fixture.smtpPort, secure: false, user: SMTP.user, password: 'wrong', from: SMTP.from });
    await expect(wrong.send({ to: 'member@asha.org', subject: 'x', text: 'x' })).rejects.toThrow();
    expect(fixture.smtp.messages).toHaveLength(1);
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
