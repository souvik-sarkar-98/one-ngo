import { sql } from 'kysely';
import type { Tx } from '../../../domain/ports/transaction.js';
import type {
  CatalogueRow,
  ConnectorFact,
  DefinitionKind,
  DefinitionRow,
  DefinitionStore,
  ModuleManifest,
  NewPublished,
  ReferenceFacts,
} from '../../../runtime/definitions/ports/definition-store.js';
import { pg } from '../tx.js';

/** Base-layer definitions every organisation has without enabling a module (metadata's PLATFORM_MODULE). */
const PLATFORM_MODULE = 'platform';

const appTenant = sql<string>`app_tenant()`;

const ROW = ['kind', 'key', 'version', 'base_version', 'module_key', 'body', 'checksum', 'status'] as const;

export class PgDefinitionStore implements DefinitionStore {
  async configVersion(tx: Tx): Promise<number | undefined> {
    const tenant = await pg(tx).selectFrom('tenant').select('config_version').where('id', '=', appTenant).executeTakeFirst();
    return tenant?.config_version;
  }

  async bumpConfigVersion(tx: Tx): Promise<void> {
    await pg(tx)
      .updateTable('tenant')
      .set((eb) => ({ config_version: eb('config_version', '+', 1) }))
      .where('id', '=', appTenant)
      .execute();
  }

  published(tx: Tx): Promise<DefinitionRow[]> {
    return pg(tx)
      .selectFrom('definition as d')
      .select([
        'kind',
        'key',
        'version',
        sql<number | null>`coalesce(base_version, case when tenant_id is null then version end)`.as('base_version'),
        'module_key',
        'body',
        'checksum',
        'status',
      ])
      .where('status', '=', 'published')
      .where((eb) =>
        eb.or([
          eb('tenant_id', '=', appTenant),
          eb.and([
            eb('tenant_id', 'is', null),
            eb('module_key', '=', PLATFORM_MODULE),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('definition as t')
                  .select(sql`1`.as('one'))
                  .where('t.tenant_id', '=', appTenant)
                  .whereRef('t.kind', '=', 'd.kind')
                  .whereRef('t.key', '=', 'd.key')
                  .where('t.status', '=', 'published'),
              ),
            ),
          ]),
        ]),
      )
      .$castTo<DefinitionRow>()
      .execute();
  }

  async version(tx: Tx, kind: DefinitionKind, key: string, version: number): Promise<DefinitionRow | undefined> {
    const rows = await pg(tx)
      .selectFrom('definition')
      .select(ROW)
      .where((eb) => eb.or([eb('tenant_id', '=', appTenant), eb.and([eb('tenant_id', 'is', null), eb('module_key', '=', PLATFORM_MODULE)])]))
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('version', '=', version)
      .where('status', '<>', 'draft')
      .orderBy('tenant_id', (ob) => ob.nullsLast())
      .limit(1)
      .$castTo<DefinitionRow>()
      .execute();
    return rows[0];
  }

  ownVersion(tx: Tx, kind: DefinitionKind, key: string, version: number): Promise<DefinitionRow | undefined> {
    return pg(tx)
      .selectFrom('definition')
      .select(ROW)
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('version', '=', version)
      .where('status', '<>', 'draft')
      .$castTo<DefinitionRow>()
      .executeTakeFirst();
  }

  history(tx: Tx, kind: DefinitionKind, key: string) {
    return pg(tx)
      .selectFrom('definition')
      .select(['version', 'status', 'base_version', 'published_at'])
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .orderBy('version')
      .execute();
  }

  catalogue(tx: Tx): Promise<CatalogueRow[]> {
    const k = pg(tx);
    return k
      .selectFrom('definition')
      .select(['kind', 'key', 'version', 'status', 'base_version', 'module_key', sql<string | null>`body ->> 'label'`.as('label')])
      .where('tenant_id', '=', appTenant)
      .where('status', 'in', ['published', 'draft'])
      .unionAll(
        k
          .selectFrom('definition as d')
          .select(['d.kind', 'd.key', 'd.version', 'd.status', sql<number | null>`d.version`.as('base_version'), 'd.module_key', sql<string | null>`d.body ->> 'label'`.as('label')])
          .where('d.tenant_id', 'is', null)
          .where('d.module_key', '=', PLATFORM_MODULE)
          .where('d.status', '=', 'published')
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('definition as t')
                  .select(sql`1`.as('one'))
                  .where('t.tenant_id', '=', appTenant)
                  .whereRef('t.kind', '=', 'd.kind')
                  .whereRef('t.key', '=', 'd.key')
                  .where('t.status', '=', 'published'),
              ),
            ),
          ),
      )
      .orderBy('kind')
      .orderBy('key')
      .$castTo<CatalogueRow>()
      .execute();
  }

  draft(tx: Tx, kind: DefinitionKind, key: string): Promise<DefinitionRow | undefined> {
    return pg(tx)
      .selectFrom('definition')
      .select(ROW)
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('status', '=', 'draft')
      .$castTo<DefinitionRow>()
      .executeTakeFirst();
  }

  draftVersion(tx: Tx, kind: DefinitionKind, key: string): Promise<{ version: number } | undefined> {
    return pg(tx)
      .selectFrom('definition')
      .select('version')
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('status', '=', 'draft')
      .executeTakeFirst();
  }

  async discardDraft(tx: Tx, kind: DefinitionKind, key: string): Promise<boolean> {
    const rows = await pg(tx)
      .updateTable('definition')
      .set({ status: 'superseded' })
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('status', '=', 'draft')
      .returning('version')
      .execute();
    return rows.length > 0;
  }

  async replaceDraft(tx: Tx, kind: DefinitionKind, key: string, version: number, body: unknown, checksum: string, actorId: string): Promise<void> {
    await pg(tx)
      .updateTable('definition')
      .set({ body: JSON.stringify(body), checksum, created_by: actorId, created_at: sql<Date>`now()` })
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('version', '=', version)
      .execute();
  }

  async addDraft(tx: Tx, kind: DefinitionKind, key: string, version: number, body: unknown, checksum: string, actorId: string): Promise<void> {
    await pg(tx)
      .insertInto('definition')
      .values({ tenant_id: appTenant, kind, key, version, status: 'draft', body: JSON.stringify(body), checksum, created_by: actorId })
      .execute();
  }

  async publishDraft(tx: Tx, kind: DefinitionKind, key: string, version: number, actorId: string): Promise<void> {
    await pg(tx)
      .updateTable('definition')
      .set({ status: 'published', published_by: actorId, published_at: sql<Date>`now()` })
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('version', '=', version)
      .execute();
  }

  async nextVersion(tx: Tx, kind: DefinitionKind, key: string): Promise<number> {
    const row = await pg(tx)
      .selectFrom('definition')
      .select(sql<number>`coalesce(max(version), 0) + 1`.as('next'))
      .where((eb) => eb.or([eb('tenant_id', '=', appTenant), eb.and([eb('tenant_id', 'is', null), eb('module_key', '=', PLATFORM_MODULE)])]))
      .where('kind', '=', kind)
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    return row.next;
  }

  async supersede(tx: Tx, kind: DefinitionKind, key: string): Promise<void> {
    await pg(tx)
      .updateTable('definition')
      .set({ status: 'superseded' })
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('status', '=', 'published')
      .execute();
  }

  async addPublished(tx: Tx, d: NewPublished): Promise<void> {
    await pg(tx)
      .insertInto('definition')
      .values({
        tenant_id: appTenant,
        module_key: d.moduleKey,
        kind: d.kind,
        key: d.key,
        version: d.version,
        base_version: d.baseVersion,
        status: 'published',
        body: JSON.stringify(d.body),
        checksum: d.checksum,
        created_by: d.actorId,
        published_by: d.actorId,
        published_at: sql<Date>`now()`,
      })
      .execute();
  }

  publishedState(tx: Tx, kind: DefinitionKind, key: string) {
    return pg(tx)
      .selectFrom('definition')
      .select(['base_version', 'checksum'])
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('status', '=', 'published')
      .executeTakeFirst();
  }

  base(tx: Tx, kind: DefinitionKind, key: string): Promise<DefinitionRow | undefined> {
    return pg(tx)
      .selectFrom('definition')
      .select(ROW)
      .where('tenant_id', 'is', null)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('status', '=', 'published')
      .$castTo<DefinitionRow>()
      .executeTakeFirst();
  }

  moduleBases(tx: Tx, moduleKey: string): Promise<DefinitionRow[]> {
    return pg(tx)
      .selectFrom('definition')
      .select(ROW)
      .where('tenant_id', 'is', null)
      .where('module_key', '=', moduleKey)
      .where('status', '=', 'published')
      .$castTo<DefinitionRow>()
      .execute();
  }

  moduleBaseVersions(tx: Tx, moduleKey: string) {
    return pg(tx)
      .selectFrom('definition')
      .select(['kind', 'key', 'version', 'body'])
      .where('tenant_id', 'is', null)
      .where('module_key', '=', moduleKey)
      .where('status', '<>', 'draft')
      .$castTo<{ kind: DefinitionKind; key: string; version: number; body: unknown }>()
      .execute();
  }

  patch(tx: Tx, kind: DefinitionKind, key: string): Promise<{ patch: unknown } | undefined> {
    return pg(tx)
      .selectFrom('extension_patch')
      .select('patch')
      .where('tenant_id', '=', appTenant)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .executeTakeFirst();
  }

  patches(tx: Tx) {
    return pg(tx)
      .selectFrom('extension_patch')
      .select(['kind', 'key', 'patch'])
      .where('tenant_id', '=', appTenant)
      .$castTo<{ kind: DefinitionKind; key: string; patch: unknown }>()
      .execute();
  }

  async savePatch(tx: Tx, kind: DefinitionKind, key: string, patch: unknown, actorId: string): Promise<void> {
    await pg(tx)
      .insertInto('extension_patch')
      .values({ tenant_id: appTenant, kind, key, patch: JSON.stringify(patch), updated_by: actorId })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'kind', 'key']).doUpdateSet((eb) => ({
          patch: eb.ref('excluded.patch'),
          updated_by: eb.ref('excluded.updated_by'),
          updated_at: sql<Date>`now()`,
        })),
      )
      .execute();
  }

  async referenceFacts(tx: Tx, namedRecipientsSetting: string): Promise<ReferenceFacts> {
    const q = pg(tx);
    const accounts = await q.selectFrom('ledger_account').select('code').where('tenant_id', '=', appTenant).execute();
    const series = await q.selectFrom('receipt_series').select('key').where('tenant_id', '=', appTenant).execute();
    const roles = await q.selectFrom('role').select(['key', 'permissions']).where('tenant_id', '=', appTenant).execute();
    const scope = await q.selectNoFrom(sql<string | null>`app_tenant()`.as('tenant')).executeTakeFirst();
    const connectors = scope?.tenant ? await this.connectorRows(tx) : null;
    const named = scope?.tenant
      ? await q.selectFrom('tenant_setting').select('value').where('tenant_id', '=', appTenant).where('key', '=', namedRecipientsSetting).executeTakeFirst()
      : null;
    const recipients = named?.value && typeof named.value === 'object' && !Array.isArray(named.value) ? Object.keys(named.value) : [];
    return {
      accountCodes: accounts.map((a) => a.code),
      receiptSeries: series.map((s) => s.key),
      roles,
      inTenant: !!scope?.tenant,
      connectors,
      namedRecipients: scope?.tenant ? recipients : null,
    };
  }

  async connectorFacts(tx: Tx): Promise<ConnectorFact[] | null> {
    const scope = await pg(tx).selectNoFrom(sql<string | null>`app_tenant()`.as('tenant')).executeTakeFirst();
    return scope?.tenant ? this.connectorRows(tx) : null;
  }

  private async connectorRows(tx: Tx): Promise<ConnectorFact[]> {
    const rows = await pg(tx).selectFrom('connector').select(['key', 'type', 'config']).where('tenant_id', '=', appTenant).where('type', 'in', ['webhook', 'http']).execute();
    return rows.map((r) => {
      const config = r.config && typeof r.config === 'object' && !Array.isArray(r.config) ? (r.config as Record<string, unknown>) : {};
      return { key: r.key, type: r.type as ConnectorFact['type'], mode: r.type === 'http' && config.mode === 'lookup' ? 'lookup' : 'send' };
    });
  }

  modules(tx: Tx) {
    return pg(tx).selectFrom('tenant_module').select(['module_key', 'module_version', 'enabled']).where('tenant_id', '=', appTenant).orderBy('module_key').execute();
  }

  async moduleEnabled(tx: Tx, moduleKey: string | null): Promise<boolean> {
    const row = await pg(tx)
      .selectFrom('tenant_module')
      .select(sql`1`.as('one'))
      .where('tenant_id', '=', appTenant)
      .where('module_key', '=', moduleKey as string)
      .where('enabled', '=', true)
      .executeTakeFirst();
    return !!row;
  }

  async installModule(tx: Tx, manifest: Pick<ModuleManifest, 'key' | 'version' | 'setup'>): Promise<void> {
    const k = pg(tx);
    for (const a of manifest.setup?.accounts ?? []) {
      await k
        .insertInto('ledger_account')
        .values({ tenant_id: appTenant, code: a.code, name: a.name, type: a.type })
        .onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing())
        .execute();
    }
    for (const s of manifest.setup?.receiptSeries ?? []) {
      await k
        .insertInto('receipt_series')
        .values({ tenant_id: appTenant, key: s.key, prefix: s.prefix, label: s.label, reset: s.reset ?? 'fiscal_year' })
        .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
        .execute();
    }
    for (const r of manifest.setup?.roles ?? []) {
      await k
        .insertInto('role')
        .values({ tenant_id: appTenant, key: r.key, label: r.label, permissions: r.permissions, require_two_step: r.requireTwoStep ?? false })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'key'])
            .doUpdateSet((eb) => ({
              label: eb.ref('excluded.label'),
              permissions: eb.ref('excluded.permissions'),
              require_two_step: eb.ref('excluded.require_two_step'),
            }))
            .where((eb) => eb.not(eb.ref('role.customised'))),
        )
        .execute();
    }
    await k
      .insertInto('tenant_module')
      .values({ tenant_id: appTenant, module_key: manifest.key, module_version: manifest.version })
      .onConflict((oc) => oc.columns(['tenant_id', 'module_key']).doUpdateSet((eb) => ({ module_version: eb.ref('excluded.module_version'), enabled: true })))
      .execute();
  }

  moduleDefinitions(tx: Tx, moduleKey: string) {
    return pg(tx)
      .selectFrom('definition')
      .select(['kind', 'key', 'base_version'])
      .where('tenant_id', '=', appTenant)
      .where('module_key', '=', moduleKey)
      .where('status', '=', 'published')
      .$castTo<{ kind: DefinitionKind; key: string; base_version: number | null }>()
      .execute();
  }

  async turnOffModule(tx: Tx, moduleKey: string): Promise<{ kind: DefinitionKind; key: string }[]> {
    const k = pg(tx);
    const rows = await k
      .updateTable('definition')
      .set({ status: 'superseded' })
      .where('tenant_id', '=', appTenant)
      .where('module_key', '=', moduleKey)
      .where('status', '=', 'published')
      .returning(['kind', 'key'])
      .$castTo<{ kind: DefinitionKind; key: string }>()
      .execute();
    await k.updateTable('tenant_module').set({ enabled: false }).where('tenant_id', '=', appTenant).where('module_key', '=', moduleKey).execute();
    return rows;
  }
}
