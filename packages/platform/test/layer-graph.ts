import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * The source-dependency graph of src/ and the final layer rules (section 10.1 of
 * docs/architecture/ngo-backend-enhancement-plan.md). Imports are read with the TypeScript compiler
 * API, so imports, re-exports, dynamic `import()` and `import('x')` types are all seen, and a
 * type-only import is told apart from a value import.
 *
 *   http            -> http, application
 *   application     -> application, runtime, domain, shared
 *   runtime         -> runtime, domain, shared
 *   domain          -> domain (including domain-owned ports), shared
 *   shared          -> shared (the pure rules the web app runs too; no Node, no other layer)
 *   infrastructure  -> infrastructure, and the port files (`.../ports/...`) of the core, type-only
 *   composition     -> everything (src/composition/: the per-capability wiring that platform.ts calls)
 *   platform.ts     -> everything (the composition root)
 *   other root entry points -> platform.ts, composition and their sibling root files (main.ts also reaches http)
 *   only the entry points (main, deploy, prepare-deployment, organisation) and platform.ts may import composition
 */

export interface Source {
  path: string;
  src: string;
}

export interface Edge {
  from: string;
  to: string;
  /** True when every import of `to` in `from` is type-only. */
  typeOnly: boolean;
}

export const ROOT = join(import.meta.dirname, '..');

export const CORE = ['application', 'runtime', 'domain'] as const;
export const LAYERS = ['api', 'http', 'application', 'runtime', 'domain', 'shared', 'infrastructure', 'composition'] as const;
/** Root files that may import composition: platform.ts, and the process entry points that build what they run from it. */
export const COMPOSITION_USERS = ['src/platform.ts', 'src/prepare-deployment.ts', 'src/api/operator.ts'] as const;
const SOURCE_FILE = /\.(ts|mts|cts)$/;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : SOURCE_FILE.test(f) ? [p] : [];
  });
}

export const sources = (): Source[] => files(join(ROOT, 'src')).map((p) => ({ path: relative(ROOT, p).split(sep).join('/'), src: readFileSync(p, 'utf8') }));

/** `src/http/x.ts` -> `http`; `src/platform.ts` -> `platform.ts`; outside src -> null. */
export function layerOf(path: string): string | null {
  if (!path.startsWith('src/')) return null;
  return path.slice(4).split('/')[0]!;
}

export const isRootFile = (path: string) => layerOf(path) !== null && !path.slice(4).includes('/');
export const isPort = (path: string) => path.includes('/ports/');

/** `src/runtime/records/x.ts` -> `runtime/records`; a root file -> `root`. */
export function ownerOf(path: string): string {
  if (isRootFile(path)) return 'root';
  const [layer, capability] = path.slice(4).split('/');
  if (!capability || capability.endsWith('.ts')) return layer!;
  return `${layer}/${capability}`;
}

function specifiers(sf: ts.SourceFile): { text: string; typeOnly: boolean }[] {
  const out: { text: string; typeOnly: boolean }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const clause = n.importClause;
      const named = clause?.namedBindings;
      const allTyped = !!clause && !clause.name && !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
      out.push({ text: n.moduleSpecifier.text, typeOnly: !!clause && (clause.isTypeOnly || allTyped) });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const named = n.exportClause;
      const allTyped = !!named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
      out.push({ text: n.moduleSpecifier.text, typeOnly: n.isTypeOnly || allTyped });
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      out.push({ text: n.argument.literal.text, typeOnly: true });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      out.push({ text: n.moduleReference.expression.text, typeOnly: n.isTypeOnly });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      out.push({ text: n.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const toTs = (p: string) => p.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts');

/** Every relative import between files of src/, one edge per (from, to). */
export function collectEdges(all: Source[]): Edge[] {
  const edges = new Map<string, Edge>();
  for (const f of all) {
    const sf = ts.createSourceFile(f.path, f.src, ts.ScriptTarget.ES2023, true);
    for (const s of specifiers(sf)) {
      if (!s.text.startsWith('.')) continue;
      const to = toTs(posix.normalize(posix.join(posix.dirname(f.path), s.text)));
      if (!to.startsWith('src/') || to === f.path) continue;
      const key = `${f.path} -> ${to}`;
      const seen = edges.get(key);
      if (seen) seen.typeOnly &&= s.typeOnly;
      else edges.set(key, { from: f.path, to, typeOnly: s.typeOnly });
    }
  }
  return [...edges.values()];
}

/** Why the edge breaks the layer table, or null when the table allows it. */
export function breaks(e: Edge): string | null {
  if (e.from === 'src/platform.ts') return null;
  const from = layerOf(e.from)!;
  const to = layerOf(e.to);
  if (to === null) return 'imports outside src/';
  if (from === 'api') return null;
  if (from === 'composition') return null;
  if (to === 'composition' && !(COMPOSITION_USERS as readonly string[]).includes(e.from)) {
    return `${isRootFile(e.from) ? e.from.slice(4) : from} imports composition; only platform.ts and the entry points (main, deploy, prepare-deployment, organisation) may`;
  }
  if (isRootFile(e.from)) {
    if (e.to === 'src/platform.ts' || isRootFile(e.to) || to === 'api' || to === 'composition') return null;
    if (e.from === 'src/main.ts' && to === 'http') return null;
    return `entry point imports ${to === 'infrastructure' || to === 'http' || CORE.includes(to as never) ? to : e.to} directly; it should reach it through platform.ts or composition`;
  }
  if (to === from) return null;
  switch (from) {
    case 'http':
      if (e.to === 'src/platform.ts') return 'http imports Platform; it should receive an application-facing bundle';
      if (to === 'application') return null;
      return `http imports ${to}; it may reach application only`;
    case 'application':
      if (to === 'runtime' || to === 'domain' || to === 'shared') return null;
      return `application imports ${isRootFile(e.to) ? e.to.slice(4) : to}; it may reach runtime, domain and shared only`;
    case 'runtime':
      if (to === 'domain' || to === 'shared') return null;
      return `runtime imports ${isRootFile(e.to) ? e.to.slice(4) : to}; it may reach domain and shared only`;
    case 'domain':
      if (to === 'shared') return null;
      return `domain imports ${isRootFile(e.to) ? e.to.slice(4) : to}; it may reach domain and shared only`;
    case 'shared':
      return `shared imports ${isRootFile(e.to) ? e.to.slice(4) : to}; it may reach shared only`;
    case 'infrastructure':
      if (CORE.includes(to as never) && isPort(e.to)) return e.typeOnly ? null : 'infrastructure imports a core port as a value; the import must be type-only';
      return `infrastructure imports ${isRootFile(e.to) ? e.to.slice(4) : to}${CORE.includes(to as never) ? ' beyond its ports' : ''}; it may implement core ports (type-only) only`;
    default:
      return `unknown layer ${from}`;
  }
}

/** The block of the plan that clears an edge, by where it starts. */
export function removeAfterBlock(e: Edge): string {
  const from = layerOf(e.from)!;
  if (from === 'http') return 'A2';
  if (isRootFile(e.from)) return 'A7';
  if (from === 'infrastructure') return 'A6';
  if (from === 'domain') return 'A5';
  const capability = e.from.split('/')[2] ?? '';
  if (from === 'runtime') return capability === 'records' ? 'A3' : 'A4';
  if (['actions', 'records', 'files', 'notifications', 'connectors'].includes(capability)) return 'A3';
  if (capability === 'definitions') return 'A4';
  return 'A5';
}

/** Edges that break the table, by `from -> to`. */
export function violations(all: Source[]): Map<string, { edge: Edge; why: string }> {
  const out = new Map<string, { edge: Edge; why: string }>();
  for (const edge of collectEdges(all)) {
    const why = breaks(edge);
    if (why) out.set(`${edge.from} -> ${edge.to}`, { edge, why });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Conformance rules (block G). Each rule returns hits keyed `<rule>: <detail>`. There are no hits
// today, and any hit fails its test (see docs/architecture/guardrail-violations.md).
// ---------------------------------------------------------------------------------------------

/** Blocks that own a rule: H http->application, R runtime/application siblings, D domain purity, I infrastructure, C composition. */
export type PendingBlock = 'H' | 'R' | 'D' | 'I' | 'C';
export interface Hit {
  why: string;
  block: PendingBlock;
}
export type Hits = Map<string, Hit>;

export const RULE = {
  runtime: 'runtime-sibling',
  application: 'application-sibling',
  http: 'http-reexport',
  ports: 'port-values',
  persistence: 'persistence',
  composition: 'composition',
} as const;

/** `from` + a relative specifier, resolved to a `src/...ts` path (null when it leaves src/ or is a package). */
export function resolveSpecifier(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const to = toTs(posix.normalize(posix.join(posix.dirname(from), spec)));
  return to.startsWith('src/') ? to : null;
}

const parse = (f: Source) => ts.createSourceFile(f.path, f.src, ts.ScriptTarget.ES2023, true);
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Pure helpers one runtime capability may import from a sibling (section 10.1: "pure shared contracts").
 * Pure means: no I/O, no stores, no service class, no state. A sibling's service class (RecordService,
 * DefinitionService, ScriptSandbox, ApprovalService ...) is never on this list. Types files (`types.ts`),
 * everything under `ports/` and everything under `runtime/expressions/` are allowed without being listed.
 */
export const RUNTIME_PURE_HELPERS: Record<string, string> = {
  'src/runtime/definitions/field-permissions.ts': 'Pure permission checks and masking over a definition and an actor; no state.',
  'src/runtime/definitions/workflows.ts': 'Pure helpers that read workflow definitions (primary, approver, step lookup).',
  'src/runtime/definitions/list-params.ts': 'Pure parsing and validation of list and paging parameters.',
  'src/runtime/definitions/number-format.ts': 'Pure number-pattern formatting.',
  'src/runtime/automation/limits.ts': 'The depth at which a chain of record events stops.',
  'src/runtime/definitions/field-pattern.ts': 'Pure field-pattern check; runs the pattern in an isolated vm context, no state.',
  'src/runtime/definitions/cron.ts': 'Pure cron schedule parser.',
  'src/runtime/definitions/script-inputs.ts': 'Pure limits and checks for declared script inputs.',
};

/** `src/application/shared/` is the shared contract module of the application layer (context, errors, logger), not a use case. */
export const APPLICATION_SHARED_PREFIX = 'src/application/shared/';

const inLayer = (p: string, layer: string) => p.startsWith(`src/${layer}/`);

/** runtime/<a> -> runtime/<b>: only types.ts, ports/, expressions and RUNTIME_PURE_HELPERS. */
export function runtimeSiblingHits(all: Source[]): Hits {
  const out: Hits = new Map();
  for (const e of collectEdges(all)) {
    if (!inLayer(e.from, 'runtime') || !inLayer(e.to, 'runtime') || ownerOf(e.from) === ownerOf(e.to)) continue;
    if (baseName(e.to) === 'types.ts' || isPort(e.to) || inLayer(e.to, 'runtime/expressions') || e.to in RUNTIME_PURE_HELPERS) continue;
    out.set(`${RULE.runtime}: ${e.from} -> ${e.to}`, {
      why: `${ownerOf(e.from)} ${e.typeOnly ? 'type-imports' : 'imports'} ${e.to.slice(4)} of ${ownerOf(e.to)}; siblings share only types.ts, ports/, expressions and listed pure helpers`,
      block: 'R',
    });
  }
  return out;
}

/** application/<a> -> application/<b>: value imports only of ports/ and application/shared; type-only imports are allowed. */
export function applicationSiblingHits(all: Source[]): Hits {
  const out: Hits = new Map();
  for (const e of collectEdges(all)) {
    if (!inLayer(e.from, 'application') || !inLayer(e.to, 'application') || ownerOf(e.from) === ownerOf(e.to)) continue;
    if (e.typeOnly || isPort(e.to) || e.to.startsWith(APPLICATION_SHARED_PREFIX)) continue;
    out.set(`${RULE.application}: ${e.from} -> ${e.to}`, {
      why: `${ownerOf(e.from)} value-imports ${e.to.slice(4)} of ${ownerOf(e.to)}; inject it through the constructor and import its type only`,
      block: 'R',
    });
  }
  return out;
}

/**
 * Application files the HTTP layer sees: everything http imports, every `http-api.ts`, and application/shared.
 * They may not re-export anything from domain or runtime, value or type-only: a type re-export still makes http
 * depend on a lower layer's type. Decision (default of block G): reject all of them; the application declares
 * its own interface or alias, and types of a port stay with the port.
 */
export function httpReexportHits(all: Source[]): Hits {
  const out: Hits = new Map();
  const seenByHttp = new Set(collectEdges(all).filter((e) => inLayer(e.from, 'http') && inLayer(e.to, 'application')).map((e) => e.to));
  for (const f of all) {
    if (!inLayer(f.path, 'application')) continue;
    if (!(seenByHttp.has(f.path) || baseName(f.path) === 'http-api.ts' || f.path.startsWith(APPLICATION_SHARED_PREFIX))) continue;
    const lower = (target: string | null) => (target && (inLayer(target, 'domain') || inLayer(target, 'runtime')) ? target : null);
    const imported = new Map<string, string>();
    const note = (target: string, names: string[], typed: boolean) => {
      out.set(`${RULE.http}: ${f.path} -> ${target}`, {
        why: `${f.path.slice(4)} re-exports ${typed ? 'types' : 'values'} (${names.join(', ')}) of ${layerOf(target)} to http; declare an application-owned type or wrapper`,
        block: 'H',
      });
    };
    for (const n of parse(f).statements) {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
        const target = lower(resolveSpecifier(f.path, n.moduleSpecifier.text));
        const c = n.importClause;
        if (target) {
          if (c.name) imported.set(c.name.text, target);
          if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) imported.set(c.namedBindings.name.text, target);
          if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) imported.set(el.name.text, target);
        }
      } else if (ts.isExportDeclaration(n)) {
        const names = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((el) => el.name.text) : ['*'];
        if (n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
          const target = lower(resolveSpecifier(f.path, n.moduleSpecifier.text));
          if (target) note(target, names, n.isTypeOnly);
        } else if (n.exportClause && ts.isNamedExports(n.exportClause)) {
          for (const el of n.exportClause.elements) {
            const target = imported.get((el.propertyName ?? el.name).text);
            if (target) note(target, [el.name.text], n.isTypeOnly || el.isTypeOnly);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Executable values a /ports/ file may keep, as `path::name` -> reason. Empty: a port file holds interfaces,
 * type aliases, `declare const` brand symbols and type-only exports; its constants, functions and classes move
 * to the owning domain or runtime module (section 10.1).
 */
export const PORT_VALUE_EXCEPTIONS: Record<string, string> = {};

/** Executable top-level statements of every /ports/ file under src/, except `declare`d ones and PORT_VALUE_EXCEPTIONS. */
export function portValueHits(all: Source[]): Hits {
  const out: Hits = new Map();
  for (const f of all) {
    if (!isPort(f.path)) continue;
    const add = (kind: string, name: string, block: PendingBlock = 'D') => {
      if (`${f.path}::${name}` in PORT_VALUE_EXCEPTIONS) return;
      out.set(`${RULE.ports}: ${f.path}: ${kind} ${name}`, {
        why: block === 'I' ? `port file re-exports a value (${name}); the owner of the value exports it, callers import it there` : `port file declares an executable ${kind} (${name}); move it to the domain or runtime module that owns it`,
        block,
      });
    };
    const declared = (n: ts.Node) => !!ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
    for (const n of parse(f).statements) {
      if (ts.isVariableStatement(n) && !declared(n)) {
        const kind = n.declarationList.flags & ts.NodeFlags.Const ? 'const' : n.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
        for (const d of n.declarationList.declarations) add(kind, d.name.getText());
      } else if (ts.isFunctionDeclaration(n) && n.body && !declared(n)) add('function', n.name?.text ?? 'default');
      else if (ts.isClassDeclaration(n) && !declared(n)) add('class', n.name?.text ?? 'default');
      else if (ts.isEnumDeclaration(n) && !declared(n)) add('enum', n.name.text);
      else if (ts.isModuleDeclaration(n) && !declared(n)) add('namespace', n.name.getText());
      else if (ts.isExportAssignment(n)) add('export default', 'default');
      else if (ts.isExpressionStatement(n)) add('statement', n.expression.getText().slice(0, 30));
      else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const allTyped = !!n.exportClause && ts.isNamedExports(n.exportClause) && n.exportClause.elements.every((el) => el.isTypeOnly);
        if (!n.isTypeOnly && !allTyped) add('value re-export', n.moduleSpecifier.text, 'I');
      }
    }
  }
  return out;
}

const TRANSACTION_CALLS = new Set(['withTenant', 'asSystem', 'asTx', 'joinTx', 'transaction']);
const REQUEST_NAMES = new Set(['req', 'reply', 'request']);

/**
 * src/composition/ is wiring only: no transaction, no audit write, no request handling. Hits are counted per
 * file and kind, so one more call in a file with pending work still fails.
 */
export function compositionHits(all: Source[]): Hits {
  const out: Hits = new Map();
  for (const f of all) {
    if (!inLayer(f.path, 'composition')) continue;
    const counts = new Map<string, number>();
    const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (TRANSACTION_CALLS.has(name)) bump(`transaction call ${name}`);
        if (ts.isPropertyAccessExpression(callee) && (name === 'audit' || name === 'event')) {
          const receiver = ts.isIdentifier(callee.expression) ? callee.expression.text : ts.isPropertyAccessExpression(callee.expression) ? callee.expression.name.text : '';
          if (receiver === 'audit') bump(`audit write audit.${name}`);
        }
      } else if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        if (n.moduleSpecifier.text === 'fastify' || n.moduleSpecifier.text.startsWith('@fastify/')) bump(`request handling import ${n.moduleSpecifier.text}`);
      } else if (ts.isParameter(n) && ts.isIdentifier(n.name) && REQUEST_NAMES.has(n.name.text)) bump(`request handling parameter ${n.name.text}`);
      else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && REQUEST_NAMES.has(n.expression.text)) bump(`request handling use of ${n.expression.text}`);
      ts.forEachChild(n, visit);
    };
    visit(parse(f));
    for (const [kind, n] of counts) {
      out.set(`${RULE.composition}: ${f.path}: ${kind} x${n}`, { why: `composition is wiring only; ${kind} (${n}x) belongs in an application use case or an infrastructure adapter`, block: 'C' });
    }
  }
  return out;
}

/** Every conformance rule that reads src/ through the import graph or syntax tree. (The persistence rule lives in test/persistence-graph.ts.) */
export function conformanceHits(all: Source[]): Hits {
  return new Map([...runtimeSiblingHits(all), ...applicationSiblingHits(all), ...httpReexportHits(all), ...portValueHits(all), ...compositionHits(all)]);
}
