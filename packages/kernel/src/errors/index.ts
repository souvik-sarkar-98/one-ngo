import type { FieldIssue } from '../ports/index.js';
export type { FieldIssue } from '../ports/index.js';

export type ErrorCode =
  | 'validation_failed'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rule_violation'
  | 'definition_invalid'
  | 'script_failed'
  | 'script_limit'
  | 'rate_limited';

export class PlatformError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly issues: FieldIssue[] = [],
    /** The screen-text key for this wording, where the app ships one; `message` is its English. */
    readonly textKey?: string,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

export const validationFailed = (message: string, issues: FieldIssue[] = []) => new PlatformError('validation_failed', message, issues);
export const forbidden = (message = 'You do not have permission to do this.') => new PlatformError('forbidden', message);
export const notFound = (message = 'Not found.') => new PlatformError('not_found', message);
export const conflict = (message: string) => new PlatformError('conflict', message);
export const ruleViolation = (message: string, textKey?: string) => new PlatformError('rule_violation', message, [], textKey);
export const definitionInvalid = (message: string, issues: FieldIssue[] = []) => new PlatformError('definition_invalid', message, issues);

export type InfrastructureErrorCode = Extract<ErrorCode, 'validation_failed' | 'forbidden' | 'not_found' | 'conflict' | 'rule_violation'>;
export class InfrastructureError extends Error {
  constructor(
    readonly code: InfrastructureErrorCode,
    message: string,
    readonly issues: FieldIssue[] = [],
  ) {
    super(message);
    this.name = 'InfrastructureError';
  }
}

export const infrastructureValidationFailed = (message: string, issues: FieldIssue[] = []) =>
  new InfrastructureError('validation_failed', message, issues);
export const infrastructureForbidden = (message = 'You do not have permission to do this.') =>
  new InfrastructureError('forbidden', message);
export const infrastructureNotFound = (message = 'Not found.') => new InfrastructureError('not_found', message);
export const infrastructureConflict = (message: string) => new InfrastructureError('conflict', message);
export const infrastructureRuleViolation = (message: string) => new InfrastructureError('rule_violation', message);
