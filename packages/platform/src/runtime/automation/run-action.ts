import { compileExpression, ExpressionError } from '../expressions/expression.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { ruleViolation } from '@onengo/kernel/errors';
import { maskFor } from '../definitions/field-permissions.js';
import type { AutomationAction, RecordTypeDef } from '../definitions/types.js';
import type { NotifyInput } from './ports/automation-collaborators.js';
import type { SaveResult } from '../records/ports/record-result.js';
import type { ActionRecords } from './ports/automation-records.js';

/** Queued as a `connector.webhook` event and signed when it is delivered. */
export interface WebhookRequest {
  connector: string;
  event: string;
  record: { id: string; type: string; number: string | null; status: string | null };
  body: Record<string, unknown>;
  actorId: string;
  time: string;
}

/** A connector step: the record as the step saw it and the step's evaluated body values. */
export interface ConnectorStepRequest {
  connector: string;
  event: string;
  recordId: string;
  /** The record's values with its id and number, as in the step's scope. */
  record: Record<string, unknown>;
  body: Record<string, unknown>;
}

/**
 * The `connector.http` outbox payload for a connector step. Its templates
 * read `record`: the record with sensitive and protected values masked, as
 * in queued notifications, and the step's body values on top.
 */
export function connectorDelivery(request: ConnectorStepRequest, type: RecordTypeDef | undefined) {
  const { id, number } = request.record;
  const record = type ? maskFor(null, type, request.record) : { id, number };
  return { connector: request.connector, event: request.event, recordId: request.recordId, binding: { record: { ...record, ...request.body } } };
}

/** What an automation action or a record action step changes or tells people. */
export interface ActionRunner {
  records: ActionRecords;
  notify(input: NotifyInput): Promise<unknown>;
  webhook(request: WebhookRequest): Promise<unknown>;
  /** Queues a call to an http connector in send mode. */
  connector(request: ConnectorStepRequest): Promise<unknown>;
  /** Names the webhook event, for example `action.sendReminder` or `automation.thankDonor`. */
  event: string;
}

export function evaluate(source: string, scope: Record<string, unknown>, where: string): unknown {
  try {
    return compileExpression(source).evaluate(scope);
  } catch (e) {
    if (e instanceof ExpressionError) throw ruleViolation(`Configuration error in ${where}: ${e.message}`);
    throw e;
  }
}

export function check(source: string, scope: Record<string, unknown>, where: string): boolean {
  try {
    return compileExpression(source).test(scope);
  } catch (e) {
    if (e instanceof ExpressionError) throw ruleViolation(`Configuration error in ${where}: ${e.message}`);
    throw e;
  }
}

export function evaluateMap(map: Record<string, string> | undefined, scope: Record<string, unknown>, where: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(map ?? {}).map(([k, expr]) => [k, evaluate(expr, scope, `${where} ${k}`)]));
}

/** Runs setFields, transition, createRecord, notify, webhook or connector; returns the save for steps that change a record. */
export async function runAutomationAction(
  run: ActionRunner,
  ctx: TenantContext,
  action: AutomationAction,
  record: { id: string; type: string; number: string | null; status: string | null; version: number; createdBy: string | null },
  scope: Record<string, unknown>,
): Promise<SaveResult | undefined> {
  switch (action.type) {
    case 'setFields':
      return run.records.update(ctx, record.id, { data: evaluateMap(action.values, scope, 'setFields'), expectedVersion: record.version });
    case 'transition':
      return run.records.transition(ctx, record.id, action.transition, {
        data: evaluateMap(action.values, scope, `transition ${action.transition}`),
        expectedVersion: record.version,
      });
    case 'createRecord':
      return run.records.create(ctx, action.recordType, evaluateMap(action.values, scope, `createRecord ${action.recordType}`));
    case 'notify':
      await run.notify({
        template: action.template,
        to: action.to,
        channels: action.channels,
        scope,
        recordId: record.id,
        creatorId: record.createdBy,
        recordType: record.type,
      });
      return undefined;
    case 'webhook':
      await run.webhook({
        connector: action.connector,
        event: run.event,
        record: { id: record.id, type: record.type, number: record.number, status: record.status },
        body: evaluateMap(action.body, scope, `webhook ${action.connector}`),
        actorId: ctx.actor.id,
        time: new Date().toISOString(),
      });
      return undefined;
    case 'connector': {
      const seen = scope.record;
      await run.connector({
        connector: action.connector,
        event: run.event,
        recordId: record.id,
        record: seen && typeof seen === 'object' ? { ...(seen as Record<string, unknown>) } : { id: record.id, number: record.number },
        body: evaluateMap(action.body, scope, `connector ${action.connector}`),
      });
      return undefined;
    }
  }
}
