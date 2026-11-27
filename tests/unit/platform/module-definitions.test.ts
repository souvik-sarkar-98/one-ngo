import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_DIR } from '../../../packages/platform/src/platform.js';
import { checkCrossReferences, type DefinitionLookup } from '../../../packages/platform/src/runtime/definitions/cross-refs.js';
import { loadModulePackage, type ModulePackage } from '../../../packages/platform/src/runtime/definitions/package-loader.js';
import { SchemaRegistry } from '../../../packages/platform/src/runtime/definitions/schema-registry.js';
import { type DefinitionBodies, type DefinitionKind, type ModuleManifest, type WorkflowDef } from '../../../packages/platform/src/runtime/definitions/types.js';
import { isPrimary, workflowsOf } from '../../../packages/platform/src/runtime/definitions/workflows.js';
import { PRODUCT_ROOT } from '../../support/paths.js';

/**
 * Generic checks over every module under packages/product/modules. Modules and
 * definitions are discovered from disk, so adding, removing or changing a
 * definition needs no edit here.
 */

const MODULES_DIR = join(PRODUCT_ROOT, 'modules');
const folders = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const schemas = new SchemaRegistry(SCHEMA_DIR);

const dirOf = (folder: string) => join(MODULES_DIR, folder);
const manifestOf = (folder: string) => JSON.parse(readFileSync(join(dirOf(folder), 'module.json'), 'utf8')) as ModuleManifest;
const jsonFilesIn = (folder: string) => readdirSync(dirOf(folder)).filter((f) => f.endsWith('.json') && f !== 'module.json').sort();
const id = (kind: string, key: string) => `${kind}|${key}`;

const packages = new Map<string, Promise<ModulePackage>>();
/** Loads and validates one module once per run; a broken module rejects with its issues. */
function load(folder: string): Promise<ModulePackage> {
  if (!packages.has(folder)) packages.set(folder, loadModulePackage(dirOf(folder), schemas));
  return packages.get(folder)!;
}

/** The module itself and every module it depends on, directly or through another. */
function reach(folder: string, seen = new Set<string>()): Set<string> {
  if (seen.has(folder)) return seen;
  seen.add(folder);
  for (const dep of manifestOf(folder).dependsOn ?? []) reach(dep, seen);
  return seen;
}

/**
 * A lookup over the given definitions only. Facts about the organisation (accounts,
 * roles, connectors, receipt series) are unknown here, so checks that need them are skipped.
 */
function lookupOver(defs: Map<string, unknown>): DefinitionLookup {
  const all = <K extends DefinitionKind>(kind: K) => [...defs].filter(([k]) => k.startsWith(`${kind}|`)).map(([, v]) => v as DefinitionBodies[K]);
  const workflowsOfType = (recordType: string) => workflowsOf(all('workflow') as WorkflowDef[], recordType, (w) => w);
  return {
    recordType: (key) => defs.get(id('recordType', key)) as DefinitionBodies['recordType'] | undefined,
    template: (key) => defs.get(id('template', key)) as DefinitionBodies['template'] | undefined,
    definition: (kind, key) => defs.get(id(kind, key)) as never,
    all: (kind) => all(kind) as never,
    workflowFor: (recordType) => workflowsOfType(recordType).find(isPrimary),
    workflowsFor: workflowsOfType,
    accountCodes: null,
    receiptSeries: null,
    roles: null,
    connectors: null,
    namedRecipients: null,
    rolePermissions: null,
  };
}

describe('shipped modules, generic checks', () => {
  it('finds at least one module to check', () => {
    expect(folders.length).toBeGreaterThan(0);
  });

  it.each(folders)('%s: module.json and every definition validate against the schemas', async (folder) => {
    await expect(load(folder)).resolves.toMatchObject({ manifest: { key: folder } });
  });

  it.each(folders)('%s: every definition file on disk is listed in module.json, and every listed file exists', (folder) => {
    const listed = manifestOf(folder).definitions;
    expect(new Set(listed).size, 'a file is listed twice').toBe(listed.length);
    expect(jsonFilesIn(folder)).toEqual([...listed].sort());
  });

  it('defines each kind and key once across all modules', async () => {
    const owner = new Map<string, string>();
    for (const folder of folders) {
      for (const d of (await load(folder)).definitions) {
        const key = id(d.kind, d.body.key);
        if (owner.has(key)) expect.fail(`${key} is defined in both ${owner.get(key)} and ${folder}`);
        owner.set(key, folder);
      }
    }
  });

  it.each(folders)('%s: every reference resolves inside the module or a module it depends on', async (folder) => {
    const defs = new Map<string, unknown>();
    for (const m of reach(folder)) {
      for (const d of (await load(m)).definitions) defs.set(id(d.kind, d.body.key), d.body);
    }
    const lookup = lookupOver(defs);
    const problems = (await load(folder)).definitions.flatMap((d) =>
      checkCrossReferences(d.kind, d.body, lookup).map((i) => `${d.kind} ${d.body.key}${i.path}: ${i.message}`),
    );
    expect(problems).toEqual([]);
  });

  it('the reference check can fail: a record group naming a missing record type is reported', () => {
    const group = { key: 'g', label: 'G', recordTypes: ['ghost'] } as DefinitionBodies['recordGroup'];
    expect(checkCrossReferences('recordGroup', group, lookupOver(new Map()))).toHaveLength(1);
  });
});
