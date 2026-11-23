import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ModuleManifest } from '../src/shared/definitions/types.js';
import { prepareDeployment } from '../src/prepare-deployment.js';
import { createWorld, type TestWorld } from './helpers.js';

const MODULES_DIR = join(import.meta.dirname, '../../product/modules');
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
