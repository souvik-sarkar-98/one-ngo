import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PasswordPolicy } from '../src/domain/identity/password-policy.js';
import { commonPasswordsFile, pwnedPasswords, type BreachFetch } from '@onengo/kernel/crypto';
import { MemoryLogger } from '@onengo/kernel/observability';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();

function fakeRange(breached: Record<string, number>): { fetch: BreachFetch; urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  return {
    urls,
    headers,
    fetch: async (url, init) => {
      urls.push(url);
      headers.push(init.headers);
      const prefix = url.slice(-5);
      const lines = Object.entries(breached)
        .map(([pw, n]) => [sha1(pw), n] as const)
        .filter(([h]) => h.startsWith(prefix))
        .map(([h, n]) => `${h.slice(5)}:${n}`);
      // Padding entries have a count of zero.
      lines.push('0000000000000000000000000000000000A:0', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0');
      return { status: 200, text: async () => lines.join('\r\n') };
    },
  };
}

const expectRefused = async (p: Promise<void>, message: RegExp) => {
  await expect(p).rejects.toMatchObject({ code: 'validation_failed', message: expect.stringMatching(message) });
};

describe('password policy (offline rules)', () => {
  const policy = new PasswordPolicy();

  it('accepts a reasonable passphrase', async () => {
    await expect(policy.check('monsoon in the hills')).resolves.toBeUndefined();
  });

  it('refuses short, common, and patterned passwords', async () => {
    await expectRefused(policy.check('short'), /at least 10/);
    await expectRefused(policy.check('Password123'), /too easy/);
    await expectRefused(policy.check('QWERTYUIOP'), /too easy/);
    await expectRefused(policy.check('1234567890'), /too easy/);
    await expectRefused(policy.check('aaaaaaaaaaaa'), /too easy/);
    await expectRefused(policy.check('abcabcabcabc'), /too easy/);
    await expectRefused(policy.check('9876543210'), /too easy/);
  });

  it('refuses passwords built around the person or organisation', async () => {
    const ctx = { email: 'priya.sen@asha.org', displayName: 'Priya Sen', organisationNames: ['Asha Trust', 'asha'] };
    await expectRefused(policy.check('PriyaSen2026!', ctx), /name, email, or organisation/);
    await expectRefused(policy.check('ashatrust123', ctx), /name, email, or organisation/);
    await expect(policy.check('priya likes long mountain walks', ctx)).resolves.toBeUndefined();
  });

  it('loads an extra common-password list from a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-'));
    const file = join(dir, 'common.txt');
    writeFileSync(file, 'short\ncorrect horse battery staple\n');
    const withFile = new PasswordPolicy({ commonPasswords: commonPasswordsFile(file) });
    await expectRefused(withFile.check('Correct Horse Battery Staple'), /too easy/);
    expect(withFile.commonListSize).toBeGreaterThan(new PasswordPolicy().commonListSize);
  });
});

describe('password policy (online breach check)', () => {
  it('sends only the first five characters of the SHA-1 and refuses breached passwords', async () => {
    const fake = fakeRange({ 'monsoon in the hills': 3 });
    const policy = new PasswordPolicy({ breachCheck: 'online', breaches: pwnedPasswords({ fetch: fake.fetch }) });
    await expectRefused(policy.check('monsoon in the hills'), /data breach/);
    expect(fake.urls[0]).toBe(`https://api.pwnedpasswords.com/range/${sha1('monsoon in the hills').slice(0, 5)}`);
    expect(fake.urls[0]).not.toContain(sha1('monsoon in the hills').slice(5));
    expect(fake.headers[0]!['Add-Padding']).toBe('true');
    await expect(policy.check('a quiet garden at dawn')).resolves.toBeUndefined();
  });

  it('respects the threshold and ignores zero-count padding', async () => {
    const fake = fakeRange({ 'rarely seen phrase here': 1 });
    await expect(new PasswordPolicy({ breachCheck: 'online', breachThreshold: 5, breaches: pwnedPasswords({ fetch: fake.fetch }) }).check('rarely seen phrase here')).resolves.toBeUndefined();
  });

  it('does not block anyone when the service is unreachable, and logs it', async () => {
    const logger = new MemoryLogger();
    const down: BreachFetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const policy = new PasswordPolicy({ breachCheck: 'online', breaches: pwnedPasswords({ fetch: down }), logger });
    await expect(policy.check('a quiet garden at dawn')).resolves.toBeUndefined();
    expect(logger.entries[0]).toMatchObject({ severity: 'WARNING', message: 'Breached-password check skipped' });
  });

  it('gives up after the timeout', async () => {
    const hang: BreachFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const started = Date.now();
    await new PasswordPolicy({ breachCheck: 'online', breaches: pwnedPasswords({ fetch: hang, timeoutMs: 100 }) }).check('a quiet garden at dawn');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
