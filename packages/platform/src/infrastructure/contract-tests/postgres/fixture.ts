import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { inject } from 'vitest';
import { sql } from '../../postgres/kysely.js';
import { ownerCapabilities } from '../../postgres/tenant-directory.js';
import { databaseErrorOf, RAISE_EXCEPTION, UNIQUE_VIOLATION } from '../../postgres/db-errors.js';
import { fieldExpr, typePredicate, type IndexCast } from '../../postgres/query-compiler/index-expressions.js';
import { JobRunner } from '../../jobs/jobs.js';
import { migrate, migrationStatus } from '../../postgres/migrate.js';
import { OutboxDispatcher } from '../../outbox/outbox-dispatcher.js';
import { PostgresJobStore } from '../../postgres/stores/job-store.js';
import { PostgresOutboxStore } from '../../postgres/stores/outbox-store.js';
import { PostgresSequenceStore, type FiscalYearRules } from '../../postgres/stores/sequence-store.js';
import { PgDatabase } from '../../postgres/pg-database.js';
import { provisionTenant } from '../../postgres/tenants.js';
import { postgresCapabilities } from '../../postgres/capabilities.js';
import { PgDefinitionStore } from '../../postgres/stores/definition-store.js';
import { PgFileCatalog } from '../../postgres/stores/file-catalog.js';
import { pgLedgerStore } from '../../postgres/stores/ledger-store.js';
import { pgReceiptStore } from '../../postgres/stores/receipt-store.js';
import { PgRecordQueries } from '../../postgres/stores/record-queries.js';
import { PgRecordStore } from '../../postgres/stores/record-store.js';
import { PgShareStore } from '../../postgres/stores/share-store.js';
import { pg } from '../../postgres/tx.js';
import type { Database } from '../../postgres/db.js';
import type { TransactionManager, Tx } from '../../../domain/ports/transaction.js';
import type { BypassHandle, IndexManagerUnderTest, ManagedIndexSpec, MigrationTarget, ProviderUnderTest, ProviderWorld, Refusal } from '../provider.js';

const PRODUCT_MIGRATIONS = join(import.meta.dirname, '../../../../migrations');
const TENANT = sql<string>`app_tenant()`;

/**
 * Each world and migration target is its own schema of the test database,
 * named with the run's prefix so test/global-setup.ts drops it when the run
 * ends. The migrator creates the schema on first use.
 */
function newDatabase(tag: string, maxConnections = 3): PgDatabase {
  const schema = `${inject('testSchemaPrefix')}${tag}_${randomBytes(4).toString('hex')}`;
  return new PgDatabase({ connectionString: inject('testDatabaseUrl'), schema, maxConnections });
}

/**
 * PostgreSQL error classes: 23505 unique, 23514 check, P0001 trigger. 42501 is a
 * row-level security policy, or a privilege the runtime role lacks (it may not
 * delete journals or receipts; the triggers refuse the owner too).
 */
function refusal(error: unknown): Refusal {
  const info = databaseErrorOf(error);
  if (!info) return 'other';
  if (info.code === UNIQUE_VIOLATION) return 'duplicate';
  if (info.code === RAISE_EXCEPTION || info.code === '23514') return 'rule';
  if (info.code === '42501') return /row-level security/.test(info.message) ? 'isolation' : 'rule';
  return 'other';
}

const INDEX_CAST: Record<ManagedIndexSpec['as'], IndexCast> = { text: 'text', numeric: 'numeric', caseless: 'lower' };

function indexManager(db: PgDatabase): IndexManagerUnderTest {
  const indexes = ownerCapabilities(db).indexes;
  return {
    async create(spec) {
      const cast = INDEX_CAST[spec.as];
      const name = `rx_${createHash('sha256').update(`${spec.typeKey}|${spec.field}|${cast}|${spec.unique ? 'unique' : ''}`).digest('hex').slice(0, 20)}`;
      await indexes.markNeeded([
        { name, type_key: spec.typeKey, field: spec.field, cast_as: cast === 'lower' ? 'text' : cast, kind: spec.unique ? 'unique' : 'filter' },
      ]);
      const how = postgresCapabilities.concurrentIndexBuild ? 'concurrently ' : '';
      await indexes.runDdl(
        `create ${spec.unique ? 'unique ' : ''}index ${how}if not exists ${name} on record (tenant_id, ${fieldExpr(spec.field, cast)}) where ${typePredicate(spec.typeKey)}`,
      );
      await indexes.markReady(name);
      return name;
    },
    async inspect(name) {
      const [row] = await indexes.states([name]);
      return row ? { status: row.status, present: row.present } : undefined;
    },
    async remove(name) {
      await indexes.runDdl(`drop index ${postgresCapabilities.concurrentIndexBuild ? 'concurrently ' : ''}if exists ${name}`);
      await indexes.forget(name);
    },
  };
}

/** Kysely on the tables, inside the caller's tenant transaction: row-level security and the triggers apply as to the stores. */
const bypass: BypassHandle = {
  async visibleRows(tx, entity) {
    const table = ({ record: 'record', journal: 'journal_entry', receipt: 'receipt', outbox: 'outbox_event', job: 'job' } as const)[entity];
    const row = await pg(tx)
      .selectFrom(table)
      .select((eb) => eb.cast<number>(eb.fn.countAll(), 'integer').as('n'))
      .executeTakeFirstOrThrow();
    return row.n;
  },
  async insertRecordFor(tx, tenantId, typeKey) {
    await pg(tx).insertInto('record').values({ tenant_id: tenantId, type_key: typeKey, schema_version: 1 }).execute();
  },
  async touchRecord(tx, id) {
    const r = await pg(tx).updateTable('record').set({ data: JSON.stringify({ touched: true }) }).where('id', '=', id).executeTakeFirst();
    return Number(r.numUpdatedRows);
  },
  async overwriteRecord(tx, id, version) {
    const r = await pg(tx).updateTable('record').set({ version }).where('id', '=', id).executeTakeFirst();
    return Number(r.numUpdatedRows);
  },
  async insertJournal(tx, entry) {
    const k = pg(tx);
    const row = await k
      .insertInto('journal_entry')
      .values({ tenant_id: TENANT, period_id: entry.periodId, entry_date: entry.date })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const l of entry.lines) {
      await k.insertInto('journal_line').values({ tenant_id: TENANT, entry_id: row.id, account_id: l.accountId, debit: l.debit, credit: l.credit }).execute();
    }
    return row.id;
  },
  async addJournalLines(tx, entryId, lines) {
    for (const l of lines) {
      await pg(tx).insertInto('journal_line').values({ tenant_id: TENANT, entry_id: entryId, account_id: l.accountId, debit: l.debit, credit: l.credit }).execute();
    }
  },
  async setJournalLineAmount(tx, entryId, debit) {
    await pg(tx).updateTable('journal_line').set({ debit }).where('entry_id', '=', entryId).where('debit', '>', '0').execute();
  },
  async setJournalMemo(tx, entryId, memo) {
    await pg(tx).updateTable('journal_entry').set({ memo }).where('id', '=', entryId).execute();
  },
  async setJournalStatus(tx, entryId, status) {
    await pg(tx).updateTable('journal_entry').set({ status }).where('id', '=', entryId).execute();
  },
  async deleteJournal(tx, entryId) {
    await pg(tx).deleteFrom('journal_entry').where('id', '=', entryId).execute();
  },
  async setReceiptAmount(tx, receiptId, amount) {
    await pg(tx).updateTable('receipt').set({ amount }).where('id', '=', receiptId).execute();
  },
  async setReceiptStatus(tx, receiptId, status, reason) {
    await pg(tx).updateTable('receipt').set({ status, void_reason: reason }).where('id', '=', receiptId).execute();
  },
  async deleteReceipt(tx, receiptId) {
    await pg(tx).deleteFrom('receipt').where('id', '=', receiptId).execute();
  },
  outboxEvents(tx) {
    return pg(tx).selectFrom('outbox_event').select(['id', 'type', 'status', 'attempts']).orderBy('created_at').orderBy('id').execute();
  },
  async makeOutboxDue(tx) {
    await pg(tx).updateTable('outbox_event').set({ available_at: sql<Date>`now()` }).where('status', '=', 'pending').execute();
  },
  async expireJobLeases(tx) {
    await pg(tx).updateTable('job').set({ locked_until: sql<Date>`now() - interval '1 second'` }).where('status', '=', 'running').execute();
  },
};

function migrationTarget(db: PgDatabase): MigrationTarget {
  const ids = (names: string[]) => names.map((n) => n.replace(/\.sql$/, ''));
  return {
    apply: async (dir) => ids(await migrate(db, dir)),
    async status(dir) {
      const s = await migrationStatus(db, dir);
      return { pending: ids(s.pending), unknown: ids(s.unknown) };
    },
    async peer() {
      const { schema } = db.migratorTarget();
      return migrationTarget(new PgDatabase({ connectionString: inject('testDatabaseUrl'), schema, maxConnections: 1 }));
    },
    close: () => db.close(),
  };
}

let tenants = 0;

/**
 * Infrastructure may not import core values, so the test that runs this suite hands in the transaction
 * helpers and the financial-year rules (test/postgres-contract.test.ts).
 */
export interface CoreTransactions {
  fiscalYear: FiscalYearRules;
  transactions(db: Database): TransactionManager;
  joinTx(tenantId: string, tx: Tx): TransactionManager;
}

export const postgresProvider = (core: CoreTransactions): ProviderUnderTest => ({
  name: 'PostgreSQL',
  capabilities: postgresCapabilities,

  async open(): Promise<ProviderWorld> {
    const db = newDatabase('contract', 6);
    const sequences = new PostgresSequenceStore(core.fiscalYear);
    await migrate(db, PRODUCT_MIGRATIONS);
    return {
      transactions: core.transactions(db),
      joinTx: core.joinTx,
      newTenant: () => provisionTenant(db, { key: `org${++tenants}${randomBytes(3).toString('hex')}`, name: `Organisation ${tenants}` }),
      stores: {
        records: new PgRecordStore(sequences),
        queries: new PgRecordQueries(),
        shares: new PgShareStore(),
        files: new PgFileCatalog(),
        definitions: new PgDefinitionStore(),
        ledger: pgLedgerStore(sequences),
        receipts: pgReceiptStore(sequences),
      },
      jobs: () => new JobRunner(new PostgresJobStore(db), { autoRun: false }),
      outbox: () => new OutboxDispatcher(new PostgresOutboxStore(db)),
      indexes: indexManager(db),
      bypass,
      refusal,
      close: () => db.close(),
    };
  },

  migrations: {
    file: (id, step) => ({
      name: `${id}.sql`,
      text: `create table ${step.creates} (id int);\n${step.fails ? 'select 1 / 0;\n' : ''}`,
    }),
    open: async () => migrationTarget(newDatabase('migr', 1)),
  },
});
