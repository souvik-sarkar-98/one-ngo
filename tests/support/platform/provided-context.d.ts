import 'vitest';

/** What global-setup.ts provides to every integration test (and to the contract harness in src). */
declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
    /** Every test world's schema name starts with this; unique to one run. */
    testSchemaPrefix: string;
  }
}
