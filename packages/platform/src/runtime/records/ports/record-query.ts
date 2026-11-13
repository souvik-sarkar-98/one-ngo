import type { Tx } from '../../../domain/ports/transaction.js';
import type { RecordRow } from './record-store.js';

/**
 * The record-query AST: which records a list, count, total or lookup reads,
 * checked against the published record type. It holds no database syntax; a
 * compiler turns it into the database's clauses with every value bound.
 * Field and record type keys are definition keys.
 */
export type RecordPredicate =
  /** Live records of the record type. */
  | { kind: 'ofType'; type: string }
  /** Records of a restricted type the person may see: own, shared with them or a role, or awaiting a step they approve. */
  | { kind: 'visibleTo'; person: string; roles: string[]; approvableSteps: string[] }
  /** Records shared (unexpired) with the person or one of their roles that are not their own. */
  | { kind: 'sharedWith'; person: string; roles: string[] }
  | { kind: 'ownedBy'; person: string }
  | { kind: 'idIn'; ids: string[] }
  | { kind: 'idIs'; id: string }
  | { kind: 'idIsNot'; id: string }
  /** The record number, ignoring case. */
  | { kind: 'numberIs'; number: string }
  | { kind: 'statusIn'; values: string[] }
  /**
   * In one of `states` of a workflow: the status of a primary workflow (`orNone`
   * also matches records that follow no workflow), else the parallel state.
   */
  | { kind: 'workflowIn'; workflow: string; primary: boolean; orNone: boolean; states: string[] }
  /** The record's search text (number and searchable fields) contains the text, ignoring case. */
  | { kind: 'search'; text: string }
  /** One of these fields' text contains `text`, ignoring case. Does not read fields that are not listed. */
  | { kind: 'containsAny'; fields: string[]; text: string }
  /** The stored value equals `value` exactly (same JSON type). */
  | { kind: 'equals'; field: string; value: string | number | boolean }
  /** The value is one of `values`; for a multi-choice field, holds any of them. */
  | { kind: 'oneOf'; field: string; as: 'text' | 'numeric' | 'multi'; values: (string | number)[] }
  /** Inclusive bounds; dates are YYYY-MM-DD. */
  | { kind: 'range'; field: string; as: 'numeric' | 'date'; from?: string | number; to?: string | number }
  | { kind: 'near'; field: string; lat: number; lng: number; km: number }
  /** A unique or title value: text ignoring case, or a number. */
  | { kind: 'matches'; field: string; as: 'caseless' | 'numeric'; value: string };

export type SortDir = 'asc' | 'desc';

export type RecordSort =
  /** Newest first. */
  | { kind: 'newest' }
  | { kind: 'id' }
  | { kind: 'column'; column: 'number' | 'status' | 'createdAt' | 'updatedAt'; dir: SortDir }
  | { kind: 'field'; field: string; as: 'text' | 'numeric'; dir: SortDir }
  /** Distance of a location field from a point. */
  | { kind: 'distance'; field: string; lat: number; lng: number; dir: SortDir };

export interface RecordQueryAst {
  /** All must hold. */
  where: RecordPredicate[];
  sort: RecordSort;
  limit: number;
  offset: number;
}

export type Period = 'day' | 'week' | 'month' | 'financialYear';

export type RecordMeasure = { kind: 'count' } | { kind: 'sum'; field: string };

export type RecordGroup =
  | { kind: 'status' }
  /** A choice, yes/no or reference field. */
  | { kind: 'field'; field: string }
  /** `fiscalYearStartMonth` (1–12) is needed for financial years. */
  | { kind: 'period'; period: Period; date: { column: 'createdAt' | 'updatedAt' } | { field: string }; fiscalYearStartMonth?: number };

/** A count or a total over the records a query matches, split by a group when given; records with no group value are left out. */
export interface RecordAggregateAst {
  measure: RecordMeasure;
  group?: RecordGroup;
}

/**
 * Runs validated record-query ASTs inside an open transaction, so the
 * database's managed indexes and row-level security apply.
 */
export interface RecordQueries {
  /** Ids of the records `q` matches, in its order, on its page. */
  ids(tx: Tx, q: RecordQueryAst): Promise<string[]>;
  /** The page of records `q` matches, in its order. */
  rows(tx: Tx, q: RecordQueryAst): Promise<RecordRow[]>;
  /** How many records `q` matches. */
  count(tx: Tx, q: Pick<RecordQueryAst, 'where'>): Promise<number>;
  /** The value `v` of `agg` over the records `q` matches, with each group's key `k` when it is grouped. */
  aggregate<T>(tx: Tx, q: Pick<RecordQueryAst, 'where'>, agg: RecordAggregateAst): Promise<T[]>;
  /** Totals of number or money fields over every record `q` matches, by field key. */
  sums(tx: Tx, q: Pick<RecordQueryAst, 'where'>, keys: string[]): Promise<Record<string, number>>;
}
