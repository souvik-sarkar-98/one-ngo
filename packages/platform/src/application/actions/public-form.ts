import { notFound, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { demand } from '../../domain/permissions.js';
import type { CredentialCrypto } from '@onengo/kernel/ports';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../runtime/definitions/ports/definition-reader.js';
import type { FieldDef, PublicAccessDef, RecordTypeDef } from '../../runtime/definitions/types.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { PostgresPublicFormLinkStore } from '../../infrastructure/postgres/stores/public-form-link-store.js';
import type { SignInTheme } from '../organisations/organisation-service.js';

const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
const KEY = /^[a-z][a-zA-Z0-9_-]{0,62}$/;
const MISSING = 'Not found.';
const PAGE = 20;

/** The person a public save is recorded as. No permissions, so it cannot pass a staff route. */
export const PUBLIC_ACTOR = { id: 'public', roles: [] as string[], permissions: [] as string[] };

export interface PublicField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  help?: string;
  placeholder?: string;
  choices?: { value: string; label: string }[];
  /** Set when the field chooses one record from that catalogue. */
  referenceType?: string;
}

export interface PublicFormView {
  organisation: string;
  /** The organisation's published colours. Null when none are published. */
  theme: SignInTheme | null;
  label: string;
  thanks: string | null;
  fields: PublicField[];
}

export interface CatalogueItem {
  /** The id the request form submits. It is already shown by this search. */
  id: string;
  values: Record<string, string>;
  requestPath: string | null;
}

export interface CataloguePage {
  organisation: string;
  theme: SignInTheme | null;
  label: string;
  fields: { key: string; label: string }[];
  items: CatalogueItem[];
  more: boolean;
}

export interface PublicSubmission {
  /** The organisation's published colours. Null when none are published. */
  theme: SignInTheme | null;
  label: string;
  number: string | null;
  statusLabel: string | null;
  version: number;
  edit: boolean;
  delete: boolean;
  fields: PublicField[];
  /** Values the form can send back. A reference is the catalogue record's id. Omitted when edit is off. */
  values?: Record<string, unknown>;
  display: Record<string, string>;
}

export interface PublicOrganisationHome {
  publicHome(code: string): Promise<{ tenantId: string; code: string; displayName: string; theme: SignInTheme | null }>;
  publicTheme(tenantId: string): Promise<SignInTheme | null>;
}

/** A public form, a catalogue search, and the secret link to one submission. */
export class PublicFormService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly organisations: PublicOrganisationHome,
    private readonly defs: DefinitionReader,
    private readonly records: RecordService,
    private readonly store: PostgresPublicFormLinkStore,
    private readonly crypto: Pick<CredentialCrypto, 'sha256' | 'randomToken' | 'encryptSecret' | 'decryptSecret'>,
    private readonly audit: AuditTrail,
  ) {}

  async form(code: string, typeKey: string): Promise<PublicFormView> {
    const home = await this.home(code);
    const type = await this.openType(home.tenantId, typeKey, 'create');
    return { organisation: home.displayName, theme: home.theme, label: type.label, thanks: type.public?.thanks ?? null, fields: this.formFields(type) };
  }

  async catalogue(code: string, typeKey: string, q = ''): Promise<CataloguePage> {
    const home = await this.home(code);
    const type = await this.openType(home.tenantId, typeKey, 'catalogue');
    const catalogue = type.public!.catalogue!;
    if (!catalogue.statusIn.length) throw notFound(MISSING);
    const searchFields = (catalogue.search?.length ? catalogue.search : catalogue.fields).filter((key) => KEY.test(key));
    const hits = await this.transactions.withTenant(home.tenantId, (tx) =>
      this.store.search(tx, { typeKey, statusIn: catalogue.statusIn, searchFields, q, limit: PAGE + 1 }),
    );
    const more = hits.length > PAGE;
    const request = catalogue.request;
    return {
      organisation: home.displayName,
      theme: home.theme,
      label: type.pluralLabel || type.label,
      fields: catalogue.fields.flatMap((key) => {
        const field = type.fields.find((f) => f.key === key);
        return field ? [{ key, label: field.label }] : [];
      }),
      items: hits.slice(0, PAGE).map((hit) => ({
        id: hit.id,
        values: Object.fromEntries(catalogue.fields.map((key) => [key, shown(type.fields.find((f) => f.key === key), hit.data[key])])),
        requestPath: request ? `/o/${home.code}/f/${request.recordType}?${encodeURIComponent(request.field)}=${encodeURIComponent(hit.id)}` : null,
      })),
      more,
    };
  }

  async submit(code: string, typeKey: string, input: unknown): Promise<{ path?: string; thanks?: string }> {
    const home = await this.home(code);
    const type = await this.openType(home.tenantId, typeKey, 'create');
    const data = await this.accepted(home.tenantId, type, input, null);
    const ctx: TenantContext = { tenantId: home.tenantId, actor: PUBLIC_ACTOR };
    const view = !!type.public?.view;
    let path: string | undefined;
    await this.records.createGranted(ctx, typeKey, data, async (tx, saved) => {
      if (!view) return;
      const token = this.crypto.randomToken(32);
      await this.store.saveLink(tx, {
        recordId: saved.record.id,
        tokenHash: this.crypto.sha256(token),
        tokenEnc: this.crypto.encryptSecret(token),
        actorId: PUBLIC_ACTOR.id,
      });
      await this.audit.audit(tx, { actorId: PUBLIC_ACTOR.id, action: 'record.link.created', entity: `record:${typeKey}`, entityId: saved.record.id });
      path = `/f/${token}`;
    });
    return path ? { path } : { thanks: type.public?.thanks || 'Thank you.' };
  }

  async open(token: string): Promise<PublicSubmission> {
    const found = await this.find(token);
    const submission = await this.transactions.withTenant(found.tenantId, async (tx) => this.submission(tx, found.tenantId, found.recordId, 'view'));
    return { ...submission, theme: await this.organisations.publicTheme(found.tenantId) };
  }

  async change(token: string, input: unknown, expectedVersion: number): Promise<PublicSubmission> {
    const found = await this.find(token);
    if (!Number.isInteger(expectedVersion)) throw validationFailed('The form is not valid.', [{ path: '/expectedVersion', message: 'is required' }]);
    const type = await this.openType(found.tenantId, await this.typeKey(found), 'edit');
    const data = await this.accepted(found.tenantId, type, input, found.recordId);
    const ctx: TenantContext = { tenantId: found.tenantId, actor: PUBLIC_ACTOR };
    const saved = await this.records.updateGranted(ctx, found.recordId, { data, expectedVersion });
    const opened = await this.records.openData(found.tenantId, type.key, saved.record.data);
    const view = await this.present(found.tenantId, type, saved.record.number, saved.record.status, saved.record.version, opened);
    return { ...view, theme: await this.organisations.publicTheme(found.tenantId) };
  }

  async remove(token: string, expectedVersion: number): Promise<void> {
    const found = await this.find(token);
    if (!Number.isInteger(expectedVersion)) throw validationFailed('The form is not valid.', [{ path: '/version', message: 'is required' }]);
    const type = await this.openType(found.tenantId, await this.typeKey(found), 'delete');
    const ctx: TenantContext = { tenantId: found.tenantId, actor: PUBLIC_ACTOR };
    await this.records.deleteGranted(ctx, found.recordId, expectedVersion);
    await this.transactions.withTenant(found.tenantId, async (tx) => {
      await this.store.revokeLink(tx, found.recordId, PUBLIC_ACTOR.id);
    });
  }

  /** The live link, for someone who can already edit the record. Null when there is none. */
  async linkFor(ctx: TenantContext, recordId: string): Promise<{ path: string } | null> {
    const found = await this.editable(ctx, recordId);
    const link = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.link(tx, recordId));
    if (!link || link.revoked) return null;
    return { path: `/f/${this.crypto.decryptSecret(link.tokenEnc)}` };
  }

  async revoke(ctx: TenantContext, recordId: string): Promise<void> {
    await this.editable(ctx, recordId);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const revoked = await this.store.revokeLink(tx, recordId, ctx.actor.id);
      if (!revoked) throw notFound(MISSING);
      await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'record.link.revoked', entity: 'record', entityId: recordId });
    });
  }

  /** Update permission, reported as not found when the record is not theirs to change. */
  private async editable(ctx: TenantContext, recordId: string): Promise<{ record: { type: string } }> {
    try {
      const found = await this.records.stored(ctx, recordId, 'edit');
      demand(ctx.actor, `record:${found.record.type}:update`);
      return found;
    } catch (error) {
      if ((error as { code?: string }).code === 'not_found') throw notFound(MISSING);
      throw error;
    }
  }

  private async home(code: string): Promise<Awaited<ReturnType<PublicOrganisationHome['publicHome']>>> {
    try {
      return await this.organisations.publicHome(code);
    } catch {
      throw notFound(MISSING);
    }
  }

  private async find(token: string): Promise<{ tenantId: string; recordId: string }> {
    if (!TOKEN.test(token)) throw notFound(MISSING);
    const found = await this.store.findLive(this.crypto.sha256(token));
    if (!found) throw notFound(MISSING);
    return found;
  }

  private async typeKey(found: { tenantId: string; recordId: string }): Promise<string> {
    const row = await this.transactions.withTenant(found.tenantId, (tx) => this.records.stores.records.get(tx, found.recordId));
    if (!row) throw notFound(MISSING);
    return row.type_key;
  }

  private async openType(tenantId: string, typeKey: string, operation: 'catalogue' | 'create' | 'view' | 'edit' | 'delete'): Promise<RecordTypeDef> {
    if (!KEY.test(typeKey)) throw notFound(MISSING);
    const published = await this.defs.get(tenantId, 'recordType', typeKey);
    const type = published?.body;
    const pub = type?.public;
    const on =
      operation === 'catalogue'
        ? !!pub?.catalogue
        : operation === 'create'
          ? !!pub?.create
          : operation === 'view'
            ? !!pub?.view
            : operation === 'edit'
              ? !!pub?.edit
              : !!pub?.delete;
    if (!type || !on || (await this.postsMoney(tenantId, typeKey))) throw notFound(MISSING);
    return type;
  }

  private async postsMoney(tenantId: string, typeKey: string): Promise<boolean> {
    const [posting, receipts] = await Promise.all([this.defs.list(tenantId, 'postingRule'), this.defs.list(tenantId, 'receiptRule')]);
    return posting.some((r) => r.body.recordType === typeKey) || receipts.some((r) => r.body.recordType === typeKey);
  }

  private formFields(type: RecordTypeDef): PublicField[] {
    return (type.public?.fields ?? []).flatMap((key) => {
      const field = type.fields.find((f) => f.key === key);
      return field ? [publicField(field)] : [];
    });
  }

  /** The submitted object reduced to public fields. A reference must be a live catalogue hit. */
  private async accepted(tenantId: string, type: RecordTypeDef, input: unknown, currentId: string | null): Promise<Record<string, unknown>> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw validationFailed('The form is not valid.', [{ path: '', message: 'must be an object' }]);
    const sent = input as Record<string, unknown>;
    const allowed = new Set(type.public?.fields ?? []);
    const data: Record<string, unknown> = {};
    const issues: FieldIssue[] = [];
    for (const key of allowed) {
      if (!Object.hasOwn(sent, key)) continue;
      const field = type.fields.find((f) => f.key === key);
      if (!field) continue;
      if (field.type === 'reference') {
        const id = sent[key];
        if (id === null || id === '') continue;
        if (typeof id !== 'string' || !(await this.catalogueHit(tenantId, field, id))) {
          issues.push({ path: `/${key}`, message: 'choose a record from the list' });
        } else data[key] = id;
      } else data[key] = sent[key];
    }
    if (issues.length) throw validationFailed('Some fields cannot be saved.', issues);
    void currentId;
    return data;
  }

  private async catalogueHit(tenantId: string, field: FieldDef, id: string): Promise<boolean> {
    const targetKey = field.referenceType;
    if (!targetKey) return false;
    const published = await this.defs.get(tenantId, 'recordType', targetKey);
    const catalogue = published?.body.public?.catalogue;
    if (!catalogue) return false;
    const row = await this.transactions.withTenant(tenantId, (tx) => this.records.stores.records.get(tx, id));
    return !!row && row.type_key === targetKey && !!row.status && catalogue.statusIn.includes(row.status);
  }

  private async submission(tx: Tx, tenantId: string, recordId: string, _operation: 'view'): Promise<Omit<PublicSubmission, 'theme'>> {
    const row = await this.records.stores.records.get(tx, recordId);
    if (!row) throw notFound(MISSING);
    const type = await this.openType(tenantId, row.type_key, 'view');
    const data = await this.records.openData(tenantId, type.key, row.data);
    return this.present(tenantId, type, row.number, row.status, row.version, data);
  }

  private async present(tenantId: string, type: RecordTypeDef, number: string | null, status: string | null, version: number, data: Record<string, unknown>): Promise<Omit<PublicSubmission, 'theme'>> {
    const pub = type.public as PublicAccessDef;
    const workflows = await this.defs.workflowsFor(tenantId, type.key);
    const state = workflows.flatMap((w) => w.body.states).find((s) => s.key === status);
    const fields = this.formFields(type);
    const display: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    for (const field of type.fields) {
      if (!pub.fields?.includes(field.key)) continue;
      if (field.type === 'reference' && typeof data[field.key] === 'string') {
        display[field.key] = await this.referenceText(tenantId, field, data[field.key] as string);
        values[field.key] = data[field.key];
      } else {
        display[field.key] = shown(field, data[field.key]);
        values[field.key] = data[field.key] ?? null;
      }
    }
    return {
      label: type.label,
      number,
      statusLabel: state?.label ?? status,
      version,
      edit: !!pub.edit,
      delete: !!pub.delete,
      fields,
      ...(pub.edit ? { values } : {}),
      display,
    };
  }

  private async referenceText(tenantId: string, field: FieldDef, id: string): Promise<string> {
    const targetKey = field.referenceType;
    if (!targetKey) return '';
    const published = await this.defs.get(tenantId, 'recordType', targetKey);
    const catalogue = published?.body.public?.catalogue;
    const row = await this.transactions.withTenant(tenantId, (tx) => this.records.stores.records.get(tx, id));
    if (!published || !catalogue || !row) return '';
    return catalogue.fields
      .map((key) => shown(published.body.fields.find((f) => f.key === key), row.data[key]))
      .filter(Boolean)
      .join(' · ');
  }
}

function publicField(field: FieldDef): PublicField {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: !!field.required,
    ...(field.help ? { help: field.help } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.choices ? { choices: field.choices.map((c) => ({ value: c.value, label: c.label })) } : {}),
    ...(field.type === 'reference' && field.referenceType ? { referenceType: field.referenceType } : {}),
  };
}

function shown(field: FieldDef | undefined, value: unknown): string {
  if (!field || value == null || value === '') return '';
  if (field.type === 'boolean') return value === true ? 'Yes' : value === false ? 'No' : '';
  if (field.type === 'choice') return field.choices?.find((c) => c.value === String(value))?.label ?? String(value);
  if (field.type === 'multiChoice' && Array.isArray(value)) {
    return value.map((item) => field.choices?.find((c) => c.value === String(item))?.label ?? String(item)).join(', ');
  }
  if (field.type === 'richText' && typeof value === 'string') return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (field.type === 'location' && typeof value === 'object') {
    const loc = value as { label?: unknown; lat?: unknown; lng?: unknown };
    if (typeof loc.label === 'string' && loc.label.trim()) return loc.label.trim();
    if (typeof loc.lat === 'number' && typeof loc.lng === 'number') return `${loc.lat}, ${loc.lng}`;
  }
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
