import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { notFound, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import { demand } from '../../domain/permissions.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import { financialRetainedUntil } from '../../domain/privacy/retention-period.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import type { FieldDef, RecordTypeDef } from '../../runtime/definitions/types.js';
import { searchText } from '../../runtime/records/query.js';
import type { SensitiveFields } from '../../runtime/records/sensitive.js';
import type {
  ConsentEvent,
  ConsentSource,
  ConsentState,
  ErasureReason,
  ErasureRow,
  FinancialRows,
  PrivacyStore,
  SideData,
  StoredRecord,
  SubjectKind,
} from './ports/privacy-store.js';

export const CONSENT_READ = 'privacy:consent:read';
export const CONSENT_RECORD = 'privacy:consent:record';
export const PRIVACY_ERASE = 'privacy:erase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSE = /^[a-z][a-z0-9_.-]{0,63}$/;
const KINDS: SubjectKind[] = ['record', 'member'];

/** Field types erasure clears unless the field says `personal: false`. */
const PERSONAL_TYPES = new Set<FieldDef['type']>(['text', 'longText', 'richText', 'email', 'phone', 'location', 'signature', 'file']);
/** Field types that keep a pseudonym when required; other erased values are removed. */
const PSEUDONYM_TYPES = new Set<FieldDef['type']>(['text', 'longText', 'email', 'phone']);

/** Whether erasing the record's data subject clears the field. Totals kept from child records are never personal. */
export function isPersonal(f: FieldDef): boolean {
  if (f.rollup) return false;
  return f.personal ?? (!!f.sensitive || PERSONAL_TYPES.has(f.type));
}

const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/** The value an erased field keeps: a pseudonym when it is required and can hold one, otherwise none. */
function pseudonymOf(f: FieldDef, token: string): string | undefined {
  if (!f.required || !PSEUDONYM_TYPES.has(f.type)) return undefined;
  const value = f.type === 'email' ? `erased-${token.toLowerCase()}@erased.invalid` : f.type === 'phone' ? '0000000000' : `Erased person ${token}`;
  return f.maxLength ? value.slice(0, f.maxLength) : value;
}

function erased(data: Record<string, unknown>, f: FieldDef, token: string): void {
  const value = pseudonymOf(f, token);
  if (value === undefined) delete data[f.key];
  else data[f.key] = value;
}

export interface ConsentInput {
  subjectKind: SubjectKind;
  subjectId: string;
  purpose: string;
  state: ConsentState;
  source: Exclude<ConsentSource, 'erasure'>;
}

export interface ConsentView {
  subjectKind: SubjectKind;
  subjectId: string;
  erased: boolean;
  /** The latest event for each purpose, by purpose. */
  current: ConsentEvent[];
  /** Every event, oldest first. */
  history: ConsentEvent[];
}

export interface ErasureInput {
  subjectKind: SubjectKind;
  subjectId: string;
  reason?: ErasureReason;
}

export interface ErasureSummary {
  /** Records whose personal fields were pseudonymised, with the field keys (never the values). */
  records: { id: string; type: string; fields: string[] }[];
  /** The account: erased, left because the person belongs to another organisation, or not a member erasure. */
  account: 'erased' | 'shared' | null;
  auditEntries: number;
  notifications: number;
  files: number;
  consentsWithdrawn: string[];
  /** Rows beside the records whose copies of the values were cleared, by kind; absent in erasures made before this was added. */
  sideData?: SideData;
  /** Financial rows linked to the records, kept unchanged with their numbers, amounts and dates. */
  kept: FinancialRows & { retentionYears: number; retainedUntil: string | null; retentionPeriod: 'pending counsel confirmation' };
}

export interface ErasureView {
  id: string;
  subjectKind: SubjectKind;
  subjectId: string;
  reason: ErasureReason;
  requestedBy: string;
  completedAt: string;
  /** True when the subject had been erased before; nothing changed this time. */
  alreadyErased: boolean;
  summary: ErasureSummary;
}

interface ErasureRun {
  records: ErasureSummary['records'];
  auditEntries: number;
  fileIds: string[];
}

const view = (row: ErasureRow, alreadyErased: boolean): ErasureView => ({
  id: row.id,
  subjectKind: row.subjectKind,
  subjectId: row.subjectId,
  reason: row.reason,
  requestedBy: row.requestedBy,
  completedAt: row.completedAt,
  alreadyErased,
  summary: row.summary as ErasureSummary,
});

function currentOf(history: ConsentEvent[]): ConsentEvent[] {
  const latest = new Map<string, ConsentEvent>();
  for (const e of history) latest.set(e.purpose, e);
  return [...latest.values()].sort((a, b) => a.purpose.localeCompare(b.purpose));
}

/**
 * Consent per data subject and purpose, and erasure by pseudonymisation
 * (DPDP). A data subject is a record (a donor, a beneficiary) or a member.
 * The erasure rules await product-owner approval and the financial retention
 * period awaits counsel; see docs/business/privacy/consent-and-erasure.
 */
export class PrivacyService {
  constructor(
    private readonly tx: TransactionManager,
    private readonly store: PrivacyStore,
    private readonly defs: DefinitionService,
    private readonly sensitive: SensitiveFields,
    private readonly retentionYears: number,
  ) {}

  async recordConsent(ctx: TenantContext, input: ConsentInput): Promise<ConsentEvent> {
    demand(ctx.actor, CONSENT_RECORD);
    const { kind, id } = subjectOf(input);
    if (!PURPOSE.test(input.purpose)) {
      throw validationFailed('Name the purpose in lower case, for example newsletter or donation.receipts.', [{ path: '/purpose', message: 'Lower-case letters, digits, dots, dashes and underscores.' }]);
    }
    if ((input.source as string) === 'erasure') throw validationFailed('Only erasure records this source.', [{ path: '/source', message: 'Not allowed.' }]);
    return this.tx.withTenant(ctx.tenantId, async (tx) => {
      await this.store.lockSubject(tx, kind, id);
      await this.mustExist(tx, kind, id);
      if (await this.store.erasure(tx, kind, id)) throw ruleViolation('This person has been erased; consent cannot be recorded for them.');
      return this.store.addConsent(tx, { kind, subjectId: id, purpose: input.purpose, state: input.state, source: input.source, actorId: ctx.actor.id });
    });
  }

  async consent(ctx: TenantContext, query: { subjectKind?: unknown; subjectId?: unknown }): Promise<ConsentView> {
    demand(ctx.actor, CONSENT_READ);
    const { kind, id } = subjectOf(query);
    return this.tx.withTenant(ctx.tenantId, async (tx) => {
      const history = await this.store.consentHistory(tx, kind, id);
      const erasure = await this.store.erasure(tx, kind, id);
      return { subjectKind: kind, subjectId: id, erased: !!erasure, current: currentOf(history), history };
    });
  }

  /**
   * Pseudonymises the data subject's personal fields, and the values copied
   * from them into records that reference the subject, in one transaction.
   * Amounts, dates, numbers, links, receipts and journals are kept. Asking
   * again returns the first result and changes nothing.
   */
  async erase(ctx: TenantContext, input: ErasureInput): Promise<ErasureView> {
    demand(ctx.actor, PRIVACY_ERASE);
    const { kind, id } = subjectOf(input);
    const reason = input.reason ?? 'subject_request';
    const types = new Map((await this.defs.list(ctx.tenantId, 'recordType')).map((d) => [d.key, d.body]));
    return this.tx.withTenant(ctx.tenantId, async (tx) => {
      await this.store.lockSubject(tx, kind, id);
      const done = await this.store.erasure(tx, kind, id);
      if (done) return view(done, true);

      const requestId = randomUUID();
      const token = requestId.replace(/-/g, '').slice(0, 8).toUpperCase();
      const subjects = await this.subjectRecords(tx, kind, id);
      const run: ErasureRun = { records: [], auditEntries: 0, fileIds: [] };

      for (const subject of subjects) {
        const type = types.get(subject.typeKey);
        if (!type) throw ruleViolation(`Record type '${subject.typeKey}' is not published, so its personal fields are not known.`);
        const plain = this.sensitive.open(type, subject.data);
        const next = { ...plain };
        const fields = type.fields.filter((f) => isPersonal(f) && !blank(plain[f.key]));
        for (const f of fields) erased(next, f, token);
        await this.rewrite(tx, ctx, requestId, type, subject, next, fields, run);
        await this.eraseCopies(tx, ctx, requestId, types, type, subject.id, new Set(fields.map((f) => f.key)), token, run);
      }
      if (kind === 'member') await this.eraseAccountFollows(tx, ctx, requestId, types, id, token, run);

      const recordIds = run.records.map((r) => r.id);
      const notifications = await this.store.eraseNotifications(tx, recordIds);
      const sideData = await this.store.eraseSideData(tx, { erasureId: requestId, records: run.records, memberId: kind === 'member' ? id : null, fileIds: run.fileIds });
      const account = kind === 'member' ? await this.store.eraseAccount(tx, id, `Erased person ${token}`, `erased-${token.toLowerCase()}@erased.invalid`) : null;
      const consentsWithdrawn: string[] = [];
      for (const c of currentOf(await this.store.consentHistory(tx, kind, id))) {
        if (c.state !== 'granted') continue;
        await this.store.addConsent(tx, { kind, subjectId: id, purpose: c.purpose, state: 'withdrawn', source: 'erasure', actorId: ctx.actor.id });
        consentsWithdrawn.push(c.purpose);
      }
      const financial = await this.store.financialRows(tx, recordIds);
      const summary: ErasureSummary = {
        records: run.records,
        account,
        auditEntries: run.auditEntries,
        notifications,
        files: run.fileIds.length,
        consentsWithdrawn,
        sideData,
        kept: {
          ...financial,
          retentionYears: this.retentionYears,
          retainedUntil: financial.latestDate ? financialRetainedUntil(financial.latestDate, this.retentionYears) : null,
          retentionPeriod: 'pending counsel confirmation',
        },
      };
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'privacy.erased',
        entity: 'privacy:subject',
        entityId: `${kind}:${id}`,
        after: { erasure: requestId, reason, records: recordIds.length, account, consentsWithdrawn: consentsWithdrawn.length },
      });
      const row = await this.store.addErasure(tx, { id: requestId, subjectKind: kind, subjectId: id, reason, summary, requestedBy: ctx.actor.id });
      return view(row, false);
    });
  }

  // --------------------------------------------------------------- internals

  private async mustExist(tx: Tx, kind: SubjectKind, id: string): Promise<void> {
    if (kind === 'member') {
      if (!(await this.store.memberStatus(tx, id))) throw validationFailed('This person is not a member of the organisation.', [{ path: '/subjectId', message: 'Unknown member.' }]);
      return;
    }
    const record = await this.store.record(tx, id);
    if (!record) throw validationFailed('There is no such record.', [{ path: '/subjectId', message: 'Unknown record.' }]);
  }

  /** The records that are about the subject. A member has none: the account stays, and erasure removes the sign-in. */
  private async subjectRecords(tx: Tx, kind: SubjectKind, id: string): Promise<StoredRecord[]> {
    if (kind === 'member') {
      const status = await this.store.memberStatus(tx, id);
      if (!status) throw notFound('This person is not a member of the organisation.');
      if (status !== 'suspended') throw ruleViolation('Suspend the person before erasing them.');
      return [];
    }
    const record = await this.store.record(tx, id);
    if (!record) throw notFound('There is no such record.');
    return [record];
  }

  /** Values copied from the subject's erased fields into records that reference it (a donation's donor name) are erased the same way. */
  private async eraseCopies(
    tx: Tx,
    ctx: TenantContext,
    requestId: string,
    types: Map<string, RecordTypeDef>,
    subjectType: RecordTypeDef,
    subjectId: string,
    erasedKeys: Set<string>,
    token: string,
    run: ErasureRun,
  ): Promise<void> {
    if (!erasedKeys.size) return;
    for (const other of types.values()) {
      for (const ref of other.fields.filter((f) => f.type === 'reference' && f.referenceType === subjectType.key)) {
        const copies = other.fields.filter(
          (f) =>
            (f.copyFrom?.reference === ref.key && erasedKeys.has(f.copyFrom.field)) ||
            (f.follow?.via === ref.key && erasedKeys.has(f.follow.field)),
        );
        if (!copies.length) continue;
        for (const record of await this.store.recordsWhere(tx, other.key, ref.key, subjectId)) {
          if (record.id === subjectId) continue;
          const plain = this.sensitive.open(other, record.data);
          const next = { ...plain };
          const fields = copies.filter((f) => !blank(plain[f.key]));
          for (const f of fields) erased(next, f, token);
          await this.rewrite(tx, ctx, requestId, other, record, next, fields, run);
        }
      }
    }
  }

  /** Account name and email copied onto records through a person field are erased with the member. */
  private async eraseAccountFollows(
    tx: Tx,
    ctx: TenantContext,
    requestId: string,
    types: Map<string, RecordTypeDef>,
    userId: string,
    token: string,
    run: ErasureRun,
  ): Promise<void> {
    for (const other of types.values()) {
      for (const via of other.fields.filter((f) => f.type === 'person')) {
        const follows = other.fields.filter((f) => f.follow?.via === via.key && (f.follow.field === 'name' || f.follow.field === 'email'));
        if (!follows.length) continue;
        for (const record of await this.store.recordsWhere(tx, other.key, via.key, userId)) {
          const plain = this.sensitive.open(other, record.data);
          const next = { ...plain };
          const fields = follows.filter((f) => !blank(plain[f.key]));
          for (const f of fields) erased(next, f, token);
          await this.rewrite(tx, ctx, requestId, other, record, next, fields, run);
        }
      }
    }
  }

  private async rewrite(
    tx: Tx,
    ctx: TenantContext,
    requestId: string,
    type: RecordTypeDef,
    record: StoredRecord,
    next: Record<string, unknown>,
    fields: FieldDef[],
    run: ErasureRun,
  ): Promise<void> {
    if (!fields.length) return;
    const keys = fields.map((f) => f.key);
    const stored = this.sensitive.seal(type, next);
    await this.store.rewriteRecord(tx, record.id, { data: stored.data, blindIndex: stored.index, searchText: searchText(type, record.number, next), actorId: ctx.actor.id });
    run.fileIds.push(...(await this.store.detachFiles(tx, record.id, fields.filter((f) => f.type === 'file').map((f) => f.key))));
    run.auditEntries += await this.store.eraseAuditValues(tx, type.key, record.id, keys);
    await this.store.audit(tx, { actorId: ctx.actor.id, action: 'record.pseudonymised', entity: `record:${type.key}`, entityId: record.id, after: { erasure: requestId, fields: keys } });
    run.records.push({ id: record.id, type: type.key, fields: keys });
  }
}

function subjectOf(input: { subjectKind?: unknown; subjectId?: unknown }): { kind: SubjectKind; id: string } {
  const kind = input.subjectKind as SubjectKind;
  if (!KINDS.includes(kind)) throw validationFailed('subjectKind must be record or member.', [{ path: '/subjectKind', message: 'record or member.' }]);
  const id = typeof input.subjectId === 'string' ? input.subjectId.trim() : '';
  if (!UUID.test(id)) throw validationFailed('subjectId must be the id of the record or member.', [{ path: '/subjectId', message: 'An id.' }]);
  return { kind, id: id.toLowerCase() };
}
