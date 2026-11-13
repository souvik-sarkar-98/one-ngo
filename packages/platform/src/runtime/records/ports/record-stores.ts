import type { RecordQueries } from './record-query.js';
import type { RecordStore } from './record-store.js';
import type { PersonDirectory } from './person-directory.js';
import type { ShareStore } from './share-store.js';

/** The stores the record engine works through. */
export interface RecordStores {
  records: RecordStore;
  queries: RecordQueries;
  people: PersonDirectory;
  shares: ShareStore;
}
