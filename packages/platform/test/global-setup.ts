import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { dropSchemas, prepareTestDatabase } from './test-database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
    /** Every test world's schema name starts with this; unique to one run. */
    testSchemaPrefix: string;
  }
}

/**
 * Creates the test database and the database-wide objects the migrations need
 * once per run (test/test-database.ts). Each test world then migrates its own
 * schema (test/helpers.ts).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = await prepareTestDatabase();
  const prefix = `ngo_t_${randomBytes(3).toString('hex')}_`;
  project.provide('testDatabaseUrl', url);
  project.provide('testSchemaPrefix', prefix);
  return () => dropSchemas(url, prefix);
}
