import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseCron } from '../src/runtime/definitions/cron.js';
import { renderTemplate } from '../src/runtime/definitions/template.js';
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  hashPassword,
  reencryptSecret,
  SecretKeys,
  signJwt,
  totpCode,
  verifyJwt,
  verifyPassword,
  verifyTotp,
} from '@onengo/kernel/crypto';

// The hand-written token signer and TOTP the platform used before jose and otplib, kept as reference vectors.
const b64urlJson = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function legacySignJwt(claims: object, secret: string): string {
  const signed = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson(claims)}`;
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function legacyBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + B32[(value << (5 - bits)) & 31] : out;
}

function legacyTotp(secretBase32: string, timeMs: number): string {
  let bits = 0;
  let value = 0;
  const key: number[] = [];
  for (const ch of secretBase32) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const h = createHmac('sha1', Buffer.from(key)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 1e6).padStart(6, '0');
}

describe('crypto helpers', () => {
  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
  });

  it('signs and verifies access tokens, rejecting tampering, expiry, and other algorithms', async () => {
    const secret = 'x'.repeat(40);
    const token = await signJwt({ sub: 'u', tid: 't', sid: 's', typ: 'access' }, secret, 60);
    expect((await verifyJwt(token, secret))?.sub).toBe('u');
    expect(await verifyJwt(token, 'y'.repeat(40))).toBeNull();
    const [h, b, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', tid: 't', sid: 's', typ: 'access', exp: 9e9 })).toString('base64url');
    expect(await verifyJwt(`${h}.${forged}.${s}`, secret)).toBeNull();
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    expect(await verifyJwt(`${none}.${b}.`, secret)).toBeNull();
    expect(await verifyJwt(await signJwt({ sub: 'u', tid: 't', sid: 's', typ: 'access' }, secret, -1), secret)).toBeNull();
  });

  it('accepts access tokens issued before the move to a JWT library, and issues byte-identical ones', async () => {
    const secret = 'x'.repeat(40);
    const claims = { sub: 'u-1', tid: 't-1', sid: 's-1', typ: 'access' } as const;
    // Issued by the hand-written HS256 signer; sessions started before the switch carry tokens like this.
    const issuedBefore =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJ0aWQiOiJ0LTEiLCJzaWQiOiJzLTEiLCJ0eXAiOiJhY2Nlc3MiLCJpYXQiOjE3OTAwMDAwMDAsImV4cCI6NDEwMjQ0NDgwMH0.Sk_CrkSrgsElUTjU2IEa-v_cFwkOSfDQwExKbqankwA';
    expect(issuedBefore).toBe(legacySignJwt({ ...claims, iat: 1_790_000_000, exp: 4_102_444_800 }, secret));
    expect(await verifyJwt(issuedBefore, secret)).toEqual({ ...claims, iat: 1_790_000_000, exp: 4_102_444_800 });
    expect(await verifyJwt(issuedBefore, 'y'.repeat(40))).toBeNull();

    vi.useFakeTimers({ now: 1_790_000_000_000 });
    try {
      expect(await signJwt(claims, secret, 900)).toBe(legacySignJwt({ ...claims, iat: 1_790_000_000, exp: 1_790_000_900 }, secret));
    } finally {
      vi.useRealTimers();
    }
  });

  it('encrypts secrets with authentication', () => {
    const key = randomBytes(32);
    const enc = encryptSecret('rzp_secret', key);
    expect(decryptSecret(enc, key)).toBe('rzp_secret');
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });

  it('reads a secret saved under a previous key after rotation, and encrypts only under the current key', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const saved = encryptSecret('totp-secret', oldKey);
    const rotated = new SecretKeys(newKey, [randomBytes(32), oldKey]);
    expect(decryptSecret(saved, rotated)).toBe('totp-secret');

    const fresh = encryptSecret('gateway-secret', rotated);
    expect(fresh).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(decryptSecret(fresh, newKey)).toBe('gateway-secret');
    expect(() => decryptSecret(fresh, oldKey)).toThrow();

    const moved = reencryptSecret(saved, rotated)!;
    expect(decryptSecret(moved, newKey)).toBe('totp-secret');
    expect(reencryptSecret(moved, rotated)).toBeUndefined();
  });

  it('fails clearly when the key a secret was saved with is not configured', () => {
    const saved = encryptSecret('totp-secret', randomBytes(32));
    const message = 'A stored secret could not be decrypted with ENCRYPTION_KEY or any key in ENCRYPTION_KEY_PREVIOUS';
    expect(() => decryptSecret(saved, new SecretKeys(randomBytes(32)))).toThrow(message);
    expect(() => decryptSecret(saved, new SecretKeys(randomBytes(32), [randomBytes(32)]))).toThrow(message);
    expect(() => reencryptSecret(saved, new SecretKeys(randomBytes(32)))).toThrow(message);
    expect(() => decryptSecret('v2.a.b.c', randomBytes(32))).toThrow('Unsupported secret format.');
  });

  it('matches the RFC 6238 SHA-1 test vectors and accepts one step of clock drift', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890"
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1_111_111_109, '07081804'],
      [1_111_111_111, '14050471'],
      [1_234_567_890, '89005924'],
      [2_000_000_000, '69279037'],
      [20_000_000_000, '65353130'],
    ];
    for (const [seconds, code] of vectors) expect(totpCode(secret, seconds * 1000, 30, 8)).toBe(code);
    const now = Date.now();
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 60_000), now)).toBe(false);
    expect(verifyTotp(secret, totpCode(secret, now - 120_000), now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
    expect(verifyTotp(secret, '1234567', now)).toBe(false);
  });

  it('keeps enrolled two-step secrets working: same codes and drift window as before the move to a TOTP library', () => {
    const oldKey = randomBytes(32);
    const enrolled = encryptSecret(legacyBase32(randomBytes(20)), oldKey);
    const secret = decryptSecret(enrolled, new SecretKeys(randomBytes(32), [oldKey]));
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    const base = 1_790_000_000_000;
    for (let i = 0; i < 40; i++) {
      const now = base + i * 7_919;
      expect(totpCode(secret, now)).toBe(legacyTotp(secret, now));
      for (const drift of [-2, -1, 0, 1, 2]) {
        expect(verifyTotp(secret, legacyTotp(secret, now + drift * 30_000), now)).toBe(Math.abs(drift) <= 1);
      }
    }
  });
});

describe('cron and templates', () => {
  it('parses cron schedules and finds the latest due minute', () => {
    const monthly = parseCron('0 3 1 * *');
    expect(monthly.matches(new Date('2026-11-01T03:00:00Z'))).toBe(true);
    expect(monthly.matches(new Date('2026-11-02T03:00:00Z'))).toBe(false);
    expect(monthly.lastDueBetween(new Date('2026-10-15T00:00:00Z'), new Date('2026-11-01T05:00:00Z'))?.toISOString()).toBe(
      '2026-11-01T03:00:00.000Z',
    );
    expect(monthly.lastDueBetween(new Date('2026-11-01T04:00:00Z'), new Date('2026-11-01T05:00:00Z'))).toBeNull();
    expect(parseCron('*/15 9-17 * * 1-5').matches(new Date('2026-10-19T09:45:00Z'))).toBe(true);
    expect(() => parseCron('61 * * * *')).toThrow();
    expect(() => parseCron('* * *')).toThrow();
  });

  it('renders templates as plain text', () => {
    expect(renderTemplate('Hi {{ record.name }}, total {{ record.a + record.b }}{{ record.missing }}', { record: { name: '<b>Asha</b>', a: 1, b: 2 } })).toBe(
      'Hi <b>Asha</b>, total 3',
    );
  });
});
