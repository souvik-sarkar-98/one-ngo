import type { LedgerService } from '../../domain/ledger/ledger-service.js';
import type { ReceiptService } from '../../domain/receipts/receipt-service.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { conflict, forbidden, notFound, ruleViolation, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { can, demand } from '../../domain/permissions.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import { joinTx } from '../../domain/transaction-scope.js';
import type { DefinitionReader } from '../definitions/ports/definition-reader.js';
import type { ConnectorFact } from '../definitions/ports/definition-store.js';
import type { InternalTransitionOptions, RecordView, SaveResult } from './ports/record-result.js';
import { canReadField, maskFor } from '../definitions/field-permissions.js';
import { adminOnlyParts, DEFAULT_LOOKUP_LIMIT, MAX_LOOKUP_LIMIT, SCRIPT_ADMIN_PERMISSION } from '../definitions/script-inputs.js';
import type { ApprovalDef, FieldDef, FieldFilter, RecordTypeDef, ScriptDef, WorkflowDef } from '../definitions/types.js';
import { findStep, isApprover, isPrimary, workflowsOf } from '../definitions/workflows.js';
import { buildRecordQuery, onlyIds, referenceQueries, searchText, type RecordQuery, type RecordRow } from './query.js';
import { maintainRollups, rollupValue } from './rollups.js';
import type { SensitiveFields } from './sensitive.js';
import { auditAndOutbox } from './save/audit.js';
import { saveContext, type EffectBudget, type Loaded, type Move, type SaveContext, type SaveServices } from './save/context.js';
import { effects } from './save/effects.js';
import { moveOf, parallelOf, primaryOf } from './save/moves.js';
import { prepare } from './save/pipeline.js';
import { guard } from './save/rules.js';
import { evalTest, scope } from './save/scope.js';
import { failedScripts, guardScripts, logScripts } from './save/script.js';
import { afterSaveScripts, applyEffects, auditScriptEffects, hold, runScript } from './save/script-run.js';
import { uniqueAndPatternIssues, uniqueHolder } from './save/unique.js';
import { linkRecordFiles, write } from './save/write.js';
import { ScriptFailure } from '../../domain/script-failure.js';
import type { RecordLookups } from './ports/record-lookups.js';
import type { RecordScripts } from './ports/record-scripts.js';
import { attachPeople, resolvePerson } from './person-fields.js';
import { attachReferences, type RecordRef } from './reference-fields.js';
import type { RecordStores } from './ports/record-stores.js';
import { normaliseData } from './validator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type { FieldFilter, RecordQuery };

export type { InternalTransitionOptions, RecordView, SaveResult };

export interface ListOptions {
  status?: string;
  /** Matches the record number and searchable or required fields. */
  search?: string;
  where?: Record<string, string | number | boolean>;
  limit?: number;
  offset?: number;
}

const EXPORT_PAGE_MAX = 1000;

/** Every record type's save definitions; `lookups` says whether any type has lookups. */
type LoadedOf = ((typeKey: string) => Loaded) & { lookups: boolean };

type LookupDef = NonNullable<RecordTypeDef['lookups']>[number];

/** For a service wired without connectors: a record type with lookups cannot be saved, rather than saved without them. */
const noRecordLookups: RecordLookups = {
  lookup: async () => ({ issues: [{ path: '/connector', message: 'Lookups are not available.' }] }),
};

const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * The lookups a patch changes the inputs of, with those inputs: on a create
 * every input the patch sets, on an update those whose value differs from `previous`.
 */
function dueLookups(type: RecordTypeDef, patch: Record<string, unknown>, previous: Record<string, unknown> | null): { lookup: LookupDef; changed: string[] }[] {
  return (type.lookups ?? []).flatMap((lookup) => {
    const changed = lookup.inputs.filter(
      (k) => Object.hasOwn(patch, k) && patch[k] !== undefined && (previous === null || asText(patch[k]) !== asText(previous[k])),
    );
    return changed.length ? [{ lookup, changed }] : [];
  });
}

/** Saves inside a transaction someone else holds cannot call a lookup's connector, so they may not change its inputs. */
function refuseLookups(type: RecordTypeDef, patch: Record<string, unknown>, previous: Record<string, unknown> | null): void {
  const issues: FieldIssue[] = dueLookups(type, patch, previous).flatMap(({ lookup, changed }) =>
    changed.map((field) => ({ path: `/${field}`, message: `'${field}' is looked up from '${lookup.connector}'; change it on the record screen or by import` })),
  );
  if (issues.length) throw validationFailed('Fields filled by a lookup can only be changed on the record screen or by import.', issues);
}

/**
 * A lookup's issues on the record's fields. The connector reports them on its
 * answer values: each goes to the fields that value fills, and one on a value
 * the lookup does not use is left out. The connector's own issues, or all of
 * them when none is on a used value, go to the inputs that changed.
 */
function lookupIssues(lookup: LookupDef, issues: FieldIssue[], inputs: string[]): FieldIssue[] {
  const out = new Map<string, FieldIssue>();
  const add = (field: string, message: string) => out.set(`${field}\n${message}`, { path: `/${field}`, message });
  const filled = (i: FieldIssue) => Object.keys(lookup.map).filter((f) => `/${lookup.map[f]}` === i.path);
  for (const i of issues) for (const f of filled(i)) add(f, i.message);
  const own = issues.filter((i) => i.path === '/connector');
  for (const i of out.size ? own : issues) for (const f of inputs) add(f, i.message);
  return [...out.values()];
}

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export class RecordService {
  private readonly store: RecordStores['records'];
  private readonly queries: RecordStores['queries'];
  private readonly people: RecordStores['people'];

  constructor(
    private readonly db: TransactionManager,
    /** The record engine's stores, for the services that sit beside it (aggregates, shares, bulk). */
    readonly stores: RecordStores,
    private readonly defs: DefinitionReader,
    private readonly sandbox: RecordScripts,
    private readonly ledger: LedgerService,
    private readonly receipts: ReceiptService,
    /** Encrypts sensitive values as records are written; decrypts them as they are read. */
    readonly sensitive: SensitiveFields,
    /** Lookup connectors, called before a save's transaction opens. */
    private readonly lookups: RecordLookups = noRecordLookups,
    /** Made by `within`: the caller holds the transaction, so saves that would run a lookup are refused. */
    private readonly joined = false,
  ) {
    this.store = stores.records;
    this.queries = stores.queries;
    this.people = stores.people;
  }

  /** The same service working through other transactions, such as one the caller already holds (see joinTx). */
  within(db: TransactionManager, defs: DefinitionReader): RecordService {
    return new RecordService(db, this.stores, defs, this.sandbox, this.ledger, this.receipts, this.sensitive, this.lookups, true);
  }

  /**
   * Runs `fn` with this service joined to one new transaction, so every save it makes commits or
   * rolls back together; a throw from `fn` undoes them all. As in any joined save, a save that would
   * call a lookup's connector is refused.
   */
  async saveTogether<T>(ctx: TenantContext, fn: (records: RecordService, tx: Tx) => Promise<T>): Promise<T> {
    if (this.joined) throw new Error('saveTogether opens its own transaction; call it on the unjoined service.');
    return this.inSave(ctx, (tx) => fn(this.within(joinTx(ctx.tenantId, tx), this.defs), tx));
  }

  /** Record data of a type as read from the database, its sensitive values decrypted; for services that read records themselves. */
  async openData(tenantId: string, typeKey: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const type = (await this.defs.list(tenantId, 'recordType')).find((t) => t.key === typeKey);
    return this.sensitive.open(type?.body, data);
  }

  // ------------------------------------------------------------------ reads

  async get(ctx: TenantContext, id: string): Promise<RecordView> {
    return (await this.stored(ctx, id, 'read')).record;
  }

  /**
   * The record with its unmasked values, for server-side expressions, after
   * the same checks as `get`; `edit` also needs an edit share on restricted types.
   */
  async stored(ctx: TenantContext, id: string, mode: 'read' | 'edit'): Promise<{ record: RecordView; data: Record<string, unknown>; createdBy: string | null }> {
    if (!UUID.test(id)) throw notFound('Record not found.');
    const stored = await this.db.withTenant(ctx.tenantId, (tx) => this.store.get(tx, id));
    if (!stored) throw notFound('Record not found.');
    demand(ctx.actor, `record:${stored.type_key}:read`);
    const loaded = await this.load(ctx.tenantId, stored.type_key);
    const row = this.opened(loaded.type.body, stored);
    await this.db.withTenant(ctx.tenantId, (tx) => this.assertVisible(tx, ctx, loaded, row, mode));
    const [record] = await this.db.withTenant(ctx.tenantId, async (tx) =>
      this.attachRefs(tx, ctx, loaded, await attachPeople(this.people, tx, loaded.type.body, [this.view(ctx, loaded.type.body, row)])),
    );
    return { record: record!, data: { ...row.data }, createdBy: row.created_by };
  }

  /**
   * Read access to one field of a record, for the files stored in it: the
   * record's read permission and visibility, and the field's read permission
   * (sensitive fields included). Anything not readable is reported as not found.
   */
  async assertFieldReadable(ctx: TenantContext, recordId: string, fieldKey: string): Promise<void> {
    const row = await this.db.withTenant(ctx.tenantId, (tx) => this.current(tx, recordId));
    const loaded = await this.load(ctx.tenantId, row.type_key);
    const field = loaded.type.body.fields.find((f) => f.key === fieldKey);
    demand(ctx.actor, `record:${row.type_key}:read`);
    await this.db.withTenant(ctx.tenantId, (tx) => this.assertVisible(tx, ctx, loaded, row, 'read'));
    if (!field || !canReadField(ctx.actor, loaded.type.body, field)) throw notFound('File not found.');
  }

  async list(ctx: TenantContext, typeKey: string, options: ListOptions = {}): Promise<RecordView[]> {
    const { items } = await this.query(ctx, typeKey, {
      statusIn: options.status ? [options.status] : undefined,
      search: options.search,
      equals: options.where,
      limit: options.limit,
      offset: options.offset,
      withTotal: false,
    });
    return items;
  }

  /**
   * Filtered, paged list with a total count. Every value is a bound parameter;
   * field keys are checked against the record type and sensitive fields are refused.
   */
  async query(
    ctx: TenantContext,
    typeKey: string,
    c: RecordQuery = {},
  ): Promise<{ items: RecordView[]; total: number; sums?: Record<string, number> }> {
    const q = await this.buildQuery(ctx, typeKey, c);
    const sums = (c.sum ?? []).map((k) => {
      const f = q.type.body.fields.find((x) => x.key === k);
      if (!f || (f.type !== 'number' && f.type !== 'money')) throw validationFailed(`'${k}' is not a number or money field.`);
      if (!canReadField(ctx.actor, q.type.body, f)) {
        throw forbidden(f.sensitive ? 'Sensitive fields cannot be totalled.' : `'${f.label}' cannot be totalled: you cannot see it.`);
      }
      return f;
    });
    return this.db.withTenant(ctx.tenantId, async (tx) => {
      const rows = (await this.queries.rows(tx, q)).map((r) => this.opened(q.type.body, r));
      let total = q.offset + rows.length;
      if (c.withTotal !== false) total = await this.queries.count(tx, q);
      const out: { items: RecordView[]; total: number; sums?: Record<string, number> } = {
        items: await this.attachRefs(tx, ctx, q.loaded, await attachPeople(this.people, tx, q.type.body, rows.map((r) => this.view(ctx, q.type.body, r)))),
        total,
      };
      if (sums.length) out.sums = await this.queries.sums(tx, q, sums.map((f) => f.key));
      return out;
    });
  }

  /**
   * One page of a list query for exports, which read past the list's page
   * size: the same checks, visibility and masking as `query`.
   */
  async exportPage(ctx: TenantContext, typeKey: string, c: RecordQuery, offset: number, limit: number): Promise<{ type: RecordTypeDef; items: RecordView[] }> {
    const q = await this.buildQuery(ctx, typeKey, { ...c, offset, limit }, EXPORT_PAGE_MAX);
    const items = await this.db.withTenant(ctx.tenantId, async (tx) =>
      this.attachRefs(
        tx,
        ctx,
        q.loaded,
        await attachPeople(this.people, tx, q.type.body, (await this.queries.rows(tx, q)).map((r) => this.view(ctx, q.type.body, this.opened(q.type.body, r)))),
      ),
    );
    return { type: q.type.body, items };
  }

  /**
   * Ids of every record a list query matches, in list order, with the same
   * checks and visibility as `query`; only the count when more than `max` match.
   */
  async matchingIds(ctx: TenantContext, typeKey: string, c: RecordQuery, max: number): Promise<{ ids: string[]; total: number }> {
    const { limit: _l, offset: _o, sum: _s, withTotal: _w, ...rest } = c;
    const q = await this.buildQuery(ctx, typeKey, rest);
    return this.db.withTenant(ctx.tenantId, async (tx) => {
      const total = await this.queries.count(tx, q);
      if (total > max) return { ids: [], total };
      const ids: string[] = [];
      for (;;) {
        const page = await this.queries.ids(tx, { ...q, limit: EXPORT_PAGE_MAX, offset: ids.length });
        ids.push(...page);
        if (page.length < EXPORT_PAGE_MAX || ids.length >= max) break;
      }
      return { ids: ids.slice(0, max), total };
    });
  }

  /** The number, else the title, of each of `ids` the person can see, for exports. */
  async displayNames(ctx: TenantContext, typeKey: string, ids: string[]): Promise<Map<string, string>> {
    if (!this.labelled(ctx, typeKey, ids)) return new Map();
    const loaded = await this.load(ctx.tenantId, typeKey);
    return this.db.withTenant(ctx.tenantId, (tx) => this.labelsOn(tx, ctx, loaded, typeKey, ids, 'number'));
  }

  private labelled(ctx: TenantContext, typeKey: string, ids: string[]): boolean {
    return ids.some((id) => UUID.test(id)) && can(ctx.actor, `record:${typeKey}:read`);
  }

  /**
   * What each of `ids` the person can see is called, read on an open
   * transaction: its title and its number, the preferred one first.
   */
  private async labelsOn(
    tx: Tx,
    ctx: TenantContext,
    loaded: Loaded,
    typeKey: string,
    ids: string[],
    prefer: 'title' | 'number',
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const wanted = [...new Set(ids.filter((id) => UUID.test(id)))];
    if (!wanted.length || !can(ctx.actor, `record:${typeKey}:read`)) return out;
    const q = buildRecordQuery(ctx.actor, typeKey, loaded, {});
    for (const row of await this.queries.rows(tx, onlyIds(q, wanted))) {
      const view = this.view(ctx, q.type.body, this.opened(q.type.body, row));
      const value = q.type.body.titleField ? view.data[q.type.body.titleField] : undefined;
      const title = typeof value === 'string' || typeof value === 'number' ? String(value) : null;
      out.set(row.id, (prefer === 'title' ? (title ?? row.number) : (row.number ?? title)) ?? row.id);
    }
    return out;
  }

  /**
   * The label of the record each reference field holds, read on the
   * transaction that loaded the views: the title the picker and list rows
   * show, so a record never shows a reference as a raw id.
   */
  private attachRefs<V extends { data: Record<string, unknown>; references?: Record<string, RecordRef> }>(
    tx: Tx,
    ctx: TenantContext,
    loaded: Loaded,
    views: V[],
  ): Promise<V[]> {
    const labels = (typeKey: string, ids: string[]) =>
      this.labelled(ctx, typeKey, ids) && loaded.typeOf(typeKey)
        ? this.labelsOn(tx, ctx, loaded.loadedOf(typeKey), typeKey, ids, 'title')
        : Promise.resolve(new Map<string, string>());
    return attachReferences(labels, loaded.type.body, views);
  }

  /**
   * The record of a type holding `value` in a unique field, whoever can see
   * it (unique values are unique across the organisation), with its version.
   */
  async findByUnique(ctx: TenantContext, typeKey: string, fieldKey: string, value: string): Promise<{ id: string; version: number } | null> {
    const { type } = await this.load(ctx.tenantId, typeKey);
    const f = type.body.fields.find((x) => x.key === fieldKey);
    if (!f?.unique) throw validationFailed(`'${fieldKey}' is not a unique field.`);
    if (f.type === 'number' && !Number.isFinite(Number(value))) return null;
    return this.db.withTenant(ctx.tenantId, async (tx) => {
      const hit = await uniqueHolder(this.uniqueLookup(), tx, type.body, f, value.trim(), null);
      if (!hit) return null;
      const version = await this.store.versionOf(tx, hit);
      return version === undefined ? null : { id: hit, version };
    });
  }

  /**
   * The record of a type a person means by some text, among the records they
   * can see: its id, its number, a unique field's value, or its title, tried
   * in that order. Sensitive unique fields count only for people who may see them.
   */
  async resolveReference(ctx: TenantContext, typeKey: string, text: string): Promise<string> {
    const value = text.trim();
    const q = await this.buildQuery(ctx, typeKey, {});
    const type = q.type.body;
    const tries = referenceQueries(q, type, ctx.actor, value, UUID.test(value));
    const what = type.label.toLowerCase();
    return this.db.withTenant(ctx.tenantId, async (tx) => {
      for (const lookup of tries) {
        let hits: string[];
        if ('query' in lookup) hits = await this.queries.ids(tx, lookup.query);
        else {
          const ids = await this.store.idsByHash(tx, type.key, lookup.hashed.key, this.sensitive.lookups(type, lookup.hashed, value), null, 2);
          hits = ids.length ? await this.queries.ids(tx, onlyIds(q, ids)) : [];
        }
        if (hits.length > 1) throw validationFailed(`matches more than one ${what}`);
        if (hits.length === 1) return hits[0]!;
      }
      throw validationFailed(`does not match any ${what}`);
    });
  }

  /** The active member some text means, by email or user id, for a person field. */
  async resolvePerson(ctx: TenantContext, text: string): Promise<string> {
    return this.db.withTenant(ctx.tenantId, (tx) => resolvePerson(this.people, tx, text));
  }

  /**
   * The checked AST of a list query, after the record type's read permission.
   */
  async buildQuery(ctx: TenantContext, typeKey: string, c: RecordQuery = {}, maxLimit = 200) {
    demand(ctx.actor, `record:${typeKey}:read`);
    const loaded = await this.load(ctx.tenantId, typeKey);
    return { ...buildRecordQuery(ctx.actor, typeKey, loaded, c, maxLimit), loaded };
  }

  // ----------------------------------------------------------------- writes

  async create(ctx: TenantContext, typeKey: string, input: Record<string, unknown>): Promise<SaveResult> {
    demand(ctx.actor, `record:${typeKey}:create`);
    const loaded = await this.load(ctx.tenantId, typeKey);
    let data = input;
    if (loaded.type.body.lookups?.length) {
      if (this.joined) refuseLookups(loaded.type.body, input, null);
      else data = await this.lookUp(ctx.tenantId, loaded.type.body, input, null);
    }
    const primary = this.choosePrimary(ctx, loaded, data);
    const status = primary?.initial ?? null;
    const start: Move = { workflow: primary?.key ?? null, status, states: {} };

    return this.inSave(ctx, (tx) => this.run(tx, this.context(ctx, loaded, null, data, start), null, 'record.created'));
  }

  /**
   * The create path without a permission check. The caller has already decided
   * this save is allowed, for example a public form whose record type says so.
   * `after` runs in the same transaction, before it commits.
   */
  async createGranted(
    ctx: TenantContext,
    typeKey: string,
    input: Record<string, unknown>,
    after?: (tx: Tx, saved: SaveResult) => Promise<void>,
  ): Promise<SaveResult> {
    const loaded = await this.load(ctx.tenantId, typeKey);
    let data = input;
    if (loaded.type.body.lookups?.length) {
      if (this.joined) refuseLookups(loaded.type.body, input, null);
      else data = await this.lookUp(ctx.tenantId, loaded.type.body, input, null);
    }
    const primary = this.choosePrimary(ctx, loaded, data);
    const status = primary?.initial ?? null;
    const start: Move = { workflow: primary?.key ?? null, status, states: {} };
    return this.inSave(ctx, async (tx) => {
      const saved = await this.run(tx, this.context(ctx, loaded, null, data, start), null, 'record.created');
      if (after) await after(tx, saved);
      return saved;
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: { data: Record<string, unknown>; expectedVersion: number },
  ): Promise<SaveResult> {
    const loadedOf = await this.loadAll(ctx.tenantId);
    let data = input.data;
    let expectedVersion = input.expectedVersion;
    if (loadedOf.lookups && !this.joined) {
      const read = await this.db.withTenant(ctx.tenantId, (tx) => this.editable(tx, ctx, loadedOf, id), { readOnly: true });
      if (read.loaded.type.body.lookups?.length) {
        data = await this.lookUp(ctx.tenantId, read.loaded.type.body, input.data, read.current);
        expectedVersion = input.expectedVersion ?? read.current.version;
      }
    }
    return this.inSave(ctx, async (tx) => {
      const { current, loaded } = await this.editable(tx, ctx, loadedOf, id);
      if (this.joined) refuseLookups(loaded.type.body, input.data, current.data);
      return this.run(tx, this.context(ctx, loaded, current, data, moveOf(loaded, current)), expectedVersion, 'record.updated');
    });
  }

  /** The update path without a permission or visibility check. A locked or final state is still refused. */
  async updateGranted(ctx: TenantContext, id: string, input: { data: Record<string, unknown>; expectedVersion: number }): Promise<SaveResult> {
    const loadedOf = await this.loadAll(ctx.tenantId);
    return this.inSave(ctx, async (tx) => {
      const { current, loaded } = await this.editable(tx, ctx, loadedOf, id, 'granted');
      if (this.joined) refuseLookups(loaded.type.body, input.data, current.data);
      return this.run(tx, this.context(ctx, loaded, current, input.data, moveOf(loaded, current)), input.expectedVersion, 'record.updated');
    });
  }

  /** Soft-deletes one record without a permission check. A locked or final state is still refused. */
  async deleteGranted(ctx: TenantContext, id: string, expectedVersion: number): Promise<void> {
    const loadedOf = await this.loadAll(ctx.tenantId);
    await this.inSave(ctx, async (tx) => {
      const { current, loaded } = await this.editable(tx, ctx, loadedOf, id, 'granted');
      if (current.version !== expectedVersion) throw conflict('This record was changed by someone else. Reload it and try again.');
      const gone = await this.store.softDelete(tx, id, expectedVersion, ctx.actor.id);
      if (!gone) throw conflict('This record was changed by someone else. Reload it and try again.');
      await maintainRollups(this.store, tx, ctx, loaded, current, { ...current, data: {} }, this.sensitive);
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'record.deleted',
        entity: `record:${current.type_key}`,
        entityId: current.id,
      });
    });
  }

  /**
   * The patch with the fields of each lookup whose inputs it changes filled
   * from the lookup's connector. Called with no transaction open: lookups go out over HTTP.
   */
  private async lookUp(tenantId: string, type: RecordTypeDef, patch: Record<string, unknown>, current: RecordRow | null): Promise<Record<string, unknown>> {
    const due = dueLookups(type, patch, current?.data ?? null);
    if (!due.length) return patch;
    const merged = { ...(current?.data ?? {}), ...patch };
    const out = { ...patch };
    for (const { lookup, changed } of due) {
      const result = await this.lookups.lookup(tenantId, lookup.connector, { record: merged, recordId: current?.id ?? null });
      if ('issues' in result) throw validationFailed(`Looking up '${lookup.key}' from '${lookup.connector}' failed.`, lookupIssues(lookup, result.issues, changed));
      for (const [field, key] of Object.entries(lookup.map)) {
        if (!Object.hasOwn(result.values, key)) continue;
        out[field] = result.values[key];
        merged[field] = result.values[key];
      }
    }
    return out;
  }

  /**
   * Runs a create, or an update of record `id`, through the checks a save
   * makes (permissions, visibility, conditions, required fields, rules,
   * unique values) without saving: no number is taken and nothing is written.
   * Returns the data that would be saved. For import checks.
   */
  async check(ctx: TenantContext, typeKey: string, input: { data: Record<string, unknown>; id?: string }): Promise<{ data: Record<string, unknown> }> {
    if (input.id) {
      const id = input.id;
      const loadedOf = await this.loadAll(ctx.tenantId);
      return this.db.withTenant(ctx.tenantId, async (tx) => {
        const { current, loaded } = await this.editable(tx, ctx, loadedOf, id);
        if (current.type_key !== typeKey) throw notFound('Record not found.');
        return prepare(tx, this.context(ctx, loaded, current, input.data, moveOf(loaded, current), { dryRun: true }));
      });
    }
    demand(ctx.actor, `record:${typeKey}:create`);
    const loaded = await this.load(ctx.tenantId, typeKey);
    const primary = this.choosePrimary(ctx, loaded, input.data);
    const status = primary?.initial ?? null;
    return this.db.withTenant(ctx.tenantId, (tx) =>
      prepare(tx, this.context(ctx, loaded, null, input.data, { workflow: primary?.key ?? null, status, states: {} }, { dryRun: true })),
    );
  }

  private async editable(
    tx: Tx,
    ctx: TenantContext,
    loadedOf: (typeKey: string) => Loaded,
    id: string,
    authority: 'demand' | 'granted' = 'demand',
  ): Promise<{ current: RecordRow; loaded: Loaded }> {
    const stored = await this.current(tx, id);
    const loaded = loadedOf(stored.type_key);
    const current = this.opened(loaded.type.body, stored);
    if (authority === 'demand') {
      demand(ctx.actor, `record:${stored.type_key}:update`);
      await this.assertVisible(tx, ctx, loaded, current, 'edit');
    }
    const state = primaryOf(loaded, current)?.states.find((s) => s.key === current.status);
    if (state?.locked || state?.final) throw ruleViolation(`Records that are ${state.label} cannot be edited.`);
    return { current, loaded };
  }

  async transition(
    ctx: TenantContext,
    id: string,
    transitionKey: string,
    input: { data?: Record<string, unknown>; expectedVersion: number },
    internal: InternalTransitionOptions = {},
  ): Promise<SaveResult> {
    const loadedOf = await this.loadAll(ctx.tenantId);
    return this.inSave(ctx, (tx) => this.transitionIn(tx, ctx, loadedOf, id, transitionKey, input, internal));
  }

  private async transitionIn(
    tx: Tx,
    ctx: TenantContext,
    loadedOf: (typeKey: string) => Loaded,
    id: string,
    transitionKey: string,
    input: { data?: Record<string, unknown>; expectedVersion: number },
    internal: InternalTransitionOptions,
  ): Promise<SaveResult> {
    const stored = await this.current(tx, id);
    const loaded = loadedOf(stored.type_key);
    const current = this.opened(loaded.type.body, stored);
    const primary = primaryOf(loaded, current);
    const own = [...(primary ? [primary] : []), ...parallelOf(loaded)];
    if (!own.length) throw ruleViolation('This record type has no workflow.');
    const found = findStep(own, transitionKey);
    if (!found) throw notFound(`Unknown step '${transitionKey}'.`);
    const { workflow: wf, step: t } = found;
    if (!internal.approvedRequestId) demand(ctx.actor, t.permission ?? `record:${current.type_key}:transition:${t.key}`);
    await this.assertVisible(tx, ctx, loaded, current, internal.approvedRequestId ? 'read' : 'edit');
    const was = moveOf(loaded, current);
    const parallel = wf !== primary;
    const from = parallel ? was.states[wf.key] : was.status;
    if (!from || !t.from.includes(from)) {
      throw ruleViolation(`'${t.label}' is not available from the current status.`);
    }
    if (current.version !== input.expectedVersion) {
      throw conflict('This record was changed by someone else. Reload it and try again.');
    }
    const move: Move = parallel ? { ...was, states: { ...was.states, [wf.key]: t.to } } : { ...was, status: t.to };

    const opts = { requiredFields: t.requiredFields ?? [], transition: t };
    if (t.approval && !internal.approvedRequestId) {
      const s = this.context(ctx, loaded, current, input.data ?? {}, move, opts);
      await prepare(tx, s);
      guard(s);
      await guardScripts(tx, s);
      if (!t.approval.when || evalTest(t.approval.when, scope(ctx, s.data, move.status, current.data, current.status, move), `approval for ${t.key}`)) {
        return this.requestApproval(tx, ctx, loaded, current, t, input.data ?? {});
      }
    }
    return this.run(tx, this.context(ctx, loaded, current, input.data ?? {}, move, opts), input.expectedVersion, 'record.transitioned');
  }

  private async requestApproval(
    tx: Tx,
    ctx: TenantContext,
    loaded: Loaded,
    current: RecordRow,
    t: WorkflowDef['transitions'][number],
    data: Record<string, unknown>,
  ): Promise<SaveResult> {
    if (await this.store.hasPendingApproval(tx, current.id)) throw ruleViolation('This record already has a step waiting for approval.');
    const requestId = await this.store.addApprovalRequest(tx, {
      recordId: current.id,
      transitionKey: t.key,
      requestedBy: ctx.actor.id,
      data: this.sensitive.seal(loaded.type.body, data).data,
      recordVersion: current.version,
      requiredApprovals: t.approval!.count ?? 1,
    });
    await this.store.audit(tx, {
      actorId: ctx.actor.id,
      action: 'approval.requested',
      entity: `record:${current.type_key}`,
      entityId: current.id,
      after: { transition: t.key, requestId },
    });
    await this.store.enqueueEvent(tx, 'approval.requested', {
      requestId,
      id: current.id,
      type: current.type_key,
      transition: t.key,
      requestedBy: ctx.actor.id,
      depth: ctx.depth ?? 0,
    });
    return {
      record: this.view(ctx, loaded.type.body, current),
      receipts: [],
      journalEntryIds: [],
      approvalRequestId: requestId,
    };
  }

  /**
   * Runs a save in one transaction. The runs of a before-save script that
   * failed are logged after it rolls back, so the log is kept.
   */
  private async inSave<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.withTenant(ctx.tenantId, fn);
    } catch (e) {
      const runs = e && typeof e === 'object' ? failedScripts.get(e) : undefined;
      if (runs) await this.db.withTenant(ctx.tenantId, (tx) => logScripts(this.store, tx, runs, null));
      throw e;
    }
  }

  // -------------------------------------------------------------- pipeline

  private context(
    ctx: TenantContext,
    loaded: Loaded,
    current: RecordRow | null,
    input: Record<string, unknown>,
    move: Move,
    opts?: Parameters<typeof saveContext>[6],
  ): SaveContext {
    const services: SaveServices = {
      store: this.store,
      people: this.people,
      sandbox: this.sandbox,
      ledger: this.ledger,
      receipts: this.receipts,
      sensitive: this.sensitive,
      checkUniqueAndPatterns: (...args) => this.checkUniqueAndPatterns(...args),
      linkFiles: (...args) => this.linkFiles(...args),
      scriptInputs: (...args) => this.scriptInputs(...args),
      nested: {
        create: (t, c, outer, typeKey, data) => this.createIn(t, c, outer, typeKey, data, s.budget),
        update: (t, c, outer, id, change) => this.updateIn(t, c, outer, id, change, s.budget),
      },
    };
    const s = saveContext(services, ctx, loaded, current, input, move, opts);
    return s;
  }

  /**
   * The stages of a save: prepare, guard and workflow-guard scripts, write,
   * posting and receipt effects, after-save scripts, the scripts' held
   * effects, audit and outbox, then the script-effects audit entry.
   */
  private async run(tx: Tx, s: SaveContext, expectedVersion: number | null, event: string): Promise<SaveResult> {
    await prepare(tx, s);
    guard(s);
    await guardScripts(tx, s);
    const row = await write(tx, s, expectedVersion);
    const done = await effects(tx, s, row);
    await afterSaveScripts(tx, s, row);
    const scripted = await applyEffects(tx, s, row);
    await auditAndOutbox(tx, s, row, event);
    await auditScriptEffects(tx, s, row, scripted.applied);
    const [record] = await this.attachRefs(tx, s.ctx, s.loaded, await attachPeople(this.people, tx, s.type, [this.view(s.ctx, s.type, row)]));
    return { record: record!, receipts: done.receipts, journalEntryIds: [...done.journalEntryIds, ...scripted.journalEntryIds] };
  }

  /**
   * Runs a record's custom-button script and saves the record values it
   * returns as an update at `expectedVersion`, applying its proposals in that
   * update's transaction. Inputs are read as `ctx`; `saveAs` saves (an
   * action's authority, by default `ctx`).
   */
  async runButtonScript(ctx: TenantContext, id: string, scriptKey: string, expectedVersion: number, saveAs: TenantContext = ctx): Promise<SaveResult> {
    const loadedOf = await this.loadAll(ctx.tenantId);
    return this.inSave(ctx, async (tx) => {
      const { current, loaded } = await this.editable(tx, saveAs, loadedOf, id);
      const def = loaded.buttonScript(scriptKey);
      if (!def) throw notFound(`Unknown script '${scriptKey}'.`);
      if (current.version !== expectedVersion) throw conflict('This record was changed by someone else. Reload it and try again.');
      const reader = this.context(ctx, loaded, current, {}, moveOf(loaded, current));
      const out = await runScript(tx, reader, def, 'customButton', { record: { ...current.data }, extra: { id: current.id, number: current.number }, savedRecordId: current.id });
      const fields = new Set(loaded.type.body.fields.map((f) => f.key));
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(normaliseData(out.record!))) {
        if (!fields.has(k)) throw new ScriptFailure('script_failed', `Script '${def.key}' set unknown field '${k}'.`, out.logs);
        if (JSON.stringify(v) !== JSON.stringify(current.data[k])) patch[k] = v;
      }
      const s = this.context(saveAs, loaded, current, patch, moveOf(loaded, current), { budget: reader.budget });
      s.scripts.push(...reader.scripts);
      hold(s, def, out.effects);
      return this.run(tx, s, expectedVersion, 'record.updated');
    });
  }

  /**
   * A script's declared inputs as the person trying it would see them, in a
   * read-only transaction; for Try it. Ledger balances, like publishing a
   * script that reads them, need the script administrator permission.
   */
  async previewScriptInputs(ctx: TenantContext, def: ScriptDef, record: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (adminOnlyParts(def).length && !can(ctx.actor, SCRIPT_ADMIN_PERMISSION)) throw forbidden('Only an organisation administrator can try a script that reads ledger balances or runs as a role.');
    const loaded = await this.load(ctx.tenantId, def.recordType);
    return this.db.withTenant(ctx.tenantId, (tx) => this.scriptInputs(tx, ctx, loaded, def, record, new Date().toISOString().slice(0, 10)), { readOnly: true });
  }

  /** A create inside the open transaction, through the full pipeline; for script effects. */
  private async createIn(tx: Tx, ctx: TenantContext, outer: Loaded, typeKey: string, data: Record<string, unknown>, budget: EffectBudget) {
    demand(ctx.actor, `record:${typeKey}:create`);
    const loaded = outer.loadedOf(typeKey);
    refuseLookups(loaded.type.body, data, null);
    const primary = this.choosePrimary(ctx, loaded, data);
    const start: Move = { workflow: primary?.key ?? null, status: primary?.initial ?? null, states: {} };
    const saved = await this.run(tx, this.context(ctx, loaded, null, data, start, { budget }), null, 'record.created');
    return saved.record;
  }

  /** An update at the expected version inside the open transaction, through the full pipeline; for script effects. */
  private async updateIn(
    tx: Tx,
    ctx: TenantContext,
    outer: Loaded,
    id: string,
    input: { recordType: string; data: Record<string, unknown>; expectedVersion: number },
    budget: EffectBudget,
  ) {
    const { current, loaded } = await this.editable(tx, ctx, outer.loadedOf, id);
    if (current.type_key !== input.recordType) throw notFound('Record not found.');
    refuseLookups(loaded.type.body, input.data, current.data);
    const saved = await this.run(tx, this.context(ctx, loaded, current, input.data, moveOf(loaded, current), { budget }), input.expectedVersion, 'record.updated');
    return saved.record;
  }

  /**
   * A script's declared inputs, read as `ctx`'s actor through the same checks
   * as the screens: a record they cannot read is null like a missing one, and
   * fields they may not see are masked.
   */
  private async scriptInputs(tx: Tx, ctx: TenantContext, loaded: Loaded, def: ScriptDef, data: Record<string, unknown>, asOf: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const pick = (view: RecordView, fields: string[]) => ({
      id: view.id,
      number: view.number,
      status: view.status,
      version: view.version,
      ...Object.fromEntries(fields.map((k) => [k, view.data[k] ?? null])),
    });
    const type = loaded.type.body;
    for (const r of def.inputs?.related ?? []) {
      out[r.name] = null;
      const f = type.fields.find((x) => x.key === r.field);
      const id = data[r.field];
      if (f?.type !== 'reference' || !f.referenceType || typeof id !== 'string' || !UUID.test(id)) continue;
      if (!can(ctx.actor, `record:${f.referenceType}:read`) ) continue;
      const stored = await this.store.get(tx, id);
      if (!stored || stored.type_key !== f.referenceType) continue;
      const target = loaded.loadedOf(stored.type_key);
      const row = this.opened(target.type.body, stored);
      const visible = await this.assertVisible(tx, ctx, target, row, 'read').then(
        () => true,
        () => false,
      );
      if (visible) out[r.name] = pick(this.view(ctx, target.type.body, row), r.fields);
    }
    for (const l of def.inputs?.lookups ?? []) {
      out[l.name] = [];
      if (!can(ctx.actor, `record:${l.recordType}:read`) ) continue;
      const equals: Record<string, string | number | boolean> = {};
      let matchable = true;
      for (const [theirs, ours] of Object.entries(l.match)) {
        const v = data[ours];
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') equals[theirs] = v;
        else matchable = false;
      }
      if (!matchable) continue;
      const target = loaded.loadedOf(l.recordType);
      const q = buildRecordQuery(ctx.actor, l.recordType, target, { equals, limit: l.limit ?? DEFAULT_LOOKUP_LIMIT, withTotal: false }, MAX_LOOKUP_LIMIT);
      const rows = await this.queries.rows(tx, q);
      out[l.name] = rows.map((r) => pick(this.view(ctx, target.type.body, this.opened(target.type.body, r)), l.fields));
    }
    if (def.inputs?.settings?.length) {
      const all = (await this.store.scriptSettings(tx)) as unknown as Record<string, unknown>;
      out.settings = Object.fromEntries(def.inputs.settings.map((k) => [k, all[k] ?? null]));
    }
    if (def.inputs?.balances) {
      out.balances = await this.store.ledgerBalances(tx, def.inputs.balances.accounts ?? [], def.inputs.balances.funds ?? [], asOf);
    }
    return out;
  }

  /**
   * Unique values and format rules, checked only when a value changes so
   * records saved before a rule was added stay editable.
   */
  private async checkUniqueAndPatterns(
    tx: Tx,
    type: RecordTypeDef,
    data: Record<string, unknown>,
    previous: Record<string, unknown> | null,
    recordId: string | null,
  ): Promise<FieldIssue[]> {
    return uniqueAndPatternIssues(this.uniqueLookup(), tx, type, data, previous, recordId);
  }

  private uniqueLookup() {
    return { store: this.store, queries: this.queries, sensitive: this.sensitive };
  }

  private async linkFiles(tx: Tx, ctx: TenantContext, type: RecordTypeDef, recordId: string, data: Record<string, unknown>): Promise<void> {
    return linkRecordFiles(this.store, tx, ctx, type, recordId, data);
  }

  // -------------------------------------------------------------- helpers

  private async load(tenantId: string, typeKey: string): Promise<Loaded> {
    return (await this.loadAll(tenantId))(typeKey);
  }

  /**
   * Reads every definition a save needs up front, for whichever record type
   * it turns out to be, so no definition lookups happen inside the save transaction.
   */
  private async loadAll(tenantId: string): Promise<LoadedOf> {
    const [types, allWorkflows, posting, receipt, scripts] = [
      await this.defs.list(tenantId, 'recordType'),
      await this.defs.list(tenantId, 'workflow'),
      await this.defs.list(tenantId, 'postingRule'),
      await this.defs.list(tenantId, 'receiptRule'),
      await this.defs.list(tenantId, 'script'),
    ];
    const callsConnectors = scripts.some((s) => s.body.enabled !== false && s.body.effects?.connectors?.length);
    const connectors: ReadonlyMap<string, ConnectorFact> = callsConnectors && this.defs.connectors ? await this.defs.connectors(tenantId) : new Map();
    const loadedOf = (typeKey: string): Loaded => {
      const type = types.find((t) => t.key === typeKey);
      if (!type) throw notFound(`Unknown record type '${typeKey}'.`);
      const workflows = workflowsOf(allWorkflows, typeKey, (w) => w.body);
      const own = scripts.filter((s) => s.body.recordType === typeKey && s.body.enabled !== false);
      const onHook = (hook: ScriptDef['hook']) =>
        own.filter((s) => s.body.hook === hook).sort((a, b) => (a.body.order ?? 0) - (b.body.order ?? 0) || a.key.localeCompare(b.key));
      return {
        type,
        workflow: workflows.find((w) => isPrimary(w.body)),
        workflows,
        postingRules: posting.map((d) => d.body).filter((r) => r.recordType === typeKey),
        receiptRules: receipt.map((d) => d.body).filter((r) => r.recordType === typeKey),
        rollupParents: types.flatMap((t) => t.body.fields.filter((f) => f.rollup?.recordType === typeKey).map((field) => ({ type: t.body, field }))),
        beforeSave: onHook('beforeSave'),
        validateScripts: onHook('validate'),
        afterSave: onHook('afterSave'),
        workflowGuard: onHook('workflowGuard'),
        buttonScript: (key) => own.find((s) => s.key === key && s.body.hook === 'customButton'),
        typeOf: (key) => types.find((t) => t.key === key)?.body,
        connectors,
        loadedOf,
      };
    };
    return Object.assign(loadedOf, { lookups: types.some((t) => !!t.body.lookups?.length) });
  }

  /** The first primary workflow whose appliesWhen matches the new record, else the default one. */
  private choosePrimary(ctx: TenantContext, loaded: Loaded, input: Record<string, unknown>): WorkflowDef | undefined {
    const primaries = loaded.workflows.filter((w) => isPrimary(w.body)).map((w) => w.body);
    if (!primaries.length) return undefined;
    const created = scope(ctx, normaliseData(input), null, null);
    const chosen = primaries.find((w) => w.appliesWhen !== undefined && evalTest(w.appliesWhen, created, `workflow ${w.key}`));
    const fallback = chosen ?? primaries.find((w) => w.appliesWhen === undefined);
    if (!fallback) throw ruleViolation('None of the workflows applies to this record. Check its details and try again.');
    return fallback;
  }

  /**
   * Restricted record types: people see records they created, records shared
   * with them or one of their roles, or every record with read:all. Approvers
   * may read the record they are asked to decide. Editing needs an edit share.
   * Records someone may not see are reported as not found.
   */
  private async assertVisible(tx: Tx, ctx: TenantContext, loaded: Loaded, row: RecordRow, mode: 'read' | 'edit'): Promise<void> {
    const type = loaded.type.body;
    if (type.visibility !== 'restricted') return;
    if (row.created_by === ctx.actor.id || row.owner_id === ctx.actor.id || can(ctx.actor, `record:${type.key}:read:all`)) return;
    const access = await this.store.shareAccess(tx, row.id, ctx.actor);
    if (access && (mode === 'read' || access === 'edit')) return;
    if (mode === 'read' && (await this.isApproverOf(tx, ctx, loaded, row.id))) return;
    throw notFound('Record not found.');
  }

  private async isApproverOf(tx: Tx, ctx: TenantContext, loaded: Loaded, recordId: string): Promise<boolean> {
    const pending = await this.store.pendingApprovalSteps(tx, recordId);
    const workflows = loaded.workflows.map((w) => w.body);
    return pending.some((step) => {
      const approval: ApprovalDef | undefined = findStep(workflows, step)?.step.approval;
      return !!approval && isApprover(ctx.actor, approval);
    });
  }

  /** Recomputes the rollups of one page of records of a type, in id order; for the rollup.rebuild job. */
  async rebuildRollups(tenantId: string, typeKey: string, afterId: string | null, limit: number): Promise<{ lastId: string | null; count: number }> {
    const loaded = await this.load(tenantId, typeKey);
    const fields = loaded.type.body.fields.filter((f) => f.rollup);
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await this.store.page(tx, typeKey, afterId, limit);
      for (const row of rows) {
        const values: Record<string, number> = {};
        for (const f of fields) values[f.key] = await rollupValue(this.store, tx, f, row.id, this.childData(loaded, f));
        if (fields.length) await this.store.mergeData(tx, row.id, values);
      }
      return { lastId: rows.at(-1)?.id ?? null, count: rows.length };
    });
  }

  /** The rollup's child records as read, their sensitive values decrypted. */
  private childData(loaded: Loaded, f: FieldDef) {
    return (data: Record<string, unknown>) => this.sensitive.open(loaded.typeOf(f.rollup!.recordType), data);
  }

  /** Recomputes the rollups of the given records, whatever their types; for saves that deferred them. */
  async recomputeRollups(tenantId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const rows = await this.db.withTenant(tenantId, (tx) => this.store.typesOf(tx, ids));
    const loadedOf = new Map<string, Loaded>();
    for (const key of new Set(rows.map((r) => r.type_key))) loadedOf.set(key, await this.load(tenantId, key));
    await this.db.withTenant(tenantId, async (tx) => {
      for (const row of rows) {
        const loaded = loadedOf.get(row.type_key)!;
        const fields = loaded.type.body.fields.filter((f) => f.rollup);
        if (!fields.length) continue;
        const values: Record<string, number> = {};
        for (const f of fields) values[f.key] = await rollupValue(this.store, tx, f, row.id, this.childData(loaded, f));
        await this.store.mergeData(tx, row.id, values);
      }
    });
  }

  /** Refills the search text of one page of records of a type, in id order; for the search.rebuild job. */
  async rebuildSearch(tenantId: string, typeKey: string, afterId: string | null, limit: number): Promise<{ lastId: string | null; count: number }> {
    const { type } = await this.load(tenantId, typeKey);
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await this.store.page(tx, typeKey, afterId, limit);
      for (const row of rows) await this.store.setSearchText(tx, row.id, searchText(type.body, row.number, row.data));
      return { lastId: rows.at(-1)?.id ?? null, count: rows.length };
    });
  }

  /**
   * Rewrites one page of records of a type, in id order, so their sensitive
   * values are stored as the definition and the current key call for; for the
   * fields.reencrypt job. The rows are locked while they are rewritten, and
   * keep their version: the values do not change.
   */
  async reencrypt(tenantId: string, typeKey: string, afterId: string | null, limit: number): Promise<{ lastId: string | null; count: number; rewritten: number }> {
    const { type } = await this.load(tenantId, typeKey);
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await this.store.lockStoredPage(tx, typeKey, afterId, limit);
      let rewritten = 0;
      for (const row of rows) {
        const next = this.sensitive.rewrite(type.body, row.data, row.blind_index);
        if (!next) continue;
        await this.store.restore(tx, row.id, next);
        rewritten++;
      }
      return { lastId: rows.at(-1)?.id ?? null, count: rows.length, rewritten };
    });
  }

  async titleFieldOf(tenantId: string, typeKey: string): Promise<string | undefined> {
    return (await this.defs.get(tenantId, 'recordType', typeKey))?.body.titleField;
  }

  /** Posted account and fund balances up to and including `asOf`, for a report's ledger dataset. */
  async ledgerBalances(ctx: TenantContext, accounts: string[], funds: string[], asOf: string): Promise<{ accounts: Record<string, string>; funds: Record<string, string> }> {
    return this.db.withTenant(ctx.tenantId, (tx) => this.store.ledgerBalances(tx, accounts, funds, asOf));
  }

  async countOfType(tenantId: string, typeKey: string): Promise<number> {
    return this.db.withTenant(tenantId, (tx) => this.store.countOfType(tx, typeKey));
  }

  private async current(tx: Tx, id: string): Promise<RecordRow> {
    const row = await this.store.get(tx, id);
    if (!row) throw notFound('Record not found.');
    return row;
  }

  private opened(type: RecordTypeDef, row: RecordRow): RecordRow {
    const data = this.sensitive.open(type, row.data);
    return data === row.data ? row : { ...row, data };
  }

  private view(ctx: TenantContext, type: RecordTypeDef, row: RecordRow): RecordView {
    const data = maskFor(ctx.actor, type, row.data);
    return {
      id: row.id,
      type: row.type_key,
      number: row.number,
      status: row.status,
      version: row.version,
      schemaVersion: row.schema_version,
      data,
      workflow: row.workflow_key,
      states: row.workflow_state ?? {},
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ...(type.visibility === 'restricted' && (row.created_by === ctx.actor.id || can(ctx.actor, `record:${type.key}:share`)) ? { canShare: true } : {}),
    };
  }
}
