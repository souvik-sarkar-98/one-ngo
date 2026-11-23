import { PLATFORM_STORE, type FileStore, type FileStoreResolver } from '@onengo/kernel/files';
import { ruleViolation } from '@onengo/kernel/errors';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { OAuthCredentials } from '../connectors/oauth-credentials.js';
import type { ConnectorRow, ConnectorStore } from '../connectors/ports/connector-store.js';
import { FILE_STORE_SETTING } from '../connectors/ports/connector-store.js';
import { openStorageStore, parseStorageConfig } from '../../infrastructure/files/storage-connector.js';

const NO_STORE = 'Choose a file store in Settings before uploading.';

/**
 * Each organisation's files go to the storage connector named in Settings.
 * A file is always read from the connector recorded on it, even after the setting changes.
 * Tests may inject one local store, served as `platform`. A server does not.
 */
export class ConnectorStoreResolver implements FileStoreResolver {
  private readonly cache = new Map<string, { stamp: string; store: FileStore }>();

  constructor(
    private readonly tm: TransactionManager,
    private readonly connectors: Pick<ConnectorStore, 'connector' | 'storeChoice'>,
    private readonly decrypt: (stored: string) => Record<string, string>,
    private readonly oauth: Pick<OAuthCredentials, 'accessToken'>,
    private readonly fallback?: FileStore,
    private readonly fetchFn?: typeof fetch,
  ) {}

  async forTenant(tenantId: string): Promise<{ ref: string; store: FileStore }> {
    const row = await this.chosen(tenantId);
    if (row) return { ref: `connector:${row.key}`, store: await this.adapter(tenantId, row) };
    if (this.fallback) return { ref: PLATFORM_STORE, store: this.fallback };
    throw ruleViolation(NO_STORE);
  }

  async byRef(tenantId: string, ref: string): Promise<FileStore> {
    if (ref === PLATFORM_STORE) {
      if (!this.fallback) throw new Error(`No file store is configured for '${ref}'.`);
      return this.fallback;
    }
    const key = ref.startsWith('connector:') ? ref.slice('connector:'.length) : '';
    const row = key ? await this.tm.withTenant(tenantId, (tx) => this.connectors.connector(tx, key)) : undefined;
    if (!row || row.type !== 'storage') throw new Error(`No file store is configured for '${ref}'.`);
    return this.adapter(tenantId, row);
  }

  private async chosen(tenantId: string): Promise<ConnectorRow | undefined> {
    const key = await this.tm.withTenant(tenantId, (tx) => this.connectors.storeChoice(tx));
    if (!key) return undefined;
    const row = await this.tm.withTenant(tenantId, (tx) => this.connectors.connector(tx, key));
    if (!row?.enabled || row.type !== 'storage' || !parseStorageConfig(row.config)) return undefined;
    return row;
  }

  private async adapter(tenantId: string, row: ConnectorRow): Promise<FileStore> {
    const stamp = String(row.updated_at);
    const id = `${tenantId}:${row.key}`;
    const hit = this.cache.get(id);
    if (hit?.stamp === stamp) return hit.store;
    const config = parseStorageConfig(row.config);
    if (!config) throw ruleViolation(NO_STORE);
    const secrets = row.secret_enc ? this.decrypt(row.secret_enc) : {};
    const store = openStorageStore(config, secrets, {
      ...(config.provider === 'drive' && config.credential ? { accessToken: () => this.oauth.accessToken(tenantId, config.credential!) } : {}),
      ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
    });
    this.cache.set(id, { stamp, store });
    return store;
  }
}

export { FILE_STORE_SETTING };
