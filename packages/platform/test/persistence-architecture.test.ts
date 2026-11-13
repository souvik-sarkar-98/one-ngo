import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULE, sources } from './layer-graph.js';
import { coupled, coupling, PERSISTENCE_ALLOWLIST_FILE, persistenceHits } from './persistence-graph.js';

/**
 * Kysely and the SQL executor stay in the infrastructure layer and the files that wire it in
 * (test/persistence-graph.ts). src/domain/ports/ is no longer exempt (block G): the SQL executor types it
 * declares and uses are Block D's work.
 */
const readAllowlist = (): Record<string, string> => JSON.parse(readFileSync(PERSISTENCE_ALLOWLIST_FILE, 'utf8')) as Record<string, string>;

describe('persistence ports', () => {
  it('keeps test/persistence-allowlist.json exact (it is empty)', () => {
    const found = coupled(sources());
    expect(
      Object.keys(readAllowlist()).filter((p) => !found[p]),
      'Moved behind a port: remove these from test/persistence-allowlist.json.',
    ).toEqual([]);
  });

  it('keeps Kysely and the SQL executor out of core code', () => {
    const allowlist = readAllowlist();
    const hits = [...persistenceHits(sources())].filter(([k]) => !allowlist[k.slice(RULE.persistence.length + 2)]).map(([k]) => k);
    expect(hits, 'Use a store port and put the queries in src/infrastructure/postgres/.').toEqual([]);
  });

  it('does not exempt src/domain/ports/: SQL executor types declared or used there are reported, and none are left', () => {
    const found = coupled([
      { path: 'src/domain/ports/example.ts', src: 'export interface SqlExecutor {\n  query(): void;\n}' },
      { path: 'src/domain/ports/other.ts', src: "import type { Database } from '../../infrastructure/postgres/db.js';" },
    ]);
    expect(found['src/domain/ports/example.ts']).toMatch(/declares/);
    expect(found['src/domain/ports/other.ts']).toMatch(/Database/);
    expect(Object.keys(coupled(sources())).filter((p) => p.startsWith('src/domain/ports/'))).toEqual([]);
  });

  it('flags each kind of direct database access', () => {
    expect(coupling("import { sql } from 'kysely';")).toMatch(/kysely/);
    expect(coupling("import { typed } from '../../infrastructure/postgres/kysely.js';")).toMatch(/postgres\/kysely/);
    expect(coupling("import type { DB } from '../infrastructure/postgres/db-types.js';")).toMatch(/db-types/);
    expect(coupling("import { systemActor, type SqlExecutor } from '../infrastructure/postgres/db.js';")).toBe('imports SqlExecutor from postgres/db');
    expect(coupling("import type { Database } from '../infrastructure/postgres/db.js';")).toBe('imports Database from postgres/db');
    expect(coupling("import { systemActor, type TenantContext } from '../infrastructure/postgres/db.js';")).toBeNull();
    expect(coupling("import type { Tx, TransactionManager } from '../domain/ports/transaction.js';")).toBeNull();
  });

  it('flags the SQL executor types of the old domain port, however they are imported or declared', () => {
    expect(coupling("import type { Database, SqlExecutor, TransactionOptions } from './database.js';")).toBe('imports Database from domain/ports/database');
    expect(coupling("import type { SqlExecutor } from '../domain/ports/database.js';")).toBe('imports SqlExecutor from domain/ports/database');
    expect(coupling('export interface SqlExecutor {\n  query(): void;\n}')).toBe('declares SqlExecutor');
    expect(coupling('export interface MigratorTarget {}')).toBe('declares MigratorTarget');
    expect(coupling("import type { TransactionOptions } from './database.js';")).toBeNull();
    expect(coupling('export interface DatabaseCapabilities {}')).toBeNull();
  });
});