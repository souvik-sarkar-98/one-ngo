import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { definitionInvalid, type FieldIssue } from '@onengo/kernel/errors';
import type { DefinitionService } from './definition-service.js';
import type { SchemaRegistry } from './schema-registry.js';
import { DEFINITION_KINDS, type DefinitionBodies, type DefinitionKind, type ModuleManifest } from './types.js';

export interface ModulePackage {
  manifest: ModuleManifest;
  definitions: { kind: DefinitionKind; file: string; body: DefinitionBodies[DefinitionKind] }[];
}

/** One definition a module brings, named by its kind and key. */
export interface ModuleContent {
  kind: DefinitionKind;
  key: string;
}

const INSTALL_ORDER: DefinitionKind[] = [
  'recordType',
  'workflow',
  'template',
  'postingRule',
  'receiptRule',
  'script',
  'automation',
  'theme',
  'listView',
  'recordGroup',
  'translation',
  'action',
  'page',
  'report',
  'reportGroup',
];

function kindOf(file: string): DefinitionKind {
  const kind = /\.([A-Za-z]+)\.json$/.exec(file)?.[1];
  if (!kind || !(DEFINITION_KINDS as readonly string[]).includes(kind)) {
    throw definitionInvalid(`Cannot tell the definition kind of '${file}'.`);
  }
  return kind as DefinitionKind;
}

/** The order a module's definitions are listed in, matching the order they install in. */
export function byInstallOrder(a: ModuleContent, b: ModuleContent): number {
  return INSTALL_ORDER.indexOf(a.kind) - INSTALL_ORDER.indexOf(b.kind) || a.key.localeCompare(b.key);
}

/** The kinds and keys a module's package brings, read without checking the definitions. */
export async function moduleContents(dir: string, manifest: ModuleManifest): Promise<ModuleContent[]> {
  const contents: ModuleContent[] = [];
  for (const file of manifest.definitions) {
    const body = JSON.parse(await readFile(join(dir, file), 'utf8')) as { key: string };
    contents.push({ kind: kindOf(file), key: body.key });
  }
  return contents.sort(byInstallOrder);
}

export async function loadModulePackage(dir: string, schemas: SchemaRegistry): Promise<ModulePackage> {
  const manifest = JSON.parse(await readFile(join(dir, 'module.json'), 'utf8')) as ModuleManifest;
  const manifestIssues = schemas.validate('module', manifest);
  if (manifestIssues.length) throw definitionInvalid(`module.json in '${dir}' is not valid.`, manifestIssues);

  const issues: FieldIssue[] = [];
  const definitions: ModulePackage['definitions'] = [];
  for (const file of manifest.definitions) {
    const kind = kindOf(file);
    const body = JSON.parse(await readFile(join(dir, file), 'utf8')) as DefinitionBodies[DefinitionKind];
    for (const i of schemas.validate(kind, body)) issues.push({ ...i, path: `${file}${i.path}` });
    definitions.push({ kind, file, body });
  }
  if (issues.length) throw definitionInvalid(`Module '${manifest.key}' has invalid definitions.`, issues);
  definitions.sort((a, b) => INSTALL_ORDER.indexOf(a.kind) - INSTALL_ORDER.indexOf(b.kind));
  return { manifest, definitions };
}

/** Publishes the package's definitions to the product base layer. Unchanged definitions keep their version. */
export async function publishModulePackage(service: DefinitionService, pkg: ModulePackage): Promise<void> {
  for (const d of pkg.definitions) await service.publishBase(d.kind, d.body, pkg.manifest.key);
}
