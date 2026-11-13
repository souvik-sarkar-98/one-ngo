import { FileService } from '../application/files/file-service.js';
import { ExportService } from '../application/records/export-service.js';
import { ImportService } from '../application/records/import-service.js';
import { LocalFileStore, singleStoreResolver } from '@onengo/kernel/files';
import { PgFileCatalog } from '../infrastructure/postgres/stores/file-catalog.js';
import { PgImportStore } from '../infrastructure/postgres/stores/import-store.js';
import { csvCodec } from '../infrastructure/transfer/csv.js';
import type { Definitions } from './definitions.js';
import type { Base } from './infrastructure.js';
import type { Jobs } from './jobs.js';
import type { Records } from './records.js';
import { atPortBoundary } from './infrastructure-errors.js';

/** Uploaded files with their clean-up job, and CSV import and export. */
export function wireFiles(base: Base, { definitions }: Definitions, { records }: Records, { jobs }: Jobs) {
  const { tm, owner, options, paths } = base;
  const store = atPortBoundary(options.fileStore ?? new LocalFileStore(paths.localFiles));
  const files = new FileService(tm, new PgFileCatalog(), owner.retention, definitions, records, singleStoreResolver(store), base.audit, options.files);
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
