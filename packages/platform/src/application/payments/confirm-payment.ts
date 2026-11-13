import { toPaise } from '../../domain/money.js';
import type { PaidStep, PaymentService } from '../../domain/payments/payment-service.js';
import type { HandlerCompletion, RecordsInTx } from '../actions/ports/action-ports.js';
import type { Actor, TenantContext } from '../../domain/ports/tenant-context.js';
import { SYSTEM_ACTOR_PREFIX } from '../../domain/system-actor.js';
import { joinTx } from '../../domain/transaction-scope.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import type { RequestContext } from '../shared/http-api.js';

/** The part of an outbox event this handler reads. */
interface PaymentConfirmedEvent {
  tenantId: string;
  payload: Record<string, unknown>;
}

class PaidStepRefused extends Error {}

/**
 * Runs a paid record's configured step: the `payment.confirmed` outbox handler.
 *
 * The step runs on a declared system path, not with unrestricted rights: an
 * actor holding only the step's transition permission, read access to the
 * record type, and the edit permissions of the fields the payment fills. The
 * record's own rules (step availability, guards, required fields, scripts)
 * apply as for anyone, and every receipt the step issues must carry the
 * payment's amount; otherwise nothing changes and the refusal is audited.
 */
export class ConfirmPayment {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly defs: DefinitionReader,
    private readonly payments: PaymentService,
    private readonly recordsIn: RecordsInTx,
  ) {}

  /** The step and the event's record of it commit together, so a replayed event does not run the step again. */
  async onPaymentConfirmed(event: PaymentConfirmedEvent, run: HandlerCompletion): Promise<void> {
    const p = event.payload as { intentId: string };
    const step = await this.payments.paidStep(event.tenantId, p.intentId);
    if (!step) return;
    const actor = (await this.payments.stillOffered(event.tenantId, step)) ? await this.stepActor(event.tenantId, step) : null;
    if (!actor) return this.refuse(event, run, step, 'No published record action runs this step any more.');
    const ctx: TenantContext = { tenantId: event.tenantId, actor, depth: 1 };
    try {
      await this.transactions.withTenant(event.tenantId, async (tx) => {
        const saved = await this.recordsIn(event.tenantId, tx, this.defs).transition(ctx, step.recordId, step.transition, {
          data: step.data,
          expectedVersion: step.recordVersion,
        });
        const wrong = saved.receipts.find((r) => toPaise(r.amount) !== toPaise(step.amount));
        if (wrong) throw new PaidStepRefused(`The payment is for ${step.amount} but the receipt would be for ${wrong.amount}.`);
        await run.complete(tx);
      });
    } catch (error) {
      if (error instanceof PaidStepRefused) return this.refuse(event, run, step, error.message);
      // Already moved on (for example, marked paid by hand): nothing left to do.
      const latest = await this.payments.recordStatus(event.tenantId, step.recordId);
      if (latest !== step.recordStatus) return;
      throw error;
    }
  }

  /** Only what the paid step needs; null when its transition is no longer in a workflow of the record type. */
  private async stepActor(tenantId: string, step: PaidStep): Promise<Actor | null> {
    const workflows = await this.defs.workflowsFor(tenantId, step.recordType);
    const t = workflows.flatMap((w) => w.body.transitions).find((x) => x.key === step.transition);
    if (!t) return null;
    const type = (await this.defs.get(tenantId, 'recordType', step.recordType))?.body;
    const filled = new Set(Object.keys(step.data));
    const fieldPermissions = (type?.fields ?? []).filter((f) => filled.has(f.key) && f.editPermission).map((f) => f.editPermission!);
    return {
      id: `${SYSTEM_ACTOR_PREFIX}payments:${step.provider}`,
      roles: ['system'],
      permissions: [
        t.permission ?? `record:${step.recordType}:transition:${t.key}`,
        `record:${step.recordType}:read`,
        `record:${step.recordType}:read:all`,
        ...fieldPermissions,
      ],
    };
  }

  private async refuse(event: PaymentConfirmedEvent, run: HandlerCompletion, step: PaidStep, reason: string): Promise<void> {
    await this.transactions.withTenant(event.tenantId, async (tx) => {
      await this.payments.within(joinTx(event.tenantId, tx), this.recordsIn(event.tenantId, tx, this.defs)).refusePaidStep(event.tenantId, step, reason);
      await run.complete(tx);
    });
  }
}

/** The date and bank reference of a payment confirmed by hand. */
export interface ManualConfirmation {
  paidOn: string;
  bankReference?: string;
}

/** A person confirms a payment received outside the gateway; the payment service records it and queues payment.confirmed. */
export class ConfirmPaymentManually {
  constructor(private readonly payments: Pick<PaymentService, 'confirmManually'>) {}

  run(ctx: RequestContext, intentId: string, confirmation: ManualConfirmation): Promise<void> {
    return this.payments.confirmManually(ctx, intentId, confirmation);
  }
}

/** What a provider's webhook call is answered with: 200 accepted, 401 not genuine, 404 no such provider. */
export type WebhookOutcome = 200 | 401 | 404;

/** The payment providers that call a webhook. */
const WEBHOOK_PROVIDERS = ['razorpay', 'cashfree'] as const;

/** A provider reports a payment: checked against its signature over the raw body, and applied once however often it is sent. */
export class HandlePaymentWebhook {
  constructor(private readonly payments: Pick<PaymentService, 'handleWebhook'>) {}

  async run(call: { provider: string; tenantKey: string; rawBody: string; headers: Record<string, string | undefined> }): Promise<WebhookOutcome> {
    const provider = WEBHOOK_PROVIDERS.find((p) => p === call.provider);
    if (!provider) return 404;
    const ok = await this.payments.handleWebhook(call.tenantKey, provider, call.rawBody, call.headers);
    return ok ? 200 : 401;
  }
}

/** A person requests a payment for a record through a published action; the action decides the amount and the paid step. */
export class RequestPayment {
  constructor(private readonly actions: { requestPayment(ctx: RequestContext, recordId: string, key: string, input?: unknown): Promise<unknown> }) {}

  run(ctx: RequestContext, recordId: string, action: string, input?: unknown): Promise<unknown> {
    return this.actions.requestPayment(ctx, recordId, action, input);
  }
}
