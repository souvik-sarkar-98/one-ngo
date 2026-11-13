import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPasskey, fromBase64url, getPasskey, passkeysSupported, toBase64url } from './passkey';

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;
const text = (buffer: ArrayBuffer | ArrayBufferView): number[] => Array.from(new Uint8Array(buffer as ArrayBuffer));

afterEach(() => vi.unstubAllGlobals());

describe('base64url conversion', () => {
  it('round-trips bytes and never produces the standard base64 characters', () => {
    const original = bytes(0, 1, 2, 250, 251, 252, 253, 254, 255);
    const encoded = toBase64url(original);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(text(fromBase64url(encoded))).toEqual(text(original));
  });
});

describe('passkeysSupported', () => {
  it('reports no support where there is no window to ask', async () => {
    expect(await passkeysSupported()).toBe(false);
  });
});

describe('getPasskey', () => {
  const assertionCredential = () =>
    ({
      id: 'cred-id',
      rawId: bytes(9, 9),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: bytes(1),
        authenticatorData: bytes(2),
        signature: bytes(3, 4),
        userHandle: null,
      },
    }) as unknown as PublicKeyCredential;

  it('asks the browser with binary challenge data and returns the response in JSON form', async () => {
    const get = vi.fn<(options: CredentialRequestOptions) => Promise<unknown>>(async () => assertionCredential());
    vi.stubGlobal('navigator', { credentials: { get } });

    const result = await getPasskey({
      challenge: toBase64url(bytes(1, 2, 3)),
      allowCredentials: [{ id: toBase64url(bytes(7)), type: 'public-key' }],
    });

    const request = get.mock.calls[0]![0].publicKey!;
    expect(text(request.challenge as ArrayBuffer)).toEqual([1, 2, 3]);
    expect((request.allowCredentials ?? [])[0]).toMatchObject({ type: 'public-key' });
    expect(text((request.allowCredentials ?? [])[0]!.id)).toEqual([7]);

    expect(result.id).toBe('cred-id');
    expect(result.rawId).toBe(toBase64url(bytes(9, 9)));
    expect(result.authenticatorAttachment).toBe('platform');
    expect(result.response).toEqual({
      clientDataJSON: toBase64url(bytes(1)),
      authenticatorData: toBase64url(bytes(2)),
      signature: toBase64url(bytes(3, 4)),
      userHandle: null,
    });
  });

  it('treats a cancelled prompt as a failure the page can explain', async () => {
    vi.stubGlobal('navigator', { credentials: { get: async () => null } });
    await expect(getPasskey({ challenge: toBase64url(bytes(1)) })).rejects.toThrow('No passkey was chosen.');
  });
});

describe('createPasskey', () => {
  it('passes the person id and exclusions as binary and returns the transports as a list', async () => {
    const create = vi.fn<(options: CredentialCreationOptions) => Promise<unknown>>(async () => ({
      id: 'new-id',
      rawId: bytes(5),
      type: 'public-key',
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: bytes(1),
        attestationObject: bytes(6, 7),
        getTransports: () => ['internal'],
      },
    }));
    vi.stubGlobal('navigator', { credentials: { create } });

    const result = await createPasskey({
      challenge: toBase64url(bytes(1, 2)),
      user: { id: toBase64url(bytes(42)), name: 'person@example.org', displayName: 'Person' },
      excludeCredentials: [{ id: toBase64url(bytes(8)), type: 'public-key' }],
    });

    const request = create.mock.calls[0]![0].publicKey!;
    expect(text(request.challenge as ArrayBuffer)).toEqual([1, 2]);
    expect(text((request.user as { id: ArrayBuffer }).id)).toEqual([42]);
    expect(result.response).toMatchObject({ attestationObject: toBase64url(bytes(6, 7)), transports: ['internal'] });
  });
});
