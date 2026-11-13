import { sql } from 'kysely';
import type { Database } from './db.js';
import { typed } from './kysely.js';

export const SCHEMA_LEVEL = 19;

/** Oldest schema each independently deployed server may safely use. */
export const SERVER_SCHEMA_MINIMUMS = {
  main: 5,
  operator: 6,
} as const;

export type ServerKind = keyof typeof SERVER_SCHEMA_MINIMUMS;
export type MigrationCompatibility = 'additive' | 'breaking';

export interface SchemaCompatibilityRow {
  schemaLevel: number;
  migrationName: string;
  compatibility: MigrationCompatibility;
}

export interface SchemaCompatibility {
  level: number;
  newer: SchemaCompatibilityRow[];
  metadataComplete: boolean;
}

export function assertSchemaCompatibility(server: ServerKind, status: SchemaCompatibility): void {
  const minimum = SERVER_SCHEMA_MINIMUMS[server];
  if (status.level < minimum) {
    throw new Error(`Database schema level ${status.level} is below the minimum ${minimum} required by the ${server} server. Run the deploy step first.`);
  }
  assertNoIncompatibleNewerSchema(status);
}

/** Deploy may upgrade an old schema, but must never run an old migrator over an incompatible newer one. */
export function assertNoIncompatibleNewerSchema(status: SchemaCompatibility): void {
  const breaking = status.newer.filter((row) => row.compatibility === 'breaking');
  if (breaking.length) {
    throw new Error(
      `Database schema has newer breaking migration(s) (${breaking.map((row) => row.migrationName).join(', ')}). Deploy this server version or a later one.`,
    );
  }
  if (!status.metadataComplete) {
    throw new Error('Database schema has newer migration(s) without compatibility metadata. Deploy this server version or a later one.');
  }
}

const levelOf = (name: string): number => Number(/^(\d+)_/.exec(name)?.[1] ?? 0);

/** Reads migration history and compatibility metadata without modifying the database. */
export async function readSchemaCompatibility(db: Database, unknownMigrations: readonly string[]): Promise<SchemaCompatibility> {
  const applied = await db.asSystem((tx) =>
    sql<{ name: string }>`
      select name
      from kysely_migration
      order by name
    `
      .execute(typed(tx))
      .then((result) => result.rows)
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '42P01') return [];
        throw error;
      }),
  );
  const level = Math.max(0, ...applied.map((row) => levelOf(row.name)));
  if (!unknownMigrations.length) return { level, newer: [], metadataComplete: true };

  const metadata = await db.asSystem((tx) =>
    sql<{ schema_level: number; migration_name: string; compatibility: MigrationCompatibility }>`
      select schema_level, migration_name, compatibility
      from schema_compatibility
      where migration_name in (${sql.join(unknownMigrations)})
      order by schema_level
    `
      .execute(typed(tx))
      .then((result) => result.rows)
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '42P01') return [];
        throw error;
      }),
  );
  return {
    level,
    newer: metadata.map((row) => ({
      schemaLevel: Number(row.schema_level),
      migrationName: row.migration_name,
      compatibility: row.compatibility,
    })),
    metadataComplete: metadata.length === unknownMigrations.length,
  };
}
