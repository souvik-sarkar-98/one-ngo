import {
  InfrastructureError,
  infrastructureRuleViolation as ruleViolation,
  infrastructureValidationFailed as validationFailed,
} from '@onengo/kernel/errors';
import {
  databaseErrorOf as genericDatabaseErrorOf,
  RAISE_EXCEPTION,
  UNIQUE_VIOLATION,
  type DatabaseErrorInfo,
} from '@onengo/kernel/db';
export { RAISE_EXCEPTION, UNIQUE_VIOLATION, type DatabaseErrorInfo } from '@onengo/kernel/db';

export const databaseErrorOf = (error: unknown): DatabaseErrorInfo | undefined =>
  genericDatabaseErrorOf(error, InfrastructureError);

/** Trigger messages from the migrations, matched in full, with what the user is told instead. */
const RULES: [RegExp, string][] = [
  [/^journal entry \S+ does not balance\b/, 'The journal entry does not balance: total debits must equal total credits.'],
  [/^period is closed$/, 'This accounting period is closed, so nothing can be posted to it.'],
  [/^entry date is outside its period$/, 'The entry date is outside its accounting period.'],
  [/^posted journal entries cannot be changed$/, 'Posted journal entries cannot be changed. Reverse the entry instead.'],
  [/^posted journal lines cannot be changed$/, 'Posted journal entries cannot be changed. Reverse the entry instead.'],
  [/^journal entries cannot be deleted$/, 'Journal entries cannot be deleted. Reverse the entry instead.'],
  [/^receipts cannot be deleted$/, 'Receipts cannot be deleted. Void the receipt instead.'],
  [/^issued receipts cannot be changed except by voiding$/, 'Issued receipts cannot be changed. Void the receipt instead.'],
];

/** Guards in the record query functions: reaching them is a platform fault, not a user mistake. */
const FAULTS = [/^no organisation is set for this query$/, /^invalid record query$/];

const DUPLICATE = 'Another record already has this value.';

/**
 * The platform error for a database rejection the user can act on: a unique
 * value already taken, or a money or receipt rule enforced by a trigger.
 * `field` is the record field behind a managed unique index, when known.
 * Anything else is left to the caller as an unexpected error.
 */
export function fromDatabaseError(error: DatabaseErrorInfo, field?: string): InfrastructureError | undefined {
  if (error.code === UNIQUE_VIOLATION) {
    return validationFailed(DUPLICATE, field ? [{ path: `/${field}`, message: DUPLICATE }] : []);
  }
  if (error.code === RAISE_EXCEPTION) {
    if (FAULTS.some((f) => f.test(error.message))) return undefined;
    const rule = RULES.find(([pattern]) => pattern.test(error.message));
    return ruleViolation(rule ? rule[1] : 'This change is not allowed.');
  }
  return undefined;
}
