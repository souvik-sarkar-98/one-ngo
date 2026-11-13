import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import type { RecordQuery } from '../../../runtime/records/query-ast.js';
import type { CheckResult, ImportView, MappingInput } from '../../records/import-service.js';
import type { FileView, UploadInput } from '../file-service.js';
import type { Readable } from 'node:stream';

/** What the file, import and export routes ask of storage and the import and export use cases. */

/** Stored files: upload, open and storage use. */
export interface FileTransfer {
  upload(ctx: TenantContext, input: UploadInput): Promise<FileView>;
  open(ctx: TenantContext, id: string): Promise<{ file: FileView; body: Readable }>;
  usage(ctx: TenantContext): Promise<{ used: number; quota: number }>;
}

/** CSV imports from upload to the failed-rows file. */
export interface ImportRuns {
  upload(ctx: TenantContext, typeKey: string, body: UploadInput['body'], name: string): Promise<ImportView>;
  get(ctx: TenantContext, id: string): Promise<ImportView>;
  setMapping(ctx: TenantContext, id: string, input: MappingInput): Promise<ImportView>;
  check(ctx: TenantContext, id: string): Promise<CheckResult>;
  run(ctx: TenantContext, id: string): Promise<ImportView>;
  failedCsv(ctx: TenantContext, id: string): AsyncGenerator<string>;
}

/** Starts a CSV export: a job for a large one, or the lines straight away. */
export interface ExportStarter {
  start(ctx: TenantContext, typeKey: string, query: RecordQuery): Promise<{ jobId: string } | { fileName: string; lines: AsyncIterable<string> }>;
}
