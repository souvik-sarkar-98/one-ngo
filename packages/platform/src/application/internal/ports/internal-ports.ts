import type { ApplicationError } from '../../shared/http-api.js';

/** What the host-facing routes ask of the application. */

/** Finds the field a unique index guards, so a duplicate-value rejection can name it. */
export interface UniqueFieldLookup {
  uniqueField(indexName: string): Promise<string | undefined>;
}

/** A database rejection explained as the answer a client gets. */
export interface DatabaseRejection {
  mapped: ApplicationError;
  code: string;
  constraint?: string;
  message: string;
}

/** Explains a database rejection as the answer a client gets, when it is one the application knows. */
export interface RejectionExplainer {
  explain(error: unknown): Promise<DatabaseRejection | undefined>;
}
