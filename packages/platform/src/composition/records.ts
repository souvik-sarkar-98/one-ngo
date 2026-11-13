import type { ConnectorCalls } from '../application/connectors/connector-service.js';
import { ProfileService } from '../application/identity/profile-service.js';
import { FieldFollow } from '../runtime/records/field-follow.js';
import { LedgerService } from '../domain/ledger/ledger-service.js';
import { ReceiptService } from '../domain/receipts/receipt-service.js';
import { pgIssuerSource } from '../infrastructure/postgres/stores/issuer-source.js';
import { wireSequences } from './infrastructure.js';
import type { PostgresSequenceStore } from '../infrastructure/postgres/stores/sequence-store.js';
import { pgLedgerStore } from '../infrastructure/postgres/stores/ledger-store.js';
import { pgReceiptStore } from '../infrastructure/postgres/stores/receipt-store.js';
import { postgresProfileStore } from '../infrastructure/postgres/stores/profile-store.js';
import { postgresRecordStores } from '../infrastructure/postgres/stores/records.js';
import { RecordAggregates } from '../runtime/records/aggregates.js';
import type { RecordLookups } from '../runtime/records/ports/record-lookups.js';
import { RecordService } from '../runtime/records/record-service.js';
import type { SensitiveFields } from '../runtime/records/sensitive.js';
import type { Definitions } from './definitions.js';
import type { Base } from './infrastructure.js';

/** The ledger and numbered receipts on their PostgreSQL stores. */
export function financeServices(sequences: PostgresSequenceStore = wireSequences()): { ledger: LedgerService; receipts: ReceiptService } {
  return {
    ledger: new LedgerService(pgLedgerStore(sequences)),
    receipts: new ReceiptService(pgReceiptStore(sequences), pgIssuerSource),
  };
}
export type Finance = ReturnType<typeof financeServices>;

/** The record runtime and what reads or completes records: the member picker, field follow and aggregates. */
export function wireRecords(
  base: Base,
  { definitions }: Definitions,
  { sensitive }: { sensitive: SensitiveFields },
  finance: Finance,
  { connectors }: { connectors: ConnectorCalls },
) {
  const { tm, sandbox } = base;
  const stores = postgresRecordStores(base.sequences);
  const lookups: RecordLookups = { lookup: (tenantId, key, binding) => connectors.lookup(tenantId, key, binding) };
  const records = new RecordService(tm, stores, definitions, sandbox, finance.ledger, finance.receipts, sensitive, lookups);
  return {
    records,
    profiles: new ProfileService(tm, postgresProfileStore, definitions),
    follow: new FieldFollow(tm, stores.records, definitions, sensitive),
    aggregates: new RecordAggregates(tm, records),
  };
}
export type Records = ReturnType<typeof wireRecords>;
