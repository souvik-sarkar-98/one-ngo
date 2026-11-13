import { createHash } from 'node:crypto';
import type { ActiveTenants, IndexCast, ManagedIndexes } from './ports/managed-indexes.js';
import type { Logger } from '@onengo/kernel/ports';
import { silentLogger } from '../../domain/silent-logger.js';
import { FILTERABLE_FIELD_TYPES } from './cross-refs.js';
import type { DefinitionService } from './definition-service.js';
import { isStoredEncrypted } from './field-permissions.js';
import type { ListViewDef, RecordTypeDef } from './types.js';

/** How a field is compared and sorted. */
const castOf = (f: { type: string }): IndexCast => (f.type === 'number' || f.type === 'money' ? 'numeric' : 'text');

export const MAX_INDEXES_PER_TYPE = 25;
const UNUSED_DAYS = 30;

export type IndexKind = 'unique' | 'reference' | 'location' | 'state' | 'filter' | 'sort';

export interface NeededIndex {
  name: string;
  typeKey: string;
  field: string;
  cast: IndexCast;
  kind: IndexKind;
}

export interface IndexPlan {
  needed: NeededIndex[];
  /** Fields that would be indexed but are over the per-record-type cap; they still work, unindexed. */
  overCap: { typeKey: string; field: string; kind: IndexKind }[];
}

/** Shared by every organisation with the same record type key, field and comparison. */
const indexName = (typeKey: string, field: string, cast: IndexCast, kind: IndexKind) =>
  `rx_${createHash('sha256').update(`${typeKey}|${field}|${cast}|${kind === 'unique' ? 'unique' : ''}`).digest('hex').slice(0, 20)}`;

/** The managed_index column keeps the stored comparison; unique text is compared lower-cased. */
const storedCast = (cast: IndexCast) => (cast === 'lower' ? 'text' : cast);

/** Indexes the published definitions need, in priority order per record type, capped. */
export function planIndexes(types: RecordTypeDef[], views: ListViewDef[], parallelStates: { typeKey: string; workflow: string }[]): IndexPlan {
  const plan: IndexPlan = { needed: [], overCap: [] };
  for (const type of types) {
    const fields = new Map(type.fields.map((f) => [f.key, f]));
    const wanted: { field: string; cast: IndexCast; kind: IndexKind }[] = [];
    for (const f of type.fields) {
      if (f.unique) wanted.push({ field: f.key, cast: isStoredEncrypted(f) ? 'hash' : f.type === 'number' ? 'numeric' : 'lower', kind: 'unique' });
    }
    for (const f of type.fields) if (f.type === 'reference' || f.type === 'person') wanted.push({ field: f.key, cast: 'text', kind: 'reference' });
    for (const f of type.fields) {
      if (f.type === 'location') wanted.push({ field: f.key, cast: 'lat', kind: 'location' }, { field: f.key, cast: 'lng', kind: 'location' });
    }
    for (const s of parallelStates) if (s.typeKey === type.key) wanted.push({ field: s.workflow, cast: 'state', kind: 'state' });
    const ofType = views.filter((v) => v.recordType === type.key);
    const usable = (key: string) => {
      const f = fields.get(key);
      return f && !f.sensitive && f.type !== 'multiChoice' && FILTERABLE_FIELD_TYPES.has(f.type) ? f : undefined;
    };
    for (const v of ofType) for (const k of v.filters ?? []) if (usable(k)) wanted.push({ field: k, cast: castOf(usable(k)!), kind: 'filter' });
    for (const v of ofType) {
      for (const k of [...(v.columns ?? []), ...(v.compactColumns ?? [])]) if (usable(k)) wanted.push({ field: k, cast: castOf(usable(k)!), kind: 'sort' });
    }

    const seen = new Set<string>();
    for (const w of wanted) {
      const id = `${w.field}|${w.cast}|${w.kind === 'unique'}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > MAX_INDEXES_PER_TYPE) plan.overCap.push({ typeKey: type.key, field: w.field, kind: w.kind });
      else plan.needed.push({ ...w, typeKey: type.key, name: indexName(type.key, w.field, w.cast, w.kind) });
    }
  }
  return plan;
}

/**
 * Creates and drops indexes on record data from the published definitions,
 * so new record types, references, filters and sorts never need a migration.
 * Indexes are built by background jobs as the owner role, never in a request.
 */
export class IndexManager {
  constructor(
    private readonly indexes: ManagedIndexes,
    private readonly tenants: ActiveTenants,
    private readonly defs: DefinitionService,
    private readonly logger: Logger = silentLogger,
  ) {}

  async plan(tenantId: string): Promise<IndexPlan> {
    const types = (await this.defs.list(tenantId, 'recordType')).map((d) => d.body);
    const views = (await this.defs.list(tenantId, 'listView')).map((d) => d.body);
    const workflows = (await this.defs.list(tenantId, 'workflow')).map((d) => d.body);
    const parallelStates = views.flatMap((v) =>
      (v.chips ?? [])
        .filter((c) => c.workflowState && workflows.some((w) => w.key === c.workflowState!.workflow && w.role === 'parallel'))
        .map((c) => ({ typeKey: v.recordType, workflow: c.workflowState!.workflow })),
    );
    return planIndexes(types, views, parallelStates);
  }

  /** Records that the organisation still needs its indexes, adding any new ones as pending. */
  async touch(tenantId: string): Promise<NeededIndex[]> {
    const { needed } = await this.plan(tenantId);
    await this.indexes.markNeeded(needed.map((ix) => ({ name: ix.name, type_key: ix.typeKey, field: ix.field, cast_as: storedCast(ix.cast), kind: ix.kind })));
    return needed;
  }

  /** Builds up to `limit` needed indexes that are not ready yet. Returns how many were attempted and how many remain. */
  async buildPending(tenantId: string, limit: number, skip: ReadonlySet<string> = new Set()): Promise<{ built: string[]; failed: string[]; remaining: number }> {
    const needed = await this.touch(tenantId);
    const rows = await this.indexes.states(needed.map((n) => n.name));
    const state = new Map(rows.map((r) => [r.name, r]));
    const pending = needed.filter((n) => !skip.has(n.name) && !(state.get(n.name)?.status === 'ready' && state.get(n.name)?.present));
    const out = { built: [] as string[], failed: [] as string[], remaining: Math.max(pending.length - limit, 0) };
    for (const ix of pending.slice(0, limit)) {
      try {
        await this.create(ix);
        await this.indexes.markReady(ix.name);
        out.built.push(ix.name);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        this.logger.log('WARNING', 'Could not build a managed index', { index: ix.name, typeKey: ix.typeKey, field: ix.field }, error);
        await this.indexes.runDdl(`drop index if exists ${ix.name}`).catch(() => undefined);
        await this.indexes.markFailed(ix.name, message);
        out.failed.push(ix.name);
      }
    }
    return out;
  }

  /**
   * Refreshes which indexes every active organisation needs, then drops
   * indexes no organisation has needed for 30 days.
   */
  async maintain(): Promise<{ dropped: string[] }> {
    for (const tenantId of await this.tenants.activeIds()) await this.touch(tenantId);
    const stale = await this.indexes.unneededFor(UNUSED_DAYS);
    for (const name of stale) {
      await this.exec(`drop index concurrently if exists ${name}`, `drop index if exists ${name}`);
      await this.indexes.forget(name);
    }
    return { dropped: stale };
  }

  /** For the Builder: fields still being indexed, and fields over the cap. */
  async warnings(tenantId: string, typeKey: string): Promise<{ pending: string[]; notIndexed: string[] }> {
    this.indexes.assertKey(typeKey);
    const plan = await this.plan(tenantId);
    const mine = plan.needed.filter((n) => n.typeKey === typeKey);
    const done = new Set(await this.indexes.readyAmong(mine.map((m) => m.name)));
    return {
      pending: [...new Set(mine.filter((m) => !done.has(m.name)).map((m) => m.field))],
      notIndexed: [...new Set(plan.overCap.filter((o) => o.typeKey === typeKey).map((o) => o.field))],
    };
  }

  /** The record field a managed unique index covers, from the name the database reports. */
  async uniqueField(indexName: string): Promise<string | undefined> {
    if (!/^rx_[0-9a-f]{20}$/.test(indexName)) return undefined;
    return this.indexes.uniqueField(indexName);
  }

  private async create(ix: NeededIndex): Promise<void> {
    // A concurrent build that failed leaves an invalid index behind; rebuild it.
    if (await this.indexes.isInvalid(ix.name)) await this.indexes.runDdl(`drop index if exists ${ix.name}`);
    const spec = { name: ix.name, typeKey: ix.typeKey, field: ix.field, cast: ix.cast, unique: ix.kind === 'unique' };
    await this.exec(this.indexes.createStatement(spec, true), this.indexes.createStatement(spec, false));
  }

  /** Runs the concurrent form, or the plain one where the database refuses to build concurrently. */
  private async exec(concurrent: string, plain: string): Promise<void> {
    try {
      await this.indexes.runDdl(concurrent);
    } catch (error) {
      if (!/concurrently/i.test(error instanceof Error ? error.message : '')) throw error;
      await this.indexes.runDdl(plain);
    }
  }
}
