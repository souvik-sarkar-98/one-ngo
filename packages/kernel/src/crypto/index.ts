import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { jwtVerify, SignJWT } from 'jose';
import { generateSecret, generateSync, verifySync } from 'otplib';
import type { AccessClaims, CommonPasswordSource, CredentialCrypto, PasswordBreachSource } from '../ports/index.js';

const b64url = (value: Buffer) => value.toString('base64url');
const fromB64url = (value: string) => Buffer.from(value, 'base64url');
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 } as const;
const scryptAsync = (password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keyLen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key))),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(salt)}$${b64url(key)}`;
}
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    await scryptAsync(password, randomBytes(16), SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
    return false;
  }
  const [algorithm, n, r, p, salt, key] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !key) return false;
  const expected = fromB64url(key);
  const actual = await scryptAsync(password, fromB64url(salt), Number(n), Number(r), Number(p), expected.length);
  return timingSafeEqual(actual, expected);
}

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32): string => b64url(randomBytes(bytes));
export const randomDigits = (count: number): string => Array.from({ length: count }, () => randomInt(0, 10)).join('');
export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export const hmacSha256 = (key: string | Buffer, data: string | Buffer, encoding: 'hex' | 'base64' = 'hex'): string =>
  createHmac('sha256', key).update(data).digest(encoding);

const hmacKey = (secret: string) => new TextEncoder().encode(secret);
export async function signJwt(claims: Omit<AccessClaims, 'iat' | 'exp'>, secret: string, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt(now).setExpirationTime(now + ttlSeconds).sign(hmacKey(secret));
}
export async function verifyJwt(token: string, secret: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify<AccessClaims>(token, hmacKey(secret), { algorithms: ['HS256'], requiredClaims: ['exp'] });
    return payload.typ === 'access' ? payload : null;
  } catch {
    return null;
  }
}

export function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes, base64 encoded.');
  return key;
}
export const parseKeys = (list = ''): Buffer[] => list.split(',').map((value) => value.trim()).filter(Boolean).map(parseKey);
export class SecretKeys {
  readonly all: readonly Buffer[];
  constructor(readonly current: Buffer, previous: readonly Buffer[] = []) {
    this.all = [current, ...previous];
  }
}
export type SecretKey = Buffer | SecretKeys;
const ringOf = (key: SecretKey) => (key instanceof SecretKeys ? key : new SecretKeys(key));
export function encryptSecret(plaintext: string, key: SecretKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ringOf(key).current, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(ciphertext)}`;
}
function openSecret(value: string, key: Buffer): string | undefined {
  const [, iv, tag, ciphertext] = value.split('.');
  if (!iv || !tag || !ciphertext) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, fromB64url(iv));
    decipher.setAuthTag(fromB64url(tag));
    return Buffer.concat([decipher.update(fromB64url(ciphertext)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
export function decryptSecret(value: string, key: SecretKey): string {
  if (!/^v1\.[^.]+\.[^.]+\.[^.]+$/.test(value)) throw new Error('Unsupported secret format.');
  for (const candidate of ringOf(key).all) {
    const plaintext = openSecret(value, candidate);
    if (plaintext !== undefined) return plaintext;
  }
  throw new Error(
    'A stored secret could not be decrypted with ENCRYPTION_KEY or any key in ENCRYPTION_KEY_PREVIOUS: list the key it was saved with in ENCRYPTION_KEY_PREVIOUS, or save the secret again.',
  );
}
export function reencryptSecret(value: string, key: SecretKey): string | undefined {
  const ring = ringOf(key);
  if (openSecret(value, ring.current) !== undefined) return undefined;
  return encryptSecret(decryptSecret(value, ring), ring);
}

const SEALED = /^enc:v1:([0-9a-f]{8}):([A-Za-z0-9_-]+)$/;
export const isSealed = (value: unknown): value is string => typeof value === 'string' && SEALED.test(value);
export const sealedKeyOf = (value: string): string | undefined => SEALED.exec(value)?.[1];
interface FieldKey { id: string; cipher: Buffer; index: Buffer }
function fieldKey(key: Buffer): FieldKey {
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 32));
  return { id: hmacSha256(key, 'ngo field key id').slice(0, 8), cipher: derive('ngo field encryption'), index: derive('ngo field index') };
}
export class KeyRing {
  private readonly keys: Map<string, FieldKey>;
  readonly currentId: string;
  constructor(current: Buffer, previous: readonly Buffer[] = []) {
    const keys = [current, ...previous].map(fieldKey);
    this.currentId = keys[0]!.id;
    this.keys = new Map(keys.map((key) => [key.id, key]));
  }
  seal(plaintext: string, context: string): string {
    const key = this.keys.get(this.currentId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.cipher, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `enc:v1:${key.id}:${b64url(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]))}`;
  }
  open(value: string, context: string): string {
    const match = SEALED.exec(value);
    const key = match && this.keys.get(match[1]!);
    if (!match) throw new Error('This is not an encrypted value.');
    if (!key) {
      throw new Error(`A sensitive value is encrypted with key ${match[1]}, which is not configured. Set ENCRYPTION_KEY, or list the old key in ENCRYPTION_KEY_PREVIOUS.`);
    }
    const raw = fromB64url(match[2]!);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key.cipher, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`A sensitive value could not be decrypted with key ${key.id}.`);
    }
  }
  indexes(input: string): string[] {
    const current = this.keys.get(this.currentId)!;
    return [current, ...[...this.keys.values()].filter((key) => key !== current)].map((key) => hmacSha256(key.index, input));
  }
}

const TOTP = { algorithm: 'sha1', digits: 6, period: 30 } as const;
export const generateTotpSecret = (): string => generateSecret({ length: 20 });
export const totpCode = (secret: string, timeMs = Date.now(), period = TOTP.period, digits: 6 | 8 = TOTP.digits): string =>
  generateSync({ ...TOTP, secret, period, digits, epoch: Math.floor(timeMs / 1000) });
export function totpStep(secret: string, code: string, timeMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(timeMs / 1000 / TOTP.period);
  for (let step = now - window; step <= now + window; step++) if (safeEqual(totpCode(secret, step * TOTP.period * 1000), code)) return step;
  return null;
}
export function verifyTotp(secret: string, code: string, timeMs = Date.now(), window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    return verifySync({ ...TOTP, secret, token: code, epoch: Math.floor(timeMs / 1000), epochTolerance: window * TOTP.period }).valid;
  } catch {
    return false;
  }
}

export function credentialCrypto(key: SecretKey): CredentialCrypto {
  return {
    sha256, safeEqual, randomToken, randomDigits, hashPassword, verifyPassword, signAccessToken: signJwt, verifyAccessToken: verifyJwt,
    generateTotpSecret, verifyTotp, totpStep,
    encryptSecret: (value) => encryptSecret(value, key),
    decryptSecret: (value) => decryptSecret(value, key),
  };
}

export type BreachFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;
export interface PwnedPasswordsOptions {
  timeoutMs?: number;
  fetch?: BreachFetch;
}
export function pwnedPasswords(options: PwnedPasswordsOptions = {}): PasswordBreachSource {
  const request: BreachFetch = options.fetch ?? (async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, text: () => response.text() };
  });
  return {
    async breachCount(password) {
      const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);
      try {
        const response = await request(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
          headers: { 'Add-Padding': 'true', 'User-Agent': 'ngo-platform-password-check' },
          signal: controller.signal,
        });
        if (response.status !== 200) throw new Error(`status ${response.status}`);
        const suffix = hash.slice(5);
        let found: number | null = null;
        for (const line of (await response.text()).split(/\r?\n/)) {
          const [candidate, count] = line.trim().split(':');
          if (candidate === suffix) found = Math.max(found ?? Number.NEGATIVE_INFINITY, Number(count));
        }
        return found;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
export const commonPasswordsFile = (path: string): CommonPasswordSource => ({
  lines: () => readFileSync(path, 'utf8').split(/\r?\n/),
});
