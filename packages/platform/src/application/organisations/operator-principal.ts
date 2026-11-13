import { forbidden, validationFailed } from '@onengo/kernel/errors';
import type { OperatorAuditActor } from '../../domain/organisations/ports/organisation-directory.js';

const VERIFIED_OPERATOR = Symbol('verified-operator-principal');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEXT_LIMIT = 500;

const OPERATOR_ACTIONS = ['onboard', 'status', 'retry', 'suspend', 'reactivate', 'close', 'sign_in', 'operators', 'audit'] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

/** Identity evidence produced only after the operator provider and local account have been verified. */
export interface OperatorPrincipal {
  readonly operatorId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly display: string;
  readonly authTime: string;
  readonly amr: readonly string[];
  readonly acr?: string;
  readonly assurance: string;
  readonly sessionId: string;
  /** The actions the operator account is granted; the control plane refuses any other. */
  readonly actions: readonly OperatorAction[];
  readonly [VERIFIED_OPERATOR]: true;
}

export interface OperatorPrincipalInput {
  operatorId: string;
  issuer: string;
  subject: string;
  display: string;
  authTime: string | Date;
  amr: readonly string[];
  acr?: string;
  assurance: string;
  sessionId: string;
  actions: readonly string[];
}

function text(value: string, field: string): string {
  const clean = value.trim();
  if (!clean || clean.length > TEXT_LIMIT) throw validationFailed(`The verified operator ${field} is invalid.`);
  return clean;
}

function uuid(value: string, field: string): string {
  const clean = value.trim().toLowerCase();
  if (!UUID.test(clean)) throw validationFailed(`The verified operator ${field} is invalid.`);
  return clean;
}

/**
 * Brands provider evidence after the operator application has verified it.
 * The control plane accepts no unbranded object and never accepts a display
 * name in place of the stable operator account id.
 */
export function verifiedOperatorPrincipal(input: OperatorPrincipalInput): OperatorPrincipal {
  const at = input.authTime instanceof Date ? input.authTime : new Date(input.authTime);
  if (!Number.isFinite(at.getTime())) throw validationFailed('The verified operator authentication time is invalid.');
  if (!Array.isArray(input.amr) || input.amr.some((method) => typeof method !== 'string' || !method.trim() || method.length > 100)) {
    throw validationFailed('The verified operator authentication methods are invalid.');
  }
  if (!Array.isArray(input.actions) || input.actions.some((action) => !(OPERATOR_ACTIONS as readonly string[]).includes(action))) {
    throw validationFailed('The verified operator actions are invalid.');
  }
  return Object.freeze({
    operatorId: uuid(input.operatorId, 'account id'),
    issuer: text(input.issuer, 'issuer'),
    subject: text(input.subject, 'subject'),
    display: text(input.display, 'display name'),
    authTime: at.toISOString(),
    amr: Object.freeze(input.amr.map((method) => method.trim())),
    ...(input.acr === undefined ? {} : { acr: text(input.acr, 'authentication context') }),
    assurance: text(input.assurance, 'assurance'),
    sessionId: uuid(input.sessionId, 'session id'),
    actions: Object.freeze([...new Set(input.actions as OperatorAction[])]),
    [VERIFIED_OPERATOR]: true as const,
  });
}

/** The audit actor for one action, refused unless the operator is granted it. */
export function operatorAuditActor(principal: OperatorPrincipal, permission: OperatorAction, stepUpId?: string): OperatorAuditActor {
  if (principal[VERIFIED_OPERATOR] !== true) throw validationFailed('A verified operator principal is required.');
  if (!principal.actions.includes(permission)) throw forbidden('Your operator account is not granted this action.');
  return {
    display: principal.display,
    operatorId: principal.operatorId,
    issuer: principal.issuer,
    subject: principal.subject,
    permission,
    authTime: principal.authTime,
    assurance: principal.assurance,
    amr: [...principal.amr],
    acr: principal.acr ?? null,
    sessionId: principal.sessionId,
    stepUpId: stepUpId ? uuid(stepUpId, 'step-up id') : null,
  };
}

/** As `operatorAuditActor`, for an action that also needs a one-use step-up. */
export function steppedOperatorActor(principal: OperatorPrincipal, permission: OperatorAction, stepUpId: string | undefined): OperatorAuditActor {
  const actor = operatorAuditActor(principal, permission, stepUpId);
  if (!actor.stepUpId) throw forbidden('A fresh, one-use MFA step-up is required.');
  return actor;
}
