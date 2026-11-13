import { RULE, ROOT, sources as allSources, type Hits, type Source } from './layer-graph.js';

/**
 * Persistence rule (section 10.2 of docs/architecture/ngo-backend-enhancement-plan.md): Kysely and the SQL
 * executor types stay in the infrastructure layer and in the files that wire it in. src/domain/ports/ is no
 * longer exempt (block G): SQL executor types declared or used there are reported like any other.
 */
export const PERSISTENCE_ALLOWLIST_FILE = `${ROOT}/test/persistence-allowlist.json`;

/** Where Kysely and the SQL executor may appear: the infrastructure layer (PostgreSQL provider and its support), and the files that wire them in. */
export const PROVIDER = /^src\/infrastructure\//;
export const COMPOSITION_ROOTS = new Set(['src/platform.ts', 'src/prepare-deployment.ts']);

export const SQL_TYPES = new Set(['SqlExecutor', 'SqlResult', 'Database', 'joinTransaction', 'MigratorTarget']);

/** Modules the SQL executor types are imported from: the PostgreSQL provider and the old domain port that still declares them. */
const SQL_MODULES = /(?:postgres\/db|ports\/database|\.\/database)\.js/;

/** Why `src` reaches the database directly, or null when it only uses ports. */
export function coupling(src: string): string | null {
  if (/\bfrom\s+['"]kysely['"]/.test(src)) return "imports 'kysely'";
  if (/\bfrom\s+['"][^'"]*postgres\/(kysely|db-types)\.js['"]/.test(src)) return 'imports postgres/kysely or postgres/db-types';
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]*)['"]/g)) {
    if (!SQL_MODULES.test(m[2]!)) continue;
    const names = m[1]!.split(',').map((n) => n.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0]!.trim());
    const hit = names.find((n) => SQL_TYPES.has(n));
    if (hit) return `imports ${hit} from ${m[2]!.includes('postgres/db') ? 'postgres/db' : 'domain/ports/database'}`;
  }
  const declared = src.match(/^\s*export\s+(?:interface|type|class)\s+(SqlExecutor|SqlResult|Database|MigratorTarget)\b/m);
  if (declared) return `declares ${declared[1]}`;
  return null;
}

export function coupled(all: Source[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of all) {
    if (PROVIDER.test(f.path) || COMPOSITION_ROOTS.has(f.path) || f.path.startsWith('src/composition/')) continue;
    const why = coupling(f.src);
    if (why) out[f.path] = why;
  }
  return out;
}

/** The persistence hits, as pending-list keys. */
export function persistenceHits(all: Source[] = allSources()): Hits {
  return new Map(
    Object.entries(coupled(all)).map(([path, why]) => [
      `${RULE.persistence}: ${path}`,
      { why: `${why}; the SQL executor and transaction types move to infrastructure behind store ports`, block: 'D' as const },
    ]),
  );
}
