import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isHideable, type DefinitionKind, type ModuleManifest } from '../../../packages/platform/src/shared/definitions/types.js';
import { prepareDeployment } from '../../../packages/platform/src/prepare-deployment.js';
import { provisionTenant } from '../../../packages/platform/src/infrastructure/postgres/tenants.js';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';
import { PRODUCT_ROOT } from '../../support/paths.js';

const MODULES_DIR = join(PRODUCT_ROOT, 'modules');
const folders = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const manifests = new Map(folders.map((f) => [f, JSON.parse(readFileSync(join(MODULES_DIR, f, 'module.json'), 'utf8')) as ModuleManifest]));

const worlds: TestWorld[] = [];
afterAll(() => Promise.all(worlds.map((w) => w.close())));

/** Dependencies first. */
function inOrder(): ModuleManifest[] {
  const done = new Set<string>();
  const out: ModuleManifest[] = [];
  const visit = (key: string, path: string[]) => {
    if (done.has(key)) return;
    if (path.includes(key)) throw new Error(`Modules depend on each other in a circle: ${[...path, key].join(' -> ')}`);
    const manifest = manifests.get(key);
    if (!manifest) throw new Error(`A module depends on '${key}', which is not shipped.`);
    for (const dep of manifest.dependsOn ?? []) visit(dep, [...path, key]);
    done.add(key);
    out.push(manifest);
  };
  for (const key of manifests.keys()) visit(key, []);
  return out;
}

describe('the shipped modules', () => {
  it('are named by their folders, depend only on each other, and never in a circle', () => {
    expect(folders.length).toBeGreaterThan(1);
    for (const [folder, manifest] of manifests) {
      expect(manifest.key, folder).toBe(folder);
      expect(manifest.dependsOn ?? [], folder).not.toContain(folder);
      for (const dep of manifest.dependsOn ?? []) expect([...manifests.keys()], `${folder} depends on ${dep}`).toContain(dep);
    }
    expect(() => inOrder()).not.toThrow();
  });

  it('start every definition people see as shown, and give the others no hidden flag', () => {
    for (const [folder, manifest] of manifests) {
      for (const file of manifest.definitions) {
        const kind = /\.([A-Za-z]+)\.json$/.exec(file)![1] as DefinitionKind;
        const body = JSON.parse(readFileSync(join(MODULES_DIR, folder, file), 'utf8')) as { hidden?: unknown };
        if (isHideable(kind)) expect(body.hidden, `${folder}/${file}`).toBe(false);
        else expect(body.hidden, `${folder}/${file}`).toBeUndefined();
      }
    }
  });

  it('declare a shared ledger account the same way in every module that sets it up', () => {
    const seen = new Map<string, { owner: string; name: string; type: string }>();
    for (const [folder, manifest] of manifests) {
      for (const a of manifest.setup?.accounts ?? []) {
        const first = seen.get(a.code);
        if (!first) seen.set(a.code, { owner: folder, name: a.name, type: a.type });
        else expect({ name: a.name, type: a.type }, `${a.code}: ${folder} differs from ${first.owner}`).toEqual({ name: first.name, type: first.type });
      }
    }
  });

  it('set up every ledger account their definitions name, or depend on the module that does', () => {
    const owners = new Map<string, Set<string>>();
    for (const [folder, manifest] of manifests) for (const a of manifest.setup?.accounts ?? []) owners.set(a.code, (owners.get(a.code) ?? new Set()).add(folder));
    const reach = (key: string, out = new Set<string>()): Set<string> => {
      out.add(key);
      for (const dep of manifests.get(key)?.dependsOn ?? []) reach(dep, out);
      return out;
    };
    for (const [folder, manifest] of manifests) {
      const available = reach(folder);
      const text = manifest.definitions.map((file) => readFileSync(join(MODULES_DIR, folder, file), 'utf8')).join('\n');
      for (const [code, from] of owners) {
        if (!new RegExp(`["']${code}["']`).test(text)) continue;
        expect([...from].some((m) => available.has(m)), `${folder} names the ledger account ${code}, which only ${[...from].join(', ')} sets up, and ${folder} does not depend on it`).toBe(true);
      }
    }
  });

  it('each turn on with only the modules they declare, so no module relies on another one it does not name', async () => {
    const w = await createWorld({ donations: false });
    worlds.push(w);
    const deployed = await prepareDeployment(w.platform.db, { shippedModules: folders });
    const manifestOf = (key: string) => deployed.modules.find((m) => m.manifest.key === key)!.manifest;
    const closure = (key: string, out = new Set<string>()): Set<string> => {
      for (const dep of manifests.get(key)?.dependsOn ?? []) closure(dep, out);
      out.add(key);
      return out;
    };
    for (const folder of folders) {
      const tenant = await provisionTenant(w.platform.db, { key: `alone-${folder}`, name: `Only ${folder}`, region: 'asia-south1' });
      const ctx = w.as(tenant);
      const wanted = closure(folder);
      for (const manifest of inOrder()) if (wanted.has(manifest.key)) await w.platform.definitions.enableModule(ctx, manifestOf(manifest.key));
      const enabled = (await w.platform.db.withTenant(tenant, (tx) => tx.query<{ module_key: string }>(`select module_key from tenant_module where enabled`))).map((r) => r.module_key).sort();
      expect(enabled, folder).toEqual([...wanted].sort());
    }
  }, 240_000);

  it('let every definition people see be hidden and shown again, and still publish', async () => {
    const w = await createWorld({ donations: false });
    worlds.push(w);
    const deployed = await prepareDeployment(w.platform.db, { shippedModules: folders });
    const manifestOf = (key: string) => deployed.modules.find((m) => m.manifest.key === key)!.manifest;
    const tenant = await provisionTenant(w.platform.db, { key: 'hide-all', name: 'Hide everything', region: 'asia-south1' });
    const ctx = w.as(tenant);
    for (const manifest of inOrder()) await w.platform.definitions.enableModule(ctx, manifestOf(manifest.key));

    const all = deployed.modules.flatMap((m) => m.definitions.filter((d) => isHideable(d.kind)).map((d) => ({ kind: d.kind, key: d.body.key })));
    expect(all.length).toBeGreaterThan(0);
    for (const d of all) {
      expect((await w.platform.definitions.setDefinitionHidden(ctx, d.kind, d.key, true)).body).toMatchObject({ hidden: true });
      expect((await w.platform.definitions.setDefinitionHidden(ctx, d.kind, d.key, false)).body).toMatchObject({ hidden: false });
    }
  }, 240_000);

  it('publish and turn on together, with the ledger accounts and money accounts they set up', async () => {
    const w = await createWorld({ donations: false });
    worlds.push(w);
    const deployed = await prepareDeployment(w.platform.db, { shippedModules: folders });
    expect(deployed.modules.map((m) => m.manifest.key).sort()).toEqual(folders);

    const ctx = w.as(w.ngoA);
    for (const manifest of inOrder()) await w.platform.definitions.enableModule(ctx, deployed.modules.find((m) => m.manifest.key === manifest.key)!.manifest);

    const ledger = new Set((await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ code: string }>(`select code from ledger_account`))).map((r) => r.code));
    const money = new Map((await w.platform.moneyAccounts.list(ctx)).map((a) => [a.key, a.ledgerCode]));
    for (const manifest of manifests.values()) {
      for (const account of manifest.setup?.accounts ?? []) expect(ledger, `${manifest.key} ${account.code}`).toContain(account.code);
      for (const account of manifest.setup?.moneyAccounts ?? []) {
        expect(ledger, `${manifest.key} money account ${account.key} needs ledger account ${account.ledgerCode}`).toContain(account.ledgerCode);
        expect(money.get(account.key), `${manifest.key} money account ${account.key}`).toBe(account.ledgerCode);
      }
    }
  }, 120_000);
});
