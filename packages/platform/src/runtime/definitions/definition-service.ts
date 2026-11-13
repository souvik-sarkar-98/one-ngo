import { createHash } from 'node:crypto';
import { NAMED_RECIPIENTS_SETTING } from './settings.js';
import type { DefinitionBase } from './ports/definition-base.js';
import type { DefinitionReader } from './ports/definition-reader.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { definitionInvalid, forbidden, notFound, PlatformError, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { can, demand } from '../../domain/permissions.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import { ORGANISATION_THEME } from './appearance.js';
import { checkCrossReferences, checkWarnings, type DefinitionLookup } from './cross-refs.js';
import { applyExtensionPatch, makePatch } from './merge.js';
import type { ConnectorFact, DefinitionRow, DefinitionStore, ModuleState } from './ports/definition-store.js';
import type { SchemaRegistry } from './schema-registry.js';
import { adminOnlyParts, isFinanceScript, SCRIPT_ADMIN_PERMISSION } from './script-inputs.js';
import { isPrimary, workflowsOf } from './workflows.js';
import type {
  DefinitionBodies,
  DefinitionKind,
  ModuleManifest,
  PublishedDefinition,
  RecordTypeDef,
  ScriptDef,
  ReportDef,
  TemplateDef,
  ThemeDef,
  WorkflowDef,
} from './types.js';

interface Snapshot {
  configVersion: number;
  checkedAt: number;
  defs: Map<string, PublishedDefinition>;
}

export interface CatalogueItem {
  kind: DefinitionKind;
  key: string;
  label: string | null;
  publishedVersion: number | null;
  draftVersion: number | null;
  owner: 'base' | 'tenant';
  moduleKey: string | null;
}

export interface DefinitionServiceOptions {
  /** How long a cached tenant snapshot is trusted before re-checking config_version. */
  cacheCheckMs?: number;
}

const id = (kind: string, key: string) => `${kind}|${key}`;

/** Base-layer definitions every organisation has without enabling a module. */
export const PLATFORM_MODULE = 'platform';

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const checksum = (body: unknown) => createHash('sha256').update(stableStringify(body)).digest('hex');

function toPublished(row: DefinitionRow): PublishedDefinition {
  return {
    kind: row.kind,
    key: row.key,
    version: row.version,
    baseVersion: row.base_version,
    owner: row.base_version === null ? 'tenant' : 'base',
    body: row.body as DefinitionBodies[DefinitionKind],
  };
}

function requiredPermission(kind: DefinitionKind): string {
  return kind === 'script' ? 'config:script:publish' : 'config:publish';
}

/** Only organisation administrators publish a report that reads the ledger or runs a shape script. */
function assertReportPublisher(ctx: TenantContext, def: ReportDef): void {
  const sensitive = def.datasets.some((d) => d.source === 'ledger') || (!!def.shape && 'script' in def.shape);
  if (sensitive && !can(ctx.actor, SCRIPT_ADMIN_PERMISSION)) {
    throw forbidden('Only an organisation administrator can publish a report that reads the ledger or runs a custom step.');
  }
}
function assertScriptPublisher(ctx: TenantContext, def: ScriptDef): void {
  const parts = adminOnlyParts(def);
  if (parts.length && !can(ctx.actor, SCRIPT_ADMIN_PERMISSION)) {
    const what = parts.includes('runAs') ? 'runs as a role' : parts.includes('balances') ? 'reads ledger balances' : 'shapes a report';
    throw forbidden(`Only an organisation administrator can publish a script that ${what}.`);
  }
}

/** The organisation administrator role, whose holders hear about every finance-script publish and rollback. */
export const FINANCE_SCRIPT_RECIPIENT_ROLE = 'admin';

/**
 * A finance-script publish or rollback writes `script.published.finance`
 * with the versions, the author and what changed in its effects and code,
 * and queues the event that notifies the organisation administrators, in the
 * publishing transaction. Other scripts write nothing more.
 */
async function financeScriptAudit(
  audit: AuditTrail,
  tx: Tx,
  ctx: TenantContext,
  lookup: DefinitionLookup,
  def: ScriptDef,
  version: number,
  previous: PublishedDefinition<'script'> | undefined,
  action: 'published' | 'rolled_back',
  fromVersion?: number,
): Promise<void> {
  const rules = [...lookup.all('postingRule'), ...lookup.all('receiptRule')].some((r) => r.recordType === def.recordType);
  if (!isFinanceScript(def, lookup.recordType(def.recordType), rules)) return;
  const was = previous?.body;
  const changed = {
    effects: stableStringify(was?.effects ?? null) !== stableStringify(def.effects ?? null),
    code: was?.code !== def.code,
    runAs: (was?.runAs ?? null) !== (def.runAs ?? null),
  };
  await audit.audit(tx, {
    actorId: ctx.actor.id,
    action: 'script.published.finance',
    entity: 'definition:script',
    entityId: def.key,
    before: was ? { version: previous!.version, effects: was.effects ?? null, code: was.code, runAs: was.runAs ?? null } : null,
    after: {
      action,
      version,
      previousVersion: previous?.version ?? null,
      ...(fromVersion !== undefined ? { fromVersion } : {}),
      author: ctx.actor.id,
      changed,
      effects: def.effects ?? null,
      code: def.code,
      runAs: def.runAs ?? null,
    },
  });
  await audit.event(tx, 'script.published.finance', {
    key: def.key,
    label: def.label ?? def.key,
    recordType: def.recordType,
    action,
    version,
    previousVersion: previous?.version ?? null,
    author: ctx.actor.id,
    roles: [FINANCE_SCRIPT_RECIPIENT_ROLE],
  });
}

export type { DefinitionReader };

export class DefinitionService {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly cacheCheckMs: number;

  constructor(
    private readonly tm: TransactionManager,
    private readonly store: DefinitionStore,
    private readonly schemas: SchemaRegistry,
    private readonly base: DefinitionBase,
    private readonly audit: AuditTrail,
    options: DefinitionServiceOptions = {},
  ) {
    this.cacheCheckMs = options.cacheCheckMs ?? 3000;
  }

  // ---------------------------------------------------------------- reads

  async get<K extends DefinitionKind>(tenantId: string, kind: K, key: string): Promise<PublishedDefinition<K> | undefined> {
    const snap = await this.snapshot(tenantId);
    return snap.defs.get(id(kind, key)) as PublishedDefinition<K> | undefined;
  }

  async list<K extends DefinitionKind>(tenantId: string, kind: K): Promise<PublishedDefinition<K>[]> {
    const snap = await this.snapshot(tenantId);
    return [...snap.defs.values()].filter((d) => d.kind === kind) as PublishedDefinition<K>[];
  }

  /**
   * The organisation's published definitions as they are now, read without
   * touching the database again. For work that runs inside one transaction,
   * where a fresh definition lookup would need a second connection.
   */
  async pinned(tenantId: string): Promise<DefinitionReader> {
    const snap = await this.snapshot(tenantId);
    const connectors = await this.connectors(tenantId);
    const all = [...snap.defs.values()];
    const list = async <K extends DefinitionKind>(_t: string, kind: K) => all.filter((d) => d.kind === kind) as PublishedDefinition<K>[];
    const workflowsFor = async (_t: string, recordType: string) => workflowsOf(await list(tenantId, 'workflow'), recordType, (w) => w.body);
    return {
      get: async <K extends DefinitionKind>(_t: string, kind: K, key: string) => snap.defs.get(id(kind, key)) as PublishedDefinition<K> | undefined,
      list,
      workflowsFor,
      workflowFor: async (_t: string, recordType: string) => (await workflowsFor(tenantId, recordType)).find((w) => isPrimary(w.body)),
      connectors: async () => connectors,
    };
  }

  /** Webhook and http connectors by key, read each time: saving a connector does not change the definitions snapshot. */
  async connectors(tenantId: string): Promise<ReadonlyMap<string, ConnectorFact>> {
    const facts = await this.tm.withTenant(tenantId, (tx) => this.store.connectorFacts(tx), { readOnly: true });
    return new Map((facts ?? []).map((c) => [c.key, c]));
  }

  /** The record type's first primary workflow. */
  async workflowFor(tenantId: string, recordType: string): Promise<PublishedDefinition<'workflow'> | undefined> {
    return (await this.workflowsFor(tenantId, recordType)).find((w) => isPrimary(w.body));
  }

  /** Every workflow of the record type, primary ones first. */
  async workflowsFor(tenantId: string, recordType: string): Promise<PublishedDefinition<'workflow'>[]> {
    return workflowsOf(await this.list(tenantId, 'workflow'), recordType, (w) => w.body);
  }

  async getVersion<K extends DefinitionKind>(
    tenantId: string,
    kind: K,
    key: string,
    version: number,
  ): Promise<PublishedDefinition<K> | undefined> {
    const row = await this.tm.withTenant(tenantId, (tx) => this.store.version(tx, kind, key, version));
    return row ? (toPublished(row) as PublishedDefinition<K>) : undefined;
  }

  async history(tenantId: string, kind: DefinitionKind, key: string) {
    return this.tm.withTenant(tenantId, (tx) => this.store.history(tx, kind, key));
  }

  // ------------------------------------------------------------- builder

  /** Everything the builder lists: published definitions and open drafts, with their origin. */
  async catalogue(ctx: TenantContext): Promise<CatalogueItem[]> {
    demand(ctx.actor, 'config:read');
    const rows = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.catalogue(tx));
    const byKey = new Map<string, CatalogueItem>();
    const out: CatalogueItem[] = [];
    for (const r of rows) {
      const k = id(r.kind, r.key);
      let item = byKey.get(k);
      if (!item) {
        item = { kind: r.kind, key: r.key, publishedVersion: null, draftVersion: null, owner: 'tenant', moduleKey: r.module_key, label: r.label };
        byKey.set(k, item);
        out.push(item);
      }
      if (r.status === 'published') {
        item.publishedVersion = r.version;
        item.owner = r.base_version === null ? 'tenant' : 'base';
        item.label = r.label ?? item.label;
      } else item.draftVersion = r.version;
    }
    return out;
  }

  async getDraft<K extends DefinitionKind>(ctx: TenantContext, kind: K, key: string): Promise<{ version: number; body: DefinitionBodies[K] } | undefined> {
    demand(ctx.actor, 'config:read');
    const row = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.draft(tx, kind, key));
    return row && { version: row.version, body: row.body as DefinitionBodies[K] };
  }

  async discardDraft(ctx: TenantContext, kind: DefinitionKind, key: string): Promise<void> {
    demand(ctx.actor, requiredPermission(kind));
    const discarded = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.discardDraft(tx, kind, key));
    if (!discarded) throw notFound(`No draft for ${kind} '${key}'.`);
  }

  /** The shipped base body and the NGO's patch, for editing a shipped definition. */
  async baseAndPatch<K extends DefinitionKind>(
    ctx: TenantContext,
    kind: K,
    key: string,
  ): Promise<{ baseVersion: number; base: DefinitionBodies[K]; patch: unknown | null } | undefined> {
    demand(ctx.actor, 'config:read');
    return this.tm.withTenant(ctx.tenantId, async (tx) => {
      const base = await this.store.base(tx, kind, key);
      if (!base) return undefined;
      const p = await this.store.patch(tx, kind, key);
      return { baseVersion: base.version, base: base.body as DefinitionBodies[K], patch: p?.patch ?? null };
    });
  }

  /**
   * The problems publishing `body` would hit, and the warnings the Builder shows,
   * without saving or throwing. `alongside` are checked as if published with it.
   */
  async check<K extends DefinitionKind>(
    ctx: TenantContext,
    kind: K,
    body: unknown,
    alongside: { kind: DefinitionKind; body: DefinitionBodies[DefinitionKind] }[] = [],
  ): Promise<{ errors: FieldIssue[]; warnings: FieldIssue[] }> {
    demand(ctx.actor, 'config:read');
    const errors = this.schemas.validate(kind, body);
    if (errors.length) return { errors, warnings: [] };
    const def = body as DefinitionBodies[K];
    return this.tm.withTenant(ctx.tenantId, async (tx) => {
      const lookup = await this.lookup(tx, [...alongside, { kind, body: def }]);
      return { errors: checkCrossReferences(kind, def, lookup), warnings: checkWarnings(kind, def, lookup) };
    });
  }

  // ------------------------------------------------- tenant-owned definitions

  async saveDraft<K extends DefinitionKind>(ctx: TenantContext, kind: K, body: DefinitionBodies[K]): Promise<number> {
    demand(ctx.actor, requiredPermission(kind));
    this.assertSchema(kind, body);
    const key = body.key;
    const version = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      await this.assertNotBase(tx, kind, key);
      const sum = checksum(body);
      const existing = await this.store.draftVersion(tx, kind, key);
      if (existing) {
        await this.store.replaceDraft(tx, kind, key, existing.version, body, sum, ctx.actor.id);
        return existing.version;
      }
      const next = await this.store.nextVersion(tx, kind, key);
      await this.store.addDraft(tx, kind, key, next, body, sum, ctx.actor.id);
      return next;
    });
    return version;
  }

  async publish<K extends DefinitionKind>(ctx: TenantContext, kind: K, key: string): Promise<PublishedDefinition<K>> {
    demand(ctx.actor, requiredPermission(kind));
    const previous = kind === 'script' ? await this.get(ctx.tenantId, 'script', key) : undefined;
    const result = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const draft = await this.store.draft(tx, kind, key);
      if (!draft) throw notFound(`No draft for ${kind} '${key}'.`);
      this.assertSchema(kind, draft.body);
      if (kind === 'script') assertScriptPublisher(ctx, draft.body as ScriptDef);
      if (kind === 'report') assertReportPublisher(ctx, draft.body as ReportDef);
      const lookup = await this.lookup(tx, [{ kind, body: draft.body as DefinitionBodies[K] }]);
      this.assertCrossRefs(kind, draft.body as DefinitionBodies[K], lookup);
      await this.store.supersede(tx, kind, key);
      await this.store.publishDraft(tx, kind, key, draft.version, ctx.actor.id);
      await this.store.bumpConfigVersion(tx);
      await this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: 'definition.published',
        entity: `definition:${kind}`,
        entityId: key,
        after: { version: draft.version, checksum: draft.checksum },
      });
      await this.audit.event(tx, 'definition.published', { kind, key, version: draft.version });
      if (kind === 'script') await financeScriptAudit(this.audit, tx, ctx, lookup, draft.body as ScriptDef, draft.version, previous, 'published');
      return toPublished({ ...draft, status: 'published' }) as PublishedDefinition<K>;
    });
    this.snapshots.delete(ctx.tenantId);
    return result;
  }

  /**
   * Publishes the organisation theme in one step, replacing an open draft of the same key.
   * The caller has Manage organisation settings, or may publish definitions.
   */
  async publishTheme(ctx: TenantContext, body: ThemeDef): Promise<PublishedDefinition<'theme'>> {
    if (!can(ctx.actor, 'admin:settings') && !can(ctx.actor, 'config:publish')) demand(ctx.actor, 'admin:settings');
    if (body.key !== ORGANISATION_THEME) throw validationFailed('The organisation theme is named organisation.', [{ path: 'key', message: 'Use organisation.' }]);
    this.assertSchema('theme', body);
    const result = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      await this.assertNotBase(tx, 'theme', body.key);
      if (await this.store.draftVersion(tx, 'theme', body.key)) await this.store.discardDraft(tx, 'theme', body.key);
      const lookup = await this.lookup(tx, [{ kind: 'theme', body }]);
      this.assertCrossRefs('theme', body, lookup);
      const published = (await this.insertPublished(tx, ctx.actor.id, 'theme', body.key, body, null, null)) as PublishedDefinition<'theme'>;
      await this.store.bumpConfigVersion(tx);
      await this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: 'definition.published',
        entity: 'definition:theme',
        entityId: body.key,
        after: { version: published.version },
      });
      return published;
    });
    this.snapshots.delete(ctx.tenantId);
    return result;
  }

  /**
   * Republishes an earlier version of a definition the organisation published as the
   * newest version. A version of a shipped definition comes back as the patch that
   * turns the module's current version into that version, so later module changes stay.
   */
  async rollback<K extends DefinitionKind>(
    ctx: TenantContext,
    kind: K,
    key: string,
    toVersion: number,
  ): Promise<PublishedDefinition<K>> {
    demand(ctx.actor, requiredPermission(kind));
    const previous = kind === 'script' ? await this.get(ctx.tenantId, 'script', key) : undefined;
    const result = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const old = await this.store.ownVersion(tx, kind, key, toVersion);
      if (!old) throw notFound(`Version ${toVersion} of ${kind} '${key}' does not exist.`);
      if (kind === 'script') assertScriptPublisher(ctx, old.body as ScriptDef);
      const base = old.base_version === null ? undefined : await this.store.base(tx, kind, key);
      if (old.base_version !== null && !base) {
        throw definitionInvalid('Shipped definitions are changed through extension patches, not rollback.');
      }
      let body = old.body;
      let patch: unknown;
      if (base) {
        await this.assertModuleEnabled(tx, base.module_key);
        patch = makePatch(base.body, old.body) ?? {};
        body = applyExtensionPatch(base.body, patch);
        this.assertSchema(kind, body as DefinitionBodies[K]);
      }
      if (kind === 'script') assertScriptPublisher(ctx, body as ScriptDef);
      if (kind === 'report') assertReportPublisher(ctx, body as ReportDef);
      const lookup = await this.lookup(tx, [{ kind, body: body as DefinitionBodies[K] }]);
      this.assertCrossRefs(kind, body as DefinitionBodies[K], lookup);
      if (base) await this.store.savePatch(tx, kind, key, patch, ctx.actor.id);
      const published = await this.insertPublished(tx, ctx.actor.id, kind, key, body, base?.version ?? null, base?.module_key ?? old.module_key);
      await this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: 'definition.rolled_back',
        entity: `definition:${kind}`,
        entityId: key,
        after: { fromVersion: toVersion, version: published.version, ...(base ? { baseVersion: base.version, patch } : {}) },
      });
      if (kind === 'script') await financeScriptAudit(this.audit, tx, ctx, lookup, body as ScriptDef, published.version, previous, 'rolled_back', toVersion);
      return published as PublishedDefinition<K>;
    });
    this.snapshots.delete(ctx.tenantId);
    return result;
  }

  // ---------------------------------------- extension patches on base layers

  private async assertModuleEnabled(tx: Tx, moduleKey: string | null): Promise<void> {
    if (moduleKey === PLATFORM_MODULE) return;
    if (!(await this.store.moduleEnabled(tx, moduleKey))) throw definitionInvalid(`Enable module '${moduleKey}' before changing its definitions.`);
  }

  async setExtensionPatch<K extends DefinitionKind>(
    ctx: TenantContext,
    kind: K,
    key: string,
    patch: unknown,
  ): Promise<PublishedDefinition<K>> {
    demand(ctx.actor, requiredPermission(kind));
    const result = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const base = await this.store.base(tx, kind, key);
      if (!base) throw notFound(`${kind} '${key}' is not a shipped definition.`);
      await this.assertModuleEnabled(tx, base.module_key);
      const merged = applyExtensionPatch(base.body, patch) as DefinitionBodies[K];
      if ((merged as { key: string }).key !== key) throw definitionInvalid('A patch cannot change the definition key.');
      this.assertSchema(kind, merged);
      const lookup = await this.lookup(tx, [{ kind, body: merged }]);
      this.assertCrossRefs(kind, merged, lookup);
      await this.store.savePatch(tx, kind, key, patch, ctx.actor.id);
      const published = await this.insertPublished(tx, ctx.actor.id, kind, key, merged, base.version, base.module_key);
      await this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: 'definition.patched',
        entity: `definition:${kind}`,
        entityId: key,
        after: { version: published.version, baseVersion: base.version, patch },
      });
      return published as PublishedDefinition<K>;
    });
    this.snapshots.delete(ctx.tenantId);
    return result;
  }

  // ------------------------------------------------------------ base layer

  /** Publishes a product-shipped definition. Returns the base version, unchanged if identical. */
  async publishBase<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K], moduleKey: string): Promise<number> {
    this.assertSchema(kind, body);
    return this.base.publish(kind, body.key, moduleKey, body, checksum(body));
  }

  /** The module's definitions whose published base differs from the given bodies (or is missing), as `kind|key`. */
  async unpublishedBase(moduleKey: string, definitions: { kind: DefinitionKind; body: { key: string } }[]): Promise<string[]> {
    const rows = await this.base.publishedChecksums(moduleKey);
    const published = new Map(rows.map((r) => [id(r.kind, r.key), r.checksum]));
    return definitions.filter((d) => published.get(id(d.kind, d.body.key)) !== checksum(d.body)).map((d) => id(d.kind, d.body.key));
  }

  /**
   * After a product upgrade changed a platform definition, re-applies each
   * organisation's patch to the new base. Organisations whose patch no longer
   * fits, or that have an open draft, keep their current version; their keys are returned.
   */
  async resyncPlatform(): Promise<string[]> {
    const stale = (await this.base.organisationsBehind(PLATFORM_MODULE)) as { tenant_id: string; kind: DefinitionKind; key: string }[];
    const kept: string[] = [];
    for (const s of stale) {
      try {
        await this.tm.withTenant(s.tenant_id, async (tx) => {
          const base = (await this.store.base(tx, s.kind, s.key))!;
          const p = await this.store.patch(tx, s.kind, s.key);
          const body = p ? applyExtensionPatch(base.body, p.patch) : base.body;
          this.assertSchema(s.kind, body);
          await this.insertPublished(tx, 'system', s.kind, s.key, body, base.version, PLATFORM_MODULE);
          await this.store.bumpConfigVersion(tx);
        });
      } catch (e) {
        if (!(e instanceof PlatformError)) throw e;
        kept.push(`${s.tenant_id}:${id(s.kind, s.key)}`);
      }
      this.snapshots.delete(s.tenant_id);
    }
    return kept;
  }

  /**
   * Enables a module for a tenant, or re-syncs it after a product upgrade:
   * applies setup data and materialises every base definition of the module
   * with the tenant's extension patch. All-or-nothing.
   */
  async enableModule(ctx: TenantContext, manifest: ModuleManifest): Promise<{ materialised: string[] }> {
    demand(ctx.actor, 'config:modules');
    const result = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      await this.store.installModule(tx, manifest);

      const bases = await this.store.moduleBases(tx, manifest.key);
      const patches = new Map((await this.store.patches(tx)).map((p) => [id(p.kind, p.key), p.patch]));
      const effective = bases.map((b) => {
        const patch = patches.get(id(b.kind, b.key));
        const body = patch === undefined ? b.body : applyExtensionPatch(b.body, patch);
        return { base: b, body: body as DefinitionBodies[DefinitionKind] };
      });

      const issues: FieldIssue[] = [];
      const lookup = await this.lookup(
        tx,
        effective.map((e) => ({ kind: e.base.kind, body: e.body })),
      );
      for (const e of effective) {
        for (const i of this.schemas.validate(e.base.kind, e.body)) issues.push({ ...i, path: `${e.base.kind}:${e.base.key}${i.path}` });
        for (const i of checkCrossReferences(e.base.kind, e.body, lookup)) issues.push({ ...i, path: `${e.base.kind}:${e.base.key}${i.path}` });
      }
      if (issues.length) throw definitionInvalid(`Module '${manifest.key}' cannot be enabled.`, issues);

      const materialised: string[] = [];
      for (const e of effective) {
        const current = await this.store.publishedState(tx, e.base.kind, e.base.key);
        if (current && current.base_version === null) {
          throw definitionInvalid(`The NGO already has its own ${e.base.kind} '${e.base.key}'.`);
        }
        if (current && current.base_version === e.base.version && current.checksum === checksum(e.body)) continue;
        await this.insertPublished(tx, ctx.actor.id, e.base.kind, e.base.key, e.body, e.base.version, manifest.key);
        materialised.push(id(e.base.kind, e.base.key));
      }
      await this.store.bumpConfigVersion(tx);
      await this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: 'module.enabled',
        entity: 'module',
        entityId: manifest.key,
        after: { version: manifest.version, materialised },
      });
      return { materialised };
    });
    this.snapshots.delete(ctx.tenantId);
    return result;
  }

  /**
   * Turns a module off: its definitions stop being published for the tenant.
   * Records, setup data and extension patches stay, so turning it on again
   * brings everything back.
   */
  async disableModule(ctx: TenantContext, moduleKey: string): Promise<{ removed: string[] }> {
    demand(ctx.actor, 'config:modules');
    const result = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      if (!(await this.store.moduleEnabled(tx, moduleKey))) throw notFound(`Module '${moduleKey}' is not turned on.`);
      const rows = await this.store.turnOffModule(tx, moduleKey);
      await this.store.bumpConfigVersion(tx);
      const removed = rows.map((r) => id(r.kind, r.key));
      await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'module.disabled', entity: 'module', entityId: moduleKey, after: { removed } });
      return { removed };
    });
    this.snapshots.delete(ctx.tenantId);
    return result;
  }

  /** The organisation's installed modules, by key. No permission check: callers make their own. */
  async moduleStates(tenantId: string): Promise<ModuleState[]> {
    return this.tm.withTenant(tenantId, (tx) => this.store.modules(tx));
  }

  /** The organisation's published definitions that came from the module. No permission check: callers make their own. */
  async moduleDefinitions(tenantId: string, moduleKey: string): Promise<{ kind: DefinitionKind; key: string; base_version: number | null }[]> {
    return this.tm.withTenant(tenantId, (tx) => this.store.moduleDefinitions(tx, moduleKey));
  }

  /**
   * What reviewing a module update reads in one transaction: the organisation's
   * definitions from the module, every base version of the module, and the
   * organisation's extension patches. No permission check: callers make their own.
   */
  async moduleUpdateState(tenantId: string, moduleKey: string) {
    return this.tm.withTenant(tenantId, async (tx) => ({
      current: await this.store.moduleDefinitions(tx, moduleKey),
      bases: await this.store.moduleBaseVersions(tx, moduleKey),
      patches: await this.store.patches(tx),
    }));
  }

  // -------------------------------------------------------------- internals

  private assertSchema(kind: DefinitionKind, body: unknown): void {
    const issues = this.schemas.validate(kind, body);
    if (issues.length) throw definitionInvalid(`The ${kind} definition is not valid.`, issues);
  }

  private assertCrossRefs<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K], lookup: DefinitionLookup): void {
    const issues = checkCrossReferences(kind, body, lookup);
    if (issues.length) throw definitionInvalid(`The ${kind} definition refers to things that do not exist.`, issues);
  }

  private async assertNotBase(tx: Tx, kind: DefinitionKind, key: string): Promise<void> {
    const base = await this.store.base(tx, kind, key);
    if (base) throw forbidden(`'${key}' is a shipped ${kind}. Change it with an extension patch.`);
  }

  private async insertPublished(
    tx: Tx,
    actorId: string,
    kind: DefinitionKind,
    key: string,
    body: unknown,
    baseVersion: number | null,
    moduleKey: string | null,
  ): Promise<PublishedDefinition> {
    if (await this.store.draftVersion(tx, kind, key)) {
      throw definitionInvalid(`${kind} '${key}' has an unpublished draft. Publish or discard it first.`);
    }
    const version = await this.store.nextVersion(tx, kind, key);
    await this.store.supersede(tx, kind, key);
    await this.store.addPublished(tx, { actorId, kind, key, version, baseVersion, moduleKey, body, checksum: checksum(body) });
    await this.audit.event(tx, 'definition.published', { kind, key, version });
    return { kind, key, version, baseVersion, owner: baseVersion === null ? 'tenant' : 'base', body: body as never };
  }

  private async lookup(
    tx: Tx,
    pending: { kind: DefinitionKind; body: DefinitionBodies[DefinitionKind] }[],
  ): Promise<DefinitionLookup> {
    const rows = await this.store.published(tx);
    const defs = new Map<string, unknown>(rows.map((r) => [id(r.kind, r.key), r.body]));
    for (const p of pending) defs.set(id(p.kind, p.body.key), p.body);
    const workflows = [...defs.entries()].filter(([k]) => k.startsWith('workflow|')).map(([, v]) => v as WorkflowDef);
    const facts = await this.store.referenceFacts(tx, NAMED_RECIPIENTS_SETTING);
    return {
      recordType: (key) => defs.get(id('recordType', key)) as RecordTypeDef | undefined,
      template: (key) => defs.get(id('template', key)) as TemplateDef | undefined,
      workflowFor: (recordType) => workflowsOf(workflows, recordType, (w) => w).find(isPrimary),
      workflowsFor: (recordType) => workflowsOf(workflows, recordType, (w) => w),
      definition: (kind, key) => defs.get(id(kind, key)) as never,
      all: (kind) => [...defs.entries()].filter(([k]) => k.startsWith(`${kind}|`)).map(([, v]) => v) as never,
      accountCodes: new Set(facts.accountCodes),
      receiptSeries: new Set(facts.receiptSeries),
      roles: new Set(facts.roles.map((r) => r.key)),
      connectors: facts.connectors && new Map(facts.connectors.map((c) => [c.key, c])),
      namedRecipients: facts.namedRecipients ? new Set(facts.namedRecipients) : null,
      rolePermissions: facts.inTenant ? facts.roles.flatMap((r) => r.permissions) : null,
    };
  }

  private async snapshot(tenantId: string): Promise<Snapshot> {
    const now = Date.now();
    const cached = this.snapshots.get(tenantId);
    if (cached && now - cached.checkedAt < this.cacheCheckMs) return cached;
    return this.tm.withTenant(tenantId, async (tx) => {
      const configVersion = await this.store.configVersion(tx);
      if (configVersion === undefined) throw notFound('Unknown organisation.');
      if (cached && cached.configVersion === configVersion) {
        cached.checkedAt = now;
        return cached;
      }
      const rows = await this.store.published(tx);
      const snap: Snapshot = {
        configVersion,
        checkedAt: now,
        defs: new Map(rows.map((r) => [id(r.kind, r.key), toPublished(r)])),
      };
      this.snapshots.set(tenantId, snap);
      return snap;
    });
  }
}
