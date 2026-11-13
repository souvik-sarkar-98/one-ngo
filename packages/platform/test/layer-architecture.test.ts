import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  applicationSiblingHits,
  breaks,
  collectEdges,
  httpReexportHits,
  layerOf,
  LAYERS,
  PORT_VALUE_EXCEPTIONS,
  portValueHits,
  ROOT,
  RULE,
  RUNTIME_PURE_HELPERS,
  runtimeSiblingHits,
  sources,
  violations,
  type Source,
} from './layer-graph.js';
import { expiryProblems, isClosed, OPEN_BLOCKS, parseBlockStatus, readPlanStatus, type Entry as PlanEntry } from './plan-status.js';

/**
 * The final layer table (section 10.1 of docs/architecture/ngo-backend-enhancement-plan.md), read from
 * the TypeScript syntax tree by test/layer-graph.ts:
 *
 *   http -> application; application -> runtime, domain; runtime -> domain; domain -> domain;
 *   infrastructure -> core port files, type-only; platform.ts composes everything.
 *
 * test/layer-allowlist.json is the exact list of edges that break the table today. A new edge fails,
 * and so does an entry that no longer matches an edge. `npx tsx packages/platform/test/layer-baseline.ts` rewrites it;
 * edit reasons by hand only when you must.
 */
const ALLOWLIST_FILE = join(ROOT, 'test/layer-allowlist.json');

interface Entry {
  reason: string;
  owner: string;
  removeAfterBlock: string;
}

const readAllowlist = (): Record<string, Entry> => JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')) as Record<string, Entry>;

const fake = (path: string, spec: string, kind = 'import'): Source => ({
  path,
  src: kind === 'type' ? `import type { X } from '${spec}';\n` : kind === 'value' ? `import { X } from '${spec}';\n` : `import { type X } from '${spec}';\n`,
});

describe('layer boundaries', () => {
  it('puts every file of src/ in a layer or at the root', () => {
    const all = sources();
    expect(all.length).toBeGreaterThan(200);
    const folders = all.filter((f) => f.path.slice(4).includes('/')).map((f) => layerOf(f.path)!);
    const unknown = [...new Set(folders)].filter((l) => !(LAYERS as readonly string[]).includes(l));
    expect(unknown, 'Top-level folders of src/ are the public api, composition, and the architecture layers.').toEqual([]);
  });

  it('adds no import edge that breaks the layer table, and keeps test/layer-allowlist.json exact', () => {
    const allowlist = readAllowlist();
    const found = violations(sources());
    expect(
      [...found.keys()].filter((k) => !allowlist[k]).map((k) => `${k}  (${found.get(k)!.why})`),
      'New layer violation. Import a lower layer, or move the code to the layer that owns it. Do not add allowlist entries.',
    ).toEqual([]);
    expect(Object.keys(allowlist).filter((k) => !found.has(k)), 'Fixed: remove these from test/layer-allowlist.json.').toEqual([]);
  });

  it('has no baseline edges left: every import follows the layer table', () => {
    expect(Object.keys(readAllowlist()), 'The layer baseline is empty (A8). Fix the import instead of adding an entry.').toEqual([]);
    expect([...violations(sources()).keys()]).toEqual([]);
  });

  it('keeps composition to platform.ts and the entry points, and every composition file to src/composition/', () => {
    const edges = collectEdges(sources());
    const importers = [...new Set(edges.filter((e) => layerOf(e.to) === 'composition' && layerOf(e.from) !== 'composition').map((e) => e.from))].sort();
    expect(importers).toEqual([
      'src/api/deployment.ts',
      'src/api/main.ts',
      'src/api/operator.ts',
      'src/platform.ts',
      'src/prepare-deployment.ts',
    ]);
    const root = sources().filter((f) => !f.path.slice(4).includes('/')).map((f) => f.path).sort();
    expect(root, 'Root files of src/ are the entry points and platform.ts; wiring goes in src/composition/.').toEqual([
      'src/platform.ts',
      'src/prepare-deployment.ts',
    ]);
  });

  it('gives every allowlist entry a reason, an owner and the block that removes it', () => {
    const bad = Object.entries(readAllowlist())
      .filter(([, e]) => e.reason.trim().length < 20 || !e.owner?.trim() || !/^A[1-8]$/.test(e.removeAfterBlock ?? ''))
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('expires allowlist entries whose block section 5.1 marks Merged or Done', () => {
    expect(expiryProblems(readAllowlist(), readPlanStatus(), OPEN_BLOCKS.allowlist), 'An expired or unapproved allowlist entry. Fix the import instead.').toEqual([]);
  });

  it('flags every kind of crossing', () => {
    expect(
      [...violations([
        fake('src/http/x.ts', '../platform.js', 'value'),
        fake('src/http/y.ts', '../runtime/records/record-service.js', 'value'),
        fake('src/http/z.ts', '../application/payments/confirm-payment.js', 'value'),
        fake('src/application/x.ts', '../http/server.js', 'value'),
        fake('src/application/y.ts', '../infrastructure/postgres/tx.js', 'type'),
        fake('src/application/z.ts', '../runtime/definitions/types.js', 'value'),
        fake('src/runtime/x.ts', '../application/payments/confirm-payment.js', 'value'),
        fake('src/runtime/y.ts', '@onengo/kernel/errors', 'value'),
        fake('src/domain/x.ts', '../runtime/records/record-service.js', 'value'),
        fake('src/domain/s.ts', '../shared/errors.js', 'value'),
        fake('src/shared/x.ts', '@onengo/kernel/errors', 'value'),
        fake('src/domain/y.ts', '../domain/ledger/ports/ledger-store.js', 'value'),
        fake('src/domain/z.ts', '../infrastructure/postgres/tx.js', 'type'),
        fake('src/infrastructure/postgres/x.ts', '../../domain/ledger/ledger-service.js', 'type'),
        fake('src/infrastructure/postgres/y.ts', '../../domain/ledger/ports/ledger-store.js', 'value'),
        fake('src/infrastructure/postgres/z.ts', '../../domain/ledger/ports/ledger-store.js', 'type'),
        fake('src/infrastructure/postgres/w.ts', '../../runtime/records/ports/record-store.js'),
        fake('src/infrastructure/postgres/v.ts', './db.js', 'value'),
        fake('src/platform.ts', './infrastructure/postgres/tx.js', 'value'),
        fake('src/main.ts', './http/server.js', 'value'),
        fake('src/main.ts', './application/x.js', 'value'),
        fake('src/deploy.ts', './platform.js', 'value'),
        fake('src/deploy.ts', './infrastructure/postgres/db.js', 'value'),
        fake('src/http/c.ts', '../composition/http.js', 'value'),
        fake('src/application/c.ts', '../composition/records.js', 'type'),
        fake('src/infrastructure/postgres/c.ts', '../../composition/records.js', 'type'),
        fake('src/other.ts', './composition/entry.js', 'value'),
        fake('src/composition/x.ts', '../infrastructure/postgres/tx.js', 'value'),
        fake('src/composition/y.ts', '../http/server.js', 'value'),
        fake('src/composition/z.ts', '../platform.js', 'type'),
        fake('src/main.ts', './composition/entry.js', 'value'),
        fake('src/prepare-deployment.ts', './composition/deployment.js', 'value'),
        fake('src/platform.ts', './composition/records.js', 'value'),
      ]).keys()].sort(),
    ).toEqual([
      'src/application/c.ts -> src/composition/records.ts',
      'src/application/x.ts -> src/http/server.ts',
      'src/application/y.ts -> src/infrastructure/postgres/tx.ts',
      'src/deploy.ts -> src/infrastructure/postgres/db.ts',
      'src/domain/x.ts -> src/runtime/records/record-service.ts',
      'src/domain/z.ts -> src/infrastructure/postgres/tx.ts',
      'src/http/c.ts -> src/composition/http.ts',
      'src/http/x.ts -> src/platform.ts',
      'src/http/y.ts -> src/runtime/records/record-service.ts',
      'src/infrastructure/postgres/c.ts -> src/composition/records.ts',
      'src/infrastructure/postgres/x.ts -> src/domain/ledger/ledger-service.ts',
      'src/infrastructure/postgres/y.ts -> src/domain/ledger/ports/ledger-store.ts',
      'src/main.ts -> src/application/x.ts',
      'src/main.ts -> src/composition/entry.ts',
      'src/other.ts -> src/composition/entry.ts',
      'src/runtime/x.ts -> src/application/payments/confirm-payment.ts',
    ]);
  });

  it('reads re-exports, dynamic imports and import types, and tells type-only from value imports', () => {
    const edges = collectEdges([
      {
        path: 'src/domain/a.ts',
        src: [
          "export * from '../runtime/a.js';",
          "export type { T } from '../runtime/b.js';",
          "const x = await import('../runtime/c.js');",
          "type Y = import('../runtime/d.js').Y;",
          "import { type A, type B } from '../runtime/e.js';",
          "import { A2, type B2 } from '../runtime/f.js';",
          "import 'node:fs';",
          "import { z } from 'zod';",
        ].join('\n'),
      },
    ]);
    expect(edges.map((e) => `${e.to}${e.typeOnly ? ' (type)' : ''}`)).toEqual([
      'src/runtime/a.ts',
      'src/runtime/b.ts (type)',
      'src/runtime/c.ts',
      'src/runtime/d.ts (type)',
      'src/runtime/e.ts (type)',
      'src/runtime/f.ts',
    ]);
    expect(breaks({ from: 'src/domain/a.ts', to: 'src/domain/b.ts', typeOnly: false })).toBeNull();
  });
});

/**
 * Package ownership (section 10.4 of the plan). Only the owning folders may import these packages;
 * test/package-allowlist.json is the exact list of files that import one today without owning it.
 */
const PACKAGE_OWNERS: Record<string, string[]> = {
  fastify: ['src/http/'],
  kysely: ['src/infrastructure/postgres/'],
  pg: ['src/infrastructure/postgres/'],
  'quickjs-emscripten': ['src/runtime/scripts/'],
};
const PACKAGE_ALLOWLIST_FILE = join(ROOT, 'test/package-allowlist.json');

/** `@fastify/static` is part of `fastify`; `quickjs-emscripten-core` is part of `quickjs-emscripten`. */
function ownedPackage(spec: string): string | null {
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
  if (name === 'fastify' || name.startsWith('@fastify/')) return 'fastify';
  if (name === 'quickjs-emscripten' || name.startsWith('quickjs-emscripten-') || name.startsWith('@jitl/quickjs')) return 'quickjs-emscripten';
  return name in PACKAGE_OWNERS ? name : null;
}

/** Restricted packages imported by each source, read from the syntax tree (imports, re-exports, `import()` and import types). */
function packageImports(all: Source[]): Map<string, { path: string; pkg: string }> {
  const out = new Map<string, { path: string; pkg: string }>();
  for (const f of all) {
    const sf = ts.createSourceFile(f.path, f.src, ts.ScriptTarget.ES2023, true);
    const visit = (n: ts.Node) => {
      let spec: string | undefined;
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) spec = n.moduleSpecifier.text;
      else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) spec = n.argument.literal.text;
      else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) spec = n.moduleReference.expression.text;
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) spec = n.arguments[0].text;
      const pkg = spec && !spec.startsWith('.') ? ownedPackage(spec) : null;
      if (pkg) out.set(`${f.path} -> ${pkg}`, { path: f.path, pkg });
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const packageViolations = (all: Source[]) =>
  new Map([...packageImports(all)].filter(([, { path, pkg }]) => !PACKAGE_OWNERS[pkg]!.some((dir) => path.startsWith(dir))));

describe('package ownership', () => {
  it('lets only the owning folder import fastify, kysely, pg and quickjs-emscripten, and keeps test/package-allowlist.json exact', () => {
    const allowlist = JSON.parse(readFileSync(PACKAGE_ALLOWLIST_FILE, 'utf8')) as Record<string, Entry>;
    const found = packageViolations(sources());
    expect(
      [...found.keys()].filter((k) => !allowlist[k]),
      'New package import outside its owner. fastify belongs to src/http, kysely and pg to src/infrastructure/postgres, quickjs-emscripten to src/runtime/scripts. Do not add allowlist entries.',
    ).toEqual([]);
    expect(Object.keys(allowlist).filter((k) => !found.has(k)), 'Fixed: remove these from test/package-allowlist.json.').toEqual([]);
    const bad = Object.entries(allowlist)
      .filter(([, e]) => e.reason.trim().length < 20 || !e.owner?.trim() || !/^A[1-8]$/.test(e.removeAfterBlock ?? ''))
      .map(([k]) => k);
    expect(bad).toEqual([]);
    expect(expiryProblems(allowlist, readPlanStatus(), OPEN_BLOCKS.allowlist), 'An expired or unapproved package allowlist entry. Fix the import instead.').toEqual([]);
  });

  it('flags a restricted package imported from the wrong folder, however it is imported', () => {
    const at = (path: string, src: string): Source => ({ path, src });
    expect(
      [
        ...packageViolations([
          at('src/application/a.ts', "import Fastify from 'fastify';"),
          at('src/domain/b.ts', "import { sql } from 'kysely';"),
          at('src/runtime/c.ts', "export type { Pool } from 'pg';"),
          at('src/http/d.ts', "const s = await import('@fastify/static'); import { sql } from 'kysely';"),
          at('src/infrastructure/postgres/e.ts', "import { sql } from 'kysely'; import pg from 'pg';"),
          at('src/runtime/scripts/f.ts', "import { getQuickJS } from 'quickjs-emscripten';"),
          at('src/infrastructure/g.ts', "import { getQuickJS } from 'quickjs-emscripten'; import { z } from 'zod'; import './fastify.js';"),
        ]).keys(),
      ].sort(),
    ).toEqual([
      'src/application/a.ts -> fastify',
      'src/domain/b.ts -> kysely',
      'src/http/d.ts -> kysely',
      'src/infrastructure/g.ts -> quickjs-emscripten',
      'src/runtime/c.ts -> pg',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Conformance rules (block G). None may have a hit: there is no pending list and no exception.
// ---------------------------------------------------------------------------------------------
const at = (path: string, src: string): Source => ({ path, src });
const keysOf = (hits: Map<string, unknown>) => [...hits.keys()].sort();

/** A rule with any hit fails: fix the code, there is nothing to list. */
function expectNoHits(found: Map<string, { why: string; block: string }>, advice: string) {
  expect([...found.keys()].map((k) => `${k}  (${found.get(k)!.why})`), `New violation. ${advice}`).toEqual([]);
}

describe('runtime capabilities', () => {
  it('import a sibling only for types.ts, ports, expressions and listed pure helpers', () => {
    expectNoHits(runtimeSiblingHits(sources()), 'A runtime capability may not use a sibling service class or internal module; share a pure contract in types.ts or a ports/ file instead.');
  });

  it('flags a sibling service, however it is imported, and allows the pure contracts', () => {
    const hits = runtimeSiblingHits([
      at('src/runtime/records/a.ts', "import { ScriptSandbox } from '../scripts/sandbox.js';"),
      at('src/runtime/records/b.ts', "import type { DefinitionService } from '../definitions/definition-service.js';"),
      at('src/runtime/workflows/c.ts', "import { type RecordService } from '../records/record-service.js'; export { x } from '../definitions/definition-service.js';"),
      at('src/runtime/automation/d.ts', "const s = await import('../workflows/approval-service.js');"),
      // allowed
      at('src/runtime/records/e.ts', "import type { FieldDef } from '../definitions/types.js';"),
      at('src/runtime/records/f.ts', "import type { Actor } from '../definitions/ports/tenant-context.js';"),
      at('src/runtime/definitions/g.ts', "import { compileExpression } from '../expressions/expression.js';"),
      at('src/runtime/records/h.ts', "import { canReadField } from '../definitions/field-permissions.js';"),
      at('src/runtime/records/i.ts', "import { RecordService } from './record-service.js';"),
      at('src/runtime/records/j.ts', "import { can } from '../../domain/permissions.js';"),
      at('src/application/records/k.ts', "import { ScriptSandbox } from '../../runtime/scripts/sandbox.js';"),
    ]);
    expect(keysOf(hits)).toEqual([
      'runtime-sibling: src/runtime/automation/d.ts -> src/runtime/workflows/approval-service.ts',
      'runtime-sibling: src/runtime/records/a.ts -> src/runtime/scripts/sandbox.ts',
      'runtime-sibling: src/runtime/records/b.ts -> src/runtime/definitions/definition-service.ts',
      'runtime-sibling: src/runtime/workflows/c.ts -> src/runtime/definitions/definition-service.ts',
      'runtime-sibling: src/runtime/workflows/c.ts -> src/runtime/records/record-service.ts',
    ]);
    expect([...hits.values()].every((h) => h.block === 'R')).toBe(true);
  });

  it('names each pure helper once, with a reason, and never a service class', () => {
    const byPath = new Map(sources().map((f) => [f.path, f.src]));
    for (const [path, reason] of Object.entries(RUNTIME_PURE_HELPERS)) {
      expect(byPath.has(path), `${path} is listed in RUNTIME_PURE_HELPERS but does not exist.`).toBe(true);
      expect(reason.trim().length, `${path} needs a reason.`).toBeGreaterThanOrEqual(20);
      expect(byPath.get(path)).not.toMatch(/export\s+(?:abstract\s+)?class\s+\w*(Service|Sandbox|Engine|Store|Manager)\b/);
    }
  });
});

describe('application capabilities', () => {
  it('do not value-import another capability', () => {
    expectNoHits(applicationSiblingHits(sources()), 'Inject the collaborator through the constructor and import its type only (import type).');
  });

  it('flags a value import of a sibling use case and allows types, ports and shared contracts', () => {
    const hits = applicationSiblingHits([
      at('src/application/records/a.ts', "import { FileService } from '../files/file-service.js';"),
      at('src/application/records/b.ts', "import { FileService, type FileInfo } from '../files/file-service.js';"),
      at('src/application/records/c.ts', "export { run } from '../actions/action-service.js';"),
      at('src/application/records/d.ts', "const s = await import('../notifications/notification-service.js');"),
      // allowed
      at('src/application/records/e.ts', "import type { FileService } from '../files/file-service.js';"),
      at('src/application/records/f.ts', "import { type FileService, type FileInfo } from '../files/file-service.js';"),
      at('src/application/payments/g.ts', "import { x } from '../actions/ports/action-ports.js';"),
      at('src/application/session/h.ts', "import { can } from '../shared/http-api.js';"),
      at('src/application/records/i.ts', "import { RecordThing } from './record-thing.js';"),
      at('src/application/records/j.ts', "import { can } from '../../domain/permissions.js';"),
      at('src/http/k.ts', "import { FileService } from '../application/files/file-service.js';"),
    ]);
    expect(keysOf(hits)).toEqual([
      'application-sibling: src/application/records/a.ts -> src/application/files/file-service.ts',
      'application-sibling: src/application/records/b.ts -> src/application/files/file-service.ts',
      'application-sibling: src/application/records/c.ts -> src/application/actions/action-service.ts',
      'application-sibling: src/application/records/d.ts -> src/application/notifications/notification-service.ts',
    ]);
  });
});

describe('what http sees of the application', () => {
  it('re-exports nothing from domain or runtime', () => {
    expectNoHits(httpReexportHits(sources()), 'Declare an application-owned type or wrapper instead of re-exporting a lower layer.');
  });

  it('flags value and type re-exports and re-exported bindings, and allows port-owned and local ones', () => {
    const hits = httpReexportHits([
      at('src/application/x/http-api.ts', ["export { fieldSchema } from '../../runtime/records/validator.js';", "export type { A } from '@onengo/kernel/errors';", "export * from '../../domain/permissions.js';", "import { can } from '../../domain/money.js';", 'export { can };'].join('\n')),
      at('src/application/x/service.ts', "export { y } from '../../runtime/records/y.js';"),
      at('src/application/z/other.ts', "export { w } from '../../domain/w.js';"),
      at('src/http/plugins/x.ts', "import { run } from '../../application/x/service.js';"),
      // allowed
      at('src/application/ok/http-api.ts', ["export type { Q } from './ports/q.js';", "export { local } from './local.js';", "import type { R } from '../../runtime/records/r.js';", 'export type Mine = R;', "export type { Other } from '../other/ports/o.js';"].join('\n')),
      at('src/runtime/records/index.ts', "export { y } from '../definitions/y.js';"),
    ]);
    expect(keysOf(hits)).toEqual([
      'http-reexport: src/application/x/http-api.ts -> src/domain/money.ts',
      'http-reexport: src/application/x/http-api.ts -> src/domain/permissions.ts',
      'http-reexport: src/application/x/http-api.ts -> src/runtime/records/validator.ts',
      'http-reexport: src/application/x/service.ts -> src/runtime/records/y.ts',
    ]);
    expect([...hits.values()].every((h) => h.block === 'H')).toBe(true);
  });
});

describe('port files', () => {
  it('hold contracts, not executable values', () => {
    expectNoHits(portValueHits(sources()), 'A /ports/ file holds interfaces, type aliases and declare const brands. Move constants, functions and classes to the domain or runtime module that owns them.');
  });

  it('flags every executable declaration and allows interfaces, aliases, brands and type-only exports', () => {
    const port = (src: string) => portValueHits([at('src/application/x/ports/p.ts', src), at('src/application/x/service.ts', 'export const NOT_A_PORT = 1;')]);
    expect(
      keysOf(
        port(
          [
            'export const K = 1;',
            'export function f() { return 1; }',
            'export class C {}',
            'let state = 0;',
            'export enum E { A }',
            "export { v } from '../v.js';",
            "export * from '../w.js';",
            'init();',
            'export namespace N { export const n = 1; }',
          ].join('\n'),
        ),
      ),
    ).toEqual([
      'port-values: src/application/x/ports/p.ts: class C',
      'port-values: src/application/x/ports/p.ts: const K',
      'port-values: src/application/x/ports/p.ts: enum E',
      'port-values: src/application/x/ports/p.ts: function f',
      'port-values: src/application/x/ports/p.ts: let state',
      'port-values: src/application/x/ports/p.ts: namespace N',
      'port-values: src/application/x/ports/p.ts: statement init()',
      'port-values: src/application/x/ports/p.ts: value re-export ../v.js',
      'port-values: src/application/x/ports/p.ts: value re-export ../w.js',
    ]);
    expect(
      keysOf(
        port(
          [
            "import type { Z } from './z.js';",
            'export interface A { run(): Promise<void> }',
            'export type B = string;',
            'declare const brand: unique symbol;',
            'export type Opaque = string & { readonly [brand]: true };',
            'export declare function h(): void;',
            "export type { T } from '../other.js';",
            "export { type U } from '../other.js';",
            'export type Fn = () => void;',
          ].join('\n'),
        ),
      ),
    ).toEqual([]);
  });

  it('lists no exceptions', () => {
    expect(PORT_VALUE_EXCEPTIONS).toEqual({});
  });
});

describe('allowlist expiry (section 5.1 of the plan)', () => {
  const status = (rows: Record<string, string>) => new Map(Object.entries(rows));
  const entry = (block: string): PlanEntry => ({ reason: 'a reason that is long enough to count', owner: 'runtime/records', removeAfterBlock: block });

  it('reads the block rows of section 5.1 of the plan, including escaped pipes, and stops at the next heading', () => {
    const md = [
      '## 5. Plan',
      '| Block | Status |',
      '| not | this table |',
      '### 5.1 Block status',
      '',
      '| Block | Status | Branch or commit | Notes |',
      '| --- | --- | --- | --- |',
      '| F1 | Merged | `f5b496d` | a \\| b |',
      '| **D** | Not started | x | y |',
      '| A8 | Done (server) | see branch | z |',
      '| M1 web screens | Merged | merge | `<screen> \\| OneNGO` |',
      '',
      '### 5.2 Next',
      '| Q9 | Merged | x | y |',
    ].join('\n');
    expect([...parseBlockStatus(md).entries()]).toEqual([
      ['F1', 'Merged'],
      ['D', 'Not started'],
      ['A8', 'Done (server)'],
      ['M1 web screens', 'Merged'],
    ]);
  });

  it('tells a closed block (Merged or Done) from an open one', () => {
    for (const s of ['Merged', 'Done', 'Done (server, `one-ngo`)', 'Merged into D11', 'Merged, awaiting counsel', 'merged']) expect(isClosed(s), s).toBe(true);
    for (const s of ['Not started', 'In progress (6 parallel blocks)', 'Blocked', 'Review done; findings open', '', undefined, 'Doneness', 'Unmerged']) expect(isClosed(s), String(s)).toBe(false);
  });

  it('fails an entry whose block is Merged or Done, unknown, missing or not approved as open', () => {
    const plan = status({ H: 'Not started', R: 'Merged', D: 'Done (branch)', I: 'In progress', A1: 'Done (server)', G: 'Not started' });
    const entries = {
      'open and approved': entry('H'),
      'merged block': entry('R'),
      'done block': entry('D'),
      'open but not approved': entry('G'),
      'in progress and approved': entry('I'),
      'not a row': entry('Q'),
      'old block': entry('A1'),
      'no block': entry(''),
    };
    expect(expiryProblems(entries, plan, ['H', 'R', 'D', 'I']).map((p) => p.split(':')[0])).toEqual(['merged block', 'done block', 'open but not approved', 'not a row', 'old block', 'no block']);
    expect(expiryProblems(entries, plan, ['H', 'R', 'D', 'I']).find((p) => p.startsWith('merged block'))).toContain('expired');
    expect(expiryProblems(entries, plan, []).length).toBe(8);
    expect(expiryProblems({ ok: entry('H') }, plan, ['H'])).toEqual([]);
  });

  it('has the A rows in section 5.1, all closed', () => {
    const plan = readPlanStatus();
    for (const b of ['A1', 'A8']) expect(plan.has(b), `Section 5.1 has no row ${b}.`).toBe(true);
    expect(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].filter((b) => !isClosed(plan.get(b)))).toEqual([]);
  });
});
