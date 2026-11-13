import { sql } from 'kysely';
import { enqueueEvent, writeAudit, type AuditInput } from './audit-store.js';
import { fieldExpr, typePredicate } from '../query-compiler/index-expressions.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { PostgresSequenceStore } from './sequence-store.js';
import type {
  ApprovalRequestInput,
  LedgerBalances,
  NewRecord,
  RecordChanges,
  RecordRow,
  RecordStore,
  ScriptRun,
  ScriptSettings,
  StoredFile,
} from '../../../runtime/records/ports/record-store.js';
import { executorOf, pg } from '../tx.js';

export const RECORD_COLUMNS = [
  'id',
  'type_key',
  'number',
  'status',
  'version',
  'schema_version',
  'data',
  'workflow_key',
  'workflow_state',
  'owner_id',
  'created_by',
  'created_at',
  'updated_at',
] as const;

const TENANT = sql<string>`app_tenant()`;
const anyUuid = (ids: string[]) => sql<string>`any(${ids}::uuid[])`;

export class PgRecordStore implements RecordStore {
  constructor(private readonly sequences: PostgresSequenceStore) {}

  get(tx: Tx, id: string): Promise<RecordRow | undefined> {
    return pg(tx)
      .selectFrom('record')
      .select(RECORD_COLUMNS)
      .where('tenant_id', '=', TENANT)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .$castTo<RecordRow>()
      .executeTakeFirst();
  }

  getMany(tx: Tx, ids: string[]): Promise<RecordRow[]> {
    return pg(tx).selectFrom('record').select(RECORD_COLUMNS).where('tenant_id', '=', TENANT).where('id', '=', anyUuid(ids)).$castTo<RecordRow>().execute();
  }

  typesOf(tx: Tx, ids: string[]): Promise<{ id: string; type_key: string }[]> {
    return pg(tx).selectFrom('record').select(['id', 'type_key']).where('tenant_id', '=', TENANT).where('id', '=', anyUuid(ids)).where('deleted_at', 'is', null).execute();
  }

  async versionOf(tx: Tx, id: string): Promise<number | undefined> {
    const row = await pg(tx).selectFrom('record').select('version').where('tenant_id', '=', TENANT).where('id', '=', id).executeTakeFirst();
    return row?.version;
  }

  insert(tx: Tx, r: NewRecord): Promise<RecordRow> {
    return pg(tx)
      .insertInto('record')
      .values({
        tenant_id: TENANT,
        type_key: r.typeKey,
        schema_version: r.schemaVersion,
        number: r.number,
        status: r.status,
        data: JSON.stringify(r.data),
        blind_index: JSON.stringify(r.index),
        workflow_key: r.workflowKey,
        workflow_state: JSON.stringify(r.states),
        search_text: r.searchText,
        owner_id: r.actorId,
        created_by: r.actorId,
        updated_by: r.actorId,
      })
      .returning(RECORD_COLUMNS)
      .$castTo<RecordRow>()
      .executeTakeFirstOrThrow();
  }

  async linked(tx: Tx, typeKey: string, field: string, value: string): Promise<RecordRow[]> {
    return pg(tx)
      .selectFrom('record')
      .select(RECORD_COLUMNS)
      .where('tenant_id', '=', TENANT)
      .where('type_key', '=', typeKey)
      .where('deleted_at', 'is', null)
      .where(sql<string>`data->>${field}`, '=', value)
      .orderBy('id')
      .forUpdate()
      .$castTo<RecordRow>()
      .execute();
  }

  update(tx: Tx, id: string, expectedVersion: number, c: RecordChanges): Promise<RecordRow | undefined> {
    return pg(tx)
      .updateTable('record')
      .set((eb) => ({
        data: JSON.stringify(c.data),
        blind_index: JSON.stringify(c.index),
        status: c.status,
        schema_version: c.schemaVersion,
        workflow_state: JSON.stringify(c.states),
        search_text: c.searchText,
        version: eb('version', '+', 1),
        updated_by: c.actorId,
        updated_at: sql<Date>`now()`,
      }))
      .where('tenant_id', '=', TENANT)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .where('deleted_at', 'is', null)
      .returning(RECORD_COLUMNS)
      .$castTo<RecordRow>()
      .executeTakeFirst();
  }

  softDelete(tx: Tx, id: string, expectedVersion: number, actorId: string): Promise<RecordRow | undefined> {
    return pg(tx)
      .updateTable('record')
      .set((eb) => ({
        deleted_at: sql<Date>`now()`,
        version: eb('version', '+', 1),
        updated_by: actorId,
        updated_at: sql<Date>`now()`,
      }))
      .where('tenant_id', '=', TENANT)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .where('deleted_at', 'is', null)
      .returning(RECORD_COLUMNS)
      .$castTo<RecordRow>()
      .executeTakeFirst();
  }

  async setRollup(tx: Tx, typeKey: string, id: string, fieldKey: string, value: number): Promise<void> {
    const json = JSON.stringify(value);
    await pg(tx)
      .updateTable('record')
      .set({ data: sql<string>`jsonb_set(data, array[${fieldKey}::text], ${json}::jsonb)` })
      .where('tenant_id', '=', TENANT)
      .where('id', '=', id)
      .where('type_key', '=', typeKey)
      .where('deleted_at', 'is', null)
      .execute();
  }

  async mergeData(tx: Tx, id: string, values: Record<string, number>): Promise<void> {
    await pg(tx)
      .updateTable('record')
      .set({ data: sql<string>`data || ${JSON.stringify(values)}::jsonb` })
      .where('id', '=', id)
      .execute();
  }

  async setSearchText(tx: Tx, id: string, text: string): Promise<void> {
    await pg(tx).updateTable('record').set({ search_text: text }).where('id', '=', id).execute();
  }

  page(tx: Tx, typeKey: string, afterId: string | null, limit: number) {
    return pg(tx)
      .selectFrom('record')
      .select(['id', 'number', 'data'])
      .where('tenant_id', '=', TENANT)
      .where('type_key', '=', typeKey)
      .where('deleted_at', 'is', null)
      .where(sql<boolean>`(${afterId}::uuid is null or id > ${afterId}::uuid)`)
      .orderBy('id')
      .limit(limit)
      .$castTo<{ id: string; number: string | null; data: Record<string, unknown> }>()
      .execute();
  }

  lockStoredPage(tx: Tx, typeKey: string, afterId: string | null, limit: number) {
    return pg(tx)
      .selectFrom('record')
      .select(['id', 'data', 'blind_index'])
      .where('tenant_id', '=', TENANT)
      .where('type_key', '=', typeKey)
      .where('deleted_at', 'is', null)
      .where(sql<boolean>`(${afterId}::uuid is null or id > ${afterId}::uuid)`)
      .orderBy('id')
      .limit(limit)
      .forUpdate()
      .$castTo<{ id: string; data: Record<string, unknown>; blind_index: Record<string, string> }>()
      .execute();
  }

  async restore(tx: Tx, id: string, stored: { data: Record<string, unknown>; index: Record<string, string> }): Promise<void> {
    await pg(tx)
      .updateTable('record')
      .set({ data: JSON.stringify(stored.data), blind_index: JSON.stringify(stored.index) })
      .where('tenant_id', '=', TENANT)
      .where('id', '=', id)
      .execute();
  }

  async countOfType(tx: Tx, typeKey: string): Promise<number> {
    const row = await pg(tx)
      .selectFrom('record')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('tenant_id', '=', TENANT)
      .where('type_key', '=', typeKey)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return row.n;
  }

  children(tx: Tx, typeKey: string, referenceKey: string, parentId: string) {
    return pg(tx)
      .selectFrom('record')
      .select(['status', 'data'])
      .where('tenant_id', '=', TENANT)
      .where('type_key', '=', typeKey)
      .where('deleted_at', 'is', null)
      .where(sql<string>`data->>${referenceKey}`, '=', parentId)
      .$castTo<{ status: string | null; data: Record<string, unknown> }>()
      .execute();
  }

  async idsByHash(tx: Tx, typeKey: string, fieldKey: string, hashes: string[], exceptId: string | null, limit: number): Promise<string[]> {
    const rows = await pg(tx)
      .selectFrom('record')
      .select('id')
      .where('tenant_id', '=', TENANT)
      .where(sql.raw<boolean>(typePredicate(typeKey)))
      .where(sql.raw<string>(fieldExpr(fieldKey, 'hash')), '=', sql<string>`any(${hashes}::text[])`)
      .$if(exceptId !== null, (qb) => qb.where('id', '<>', exceptId!))
      .orderBy('id')
      .limit(limit)
      .execute();
    return rows.map((r) => r.id);
  }

  async shareAccess(tx: Tx, recordId: string, person: { id: string; roles: string[] }): Promise<'read' | 'edit' | undefined> {
    const hit = await pg(tx)
      .selectFrom('record_share')
      .select('access')
      .where('tenant_id', '=', TENANT)
      .where('record_id', '=', recordId)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
      .where((eb) =>
        eb.or([
          eb.and([eb('principal_kind', '=', 'user'), eb('principal', '=', person.id)]),
          eb.and([eb('principal_kind', '=', 'role'), eb('principal', '=', sql<string>`any(${person.roles}::text[])`)]),
        ]),
      )
      .orderBy(sql`access = 'edit'`, 'desc')
      .limit(1)
      .executeTakeFirst();
    return hit?.access as 'read' | 'edit' | undefined;
  }

  async pendingApprovalSteps(tx: Tx, recordId: string): Promise<string[]> {
    const rows = await pg(tx)
      .selectFrom('approval_request')
      .select('transition_key')
      .where('tenant_id', '=', TENANT)
      .where('record_id', '=', recordId)
      .where('status', '=', 'pending')
      .execute();
    return rows.map((r) => r.transition_key);
  }

  async hasPendingApproval(tx: Tx, recordId: string): Promise<boolean> {
    const pending = await pg(tx)
      .selectFrom('approval_request')
      .select(sql<number>`1`.as('one'))
      .where('tenant_id', '=', TENANT)
      .where('record_id', '=', recordId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return !!pending;
  }

  async addApprovalRequest(tx: Tx, input: ApprovalRequestInput): Promise<string> {
    const req = await pg(tx)
      .insertInto('approval_request')
      .values({
        tenant_id: TENANT,
        record_id: input.recordId,
        transition_key: input.transitionKey,
        requested_by: input.requestedBy,
        data: JSON.stringify(input.data),
        record_version: input.recordVersion,
        required_approvals: input.requiredApprovals,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return req.id;
  }

  files(tx: Tx, ids: string[]): Promise<StoredFile[]> {
    return pg(tx)
      .selectFrom('file_object')
      .select(['id', 'mime', 'size', 'record_id', 'field_key', 'created_by'])
      .where('tenant_id', '=', TENANT)
      .where('id', '=', anyUuid(ids))
      .where('deleted_at', 'is', null)
      .execute();
  }

  async unlinkFiles(tx: Tx, recordId: string, fieldKeys: string[], keep: string[]): Promise<void> {
    await pg(tx)
      .updateTable('file_object')
      .set({ record_id: null, field_key: null })
      .where('tenant_id', '=', TENANT)
      .where('record_id', '=', recordId)
      .where('deleted_at', 'is', null)
      .where('field_key', '=', sql<string>`any(${fieldKeys}::text[])`)
      .where(sql<boolean>`not (id = any(${keep}::uuid[]))`)
      .execute();
  }

  async linkFiles(tx: Tx, recordId: string, fieldKey: string, ids: string[]): Promise<void> {
    await pg(tx).updateTable('file_object').set({ record_id: recordId, field_key: fieldKey }).where('tenant_id', '=', TENANT).where('id', '=', anyUuid(ids)).execute();
  }

  async userName(tx: Tx, userId: string): Promise<string | undefined> {
    const row = await pg(tx)
      .selectFrom('app_user')
      .select(sql<string>`app_member_name(id)`.as('display_name'))
      .where(sql<string>`id::text`, '=', userId)
      .executeTakeFirst();
    return row?.display_name;
  }

  async logScript(tx: Tx, r: ScriptRun, recordId: string | null): Promise<void> {
    await pg(tx)
      .insertInto('script_run')
      .values({
        tenant_id: TENANT,
        script_key: r.key,
        script_version: r.version,
        hook: r.hook ?? 'beforeSave',
        record_id: recordId,
        duration_ms: r.durationMs,
        outcome: r.outcome,
        message: r.message,
        effects: r.effects ? JSON.stringify(r.effects) : null,
      })
      .execute();
  }

  async scriptSettings(tx: Tx): Promise<ScriptSettings> {
    const k = pg(tx);
    const tenant = await k.selectFrom('tenant').select('name').where('id', '=', TENANT).executeTakeFirst();
    const series = await k.selectFrom('receipt_series').select(['key', 'label']).where('tenant_id', '=', TENANT).orderBy('key').execute();
    return {
      organisationName: tenant?.name ?? '',
      financialYearStartMonth: await this.sequences.fiscalYearStartMonth(executorOf(tx)),
      defaultCurrency: 'INR',
      receiptSeries: series,
    };
  }

  async ledgerBalances(tx: Tx, accounts: string[], funds: string[], asOf: string): Promise<LedgerBalances> {
    const k = pg(tx);
    const posted = k
      .selectFrom('journal_line as l')
      .innerJoin('journal_entry as e', 'e.id', 'l.entry_id')
      .where('l.tenant_id', '=', TENANT)
      .where('e.entry_date', '<=', sql<Date>`${asOf}::date`);
    const byAccount = accounts.length
      ? await posted
          .innerJoin('ledger_account as a', 'a.id', 'l.account_id')
          .select(['a.code as code', sql<string>`(sum(l.debit) - sum(l.credit))::numeric(14, 2)::text`.as('balance')])
          .where('a.code', '=', sql<string>`any(${accounts}::text[])`)
          .groupBy('a.code')
          .execute()
      : [];
    const byFund = funds.length
      ? await posted
          .select(['l.fund as code', sql<string>`(sum(l.debit) - sum(l.credit))::numeric(14, 2)::text`.as('balance')])
          .where('l.fund', '=', sql<string>`any(${funds}::text[])`)
          .groupBy('l.fund')
          .execute()
      : [];
    const out = (codes: string[], rows: { code: string | null; balance: string }[]) =>
      Object.fromEntries(codes.map((c) => [c, rows.find((r) => r.code === c)?.balance ?? '0.00']));
    return { accounts: out(accounts, byAccount), funds: out(funds, byFund) };
  }

  async rolePermissions(tx: Tx, role: string): Promise<string[] | undefined> {
    const row = await pg(tx).selectFrom('role').select('permissions').where('tenant_id', '=', TENANT).where('key', '=', role).executeTakeFirst();
    return row?.permissions;
  }

  audit(tx: Tx, input: AuditInput): Promise<void> {
    return writeAudit(executorOf(tx), input);
  }

  enqueueEvent(tx: Tx, type: string, payload: unknown): Promise<void> {
    return enqueueEvent(executorOf(tx), type, payload);
  }

  fiscalYearStartMonth(tx: Tx): Promise<number> {
    return this.sequences.fiscalYearStartMonth(executorOf(tx));
  }

  nextSequenceValue(tx: Tx, key: string, period: string): Promise<number> {
    return this.sequences.nextSequenceValue(executorOf(tx), key, period);
  }
}
