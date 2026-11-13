import type { ExportStarter, FileTransfer, ImportRuns } from './ports/file-ports.js';
import type { HttpLogger, RequestContext } from '../shared/http-api.js';

/** Background jobs as the routes read and cancel them. */
export interface JobsPort {
  get(ctx: RequestContext, id: string): Promise<unknown>;
  items(ctx: RequestContext, id: string, options?: { status?: 'done' | 'failed' | 'skipped'; limit?: number; offset?: number }): Promise<unknown>;
  cancel(ctx: RequestContext, id: string): Promise<unknown>;
  list(
    ctx: RequestContext,
    filter: {
      kind?: string[];
      status?: ('queued' | 'running' | 'done' | 'failed' | 'cancelled')[];
      startedBy?: string;
      from?: string;
      to?: string;
      limit: number;
      offset: number;
    },
  ): Promise<unknown>;
}

/** The whole-NGO export: the audit line the request leaves, then the JSON lines. */
export interface TenantExport {
  audit(ctx: RequestContext): Promise<void>;
  stream(tenantId: string, writeLine: (line: string) => void | Promise<void>): Promise<unknown>;
}

/** Uploads and downloads, CSV imports and exports, their jobs, storage use and the whole-NGO export. */
export interface FilesApi {
  files: FileTransfer;
  imports: ImportRuns;
  exports: ExportStarter;
  jobs: Pick<JobsPort, 'get' | 'items' | 'cancel'>;
  tenantExport: TenantExport;
  /** Whether a browser may show a file of this type inline rather than download it. */
  opensInline(mime: string): boolean;
  logger: HttpLogger;
}
