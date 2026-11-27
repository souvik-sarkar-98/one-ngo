import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { typed } from '../../../packages/platform/src/infrastructure/postgres/kysely.js';
import { buildServer } from '../../../apps/onengo/server/src/http/server.js';
import type { Actor } from '../../../packages/platform/src/infrastructure/postgres/db.js';
import { loadModulePackage } from '../../../packages/platform/src/runtime/definitions/package-loader.js';
import { SchemaRegistry } from '../../../packages/platform/src/runtime/definitions/schema-registry.js';
import { MODULES_DIR } from '../../../packages/platform/src/platform.js';
import { admin, createWorld, type TestWorld } from '../../support/platform/helpers.js';
import { join } from 'node:path';

let w: TestWorld;
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
});

afterAll(async () => {
  await app.close();
  await w.close();
});

const headers = (actor: Actor = admin, tenant = w.ngoA) => ({ 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) });
const get = (url: string, actor: Actor = admin, tenant = w.ngoA) => app.inject({ method: 'GET', url, headers: headers(actor, tenant) });
const hide = (kind: string, key: string, hidden: unknown, actor: Actor = admin, tenant = w.ngoA, module = 'donations') =>
  app.inject({
    method: 'PUT',
    url: `/api/builder/modules/${module}/definitions/${kind}/${key}/hidden`,
    headers: headers(actor, tenant),
    payload: { hidden } as Record<string, unknown>,
  });

interface Runtime {
  recordTypes: { key: string; hidden?: boolean }[];
  recordGroups: { key: string; recordTypes: string[] }[];
  listViews: Record<string, unknown>;
  actions: Record<string, { key: string }[]>;
}
const runtime = async (tenant = w.ngoA) => (await get('/api/runtime/definitions', admin, tenant)).json() as Runtime;

describe('hiding a definition from the Modules screen', () => {
  it('lists each definition with its label, whether it is hidden, and whether it can be', async () => {
    const donations = ((await get('/api/builder/modules')).json() as { key: string; definitions: Record<string, unknown>[] }[]).find((m) => m.key === 'donations')!;
    expect(donations.definitions).toContainEqual({ kind: 'recordType', key: 'donor', label: expect.any(String), hidden: false, hideable: true, blocked: null });
    expect(donations.definitions).toContainEqual(expect.objectContaining({ kind: 'template', key: 'donationThanks', hideable: false, blocked: null }));
  });

  it('keeps a record type out of the menus, and brings it back, without losing its record type or the choice on update', async () => {
    expect((await runtime()).recordTypes.find((t) => t.key === 'donor')?.hidden).toBe(false);

    const res = await hide('recordType', 'donor', true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'recordType', key: 'donor', hidden: true });
    try {
      const after = await runtime();
      // The type itself stays, so records that point at it still open; the app leaves it out of menus.
      expect(after.recordTypes.find((t) => t.key === 'donor')?.hidden).toBe(true);
      expect(after.recordGroups.flatMap((g) => g.recordTypes)).not.toContain('donor');
      expect(after.recordGroups.flatMap((g) => g.recordTypes)).toContain('donation');

      const row = ((await get('/api/builder/modules')).json() as { key: string; definitions: { kind: string; key: string; hidden: boolean }[] }[])
        .find((m) => m.key === 'donations')!
        .definitions.find((d) => d.kind === 'recordType' && d.key === 'donor');
      expect(row?.hidden).toBe(true);

      // Updating the module again keeps what the organisation chose.
      const pkg = await loadModulePackage(join(MODULES_DIR, 'donations'), new SchemaRegistry(join(MODULES_DIR, '../schemas')));
      await w.platform.definitions.enableModule(w.as(w.ngoA), pkg.manifest);
      expect((await runtime()).recordTypes.find((t) => t.key === 'donor')?.hidden).toBe(true);
    } finally {
      expect((await hide('recordType', 'donor', false)).statusCode).toBe(200);
    }
    expect((await runtime()).recordTypes.find((t) => t.key === 'donor')?.hidden).toBe(false);
    expect(await w.platform.definitions.getDraft(w.as(w.ngoA), 'recordType', 'donor')).toBeUndefined();
  });

  it('drops the lists and the actions of a hidden record type, and a hidden list on its own', async () => {
    expect((await hide('listView', 'donations', true)).statusCode).toBe(200);
    expect((await hide('action', 'sendReminder', true)).statusCode).toBe(200);
    try {
      const after = await runtime();
      expect(Object.keys(after.listViews)).not.toContain('donation');
      expect(after.actions.donation?.map((a) => a.key) ?? []).not.toContain('sendReminder');
      expect(Object.keys(after.listViews)).toContain('donor');
    } finally {
      await hide('listView', 'donations', false);
      await hide('action', 'sendReminder', false);
    }
    expect(Object.keys((await runtime()).listViews)).toContain('donation');
  });

  it('keeps hidden reports, and reports only in a hidden group, out of the reports list', async () => {
    const keys = async () => ((await get('/api/reports')).json().reports as { key: string; group: { key: string } | null }[]).map((r) => r.key);
    expect(await keys()).toContain('donationRegister');

    expect((await hide('report', 'donationRegister', true)).statusCode).toBe(200);
    try {
      expect(await keys()).not.toContain('donationRegister');
      expect(await keys()).toContain('donationSummary');
      expect((await hide('reportGroup', 'fundraising', true)).statusCode).toBe(200);
      expect(await keys()).not.toContain('donationSummary');
    } finally {
      await hide('reportGroup', 'fundraising', false);
      await hide('report', 'donationRegister', false);
    }
    expect(await keys()).toEqual(expect.arrayContaining(['donationRegister', 'donationSummary']));
  });

  it('refuses kinds people never see, a module that is unknown, unknown definitions and people without config:modules', async () => {
    expect((await hide('template', 'donationThanks', true)).statusCode).toBe(422);
    expect((await hide('recordType', 'donor', 'yes')).statusCode).toBe(422);
    expect((await hide('recordType', 'nothing', true)).statusCode).toBe(404);
    expect((await hide('recordType', 'donor', true, admin, w.ngoA, 'nothing')).statusCode).toBe(404);
    const configurer: Actor = { id: 'c', roles: [], permissions: ['config:read', 'config:publish'] };
    expect((await hide('recordType', 'donor', true, configurer)).statusCode).toBe(403);

  });

  it('is recorded in the audit trail', async () => {
    await hide('recordType', 'donor', true);
    await hide('recordType', 'donor', false);
    const actions = (
      await w.platform.db.withTenant(w.ngoA, (tx) => typed(tx).selectFrom('audit_event').select('action').where('entity_id', '=', 'donor').where('action', 'like', 'definition.%').execute())
    ).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['definition.hidden', 'definition.shown']));
  });
});

describe('moving the retired module options over', () => {
  it('hides a record type an option took out of its group, turns off a definition it took out whole, and keeps changed roles as they are', async () => {
    const legacy = {
      donations: {
        options: [
          { key: 'donors', label: 'Donors', hides: [{ kind: 'recordGroup', key: 'fundraising', path: '/recordTypes', value: 'donor' }] },
          { key: 'summary', label: 'Summary', hides: [{ kind: 'report', key: 'donationSummary' }] },
          { key: 'viewing', label: 'Viewing', revokes: [{ role: 'viewer', permission: 'record:donor:read' }] },
          { key: 'kept', label: 'Kept', hides: [{ kind: 'report', key: 'donationRegister' }] },
        ],
        off: ['donors', 'summary', 'viewing'],
      },
    };
    await w.platform.db.withTenant(w.ngoB, (tx) =>
      typed(tx).insertInto('tenant_setting').values({ tenant_id: sql<string>`app_tenant()`, key: 'modules.options', value: JSON.stringify(legacy) }).execute(),
    );
    const pkg = await loadModulePackage(join(MODULES_DIR, 'donations'), new SchemaRegistry(join(MODULES_DIR, '../schemas')));

    const changed = await w.platform.definitions.retireModuleOptions(w.ngoB, [pkg.manifest]);
    expect(changed).toEqual(expect.arrayContaining(['report|donationSummary', 'recordType|donor']));
    expect(changed).not.toContain('report|donationRegister');

    expect((await runtime(w.ngoB)).recordTypes.find((t) => t.key === 'donor')?.hidden).toBe(true);
    expect(await w.platform.definitions.get(w.ngoB, 'report', 'donationSummary')).toBeUndefined();
    expect(await w.platform.definitions.get(w.ngoB, 'report', 'donationRegister')).toBeDefined();

    const viewer = await w.platform.db.withTenant(w.ngoB, (tx) => typed(tx).selectFrom('role').select('customised').where('key', '=', 'viewer').executeTakeFirst());
    expect(viewer?.customised).toBe(true);

    // Once moved, a second run finds nothing to do and the setting is empty.
    expect(await w.platform.definitions.retireModuleOptions(w.ngoB, [pkg.manifest])).toEqual([]);
    const left = await w.platform.db.withTenant(w.ngoB, (tx) => typed(tx).selectFrom('tenant_setting').select('value').where('key', '=', 'modules.options').executeTakeFirst());
    expect(left?.value).toEqual({});
  });
});
