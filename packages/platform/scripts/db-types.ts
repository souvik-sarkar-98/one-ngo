// `npm run db:types` writes src/infrastructure/postgres/db-types.ts with kysely-codegen.
// `npm run db:types -- --verify` fails when the checked-in file is stale.
// The migrations run on a schema of a throwaway database of its own; kysely-codegen reads that schema, then the database is dropped.
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cli } from 'kysely-codegen';
import { migrate, PgDatabase } from '@onengo/platform/testing';
import { dropDatabase, prepareDatabase, typesDatabaseUrl, waitForNoConnections, withClient } from '../test/test-database.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = join(PACKAGE_ROOT, '.kysely-codegenrc.json');
export const TYPES_FILE = join(PACKAGE_ROOT, 'src/infrastructure/postgres/db-types.ts');

export interface DbTypesOptions {
  /** Throwaway schema name; random when absent. */
  schema?: string;
  migrationsDir?: string;
  /** Compare with the file instead of writing it; rejects when they differ. */
  verify?: boolean;
}

/** Migrates a schema of a throwaway database, runs kysely-codegen on it and drops the database. Returns the generated text. */
export async function generateDbTypes(options: DbTypesOptions = {}): Promise<string> {
  const schema = options.schema ?? `ngo_types_${randomBytes(5).toString('hex')}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Invalid schema name '${schema}'.`);
  const url = await prepareDatabase(typesDatabaseUrl());
  await withClient(url, (c) => c.query(`create schema ${schema}`));
  try {
    const db = new PgDatabase({ connectionString: url, schema, maxConnections: 1 });
    try {
      await migrate(db, options.migrationsDir ?? join(PACKAGE_ROOT, 'migrations'));
    } finally {
      await db.close();
    }
    const argv = ['--config-file', CONFIG_FILE, '--url', url, '--default-schema', schema, '--include-pattern', `${schema}.*`, '--out-file', TYPES_FILE];
    return await new Cli().run({ argv: options.verify ? [...argv, '--verify'] : argv });
  } finally {
    // kysely-codegen closes its own pool; dropping while it is still closing resets those connections.
    await waitForNoConnections(url);
    await dropDatabase(url);
  }
}

async function main(argv: string[]): Promise<void> {
  const verify = argv.includes('--verify');
  const schemaAt = argv.indexOf('--schema');
  await generateDbTypes({ verify, ...(schemaAt >= 0 ? { schema: argv[schemaAt + 1] } : {}) });
  console.log(verify ? `${TYPES_FILE} is up to date.` : `Wrote ${TYPES_FILE}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      if (process.argv.includes('--verify')) console.error('Run `npm run db:types` and commit src/infrastructure/postgres/db-types.ts.');
      process.exit(1);
    },
  );
}
