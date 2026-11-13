import type { AuditInput } from '../../../domain/ports/audit-trail.js';
import type { Tx } from '../../../domain/ports/transaction.js';

export interface AuditFilter {
  /** A user id or `api:<key name>`. */
  person: string | null;
  /** Entities named exactly, or starting with one of the prefixes. */
  area: { entities: readonly string[]; prefixes: readonly string[] } | null;
  /** Exactly this entity. */
  entity: string | null;
  /** Inclusive calendar days. */
  from: string | null;
  to: string | null;
}

export interface AuditRow {
  id: string | number | bigint;
  at: Date | string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
}

/** The organisation's audit log and settings, inside its tenant transaction. */
export interface AdministrationStore {
  /** Newest first, with the actor's name when they are a person. */
  auditPage(tx: Tx, filter: AuditFilter, page: { limit: number; offset: number }): Promise<{ rows: AuditRow[]; total: number }>;
  /** The organisation's names and its own API rate setting, if any. */
  settings(tx: Tx, rateSetting: string): Promise<{ key: string; name: string; legal_name: string | null; default_locale: string; rate: unknown } | undefined>;
  fiscalYearStartMonth(tx: Tx): Promise<number>;
  /** Whether a financial year has been opened or a receipt issued, which fixes the start month. */
  financialYearFixed(tx: Tx): Promise<boolean>;
  /** Holds the start month against concurrent year opening until the transaction ends. */
  holdFiscalYearStart(tx: Tx): Promise<void>;
  putSetting(tx: Tx, key: string, value: unknown, actorId: string): Promise<void>;
  /** The organisation's own value of a setting, if any. */
  setting(tx: Tx, key: string): Promise<unknown>;
  audit(tx: Tx, entry: AuditInput): Promise<void>;
}
