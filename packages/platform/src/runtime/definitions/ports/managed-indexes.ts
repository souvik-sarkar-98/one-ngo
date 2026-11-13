/** hash is the keyed hash a unique sensitive field keeps beside its encrypted value. */
export type IndexCast = 'text' | 'numeric' | 'lower' | 'lat' | 'lng' | 'state' | 'hash';

/** What a managed index covers: one expression over one field of one record type. */
export interface IndexSpec {
  name: string;
  typeKey: string;
  field: string;
  cast: IndexCast;
  unique: boolean;
}

export interface ManagedIndexRow {
  name: string;
  type_key: string;
  field: string;
  cast_as: string;
  kind: string;
}

/** The registry of managed record indexes, shared by every organisation, and the indexes themselves. */
export interface ManagedIndexes {
  /** The statement that creates the index; the same expressions the list query uses, so the database can use it. */
  createStatement(index: IndexSpec, concurrently: boolean): string;
  /** Throws a TypeError when the key could not be written into a statement safely. */
  assertKey(key: string): void;
  /** Adds the indexes as pending, or records that they are still needed. */
  markNeeded(rows: ManagedIndexRow[]): Promise<void>;
  /** Registry status, and whether the index exists in the schema. */
  states(names: string[]): Promise<{ name: string; status: string; present: boolean }[]>;
  markReady(name: string): Promise<void>;
  markFailed(name: string, error: string): Promise<void>;
  /** Indexes no organisation has needed for this many days. */
  unneededFor(days: number): Promise<string[]>;
  forget(name: string): Promise<void>;
  readyAmong(names: string[]): Promise<string[]>;
  uniqueField(name: string): Promise<string | undefined>;
  /** Whether a concurrent build left this index behind invalid. */
  isInvalid(name: string): Promise<boolean>;
  /** Runs one `create … index` or `drop index` statement. */
  runDdl(statement: string): Promise<void>;
}

/** The organisations whose indexes are kept up to date. */
export interface ActiveTenants {
  activeIds(): Promise<string[]>;
}
