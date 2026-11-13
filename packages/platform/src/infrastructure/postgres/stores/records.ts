import type { RecordStores } from '../../../runtime/records/ports/record-stores.js';
import { PgPersonDirectory } from './person-directory.js';
import { PgRecordQueries } from './record-queries.js';
import { PgRecordStore } from './record-store.js';
import { PgShareStore } from './share-store.js';
import type { PostgresSequenceStore } from './sequence-store.js';

/** The PostgreSQL stores of the record engine. */
export function postgresRecordStores(sequences: PostgresSequenceStore): RecordStores {
  return { records: new PgRecordStore(sequences), queries: new PgRecordQueries(), people: new PgPersonDirectory(), shares: new PgShareStore() };
}
