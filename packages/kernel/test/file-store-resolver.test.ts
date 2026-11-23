import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PLATFORM_STORE, singleStoreResolver, type FileStore } from '../src/files/index.js';

const store: FileStore = {
  put: async () => undefined,
  get: async () => Readable.from([]),
  delete: async () => undefined,
};

describe('single store resolver', () => {
  it('gives every organisation the installation store under the platform reference', async () => {
    const resolver = singleStoreResolver(store);
    await expect(resolver.forTenant('tenant-a')).resolves.toEqual({ ref: PLATFORM_STORE, store });
    await expect(resolver.forTenant('tenant-b')).resolves.toEqual({ ref: 'platform', store });
    expect(await resolver.byRef('tenant-a', 'platform')).toBe(store);
  });

  it('refuses a reference it does not have', async () => {
    await expect(singleStoreResolver(store).byRef('tenant-a', 'org:gcs')).rejects.toThrow("No file store is configured for 'org:gcs'.");
  });
});
