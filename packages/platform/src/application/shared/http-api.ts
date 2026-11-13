import { forbidden as forbiddenError, notFound as notFoundError, PlatformError, validationFailed as validationError } from '@onengo/kernel/errors';
import { can as actorCan, demand as actorDemand } from '../../domain/permissions.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { DEFINITION_KINDS, type DefinitionKind as RuntimeDefinitionKind } from '../../runtime/definitions/types.js';

/**
 * What every HTTP area shares from the application: the caller's context, the
 * error type routes answer with, the permission checks and the logger. The HTTP
 * layer imports these here, never from the domain or runtime layers directly;
 * everything below is declared here, none of it re-exported.
 */

/** What went wrong, as routes name it. */
export type ErrorCode = PlatformError['code'];

/** One field a request got wrong. */
export interface ErrorIssue {
  path: string;
  message: string;
}

/** The error every use case throws for a refused or invalid request; routes answer with its code, message and issues. */
export interface ApplicationError extends Error {
  readonly code: ErrorCode;
  readonly issues: ErrorIssue[];
  /** The screen-text key for the message, where the app ships one. */
  readonly textKey?: string;
}

/** The application error behind a thrown value, or nothing when it is some other failure. */
export function asApplicationError(error: unknown): ApplicationError | undefined {
  return error instanceof PlatformError ? error : undefined;
}

/** A refusal: not signed in, or not allowed. */
export function forbidden(message?: string): ApplicationError {
  return forbiddenError(message);
}

export function notFound(message?: string): ApplicationError {
  return notFoundError(message);
}

export function validationFailed(message: string): ApplicationError {
  return validationError(message);
}

/** Whether the person may do what the permission allows. */
export function can(actor: RequestActor, permission: string): boolean {
  return actorCan(actor, permission);
}

/** Refuses the request unless the person holds the permission. */
export function demand(actor: RequestActor, permission: string): void {
  actorDemand(actor, permission);
}

/** The kinds of definition a route may name. */
export type DefinitionKind = RuntimeDefinitionKind;

/** The definition kind a route names, or a not-found answer for an unknown one. */
export function definitionKindOf(value: string): DefinitionKind {
  if (!(DEFINITION_KINDS as readonly string[]).includes(value)) throw notFoundError('Unknown definition kind.');
  return value as DefinitionKind;
}

/** The signed-in caller of a request: the organisation and the actor, as every use case takes it. */
export type RequestContext = TenantContext;
export type RequestActor = RequestContext['actor'];

export type LogSeverity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL';

/** Where routes write operational log lines: identifiers and outcomes only. */
export interface HttpLogger {
  log(severity: LogSeverity, message: string, fields?: Record<string, string | number | boolean | null | undefined>, error?: unknown): void;
}

/** What an idempotent request keeps and replays. */
export interface StoredResponse {
  status: number;
  body: unknown;
}

/** `Idempotency-Key` support for create, update and step requests. */
export interface Idempotency {
  requestHash(method: string, path: string, body: unknown): string;
  run(ctx: RequestContext, key: string, requestHash: string, fn: () => Promise<StoredResponse>): Promise<StoredResponse & { replayed: boolean }>;
}
