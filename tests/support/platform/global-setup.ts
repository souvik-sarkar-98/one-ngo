import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { dropSchemas, prepareTestDatabase } from './test-database.js';

/**
 * Creates the test database and the database-wide objects the migrations need
 * once per run (tests/support/platform/test-database.ts). Each test world then migrates its own
 * schema (tests/support/platform/helpers.ts).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = await prepareTestDatabase();
  const prefix = `ngo_t_${randomBytes(3).toString('hex')}_`;
  project.provide('testDatabaseUrl', url);
  project.provide('testSchemaPrefix', prefix);
  return () => dropSchemas(url, prefix);
}
