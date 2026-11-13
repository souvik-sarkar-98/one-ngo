import type { DefinitionStore } from '../../runtime/definitions/ports/definition-store.js';
import type { LedgerStore } from '../../domain/ledger/ports/ledger-store.js';
import type { ReceiptStore } from '../../domain/receipts/ports/receipt-store.js';
import type { FileCatalog } from '../../application/files/ports/file-catalog.js';
import type { ShareStore } from '../../runtime/records/ports/share-store.js';
import type { TenantContext } from '../postgres/db.js';
import type { DatabaseCapabilities } from '../../domain/ports/database-capabilities.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { RecordQueries } from '../../runtime/records/ports/record-query.js';
import type { RecordStore } from '../../runtime/records/ports/record-store.js';

/**
 * What a database provider hands the contract suite. PostgreSQL supplies
 * postgres/fixture.ts; a new provider supplies its own and runs the same
 * `defineProviderContract`.
 */
export interface ProviderUnderTest {
  name: string;
  capabilities: DatabaseCapabilities;
  /** An isolated, fully migrated database (or schema) with no organisations yet. */
  open(): Promise<ProviderWorld>;
  migrations: MigrationRunnerUnderTest;
}

export interface ProviderWorld {
  transactions: TransactionManager;
  /** Transactions that all join the open 	x of 	enantId. */
  joinTx(tenantId: string, tx: Tx): TransactionManager;
  /** A new active organisation; its id. */
  newTenant(): Promise<string>;
  stores: ProviderStores;
  /** A fresh job queue on this database, sharing its jobs with every other queue opened here. */
  jobs(): JobQueueUnderTest;
  /** A fresh outbox dispatcher on this database. */
  outbox(): OutboxDispatcherUnderTest;
  indexes: IndexManagerUnderTest;
  bypass: BypassHandle;
  /** Why the database refused a write. */
  refusal(error: unknown): Refusal;
  close(): Promise<void>;
}

/** The persistence ports of section 11.3 that already exist, as this provider implements them. */
export interface ProviderStores {
  records: RecordStore;
  queries: RecordQueries;
  shares: ShareStore;
  files: FileCatalog;
  definitions: DefinitionStore;
  ledger: LedgerStore;
  receipts: ReceiptStore;
}

/**
 * `duplicate`: a unique rule. `rule`: a financial or check rule the database enforces.
 * `isolation`: a row of another organisation. `other`: anything else.
 */
export type Refusal = 'duplicate' | 'rule' | 'isolation' | 'other';

/** Job queue: append, claim with a lease, complete, fail, cancel, resume. Not yet a port (infrastructure/jobs/jobs.ts). */
export interface JobQueueUnderTest {
  register<I, S>(kind: string, def: JobKindUnderTest<I, S>): void;
  create(ctx: TenantContext, kind: string, input: Record<string, unknown>): Promise<JobViewUnderTest>;
  get(ctx: TenantContext, id: string): Promise<JobViewUnderTest>;
  cancel(ctx: TenantContext, id: string): Promise<JobViewUnderTest>;
  /** Claims and works runnable jobs until none remain or the budget runs out. */
  runOnce(options?: { timeBudgetMs?: number }): Promise<{ jobs: number; batches: number }>;
}

export interface JobKindUnderTest<I, S> {
  label: string;
  exclusive?: boolean;
  batchSize?: number;
  run(job: { ctx: TenantContext; jobId: string; input: I; state: S; batchSize: number }): Promise<{
    state: S;
    progress: number;
    total?: number;
    done: boolean;
    result?: Record<string, unknown>;
  }>;
}

export interface JobViewUnderTest {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  result: Record<string, unknown> | null;
  error: string | null;
}

/** Outbox: events are appended through `RecordStore.enqueueEvent`; this claims and settles them. Not yet a port (infrastructure/outbox/outbox-dispatcher.ts). */
export interface OutboxDispatcherUnderTest {
  on(type: string, name: string, handler: (event: { id: string; tenantId: string; type: string; payload: Record<string, unknown>; attempts: number }) => Promise<void>): void;
  runOnce(options?: { limit?: number }): Promise<{ processed: number; failed: number; retried: number }>;
}

/** A managed index on one configured field of one record type. Not yet a port (runtime/definitions/index-manager.ts over the ManagedIndexes port). */
export interface ManagedIndexSpec {
  typeKey: string;
  field: string;
  as: 'text' | 'numeric' | 'caseless';
  unique: boolean;
}

export interface IndexManagerUnderTest {
  /** Builds the index and records it as ready; its name. */
  create(spec: ManagedIndexSpec): Promise<string>;
  /** Undefined when the provider has no such managed index. */
  inspect(name: string): Promise<{ status: string; present: boolean } | undefined>;
  remove(name: string): Promise<void>;
}

/** Migrations: one logical id per step, recorded the same way on every provider. Not yet a port (infrastructure/postgres/migrate.ts). */
export interface MigrationRunnerUnderTest {
  /** The provider's file for logical step `id`: creates `entity`, then fails when `fails` is set. */
  file(id: string, step: { creates: string; fails?: boolean }): { name: string; text: string };
  /** An empty database (or schema) of its own; `peer` opens a second connection to the same one. */
  open(): Promise<MigrationTarget>;
}

export interface MigrationTarget {
  /** Applies pending steps from `dir`; the logical ids applied, in order. */
  apply(dir: string): Promise<string[]>;
  /** Steps in `dir` not applied yet, and applied steps `dir` does not hold. Start-up refuses either. */
  status(dir: string): Promise<{ pending: string[]; unknown: string[] }>;
  peer(): Promise<MigrationTarget>;
  close(): Promise<void>;
}

/**
 * Writes that skip the ports and the application, inside a tenant
 * transaction, so the suite can show the database itself refuses them.
 */
export interface BypassHandle {
  /** Rows of `entity` the transaction can see, whatever organisation they belong to. */
  visibleRows(tx: Tx, entity: 'record' | 'journal' | 'receipt' | 'outbox' | 'job'): Promise<number>;
  /** Adds a record stamped with `tenantId`. */
  insertRecordFor(tx: Tx, tenantId: string, typeKey: string): Promise<void>;
  /** Changes the data of record `id` with no organisation filter; rows changed. */
  touchRecord(tx: Tx, id: string): Promise<number>;
  /** Overwrites a record with no version check; rows changed. */
  overwriteRecord(tx: Tx, id: string, version: number): Promise<number>;
  /** Writes a journal entry and its lines directly. */
  insertJournal(tx: Tx, entry: { periodId: string; date: string; lines: { accountId: string; debit: string; credit: string }[] }): Promise<string>;
  addJournalLines(tx: Tx, entryId: string, lines: { accountId: string; debit: string; credit: string }[]): Promise<void>;
  setJournalLineAmount(tx: Tx, entryId: string, debit: string): Promise<void>;
  setJournalMemo(tx: Tx, entryId: string, memo: string): Promise<void>;
  setJournalStatus(tx: Tx, entryId: string, status: string): Promise<void>;
  deleteJournal(tx: Tx, entryId: string): Promise<void>;
  setReceiptAmount(tx: Tx, receiptId: string, amount: string): Promise<void>;
  setReceiptStatus(tx: Tx, receiptId: string, status: string, reason: string | null): Promise<void>;
  deleteReceipt(tx: Tx, receiptId: string): Promise<void>;
  /** The organisation's outbox events, oldest first. */
  outboxEvents(tx: Tx): Promise<{ id: string; type: string; status: string; attempts: number }[]>;
  /** Makes every waiting event of the organisation due now, as if its retry delay had passed. */
  makeOutboxDue(tx: Tx): Promise<void>;
  /** Ends the lease of every running job of the organisation, as if its worker had died. */
  expireJobLeases(tx: Tx): Promise<void>;
}
