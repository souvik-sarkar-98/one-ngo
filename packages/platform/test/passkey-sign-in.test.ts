import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignInPipeline } from '../src/application/identity/sign-in/pipeline.js';
import type { AuthenticationEvidence, TenantAuthPolicy } from '../src/domain/identity/ports/assurance.js';
import { counterAccepted, passkeyName } from '../src/domain/identity/passkey.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

const RP_ID = 'ngo.test';
const ORIGIN = 'https://ngo.test';

// ---------------------------------------------------------------------------
// A software authenticator. It produces the same WebAuthn bytes a platform
// passkey would (CBOR attestation, authenticator data, DER ES256 signatures),
// so the real verification library checks genuine cryptography.
// ---------------------------------------------------------------------------

type CborValue = number | string | Buffer | Map<unknown, unknown>;

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
}

function cbor(value: CborValue): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Map) {
    const parts: Buffer[] = [cborHead(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k as CborValue), cbor(v as CborValue));
    return Buffer.concat(parts);
  }
  return Buffer.concat([cborHead(2, value.length), value]);
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const uint16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const uint32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const clientData = (type: string, challenge: string, origin = ORIGIN) =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString('base64url');

class SoftwareAuthenticator {
  readonly credentialId = randomBytes(16);
  readonly id = this.credentialId.toString('base64url');
  private readonly keys: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private counter = 0;

  /** Creates the credential for a registration challenge. Flags: user present, user verified, attested data. */
  register(challenge: string): unknown {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = cbor(
      new Map<unknown, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
    const attested = Buffer.concat([Buffer.alloc(16), uint16(this.credentialId.length), this.credentialId, cose]);
    const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x45]), uint32(0), attested]);
    const attestationObject = cbor(
      new Map<unknown, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData('webauthn.create', challenge),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
    };
  }

  /** Signs an assertion. The counter rises by one unless a value is given (used to simulate a copied authenticator). */
  assert(challenge: string, options: { origin?: string; counter?: number } = {}): unknown {
    const counter = options.counter ?? ++this.counter;
    const authenticatorData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), uint32(counter)]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: options.origin ?? ORIGIN, crossOrigin: false }),
    );
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    };
  }
}

const challengeOf = (options: unknown) => (options as { challenge: string }).challenge;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe('passkey rules', () => {
  it('accepts a counter that rises, and refuses one that does not', () => {
    expect(counterAccepted(0, 0)).toBe(true);
    expect(counterAccepted(0, 1)).toBe(true);
    expect(counterAccepted(5, 6)).toBe(true);
    expect(counterAccepted(5, 5)).toBe(false);
    expect(counterAccepted(5, 4)).toBe(false);
    expect(counterAccepted(1, 0)).toBe(false);
  });

  it('tidies passkey names and falls back to a default', () => {
    expect(passkeyName('  my   phone ')).toBe('my phone');
    expect(passkeyName('')).toBe('Passkey');
    expect(passkeyName(undefined)).toBe('Passkey');
    expect(passkeyName('x'.repeat(100))).toHaveLength(60);
  });

  it('refuses passkey sign-in when the organisation has not enabled it', () => {
    const pipeline = new SignInPipeline<string>(
      async () => {
        throw new Error('not used');
      },
      async () => 'issued',
    );
    const evidence: AuthenticationEvidence = {
      method: 'passkey',
      assurance: 'aal2',
      authTime: new Date(),
      amr: ['hwk', 'user'],
    };
    const policy = (overrides: Partial<TenantAuthPolicy>): TenantAuthPolicy =>
      ({
        passwordEnabled: true,
        emailCodeEnabled: true,
        passkeyEnabled: false,
        minimumAssurance: 'aal1',
        ...overrides,
      }) as TenantAuthPolicy;

    expect(() => pipeline.enforce(policy({ passkeyEnabled: false }), evidence)).toThrow(/Passkey sign-in is not available/);
    expect(() => pipeline.enforce(policy({ passkeyEnabled: true }), evidence)).not.toThrow();
    expect(() => pipeline.enforce(policy({ passkeyEnabled: true, minimumAssurance: 'aal3' }), evidence)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// End to end, against the database
// ---------------------------------------------------------------------------

describe('passkey sign-in and device management', () => {
  let w: TestWorld;
  const password = 'long enough password';
  const email = 'passkey.person@asha.example';
  const authenticator = new SoftwareAuthenticator();
  let userId: string;
  let firstPair: { accessToken: string };
  let passkeyId: string;

  beforeAll(async () => {
    w = await createWorld();
    const policy = { passwordEnabled: true, emailCodeEnabled: true, passkeyEnabled: true, minimumAssurance: 'aal1' as const };
    await w.platform.identity.saveAuthPolicy(w.as(w.ngoA), { ...policy, passkeyEnabled: true });
    userId = await w.platform.identity.addMember(w.as(w.ngoA), { email, displayName: 'Passkey Person', roles: [] });
    await w.platform.identity.setPassword(userId, password);
  });
  afterAll(() => w.close());

  it('offers passkeys only where the organisation has enabled them', async () => {
    expect(await w.platform.passkeys.available('asha')).toBe(true);
    expect(await w.platform.passkeys.available('no-such-org')).toBe(false);
  });

  it('adds a passkey for a signed-in person', async () => {
    firstPair = await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email, password });
    const ctx = await w.platform.identity.authenticate(firstPair.accessToken);

    const { challengeId, options } = await w.platform.passkeys.registrationOptions(ctx);
    const saved = await w.platform.passkeys.register(ctx, {
      challengeId,
      response: authenticator.register(challengeOf(options)),
      name: 'Work laptop',
    });
    passkeyId = saved.id;
    expect(saved).toMatchObject({ name: 'Work laptop', deviceType: 'singleDevice' });
    expect(await w.platform.passkeys.list(ctx)).toHaveLength(1);
  });

  it('signs in with the passkey, at AAL2 with hardware and user-verification methods', async () => {
    const { challengeId, options } = await w.platform.passkeys.signInOptions({ tenantKey: 'asha' });
    const outcome = await w.platform.passkeys.signIn({
      tenantKey: 'asha',
      challengeId,
      response: authenticator.assert(challengeOf(options)),
    });
    expect(outcome.kind).toBe('tokens');
    if (outcome.kind !== 'tokens') throw new Error('expected tokens');
    expect(outcome.pair).toMatchObject({ method: 'passkey', assurance: 'aal2', amr: ['hwk', 'user'] });
    expect(await w.platform.identity.authenticate(outcome.pair.accessToken)).toMatchObject({ actor: { id: userId } });
  });

  it('refuses a replayed response', async () => {
    const { challengeId, options } = await w.platform.passkeys.signInOptions({ tenantKey: 'asha' });
    const response = authenticator.assert(challengeOf(options));
    await w.platform.passkeys.signIn({ tenantKey: 'asha', challengeId, response });
    await expectCode(w.platform.passkeys.signIn({ tenantKey: 'asha', challengeId, response }), 'forbidden');
  });

  it('refuses a response signed for another web origin', async () => {
    const { challengeId, options } = await w.platform.passkeys.signInOptions({ tenantKey: 'asha' });
    const response = authenticator.assert(challengeOf(options), { origin: 'https://phish.example' });
    await expectCode(w.platform.passkeys.signIn({ tenantKey: 'asha', challengeId, response }), 'forbidden');
  });

  it('refuses a counter that did not advance, which suggests a copied authenticator', async () => {
    const { challengeId, options } = await w.platform.passkeys.signInOptions({ tenantKey: 'asha' });
    const response = authenticator.assert(challengeOf(options), { counter: 1 });
    await expectCode(w.platform.passkeys.signIn({ tenantKey: 'asha', challengeId, response }), 'forbidden');

    // The genuine authenticator, with a rising counter, still works afterwards.
    const next = await w.platform.passkeys.signInOptions({ tenantKey: 'asha' });
    const outcome = await w.platform.passkeys.signIn({
      tenantKey: 'asha',
      challengeId: next.challengeId,
      response: authenticator.assert(challengeOf(next.options)),
    });
    expect(outcome.kind).toBe('tokens');
  });

  it('refuses a challenge issued for another organisation', async () => {
    await w.platform.identity.saveAuthPolicy(w.as(w.ngoB), {
      passwordEnabled: true,
      emailCodeEnabled: true,
      passkeyEnabled: true,
      minimumAssurance: 'aal1',
    });
    const { challengeId, options } = await w.platform.passkeys.signInOptions({ tenantKey: 'bodhi' });
    const response = authenticator.assert(challengeOf(options));
    await expectCode(w.platform.passkeys.signIn({ tenantKey: 'asha', challengeId, response }), 'forbidden');
  });

  it('refuses a passkey whose person is not a member of the organisation', async () => {
    const { challengeId, options } = await w.platform.passkeys.signInOptions({ tenantKey: 'bodhi' });
    const response = authenticator.assert(challengeOf(options));
    await expect(w.platform.passkeys.signIn({ tenantKey: 'bodhi', challengeId, response })).rejects.toThrow();
    expect(await w.platform.passkeys.available('bodhi')).toBe(true);
  });

  it('turning passkeys off stops sign-in and ends sessions made with a passkey', async () => {
    const passkeyPair = await signInWithPasskeyCredential(w, authenticator, 'asha');
    await w.platform.identity.saveAuthPolicy(w.as(w.ngoA), {
      passwordEnabled: true,
      emailCodeEnabled: true,
      passkeyEnabled: false,
      minimumAssurance: 'aal1',
    });
    await expectCode(w.platform.identity.authenticate(passkeyPair.accessToken), 'forbidden');
    await expectCode(w.platform.passkeys.signInOptions({ tenantKey: 'asha' }), 'forbidden');
    expect(await w.platform.passkeys.available('asha')).toBe(false);

    await w.platform.identity.saveAuthPolicy(w.as(w.ngoA), {
      passwordEnabled: true,
      emailCodeEnabled: true,
      passkeyEnabled: true,
      minimumAssurance: 'aal1',
    });
  });

  it('removing a passkey stops it signing in and ends its sessions', async () => {
    const pair = await signInWithPasskeyCredential(w, authenticator, 'asha');
    const ctx = await w.platform.identity.authenticate(pair.accessToken);
    const [only] = await w.platform.passkeys.list(ctx);
    expect(only?.id).toBe(passkeyId);

    await w.platform.passkeys.revoke(ctx, passkeyId);
    await expectCode(w.platform.identity.authenticate(pair.accessToken), 'forbidden');

    const { challengeId, options } = await w.platform.passkeys.signInOptions({ tenantKey: 'asha' });
    await expectCode(
      w.platform.passkeys.signIn({ tenantKey: 'asha', challengeId, response: authenticator.assert(challengeOf(options)) }),
      'forbidden',
    );
  });

  it('keeps the password sign-in working throughout', async () => {
    const pair = await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email, password });
    expect(pair).toMatchObject({ method: 'password' });
  });
});

/** Signs in with a passkey the test has already registered, through the public sign-in calls. */
async function signInWithPasskeyCredential(w: TestWorld, authenticator: SoftwareAuthenticator, tenantKey: string) {
  const { challengeId, options } = await w.platform.passkeys.signInOptions({ tenantKey });
  const outcome = await w.platform.passkeys.signIn({
    tenantKey,
    challengeId,
    response: authenticator.assert(challengeOf(options)),
  });
  if (outcome.kind !== 'tokens') throw new Error('expected tokens');
  return outcome.pair;
}
