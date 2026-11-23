import { FileService } from '../application/files/file-service.js';
import { ConnectorStoreResolver } from '../application/files/connector-store-resolver.js';
import { ExportService } from '../application/records/export-service.js';
import { ImportService } from '../application/records/import-service.js';
import type { OAuthCredentials } from '../application/connectors/oauth-credentials.js';
import { connectorSecretBox } from '../infrastructure/crypto/connector-secrets.js';
import { PgConnectorStore } from '../infrastructure/postgres/stores/connector-store.js';
import { PgFileCatalog } from '../infrastructure/postgres/stores/file-catalog.js';
import { PgImportStore } from '../infrastructure/postgres/stores/import-store.js';
import { csvCodec } from '../infrastructure/transfer/csv.js';
import type { SecretKey } from '@onengo/kernel/crypto';
import type { Definitions } from './definitions.js';
import type { Base } from './infrastructure.js';
import type { Jobs } from './jobs.js';
import type { Records } from './records.js';
import { atPortBoundary } from './infrastructure-errors.js';

/** Uploaded files with their clean-up job, and CSV import and export. The store is the organisation's storage connector. */
export function wireFiles(
  base: Base,
  { definitions }: Definitions,
  { records }: Records,
  { jobs }: Jobs,
  oauth: Pick<OAuthCredentials, 'accessToken'>,
  secretKey: SecretKey,
) {
  const { tm, owner, options } = base;
  const box = connectorSecretBox(secretKey);
  const stores = new ConnectorStoreResolver(
    tm,
    new PgConnectorStore(),
    (stored) => {
      const parsed = JSON.parse(box.decrypt(stored)) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    },
    oauth,
    options.fileStore,
    options.storageFetch,
  );
  const files = new FileService(tm, new PgFileCatalog(), owner.retention, definitions, records, stores, base.audit, options.files);
  jobs.register<Record<string, never>, { removed?: number }>('files.cleanup', {
    label: 'File clean-up',
    batchSize: 100,
    notice: () => null,
    async run({ ctx, state, batchSize }) {
      const n = await files.cleanup(ctx.tenantId, batchSize);
      const removed = (state.removed ?? 0) + n;
      return { state: { removed }, progress: removed, done: n < batchSize, result: { removed } };
    },
  });
  const csv = atPortBoundary(csvCodec);
  return {
    files,
    imports: new ImportService(tm, new PgImportStore(), definitions, records, files, jobs, csv),
    exports: new ExportService(tm, definitions, records, files, jobs, csv, base.audit, options.exportInlineRows),
  };
}
export type Files = ReturnType<typeof wireFiles>;
