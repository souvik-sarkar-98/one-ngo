import { createHash } from 'node:crypto';
import { PAYMENT_PROVIDERS, type PaymentIntent, type PaymentService } from '../../domain/payments/payment-service.js';
import type { ReceiptService } from '../../domain/receipts/receipt-service.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { conflict, notFound, ruleViolation, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { demand } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import { joinTx } from '../../domain/transaction-scope.js';
import { actionPermission } from '../../runtime/definitions/action-permissions.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import { editRefusals } from '../../runtime/definitions/field-permissions.js';
import type { ActionDef, ActionStep, FieldDef } from '../../runtime/definitions/types.js';
import { check, connectorDelivery, evaluate, runAutomationAction, type ActionRunner } from '../../runtime/automation/run-action.js';
import type { NotifyInput } from '../notifications/notification-service.js';
import type { RecordService, RecordView } from '../../runtime/records/record-service.js';
import { normaliseData, validateRecordData } from '../../runtime/records/validator.js';
import type { EnqueueEvent, RecordsInTx } from './ports/action-ports.js';

export interface ActionResult {
  record: RecordView;
  message: string;
  /** Where the app goes next: an in-app route such as the print view, or a payment link. */
  open?: string;
  payment?: PaymentIntent;
}

const CHANGES_RECORD = new Set<ActionStep['type']>(['setFields', 'transition', 'createPayment', 'script']);

/** An action that requests a payment also needs the person's own right to create one; its steps run with the action's authority. */
function demandPaymentCreate(ctx: TenantContext, def: ActionDef): void {
  if (def.steps.some((s) => s.type === 'createPayment')) demand(ctx.actor, 'payments:create');
}
/**
 * Runs a configured record action. The action's permission and `when` are
 * the gate; its steps then run with the action's authority (as the person,
 * without needing each step's own permission, though fields with an edit
 * permission still need it), in one transaction. Messages
 * and webhooks are only queued, so their delivery can fail without undoing
 * the record change.
 */
export class ActionService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly defs: DefinitionService,
    private readonly recordsIn: RecordsInTx,
    private readonly enqueue: EnqueueEvent,
    private readonly payments: PaymentService,
    private readonly receipts: ReceiptService,
  ) {}

  async run(
    ctx: TenantContext,
    typeKey: string,
    id: string,
    key: string,
    body: { input?: unknown; expectedVersion?: number } = {},
  ): Promise<ActionResult> {
    const defs = await this.defs.pinned(ctx.tenantId);
    const action = await defs.get(ctx.tenantId, 'action', key);
    if (!action || action.body.recordType !== typeKey) throw notFound(`Unknown action '${key}'.`);
    const def = action.body;
    demand(ctx.actor, actionPermission(def));
    demandPaymentCreate(ctx, def);
    await this.assertFieldsEditable(ctx, def);
    const input = this.formValues(def, body.input ?? {});
    const type = (await defs.get(ctx.tenantId, 'recordType', typeKey))?.body;

    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const records = this.recordsIn(ctx.tenantId, tx, defs);
      let current = await records.stored(ctx, id, def.steps.some((s) => CHANGES_RECORD.has(s.type)) ? 'edit' : 'read');
      if (current.record.type !== typeKey) throw notFound('Record not found.');
      if (body.expectedVersion !== undefined && body.expectedVersion !== current.record.version) {
        throw conflict('This record was changed by someone else. Reload it and try again.');
      }
      await this.checkReferences(ctx, records, def, input);

      const scope = () => {
        const r = current.record;
        return {
          record: { ...current.data, id: r.id, number: r.number },
          previous: {},
          status: r.status,
          previousStatus: null,
          workflow: r.workflow,
          states: { ...r.states, ...(r.workflow ? { [r.workflow]: r.status } : {}) },
          user: { id: ctx.actor.id, roles: [...ctx.actor.roles] },
          input,
        };
      };
      if (def.when && !check(def.when, scope(), `action ${def.key}`)) throw ruleViolation(`'${def.label}' is not available for this record.`);

      const asAction: TenantContext = { ...ctx, actor: { ...ctx.actor, permissions: ['*'] } };
      const runner: ActionRunner = {
        records,
        notify: (n: NotifyInput) => this.enqueue(tx, 'action.notify', n),
        webhook: (request) => this.enqueue(tx, 'connector.webhook', request),
        connector: (request) => this.enqueue(tx, 'connector.http', connectorDelivery(request, type)),
        event: `action.${def.key}`,
      };
      const out: Omit<ActionResult, 'record' | 'message'> = {};
      let awaitingApproval = false;
      for (const [i, step] of def.steps.entries()) {
        const where = `action ${def.key} step ${i + 1}`;
        switch (step.type) {
          case 'createPayment':
            out.payment = await this.payments.within(joinTx(ctx.tenantId, tx), records).createIntent(asAction, {
              recordId: id,
              amount: evaluate(step.amount, scope(), `${where} amount`) as number,
              provider: PAYMENT_PROVIDERS[step.provider],
              upiAccountKey: step.account,
              onPaid: step.onPaid,
            });
            out.open = out.payment.upiLink ?? `/payments/${out.payment.id}`;
            break;
          case 'openReceipt': {
            const latest = (await this.receipts.forRecord(tx, id)).filter((r) => r.status === 'issued').at(-1);
            if (!latest) throw ruleViolation('This record has no receipt to print yet.');
            out.open = `/print/receipt/${latest.id}`;
            break;
          }
          case 'report': {
            const params = new URLSearchParams({ record: id });
            for (const [name, expr] of Object.entries(step.params ?? {})) {
              const value = evaluate(expr, scope(), `${where} ${name}`);
              if (value !== null && value !== undefined && value !== '') params.set(name, String(value));
            }
            out.open = `/reports/${encodeURIComponent(step.report)}?${params.toString()}`;
            break;
          }
          case 'script':
            await records.runButtonScript(ctx, id, step.script, current.record.version, asAction);
            current = await records.stored(asAction, id, 'read');
            break;
          default: {
            const r = current.record;
            const saved = await runAutomationAction(
              runner,
              asAction,
              step,
              { id: r.id, type: r.type, number: r.number, status: r.status, version: r.version, createdBy: current.createdBy },
              scope(),
            );
            if (saved?.approvalRequestId) awaitingApproval = true;
            if (step.type === 'setFields' || step.type === 'transition') current = await records.stored(asAction, id, 'read');
          }
        }
      }
      const record = (await records.stored(ctx, id, 'read')).record;
      return { record, message: awaitingApproval ? `'${def.label}' is waiting for approval.` : `${def.label}: done.`, ...out };
    });
  }

  /**
   * Requests a payment for a record through a published action with a
   * `createPayment` step: the action decides the amount and the paid step.
   */
  async requestPayment(ctx: TenantContext, recordId: string, key: string, input?: unknown): Promise<PaymentIntent> {
    const action = await this.defs.get(ctx.tenantId, 'action', key);
    if (!action) throw notFound(`Unknown action '${key}'.`);
    if (!action.body.steps.some((s) => s.type === 'createPayment')) throw ruleViolation(`'${action.body.label}' does not request a payment.`);
    const { payment } = await this.run(ctx, action.body.recordType, recordId, key, { input: input ?? {} });
    return payment!;
  }

  /** Checks an action for a bulk run once, before it runs on each record: its placement, permission and form values. */
  async checkBulk(ctx: TenantContext, typeKey: string, key: string, rawInput: unknown): Promise<Record<string, unknown>> {
    const action = await this.defs.get(ctx.tenantId, 'action', key);
    if (!action || action.body.recordType !== typeKey) throw notFound(`Unknown action '${key}'.`);
    if (!action.body.placement.includes('bulk')) throw ruleViolation(`'${action.body.label}' cannot be run on several records at once.`);
    demand(ctx.actor, actionPermission(action.body));
    demandPaymentCreate(ctx, action.body);
    await this.assertFieldsEditable(ctx, action.body);
    return this.formValues(action.body, rawInput ?? {});
  }

  /** The record's fields the action's steps set, each with an edit permission the person must hold. */
  private async assertFieldsEditable(ctx: TenantContext, def: ActionDef): Promise<void> {
    const type = await this.defs.get(ctx.tenantId, 'recordType', def.recordType);
    const keys = def.steps.flatMap((s) =>
      s.type === 'setFields' || s.type === 'transition'
        ? Object.keys(s.values ?? {})
        : s.type === 'createPayment'
          ? Object.values(s.onPaid.fields ?? {}).filter((f): f is string => !!f)
          : [],
    );
    const refused = type ? editRefusals(ctx.actor, type.body, new Set(keys)) : [];
    if (refused.length) throw validationFailed('Some fields cannot be changed by you.', refused);
  }

  private formValues(def: ActionDef, raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validationFailed('The form values must be an object.');
    const fields = (def.form?.fields ?? []) as FieldDef[];
    const input = normaliseData(raw as Record<string, unknown>);
    // Organisations version their own actions independently, so the compiled form is keyed by its fields.
    const shape = createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 16);
    const issues = validateRecordData({ key: `action:${def.key}:${shape}`, label: def.label, fields }, 0, input);
    if (issues.length) throw validationFailed('Some fields are not valid.', issues);
    return input;
  }

  private async checkReferences(ctx: TenantContext, records: RecordService, def: ActionDef, input: Record<string, unknown>): Promise<void> {
    const issues: FieldIssue[] = [];
    for (const f of def.form?.fields ?? []) {
      const value = input[f.key];
      if (f.type !== 'reference' || typeof value !== 'string') continue;
      const found = await records.stored(ctx, value, 'read').then(
        (r) => r.record.type === f.referenceType,
        () => false,
      );
      if (!found) issues.push({ path: `/${f.key}`, message: 'was not found' });
    }
    if (issues.length) throw validationFailed('Some fields are not valid.', issues);
  }
}
