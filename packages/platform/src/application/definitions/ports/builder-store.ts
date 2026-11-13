import type { Tx } from '../../../domain/ports/transaction.js';

/** What the Builder's checks and previews read from the organisation in the open transaction. Nothing here writes. */
export interface BuilderStore {
  /** The counter value the next record numbered from the sequence gets today, with the financial year and numbering period. */
  nextNumber(tx: Tx, sequence: string, reset: 'fiscal_year' | 'never' | undefined): Promise<{ next: number; fy: string; period: string }>;
  /** Live records of the type with (or, when `present` is false, without) a non-empty value for the field. */
  countWithValue(tx: Tx, typeKey: string, field: string, present: boolean): Promise<number>;
  /**
   * Live records of the type in `state` of the primary workflow `workflowKey`;
   * records without a workflow follow `defaultPrimary`.
   */
  countInPrimaryState(tx: Tx, typeKey: string, state: string, workflowKey: string, defaultPrimary: string): Promise<number>;
  /** Live records of the type in `state` of the parallel workflow `workflowKey`. */
  countInParallelState(tx: Tx, typeKey: string, workflowKey: string, state: string): Promise<number>;
  activeAccountCodes(tx: Tx): Promise<string[]>;
}
