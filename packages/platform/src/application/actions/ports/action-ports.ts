import type { Tx } from '../../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../../runtime/definitions/definition-service.js';
import type { RecordService } from '../../../runtime/records/record-service.js';

/** Record operations that run inside `tx`, already open for `tenantId`, with the definitions `defs`. */
export type RecordsInTx = (tenantId: string, tx: Tx, defs: DefinitionReader) => RecordService;

/** Queues an outbox event in `tx`, delivered after it commits. */
export type EnqueueEvent = (tx: Tx, type: string, payload: unknown) => Promise<void>;

/** Records an outbox handler as finished inside its own transaction `tx`. */
export interface HandlerCompletion {
  complete(tx: Tx): Promise<void>;
}
