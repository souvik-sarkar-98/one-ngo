import type { Tx } from '../../ports/transaction.js';

export type ProviderName = 'upi_direct' | 'razorpay' | 'cashfree';
export type GatewayName = Exclude<ProviderName, 'upi_direct'>;
export type IntentStatus = 'awaiting_payment' | 'paid' | 'failed' | 'cancelled';

/** What happens to the record when the payment is confirmed. Field names map payment facts onto record fields. */
export interface OnPaid {
  transition: string;
  fields?: { paidOn?: string; reference?: string; method?: string };
  methodValue?: string;
}

export interface StoredIntent {
  id: string;
  recordId: string;
  provider: ProviderName;
  amount: string;
  reference: string;
  status: IntentStatus;
  upiLink: string | null;
  onPaid: OnPaid;
  providerOrderId: string | null;
}

/** A paid intent with its payment facts and the record as it is now. */
export interface PaidIntent extends StoredIntent {
  paidOn: string;
  providerPaymentId: string | null;
  recordType: string;
  recordVersion: number;
  recordStatus: string;
}

export interface StoredGateway {
  key: GatewayName;
  config: { keyId?: string; environment?: 'sandbox' | 'production' };
  enabled: boolean;
  secretEnc: string | null;
}

export interface NewIntent {
  recordId: string;
  provider: ProviderName;
  amount: string;
  reference: string;
  onPaid: OnPaid;
  upiLink: string | null;
  providerOrderId: string | null;
}

/** Payment persistence. Writes are audited with the change. */
export interface PaymentStore {
  /** Saves (and enables) the gateway's settings with its encrypted secrets. */
  saveGateway(tx: Tx, actorId: string, provider: GatewayName, config: Record<string, unknown>, secretEnc: string): Promise<void>;
  gateways(tx: Tx, providers: GatewayName[]): Promise<StoredGateway[]>;
  /** An enabled gateway's settings and encrypted secrets. */
  enabledGateway(tx: Tx, provider: GatewayName): Promise<{ config: { keyId: string; environment?: 'sandbox' | 'production' }; secretEnc: string | null } | undefined>;
  /** The UPI ID of an active money account and the organisation's name as payee. */
  upiPayee(tx: Tx, accountKey: string): Promise<{ upiId: string | null; payeeName: string } | undefined>;
  /** Undefined when the record already has a payment waiting. */
  createIntent(tx: Tx, actorId: string, intent: NewIntent): Promise<StoredIntent | undefined>;
  intent(tx: Tx, intentId: string): Promise<StoredIntent | undefined>;
  awaitingIntents(tx: Tx): Promise<StoredIntent[]>;
  intentByOrder(tx: Tx, provider: GatewayName, orderId: string): Promise<StoredIntent | undefined>;
  paidIntent(tx: Tx, intentId: string): Promise<PaidIntent | undefined>;
  /** False when the provider event was already received. */
  recordEvent(tx: Tx, provider: GatewayName, eventId: string, payload: string): Promise<boolean>;
  markFailed(tx: Tx, intentId: string): Promise<void>;
  noteAmountMismatch(tx: Tx, actorId: string, intentId: string, details: Record<string, unknown>): Promise<void>;
  /** Audits a paid intent whose record step was not run, with why. */
  notePaidStepRefused(tx: Tx, actorId: string, intentId: string, details: Record<string, unknown>): Promise<void>;
  /** Marks an awaiting intent paid and queues `payment.confirmed`; false when it was not awaiting payment. */
  markPaid(tx: Tx, actorId: string, input: { intentId: string; paidOn: string; providerPaymentId: string | null }): Promise<boolean>;
  /** The record's current status. */
  recordStatus(tx: Tx, recordId: string): Promise<string | undefined>;
}
