import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { RetentionScan } from './ports/retention-scan.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, notFound, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import { can, demand } from '../../domain/permissions.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import type { FieldDef } from '../../runtime/definitions/types.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { FileStoreResolver } from '@onengo/kernel/ports';
import { FileSniffer } from './file-type.js';
import { SIGNATURE_MAX_BYTES } from '../../runtime/records/file-kinds.js';
import type { FileCatalog, FileRow } from './ports/file-catalog.js';
import { cleanFileName } from '../shared/file-name.js';
import { QUOTA_SETTING } from '../shared/platform-settings.js';

const MB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export { QUOTA_SETTING };
/** Uploads not linked to a record within this time are removed. */
const UNLINKED_HOURS = 24;

export interface FileLimits {
  /** Largest upload when the target field sets no size; also caps field sizes. Default 25 MB. */
  maxUploadMb?: number;
  /** Storage per organisation unless its `files.quotaBytes` setting says otherwise. Default 1 GB. */
  defaultQuotaMb?: number;
}

export interface FileView {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface UploadInput {
  body: AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer>;
  name: string;
  /** The record type and field the file is for; their size and accepted kinds apply. */
  recordType?: string;
  field?: string;
  /** Replaces the platform's upload size limit (imports allow less; export results more). */
  maxBytes?: number;
}

const toView = (r: FileRow): FileView => ({
  id: r.id,
  name: r.name,
  mime: r.mime,
  size: Number(r.size),
  createdAt: new Date(r.created_at).toISOString(),
});

export { cleanFileName };

export class FileService {
  private readonly maxUploadBytes: number;
  private readonly defaultQuotaBytes: number;

  constructor(
    private readonly tm: TransactionManager,
    private readonly catalog: FileCatalog,
    private readonly retention: RetentionScan,
    private readonly defs: DefinitionReader,
    private readonly records: RecordService,
    readonly stores: FileStoreResolver,
    private readonly audit: AuditTrail,
    limits: FileLimits = {},
  ) {
    this.maxUploadBytes = (limits.maxUploadMb ?? 25) * MB;
    this.defaultQuotaBytes = (limits.defaultQuotaMb ?? 1024) * MB;
  }

  /**
   * Streams an upload into the store, counting and hashing as it goes and
   * stopping at the size limit or the organisation's remaining quota. The type
   * comes from the content; the file stays unlinked until a record saves it.
   */
  async upload(ctx: TenantContext, input: UploadInput): Promise<FileView> {
    const field = input.recordType || input.field ? await this.targetField(ctx, input.recordType ?? '', input.field ?? '') : undefined;
    const sizeLimit =
      field?.type === 'signature'
        ? SIGNATURE_MAX_BYTES
        : field?.maxSizeMb
          ? Math.min(field.maxSizeMb * MB, this.maxUploadBytes)
          : (input.maxBytes ?? this.maxUploadBytes);
    const { used, quota } = await this.usageOf(ctx.tenantId);
    if (used >= quota) throw ruleViolation(this.quotaMessage());
    const limit = Math.min(sizeLimit, quota - used);

    const name = cleanFileName(input.name);
    const id = randomUUID();
    const key = `${ctx.tenantId}/${id}`;
    const sniffer = new FileSniffer();
    const hash = createHash('sha256');
    let size = 0;
    const tooLarge = () => (size > sizeLimit ? validationFailed(`The file is larger than ${this.formatMb(sizeLimit)}.`) : ruleViolation(this.quotaMessage()));
    async function* checked(body: UploadInput['body']) {
      for await (const part of body) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += chunk.length;
        if (size > limit) throw tooLarge();
        sniffer.push(chunk);
        hash.update(chunk);
        yield chunk;
      }
    }
    const { ref: storeRef, store } = await this.stores.forTenant(ctx.tenantId);
    let mime: string;
    try {
      await store.put(key, Readable.from(checked(input.body)), 'application/octet-stream');
      const detected = sniffer.finish(name);
      mime = detected.mime;
      if (field?.type === 'signature' && mime !== 'image/png') throw validationFailed('A signature must be a PNG image.');
      if (field?.type === 'file' && field.accept?.length && !field.accept.includes(detected.kind)) {
        throw validationFailed(`'${field.label}' accepts only ${field.accept.join(', ')} files.`);
      }
    } catch (error) {
      await store.delete(key).catch(() => undefined);
      throw error;
    }

    try {
      return await this.tm.withTenant(ctx.tenantId, async (tx) => {
        if ((await this.catalog.usedBytes(tx)) + size > quota) throw ruleViolation(this.quotaMessage());
        const row = await this.catalog.add(tx, { id, name, mime, size, sha256: hash.digest('hex'), storageKey: key, storeRef, createdBy: ctx.actor.id });
        await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'file.uploaded', entity: 'file', entityId: id, after: { name, mime, size } });
        return toView(row);
      });
    } catch (error) {
      await store.delete(key).catch(() => undefined);
      throw error;
    }
  }

  /** The bytes of a stored file, from the store it was written to. The caller has checked access. */
  read(file: { storage_key: string; store_ref: string }): Promise<Readable> {
    return this.stores.byRef(file.store_ref).get(file.storage_key);
  }

  /**
   * A stored file for download. A linked file needs read access to its record
   * and field (restricted visibility and sensitive fields included); an
   * unlinked one is visible only to the person who uploaded it.
   */
  async open(ctx: TenantContext, id: string): Promise<{ file: FileView; body: Readable }> {
    if (!UUID.test(id)) throw notFound('File not found.');
    const row = await this.tm.withTenant(ctx.tenantId, (tx) => this.catalog.file(tx, id));
    if (!row) throw notFound('File not found.');
    if (!row.record_id) {
      if (row.created_by !== ctx.actor.id) throw notFound('File not found.');
    } else {
      await this.records.assertFieldReadable(ctx, row.record_id, row.field_key ?? '');
    }
    return { file: toView(row), body: await this.read(row) };
  }

  /** Bytes stored by the organisation and its quota, for people who change organisation settings. */
  async usage(ctx: TenantContext): Promise<{ used: number; quota: number }> {
    demand(ctx.actor, 'admin:settings');
    return this.usageOf(ctx.tenantId);
  }

  /** Organisations with uploads left unlinked for more than a day. */
  tenantsWithStaleUploads(): Promise<string[]> {
    return this.retention.tenantsWithStaleUploads(UNLINKED_HOURS);
  }

  /**
   * Removes up to `limit` uploads that were never linked (or were unlinked)
   * and are more than a day old; files an unfinished import still reads, the
   * organisation's logo and logos kept by issued receipts are kept. Rows are
   * marked first, so a file linked meanwhile is never removed.
   */
  async cleanup(tenantId: string, limit: number): Promise<number> {
    const rows = await this.tm.withTenant(tenantId, (tx) => this.catalog.removeUnlinked(tx, UNLINKED_HOURS, limit));
    for (const r of rows) await this.stores.byRef(r.store_ref).delete(r.storage_key);
    return rows.length;
  }

  private async targetField(ctx: TenantContext, typeKey: string, fieldKey: string): Promise<FieldDef> {
    const type = await this.defs.get(ctx.tenantId, 'recordType', typeKey);
    if (!type) throw notFound(`Unknown record type '${typeKey}'.`);
    const field = type.body.fields.find((f) => f.key === fieldKey);
    if (!can(ctx.actor, `record:${typeKey}:create`) && !can(ctx.actor, `record:${typeKey}:update`)) throw forbidden();
    if (!field || (field.type !== 'file' && field.type !== 'signature')) throw validationFailed(`'${fieldKey}' is not a file field.`);
    return field;
  }

  /** `usage` without its permission check, for callers that make their own. */
  async usageOf(tenantId: string): Promise<{ used: number; quota: number }> {
    const row = await this.tm.withTenant(tenantId, (tx) => this.catalog.usage(tx, QUOTA_SETTING));
    const setting = Number(row.quota);
    return { used: row.used, quota: row.quota !== null && Number.isFinite(setting) && setting >= 0 ? setting : this.defaultQuotaBytes };
  }

  /** The names of the organisation's files among `ids`, for showing file values. */
  async namesOf(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const rows = await this.tm.withTenant(tenantId, (tx) => this.catalog.names(tx, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private quotaMessage(): string {
    return "The organisation's file storage is full. Remove files you no longer need or ask for more storage.";
  }

  private formatMb(bytes: number): string {
    return bytes < MB ? `${Math.round(bytes / 1024)} kB` : `${Math.round((bytes / MB) * 10) / 10} MB`;
  }
}