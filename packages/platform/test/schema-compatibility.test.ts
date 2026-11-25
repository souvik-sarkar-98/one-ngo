import { describe, expect, it } from 'vitest';
import {
  SCHEMA_LEVEL,
  SERVER_SCHEMA_MINIMUMS,
  assertNoIncompatibleNewerSchema,
  assertSchemaCompatibility,
  type SchemaCompatibility,
} from '../src/infrastructure/postgres/schema-compatibility.js';

const NEXT = SCHEMA_LEVEL + 1;
const status = (over: Partial<SchemaCompatibility> = {}): SchemaCompatibility => ({
  level: SCHEMA_LEVEL,
  newer: [],
  metadataComplete: true,
  ...over,
});

describe('schema compatibility', () => {
  it('publishes explicit levels and per-server minimums', () => {
    expect(SCHEMA_LEVEL).toBe(11);
    expect(SERVER_SCHEMA_MINIMUMS).toEqual({ main: 11, operator: 6 });
  });

  it('refuses a schema below the server minimum', () => {
    expect(() => assertSchemaCompatibility('main', status({ level: 10 }))).toThrow(/below the minimum 11/);
    expect(() => assertSchemaCompatibility('operator', status({ level: 5 }))).toThrow(/below the minimum 6/);
  });

  it('lets deployment upgrade an old schema', () => {
    expect(() => assertNoIncompatibleNewerSchema(status({ level: 0 }))).not.toThrow();
  });

  it('accepts this schema and a newer additive schema', () => {
    expect(() => assertSchemaCompatibility('main', status())).not.toThrow();
    expect(() =>
      assertSchemaCompatibility(
        'main',
        status({ level: NEXT, newer: [{ schemaLevel: NEXT, migrationName: `0${NEXT}_optional_index.sql`, compatibility: 'additive' }] }),
      ),
    ).not.toThrow();
  });

  it('refuses a newer breaking schema and incomplete newer metadata', () => {
    expect(() =>
      assertSchemaCompatibility(
        'main',
        status({ level: NEXT, newer: [{ schemaLevel: NEXT, migrationName: `0${NEXT}_rekey.sql`, compatibility: 'breaking' }] }),
      ),
    ).toThrow(/newer breaking migration/);
    expect(() => assertSchemaCompatibility('main', status({ level: NEXT, metadataComplete: false }))).toThrow(/without compatibility metadata/);
  });
});
