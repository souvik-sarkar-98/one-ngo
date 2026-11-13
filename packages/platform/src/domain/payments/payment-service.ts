import type { TenantContext } from '../ports/tenant-context.js';
import { systemActor } from '../system-actor.js';
import { forbidden, notFound, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import { can, demand } from '../permissions.js';
import type { TransactionManager } from '../ports/transaction.js';
import { isMoney, paiseToDecimal, toPaise } from '../money.js';
import { organisationToday } from '../../shared/time/organisation-time.js';
import type { GatewayName, OnPaid, PaymentStore, ProviderName, StoredIntent } from './ports/payment-store.js';
import type { PaymentProvider, PaymentSecrets, PaymentTenants, ProviderCredentials } from './ports/payment-provider.js';

export type { PaymentProvider, PaymentSecrets, PaymentTenants, ProviderCredentials } from './ports/payment-provider.js';

export type { GatewayName, OnPaid, ProviderName } from './ports/payment-store.js';
const GATEWAYS: GatewayName[] = ['razorpay', 'cashfree'];

/** The payment provider each `createPayment` action step's provider names. */
export const PAYMENT_PROVIDERS: Record<'upi' | 'razorpay' | 'cashfree', ProviderName> = { upi: 'upi_direct', razorpay: 'razorpay', cashfree: 'cashfree' };

/** A gateway's stored set-up; `environment` applies to Cashfree only. */
export interface GatewaySetting {
  provider: GatewayName;
  configured: boolean;
  enabled: boolean;
  keyId: string | null;
  environment: 'sandbox' | 'production' | null;
}

export interface PaymentIntent {
  id: string;
  recordId: string;
  provider: ProviderName;
  amount: string;
  reference: string;
  status: 'awaiting_payment' | 'paid' | 'failed' | 'cancelled';
  upiLink: string | null;
  checkout: Record<string, unknown> | null;
}

/** The record a payment is for. */
export interface PayableRecord {
  id: string;
  type: string;
  number: string | null;
  status: string | null;
  workflow: string | null;
  states: Record<string, string>;
  data: Record<string, unknown>;
}

/** Reads the record a payment is for, with the caller's permissions. */
export interface PayableRecords {
  get(ctx: TenantContext, id: string): Promise<PayableRecord>;
}

/** What a payment asks for and what its record runs when it arrives. */
export interface PaymentAsk {
  provider: ProviderName;
  onPaid: OnPaid;
  /** Compared for `upi_direct` only; null skips the comparison. */
  upiAccountKey: string | null;
}

/** The published definitions every payment must agree with, read on the server. */
export interface PaymentTerms {
  /** Permissions of the published actions whose `createPayment` step asks for exactly this; empty when none does. */
  actionPermissions(tenantId: string, recordType: string, ask: PaymentAsk): Promise<string[]>;
  /**
   * The amounts of the receipts the record would be issued once its `onPaid`
   * step runs with `facts` filled in; empty when that step issues none.
   */
  receiptAmounts(tenantId: string, record: PayableRecord, onPaid: OnPaid, facts: Record<string, unknown>): Promise<unknown[]>;
}

/** The step a confirmed payment runs on its record, and the record as it was when the payment was confirmed. */
export interface PaidStep {
  intentId: string;
  provider: ProviderName;
  amount: string;
  onPaid: OnPaid;
  recordId: string;
  recordType: string;
  transition: string;
  data: Record<string, unknown>;
  recordVersion: number;
  recordStatus: string;
}

/** The record fields a paid intent fills, mapped from the payment facts by `onPaid.fields`. */
export function paidFacts(
  onPaid: OnPaid,
  payment: { provider: ProviderName; paidOn: string; reference: string; providerPaymentId: string | null },
): Record<string, unknown> {
  const f = onPaid.fields ?? {};
  const data: Record<string, unknown> = {};
  if (f.paidOn) data[f.paidOn] = payment.paidOn;
  if (f.reference) data[f.reference] = payment.providerPaymentId ?? payment.reference;
  if (f.method) data[f.method] = onPaid.methodValue ?? (payment.provider === 'upi_direct' ? 'upi' : 'online');
  return data;
}

export interface StatementLine {
  date: string;
  amount: number | string;
  description: string;
}

function newReference(randomToken: (bytes: number) => string): string {
  return `NGO${randomToken(6).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8).padEnd(8, '0')}`;
}

export function buildUpiLink(input: { vpa: string; payeeName: string; amountPaise: number; reference: string }): string {
  const params = new URLSearchParams({
    pa: input.vpa,
    pn: input.payeeName.slice(0, 50),
    am: paiseToDecimal(input.amountPaise),
    cu: 'INR',
    tn: input.reference,
    tr: input.reference,
  });
  return `upi://pay?${params.toString()}`;
}

export class PaymentService {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: PaymentStore,
    private readonly tenants: PaymentTenants,
    private readonly records: PayableRecords,
    private readonly terms: PaymentTerms,
    private readonly secrets: PaymentSecrets,
    providers: PaymentProvider[] = [],
  ) {
    for (const p of providers) this.providers.set(p.name, p);
  }

  /** The same service working through other transactions, such as `joinTx` on one the caller already holds. */
  within(transactions: TransactionManager, records: PayableRecords): PaymentService {
    return new PaymentService(transactions, this.store, this.tenants, records, this.terms, this.secrets, [...this.providers.values()]);
  }

  async saveGatewayCredentials(ctx: TenantContext, provider: 'razorpay' | 'cashfree', creds: ProviderCredentials): Promise<void> {
    demand(ctx.actor, 'payments:configure');
    const { keySecret, webhookSecret, ...config } = creds;
    await this.transactions.withTenant(ctx.tenantId, (tx) =>
      this.store.saveGateway(tx, ctx.actor.id, provider, config, this.secrets.seal(JSON.stringify({ keySecret, webhookSecret }))),
    );
  }

  /** Each gateway's set-up for this organisation, without its secrets. */
  async gateways(ctx: TenantContext): Promise<GatewaySetting[]> {
    demand(ctx.actor, 'payments:configure');
    const rows = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.gateways(tx, GATEWAYS));
    return GATEWAYS.map((provider) => {
      const row = rows.find((r) => r.key === provider);
      return {
        provider,
        configured: !!row?.secretEnc,
        enabled: row?.enabled ?? false,
        keyId: row?.config.keyId ?? null,
        environment: row && provider === 'cashfree' ? (row.config.environment ?? 'sandbox') : null,
      };
    });
  }

  /**
   * Creates a payment request for a record. `upi_direct` pays straight into the
   * NGO's own UPI ID with no fee; confirmation is manual or by statement match.
   * Record actions call this with a published `createPayment` step evaluated on
   * the server; the request must match such a step the person may run, and its
   * amount must be what the record's receipt will carry. `ActionService` passes
   * the action's all-permissions actor here, after checking that the real
   * caller holds the action's permission and `payments:create`.
   */
  async createIntent(
    ctx: TenantContext,
    input: { recordId: string; amount: number | string; provider: ProviderName; onPaid: OnPaid; upiAccountKey?: string },
  ): Promise<PaymentIntent> {
    demand(ctx.actor, 'payments:create');
    const paise = toPaise(input.amount, 'Amount');
    if (paise <= 0) throw ruleViolation('Amount must be more than zero.');
    const record = await this.records.get(ctx, input.recordId);
    if (!input.onPaid?.transition) throw validationFailed('Choose the step to run when the payment arrives.');
    const permissions = await this.terms.actionPermissions(ctx.tenantId, record.type, {
      provider: input.provider,
      onPaid: input.onPaid,
      upiAccountKey: input.upiAccountKey ?? '',
    });
    if (!permissions.length) throw ruleViolation('Payments are requested through a published record action; no action asks for this one.');
    if (!permissions.some((p) => can(ctx.actor, p))) throw forbidden();
    const reference = newReference(this.secrets.randomToken);
    const refused = await this.receiptRefusal(ctx.tenantId, record, { provider: input.provider, amount: paiseToDecimal(paise), onPaid: input.onPaid }, {
      paidOn: organisationToday(),
      reference,
      providerPaymentId: null,
    });
    if (refused) throw ruleViolation(refused);

    let upiLink: string | null = null;
    let orderId: string | null = null;
    let checkout: Record<string, unknown> | null = null;
    if (input.provider === 'upi_direct') {
      const account = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.upiPayee(tx, input.upiAccountKey ?? ''));
      if (!account?.upiId) throw ruleViolation('Choose an account that has a UPI ID.');
      upiLink = buildUpiLink({ vpa: account.upiId, payeeName: account.payeeName, amountPaise: paise, reference });
    } else {
      const provider = this.providers.get(input.provider);
      if (!provider) throw ruleViolation(`${input.provider} is not available.`);
      const creds = await this.credentials(ctx.tenantId, input.provider);
      const order = await provider.createOrder(
        { reference, amountPaise: paise, customer: { name: String(record.data.donorName ?? ''), email: record.data.donorEmail as string | undefined } },
        creds,
      );
      orderId = order.orderId;
      checkout = order.checkout;
    }

    const intent = await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const created = await this.store.createIntent(tx, ctx.actor.id, {
        recordId: record.id,
        provider: input.provider,
        amount: paiseToDecimal(paise),
        reference,
        onPaid: input.onPaid,
        upiLink,
        providerOrderId: orderId,
      });
      if (!created) throw ruleViolation('This record already has a payment waiting.');
      return created;
    });
    return { ...this.toIntent(intent), checkout };
  }

  /**
   * A finance operator confirms money that arrived in the NGO's account: the
   * request's amount. Refused when the record's receipt would carry another amount.
   */
  async confirmManually(ctx: TenantContext, intentId: string, input: { paidOn: string; bankReference?: string }): Promise<void> {
    demand(ctx.actor, 'payments:confirm');
    const confirm = { intentId, paidOn: input.paidOn, providerPaymentId: input.bankReference ?? null };
    const intent = await this.awaiting(ctx.tenantId, intentId);
    const refused = await this.confirmRefusal(ctx.tenantId, intent, confirm);
    if (refused) throw ruleViolation(refused);
    await this.markPaid(ctx.tenantId, ctx.actor.id, confirm);
  }

  /**
   * Confirms awaiting UPI payments whose reference appears in a bank statement
   * line with the same amount. A line whose record would be receipted for
   * another amount stays unmatched.
   */
  async matchStatement(ctx: TenantContext, lines: StatementLine[]): Promise<{ matched: string[]; unmatched: number }> {
    demand(ctx.actor, 'payments:confirm');
    const open = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.awaitingIntents(tx));
    const matched: string[] = [];
    let unmatched = 0;
    for (const line of lines) {
      const linePaise = toPaise(line.amount, 'Statement amount');
      const intent = open.find(
        (i) => !matched.includes(i.id) && toPaise(i.amount) === linePaise && line.description.toUpperCase().includes(i.reference),
      );
      const confirm = intent && { intentId: intent.id, paidOn: line.date, providerPaymentId: null };
      if (!intent || !confirm || (await this.confirmRefusal(ctx.tenantId, intent, confirm))) {
        unmatched++;
        continue;
      }
      await this.markPaid(ctx.tenantId, ctx.actor.id, confirm);
      matched.push(intent.id);
    }
    return { matched, unmatched };
  }

  /** Handles a provider webhook. Returns false if the signature is invalid. Idempotent per provider event id. */
  async handleWebhook(tenantKey: string, providerName: 'razorpay' | 'cashfree', rawBody: string, headers: Record<string, string | undefined>): Promise<boolean> {
    const provider = this.providers.get(providerName);
    if (!provider) return false;
    const tenantId = await this.tenants.activeIdByKey(tenantKey);
    if (!tenantId) return false;
    const creds = await this.configuredCredentials(tenantId, providerName);
    if (!creds) return false;
    const event = provider.parseWebhook(rawBody, headers, creds);
    if (!event) return false;

    const fresh = await this.transactions.withTenant(tenantId, (tx) => this.store.recordEvent(tx, providerName, event.eventId, rawBody));
    if (!fresh || event.kind === 'ignored' || !event.orderId) return true;
    const orderId = event.orderId;

    const intent = await this.transactions.withTenant(tenantId, (tx) => this.store.intentByOrder(tx, providerName, orderId));
    if (!intent || intent.status !== 'awaiting_payment') return true;
    if (event.kind === 'failed') {
      await this.transactions.withTenant(tenantId, (tx) => this.store.markFailed(tx, intent.id));
      return true;
    }
    const actorId = systemActor(`payments:${providerName}`).id;
    const confirm = { intentId: intent.id, paidOn: organisationToday(), providerPaymentId: event.paymentId };
    const received = event.amountPaise === null ? null : paiseToDecimal(event.amountPaise);
    const refused =
      event.amountPaise !== toPaise(intent.amount)
        ? received === null
          ? 'The provider did not say how much was paid.'
          : 'The amount paid differs from the payment request.'
        : await this.confirmRefusal(tenantId, intent, confirm);
    if (refused) {
      await this.transactions.withTenant(tenantId, (tx) =>
        this.store.noteAmountMismatch(tx, actorId, intent.id, { expected: intent.amount, received, paymentId: event.paymentId, reason: refused }),
      );
      return true;
    }
    await this.markPaid(tenantId, actorId, confirm);
    return true;
  }

  /** The record step a paid intent runs, with the payment facts mapped onto record fields; null unless the intent is paid. */
  async paidStep(tenantId: string, intentId: string): Promise<PaidStep | null> {
    const intent = await this.transactions.withTenant(tenantId, (tx) => this.store.paidIntent(tx, intentId));
    if (!intent || intent.status !== 'paid') return null;
    return {
      intentId: intent.id,
      provider: intent.provider,
      amount: intent.amount,
      onPaid: intent.onPaid,
      recordId: intent.recordId,
      recordType: intent.recordType,
      transition: intent.onPaid.transition,
      data: paidFacts(intent.onPaid, intent),
      recordVersion: intent.recordVersion,
      recordStatus: intent.recordStatus,
    };
  }

  /** Whether the paid intent's record step is still offered by a published action. */
  async stillOffered(tenantId: string, step: PaidStep): Promise<boolean> {
    const ask = { provider: step.provider, onPaid: step.onPaid, upiAccountKey: null };
    return (await this.terms.actionPermissions(tenantId, step.recordType, ask)).length > 0;
  }

  /** Audits a paid intent whose record step was not run. */
  async refusePaidStep(tenantId: string, step: PaidStep, reason: string): Promise<void> {
    await this.transactions.withTenant(tenantId, (tx) =>
      this.store.notePaidStepRefused(tx, systemActor(`payments:${step.provider}`).id, step.intentId, { reason, amount: step.amount }),
    );
  }

  /** The record's status now, to tell whether a paid step still has anything to do. */
  async recordStatus(tenantId: string, recordId: string): Promise<string | undefined> {
    return this.transactions.withTenant(tenantId, (tx) => this.store.recordStatus(tx, recordId));
  }

  async get(ctx: TenantContext, intentId: string): Promise<PaymentIntent> {
    demand(ctx.actor, 'payments:create');
    const row = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.intent(tx, intentId));
    if (!row) throw notFound('Payment request not found.');
    await this.records.get(ctx, row.recordId);
    return { ...this.toIntent(row), checkout: null };
  }

  private async awaiting(tenantId: string, intentId: string): Promise<StoredIntent> {
    const intent = await this.transactions.withTenant(tenantId, (tx) => this.store.intent(tx, intentId));
    if (!intent || intent.status !== 'awaiting_payment') throw ruleViolation('This payment is not waiting for confirmation.');
    return intent;
  }

  /** Why an awaiting intent may not be confirmed: its step is no longer published, or the receipt would carry another amount. */
  private async confirmRefusal(
    tenantId: string,
    intent: StoredIntent,
    confirm: { paidOn: string; providerPaymentId: string | null },
  ): Promise<string | null> {
    const record = await this.records.get({ tenantId, actor: systemActor(`payments:${intent.provider}`) }, intent.recordId);
    const ask = { provider: intent.provider, onPaid: intent.onPaid, upiAccountKey: null };
    if (!(await this.terms.actionPermissions(tenantId, record.type, ask)).length) {
      return 'No published record action asks for this payment any more; record it on the record by hand.';
    }
    return this.receiptRefusal(tenantId, record, intent, { ...confirm, reference: intent.reference });
  }

  /** Why the record's receipt would not match the payment, or null when every receipt its paid step issues carries the payment's amount. */
  private async receiptRefusal(
    tenantId: string,
    record: PayableRecord,
    payment: { provider: ProviderName; amount: string; onPaid: OnPaid },
    facts: { paidOn: string; reference: string; providerPaymentId: string | null },
  ): Promise<string | null> {
    const amounts = await this.terms.receiptAmounts(tenantId, record, payment.onPaid, paidFacts(payment.onPaid, { provider: payment.provider, ...facts }));
    const expected = toPaise(payment.amount);
    for (const amount of amounts) {
      if (isMoney(amount) && toPaise(amount) === expected) continue;
      const shown = isMoney(amount) ? paiseToDecimal(toPaise(amount)) : String(amount);
      return `The payment is for ${payment.amount} but the record's receipt would be for ${shown}.`;
    }
    return null;
  }

  private async markPaid(
    tenantId: string,
    actorId: string,
    input: { intentId: string; paidOn: string; providerPaymentId: string | null },
  ): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw validationFailed('Payment date must be an ISO date.');
    await this.transactions.withTenant(tenantId, async (tx) => {
      if (!(await this.store.markPaid(tx, actorId, input))) throw ruleViolation('This payment is not waiting for confirmation.');
    });
  }

  private async credentials(tenantId: string, provider: 'razorpay' | 'cashfree'): Promise<ProviderCredentials> {
    const creds = await this.configuredCredentials(tenantId, provider);
    if (!creds) throw ruleViolation(`${provider} is not set up for this organisation.`);
    return creds;
  }

  /** Null when the gateway is not set up; a secret that no longer decrypts throws, so it is not mistaken for a forged webhook. */
  private async configuredCredentials(tenantId: string, provider: 'razorpay' | 'cashfree'): Promise<ProviderCredentials | null> {
    const row = await this.transactions.withTenant(tenantId, (tx) => this.store.enabledGateway(tx, provider));
    if (!row?.secretEnc) return null;
    const secrets = JSON.parse(this.secrets.open(row.secretEnc)) as { keySecret: string; webhookSecret: string };
    return { ...row.config, ...secrets };
  }

  private toIntent(row: StoredIntent): Omit<PaymentIntent, 'checkout'> {
    return {
      id: row.id,
      recordId: row.recordId,
      provider: row.provider,
      amount: row.amount,
      reference: row.reference,
      status: row.status,
      upiLink: row.upiLink,
    };
  }
}
